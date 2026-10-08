import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type LocalDeps, localInstall, localStatus } from "../../src/local/install";
import { localPaths } from "../../src/local/paths";
import { BUILDS, type BuildId, MODEL, PARAKEET_VERSION } from "../../src/local/pins";
import { UserError } from "../../src/types";

const root = mkdtempSync(join(tmpdir(), "vs-local-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const RELEASE = `https://github.com/mudler/parakeet.cpp/releases/download/${PARAKEET_VERSION}/`;

// Fixture archives: their content names the build, the stub tar unpacks it into the real layout.
const archives = Object.fromEntries(
  (Object.keys(BUILDS) as BuildId[]).map((b) => [b, new TextEncoder().encode(`archive:${b}:${"x".repeat(5000)}`)]),
) as Record<BuildId, Uint8Array>;
const modelBytes = new Uint8Array(randomBytes(200_000));

const fixturePins = () => ({
  BUILDS: Object.fromEntries(
    (Object.keys(BUILDS) as BuildId[]).map((b) => [b, { ...BUILDS[b], size: archives[b].length, sha256: sha(archives[b]) }]),
  ) as typeof BUILDS,
  MODEL: { ...MODEL, size: modelBytes.length, sha256: sha(modelBytes) },
});

/** Body in 16 KB chunks with a macrotask between them, so concurrent installs interleave. */
function chunked(bytes: Uint8Array, delayMs = 0): Response {
  let off = 0;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (off >= bytes.length) return c.close();
      c.enqueue(bytes.slice(off, off + 16384));
      off += 16384;
    },
  }));
}

let dir: string;
let n = 0;
let fetched: string[];
let served: Map<string, Uint8Array>;
let tarCalls: string[][];

beforeEach(() => {
  dir = join(root, `t${n++}`);
  fetched = [];
  tarCalls = [];
  served = new Map<string, Uint8Array>([[MODEL.url, modelBytes]]);
  for (const b of Object.keys(BUILDS) as BuildId[]) served.set(RELEASE + BUILDS[b].asset, archives[b]);
});

const deps = (o: { vulkan?: boolean; nvidia?: boolean; platform?: "linux" | "darwin"; arch?: "x64" | "arm64" } = {}): LocalDeps => ({
  run: async (cmd) => {
    tarCalls.push(cmd);
    expect(cmd.slice(0, 2)).toEqual(["tar", "-xzf"]);
    expect(cmd[3]).toBe("-C");
    const build = new TextDecoder().decode(readFileSync(cmd[2]!)).split(":")[1]!;
    await new Promise((r) => setTimeout(r, 5));
    const out = join(cmd[4]!, `parakeet-${PARAKEET_VERSION}-bin-${build}`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "README.md"), "readme");
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(out, "parakeet-cli"), `cli:${build}`);
    return { code: 0, stdout: "", stderr: "" };
  },
  fetch: async (url) => {
    fetched.push(url);
    const body = served.get(url);
    return body ? chunked(body) : new Response("not found", { status: 404 });
  },
  env: { XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state") },
  home: join(dir, "home"),
  platform: o.platform ?? "linux",
  arch: o.arch ?? "x64",
  exists: (p) => (p.startsWith(root) ? existsSync(p) : p === "/usr/lib/x86_64-linux-gnu/libvulkan.so.1" && !!o.vulkan),
  has: (bin) => bin === "nvidia-smi" && !!o.nvidia,
});

const paths = () => localPaths(deps().env, deps().home);
const versionDir = () => dirname(paths().binDir("linux-cpu-x64"));
const modelsDir = () => dirname(paths().model);

test("install: downloads planned builds and the model, verifies, places them; second run downloads 0 bytes", async () => {
  const d = deps({ vulkan: true });
  const pins = fixturePins();
  const r = await localInstall(d, pins);
  expect(r).toEqual({
    version: "v0.6.1",
    builds: ["linux-vulkan-x64", "linux-cpu-x64"],
    model: { path: paths().model, bytes: modelBytes.length },
    downloaded_bytes: archives["linux-vulkan-x64"].length + archives["linux-cpu-x64"].length + modelBytes.length,
  });
  expect(readFileSync(paths().cli("linux-vulkan-x64"), "utf8")).toBe("cli:linux-vulkan-x64");
  expect(readFileSync(paths().cli("linux-cpu-x64"), "utf8")).toBe("cli:linux-cpu-x64");
  expect(existsSync(join(paths().binDir("linux-cpu-x64"), "README.md"))).toBe(true);
  expect(sha(readFileSync(paths().model))).toBe(sha(modelBytes));
  // Nothing left behind: no temp dirs, archives or .part files.
  expect(readdirSync(versionDir()).sort()).toEqual(["linux-cpu-x64", "linux-vulkan-x64"]);
  expect(readdirSync(modelsDir())).toEqual(["ultra-q8_0.gguf"]);
  expect(fetched.sort()).toEqual([MODEL.url, RELEASE + BUILDS["linux-cpu-x64"].asset, RELEASE + BUILDS["linux-vulkan-x64"].asset].sort());

  fetched = [];
  const again = await localInstall(d, pins);
  expect(again.downloaded_bytes).toBe(0);
  expect(again.builds).toEqual(["linux-vulkan-x64", "linux-cpu-x64"]);
  expect(fetched).toEqual([]);
});

test("install: archive with wrong sha256 -> UserError naming the asset, no build dir", async () => {
  const pins = fixturePins();
  pins.BUILDS["linux-cpu-x64"] = { ...pins.BUILDS["linux-cpu-x64"], sha256: "0".repeat(64) };
  const err = await localInstall(deps(), pins).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(
    "downloaded parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz does not match the pinned checksum — retry `local install`",
  );
  expect(existsSync(paths().binDir("linux-cpu-x64"))).toBe(false);
  expect(readdirSync(versionDir())).toEqual([]);
  expect(tarCalls).toEqual([]);
});

test("install: archive of the wrong size -> the same checksum error", async () => {
  served.set(RELEASE + BUILDS["linux-cpu-x64"].asset, new Uint8Array([...archives["linux-cpu-x64"], 1, 2, 3]));
  const err = await localInstall(deps(), fixturePins()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz does not match the pinned checksum");
  expect(readdirSync(versionDir())).toEqual([]);
});

test("install: model with wrong bytes -> UserError naming ultra-q8_0.gguf; no final model file; .part removed", async () => {
  const bad = new Uint8Array(modelBytes);
  bad[1000] = bad[1000]! ^ 0xff;
  served.set(MODEL.url, bad);
  const err = await localInstall(deps(), fixturePins()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("downloaded ultra-q8_0.gguf does not match the pinned checksum — retry `local install`");
  expect(existsSync(paths().model)).toBe(false);
  expect(readdirSync(modelsDir())).toEqual([]);
});

test("install: leftover .part from an interrupted run is replaced", async () => {
  mkdirSync(modelsDir(), { recursive: true });
  writeFileSync(join(modelsDir(), "ultra-q8_0.gguf.1a2b3c.part"), modelBytes.slice(0, 5000));
  const r = await localInstall(deps(), fixturePins());
  expect(r.downloaded_bytes).toBeGreaterThanOrEqual(modelBytes.length);
  expect(readdirSync(modelsDir())).toEqual(["ultra-q8_0.gguf"]);
  expect(sha(readFileSync(paths().model))).toBe(sha(modelBytes));
});

test("install: a corrupted model in place (right size, wrong hash) is downloaded again", async () => {
  mkdirSync(modelsDir(), { recursive: true });
  writeFileSync(paths().model, new Uint8Array(modelBytes.length));
  const r = await localInstall(deps(), fixturePins());
  expect(fetched).toContain(MODEL.url);
  expect(r.downloaded_bytes).toBe(archives["linux-cpu-x64"].length + modelBytes.length);
  expect(sha(readFileSync(paths().model))).toBe(sha(modelBytes));
});

test("install: concurrent installs end with a complete build dir", async () => {
  const d = deps({ vulkan: true });
  const pins = fixturePins();
  // The second model download is slow: the first run finishes and sweeps its .part as stale meanwhile.
  let modelRequests = 0;
  const fetchFast = d.fetch;
  d.fetch = async (url, init) => {
    if (url !== MODEL.url || ++modelRequests === 1) return fetchFast(url, init);
    fetched.push(url);
    return chunked(modelBytes, 5);
  };
  const [a, b] = await Promise.all([localInstall(d, pins), localInstall(d, pins)]);
  expect(a.builds).toEqual(["linux-vulkan-x64", "linux-cpu-x64"]);
  expect(b.builds).toEqual(["linux-vulkan-x64", "linux-cpu-x64"]);
  for (const build of ["linux-vulkan-x64", "linux-cpu-x64"] as const) {
    expect(readFileSync(paths().cli(build), "utf8")).toBe(`cli:${build}`);
    expect(readdirSync(paths().binDir(build)).sort()).toEqual(["README.md", "parakeet-cli"]);
  }
  expect(sha(readFileSync(paths().model))).toBe(sha(modelBytes));
  expect(readdirSync(versionDir()).sort()).toEqual(["linux-cpu-x64", "linux-vulkan-x64"]);
  expect(readdirSync(modelsDir())).toEqual(["ultra-q8_0.gguf"]);
});

test("install: network error -> UserError with the error code, not the message", async () => {
  const d = deps();
  d.fetch = async () => {
    throw Object.assign(new TypeError("fetch failed: secret detail"), { cause: { code: "ECONNRESET" } });
  };
  const err = await localInstall(d, fixturePins()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("could not download parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz: ECONNRESET");
  expect(readdirSync(versionDir())).toEqual([]);
});

test("install: HTTP error status -> UserError with the status", async () => {
  served.delete(MODEL.url);
  const err = await localInstall(deps(), fixturePins()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("could not download ultra-q8_0.gguf: HTTP 404");
  expect(readdirSync(modelsDir())).toEqual([]);
});

test("install: tar failure -> UserError naming the asset, no build dir", async () => {
  const d = deps();
  d.run = async () => ({ code: 2, stdout: "", stderr: "gzip: stdin: not in gzip format\n" });
  const err = await localInstall(d, fixturePins()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("could not unpack parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz: gzip: stdin: not in gzip format");
  expect(readdirSync(versionDir())).toEqual([]);
});

test("install: darwin arm64 installs only the Metal build", async () => {
  const r = await localInstall(deps({ platform: "darwin", arch: "arm64" }), fixturePins());
  expect(r.builds).toEqual(["macos-metal-arm64"]);
  expect(existsSync(paths().cli("macos-metal-arm64"))).toBe(true);
});

test("status: not installed", () => {
  expect(localStatus(deps(), fixturePins())).toEqual({
    installed: false, version: "v0.6.1", builds: [],
    model: { present: false, verified: false, path: paths().model }, vulkan_lib: false,
  });
});

test("status: installed", async () => {
  const d = deps({ vulkan: true });
  await localInstall(d, fixturePins());
  expect(localStatus(d, fixturePins())).toEqual({
    installed: true, version: "v0.6.1", builds: ["linux-vulkan-x64", "linux-cpu-x64"],
    model: { present: true, verified: true, path: paths().model }, vulkan_lib: true,
  });
});

test("status: model of the wrong size -> present, not verified, not installed", async () => {
  const d = deps();
  await localInstall(d, fixturePins());
  writeFileSync(paths().model, "truncated");
  const s = localStatus(d, fixturePins());
  expect(s.builds).toEqual(["linux-cpu-x64"]);
  expect(s.model).toEqual({ present: true, verified: false, path: paths().model });
  expect(s.installed).toBe(false);
});

test("status: linux without libvulkan with nvidia-smi -> hint", () => {
  expect(localStatus(deps({ nvidia: true }), fixturePins()).hint).toBe("sudo apt install libvulkan1");
  expect(localStatus(deps({ nvidia: true, vulkan: true }), fixturePins()).hint).toBeUndefined();
  expect(localStatus(deps({ nvidia: false }), fixturePins()).hint).toBeUndefined();
  expect(localStatus(deps({ nvidia: true, platform: "darwin", arch: "arm64" }), fixturePins()).hint).toBeUndefined();
});

test("pins: release assets and the model are the pinned v0.6.1 / Ultra values", () => {
  expect(BUILDS["linux-cpu-x64"]).toEqual({
    asset: "parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz", size: 2727511,
    sha256: "cce60d122ab72e1068cd0d164e54a21655a0b83f1b9c21befc20124f5a972c10", gpu: false,
  });
  expect(BUILDS["linux-vulkan-x64"].gpu).toBe(true);
  expect(BUILDS["macos-metal-arm64"].gpu).toBe(true);
  expect(MODEL).toEqual({
    file: "ultra-q8_0.gguf",
    url: "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/741158ae71e64ef5c89385862c18f777d07a97a1/ultra-q8_0.gguf",
    size: 941517728, sha256: "c2fb452a9df468a141012b01c8c168a25ce93f710897c7de6e353c6cc250986a",
  });
});
