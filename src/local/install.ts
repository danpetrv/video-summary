import { createHash, randomBytes } from "node:crypto";
import { type Stats, createReadStream, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { netErrorTag, oneLine } from "../net";
import { type Fetcher, type Platform, type Runner, UserError } from "../types";
import { findVulkanLib, planBuilds } from "./builds";
import { diarModelReady } from "./diarize";
import { type LocalPaths, localPaths } from "./paths";
import { BUILDS, type BuildId, type BuildPin, DIAR_MODEL, MODEL, type ModelPin, PARAKEET_VERSION, RELEASE_URL } from "./pins";

export type LocalDeps = {
  run: Runner; fetch: Fetcher; env: Record<string, string | undefined>; home: string;
  platform: Platform; arch: "x64" | "arm64"; exists: (p: string) => boolean; has: (bin: string) => boolean;
  downloadIdleMs?: number; // a download with no headers or bytes for this long gives up (default DOWNLOAD_IDLE_MS)
};
/** Injectable for tests: fixture sizes and hashes instead of the real release. */
export type Pins = { BUILDS: Record<BuildId, BuildPin>; MODEL: ModelPin; DIAR_MODEL: ModelPin };

export type LocalStatus = {
  installed: boolean; version: string; builds: BuildId[];
  model: { present: boolean; verified: boolean; path: string };
  /** Optional speaker-diarization model: its absence does not make `installed` false. */
  diarization: { present: boolean; verified: boolean; path: string };
  vulkan_lib: boolean; hint?: string;
};
export type LocalInstallResult = {
  version: string; builds: BuildId[]; model: { path: string; bytes: number };
  diar_model: { path: string; bytes: number }; downloaded_bytes: number;
};

const DEFAULT_PINS: Pins = { BUILDS, MODEL, DIAR_MODEL };

/** A stalled download (no response headers or no new bytes for this long) is aborted. */
export const DOWNLOAD_IDLE_MS = 60_000;

/** Builds for this machine: GPU first, then the CPU fallback (device "auto": install covers both paths). */
function plannedBuilds(d: LocalDeps, vulkanLib: boolean): BuildId[] {
  const p = planBuilds({ platform: d.platform, arch: d.arch, vulkanLib, device: "auto" });
  return [p.gpu, p.cpu].filter((b): b is BuildId => b !== null);
}

/**
 * No network, no hashing: the model counts as verified when it has the exact pinned size.
 * Installed = verified model + the build that can run on CPU (darwin arm64: the Metal build).
 * A planned GPU build that is missing (libvulkan1 added after `local install`) only means CPU runs.
 */
export function localStatus(d: LocalDeps, pins: Pins = DEFAULT_PINS): LocalStatus {
  const paths = localPaths(d.env, d.home);
  const vulkanLib = findVulkanLib(d.exists);
  const builds = plannedBuilds(d, vulkanLib).filter((b) => d.exists(paths.cli(b)));
  const cpuBuild = planBuilds({ platform: d.platform, arch: d.arch, vulkanLib, device: "cpu" }).cpu!;
  const present = d.exists(paths.model);
  const verified = present && sizeOf(paths.model) === pins.MODEL.size;
  const out: LocalStatus = {
    installed: d.exists(paths.cli(cpuBuild)) && verified,
    version: PARAKEET_VERSION, builds, model: { present, verified, path: paths.model },
    diarization: { present: d.exists(paths.diarModel), verified: diarModelReady(paths, pins.DIAR_MODEL.size), path: paths.diarModel },
    vulkan_lib: vulkanLib,
  };
  // An NVIDIA GPU without the Vulkan loader: installing it lets the next `local install` add the GPU build.
  if (d.platform === "linux" && !vulkanLib && d.has("nvidia-smi")) out.hint = "sudo apt install libvulkan1";
  return out;
}

/** Downloads what is missing or broken, verifies size and sha256, places it atomically. Idempotent. */
export async function localInstall(d: LocalDeps, pins: Pins = DEFAULT_PINS): Promise<LocalInstallResult> {
  const paths = localPaths(d.env, d.home);
  const builds = plannedBuilds(d, findVulkanLib(d.exists));
  let downloaded = 0;
  for (const b of builds) downloaded += await ensureBuild(d, paths, b, pins.BUILDS[b]);
  downloaded += await ensureModel(d, paths.model, pins.MODEL);
  downloaded += await ensureModel(d, paths.diarModel, pins.DIAR_MODEL);
  return {
    version: PARAKEET_VERSION, builds, model: { path: paths.model, bytes: pins.MODEL.size },
    diar_model: { path: paths.diarModel, bytes: pins.DIAR_MODEL.size }, downloaded_bytes: downloaded,
  };
}

/** Archive -> temp dir next to the target -> `tar -xzf` -> rename the unpacked dir into place. */
async function ensureBuild(d: LocalDeps, paths: LocalPaths, build: BuildId, pin: BuildPin): Promise<number> {
  const cli = paths.cli(build);
  if (d.exists(cli)) return 0;
  const target = paths.binDir(build);
  await mkdir(dirname(target), { recursive: true });
  const tmp = await mkdtemp(join(dirname(target), `.${build}-`));
  try {
    const archive = join(tmp, pin.asset);
    const bytes = await download(d, RELEASE_URL + pin.asset, archive, pin, pin.asset);
    const r = await d.run(["tar", "-xzf", archive, "-C", tmp]);
    if (r.code !== 0) throw new UserError(`could not unpack ${pin.asset}: ${oneLine(r.stderr).slice(0, 300)}`);
    const unpacked = join(tmp, `parakeet-${PARAKEET_VERSION}-bin-${build}`);
    if (!d.exists(join(unpacked, "parakeet-cli"))) throw new UserError(`could not unpack ${pin.asset}: no parakeet-cli inside`);
    try {
      await rename(unpacked, target);
    } catch {
      // A concurrent install got there first: its directory is complete (it was renamed in whole).
      if (d.exists(cli)) return bytes;
      throw new UserError(`${target} exists but has no parakeet-cli — remove it and retry \`local install\``);
    }
    return bytes;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Re-downloads unless the file is there with the pinned size and sha256; then drops stale `.part` files. */
async function ensureModel(d: LocalDeps, path: string, pin: ModelPin): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const check = await verify(path, pin);
  // A bad file goes first: a failed re-download must not leave it for `status` to call verified (size only).
  // Same inode only, so a verified file a concurrent run has just renamed in is kept.
  if (check.bad && (await stat(path).catch(() => null))?.ino === check.bad.ino) await rm(path, { force: true });
  const bytes = check.ok ? 0 : await download(d, pin.url, path, pin, pin.file);
  // Leftovers of interrupted runs. A concurrent download whose .part goes too accepts our verified file.
  const prefix = `${basename(path)}.`;
  for (const name of await readdir(dirname(path))) {
    if (name.startsWith(prefix) && name.endsWith(".part")) await rm(join(dirname(path), name), { force: true });
  }
  return bytes;
}

const mismatch = (file: string) =>
  new UserError(`downloaded ${file} does not match the pinned checksum — retry \`local install\``);

/** A network failure (connection error, stalled stream): retried, unlike HTTP status and checksum errors. */
class NetDrop extends Error {
  constructor(readonly tag: string) {
    super(tag);
  }
}

async function net<T>(p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (e) {
    throw new NetDrop(netErrorTag(e)); // a code, never the message
  }
}

/**
 * `p`, or a TimeoutError once `ms` pass without it settling; the timeout also aborts `ac`, which
 * tears the request down (a fetcher that ignores the signal still cannot hang the download).
 */
async function idle<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new DOMException("download stalled", "TimeoutError");
      ac.abort(e);
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([p, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/** Retries after a dropped connection or a stall, per file and run; each resumes with `Range`. */
export const DOWNLOAD_RETRIES = 3;

/**
 * Streams `url` into a unique `<target>.<random>.part` while hashing, checks size and sha256,
 * renames onto `target`. Waiting for headers and for each chunk is limited by the idle timeout.
 * A network failure (including a body that ends short of the pinned size) is retried up to
 * DOWNLOAD_RETRIES times with `Range: bytes=<received>-`: `206` appends, `200` starts over.
 * A drop after the last byte is not retried. HTTP errors and a size overflow are final.
 * On any failure the .part is removed. Returns the size of the downloaded file.
 */
async function download(d: LocalDeps, url: string, target: string, pin: { size: number; sha256: string }, file: string): Promise<number> {
  const part = `${target}.${randomBytes(6).toString("hex")}.part`;
  const idleMs = d.downloadIdleMs ?? DOWNLOAD_IDLE_MS;
  let hash = createHash("sha256");
  let bytes = 0;
  const fh = await open(part, "wx");
  try {
    try {
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController(); // per attempt: a stall aborts only its own request
        try {
          const headers: Record<string, string> = bytes > 0 ? { range: `bytes=${bytes}-` } : {};
          const res = await net(() => idle(d.fetch(url, { signal: ac.signal, headers }), idleMs, ac));
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            throw new UserError(`could not download ${file}: HTTP ${res.status}`);
          }
          if (res.status !== 206 && bytes > 0) {
            // The server ignored Range and sends the whole file: start over.
            await fh.truncate(0);
            bytes = 0;
            hash = createHash("sha256");
          }
          const reader = res.body?.getReader();
          for (;;) {
            const chunk = reader ? await net(() => idle(reader.read(), idleMs, ac)) : { done: true as const, value: undefined };
            if (chunk.done) {
              // A clean end short of the pinned size is a dropped connection too: resume it.
              if (bytes < pin.size) throw new NetDrop("TRUNCATED");
              break;
            }
            if (bytes + chunk.value.length > pin.size) {
              await reader!.cancel().catch(() => {});
              throw mismatch(file);
            }
            hash.update(chunk.value);
            // Explicit position: after a truncate the descriptor's own offset is stale.
            for (let off = 0; off < chunk.value.length; ) {
              off += (await fh.write(chunk.value, off, chunk.value.length - off, bytes + off)).bytesWritten;
            }
            bytes += chunk.value.length;
          }
          break;
        } catch (e) {
          if (!(e instanceof NetDrop)) throw e;
          ac.abort(e);
          // Every byte arrived before the drop: a Range request would get a 416, let the size and sha256 check decide.
          if (bytes === pin.size) break;
          if (attempt >= DOWNLOAD_RETRIES) throw new UserError(`could not download ${file}: ${e.tag}`);
        }
      }
    } finally {
      await fh.close();
    }
    if (bytes !== pin.size || hash.digest("hex") !== pin.sha256) throw mismatch(file);
    try {
      await rename(part, target);
    } catch (e) {
      // A concurrent install placed its verified file and removed our .part as stale.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || sizeOf(target) !== pin.size) throw e;
    }
    return bytes;
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}

/** `ok`: pinned size and sha256. `bad`: the file exists but does not match (its stat, to remove that very file). */
async function verify(path: string, pin: { size: number; sha256: string }): Promise<{ ok: boolean; bad?: Stats }> {
  const st = await stat(path).catch(() => null);
  if (!st) return { ok: false };
  if (st.size === pin.size) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest("hex") === pin.sha256) return { ok: true };
  }
  return { ok: false, bad: st };
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
