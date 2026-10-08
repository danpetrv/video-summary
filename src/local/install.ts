import { createHash, randomBytes } from "node:crypto";
import { type Stats, createReadStream, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { netErrorTag, oneLine } from "../net";
import { type Fetcher, type Platform, type Runner, UserError } from "../types";
import { findVulkanLib, planBuilds } from "./builds";
import { type LocalPaths, localPaths } from "./paths";
import { BUILDS, type BuildId, type BuildPin, MODEL, type ModelPin, PARAKEET_VERSION, RELEASE_URL } from "./pins";

export type LocalDeps = {
  run: Runner; fetch: Fetcher; env: Record<string, string | undefined>; home: string;
  platform: Platform; arch: "x64" | "arm64"; exists: (p: string) => boolean; has: (bin: string) => boolean;
};
/** Injectable for tests: fixture sizes and hashes instead of the real release. */
export type Pins = { BUILDS: Record<BuildId, BuildPin>; MODEL: ModelPin };

export type LocalStatus = {
  installed: boolean; version: string; builds: BuildId[];
  model: { present: boolean; verified: boolean; path: string }; vulkan_lib: boolean; hint?: string;
};
export type LocalInstallResult = {
  version: string; builds: BuildId[]; model: { path: string; bytes: number }; downloaded_bytes: number;
};

const DEFAULT_PINS: Pins = { BUILDS, MODEL };

/** Builds for this machine: GPU first, then the CPU fallback (device "auto": install covers both paths). */
function plannedBuilds(d: LocalDeps, vulkanLib: boolean): BuildId[] {
  const p = planBuilds({ platform: d.platform, arch: d.arch, vulkanLib, device: "auto" });
  return [p.gpu, p.cpu].filter((b): b is BuildId => b !== null);
}

/** No network, no hashing: the model counts as verified when it has the exact pinned size. */
export function localStatus(d: LocalDeps, pins: Pins = DEFAULT_PINS): LocalStatus {
  const paths = localPaths(d.env, d.home);
  const vulkanLib = findVulkanLib(d.exists);
  const planned = plannedBuilds(d, vulkanLib);
  const builds = planned.filter((b) => d.exists(paths.cli(b)));
  const present = d.exists(paths.model);
  const verified = present && sizeOf(paths.model) === pins.MODEL.size;
  const out: LocalStatus = {
    installed: builds.length === planned.length && verified,
    version: PARAKEET_VERSION, builds, model: { present, verified, path: paths.model }, vulkan_lib: vulkanLib,
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
  downloaded += await ensureModel(d.fetch, paths.model, pins.MODEL);
  return { version: PARAKEET_VERSION, builds, model: { path: paths.model, bytes: pins.MODEL.size }, downloaded_bytes: downloaded };
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
    const bytes = await download(d.fetch, RELEASE_URL + pin.asset, archive, pin, pin.asset);
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
async function ensureModel(fetch: Fetcher, path: string, pin: ModelPin): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const check = await verify(path, pin);
  // A bad file goes first: a failed re-download must not leave it for `status` to call verified (size only).
  // Same inode only, so a verified file a concurrent run has just renamed in is kept.
  if (check.bad && (await stat(path).catch(() => null))?.ino === check.bad.ino) await rm(path, { force: true });
  const bytes = check.ok ? 0 : await download(fetch, pin.url, path, pin, pin.file);
  // Leftovers of interrupted runs. A concurrent download whose .part goes too accepts our verified file.
  const prefix = `${basename(path)}.`;
  for (const name of await readdir(dirname(path))) {
    if (name.startsWith(prefix) && name.endsWith(".part")) await rm(join(dirname(path), name), { force: true });
  }
  return bytes;
}

const mismatch = (file: string) =>
  new UserError(`downloaded ${file} does not match the pinned checksum — retry \`local install\``);

async function net<T>(file: string, p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (e) {
    throw new UserError(`could not download ${file}: ${netErrorTag(e)}`); // a code, never the message
  }
}

/**
 * Streams `url` into a unique `<target>.<random>.part` while hashing, checks size and sha256,
 * renames onto `target`. On any failure the .part is removed. Returns the bytes received.
 */
async function download(fetch: Fetcher, url: string, target: string, pin: { size: number; sha256: string }, file: string): Promise<number> {
  const part = `${target}.${randomBytes(6).toString("hex")}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  const fh = await open(part, "wx");
  try {
    try {
      const res = await net(file, () => fetch(url));
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new UserError(`could not download ${file}: HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      for (;;) {
        const chunk = reader ? await net(file, () => reader.read()) : { done: true as const, value: undefined };
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > pin.size) {
          await reader!.cancel().catch(() => {});
          throw mismatch(file);
        }
        hash.update(chunk.value);
        for (let off = 0; off < chunk.value.length; ) off += (await fh.write(chunk.value, off)).bytesWritten;
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
