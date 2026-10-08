import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProvider } from "../../src/asr/presets";
import { LOCAL_TIMEOUT_MS, plannedDevice, transcribeParakeet, wordsToCues } from "../../src/local/parakeet";
import { localPaths } from "../../src/local/paths";
import type { BuildId } from "../../src/local/pins";
import { type Runner, UserError } from "../../src/types";

const FX = join(import.meta.dir, "../fixtures");
const fixture = await Bun.file(join(FX, "parakeet-words.json")).text();
const root = mkdtempSync(join(tmpdir(), "vs-parakeet-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const VULKAN_LIB = "/usr/lib/x86_64-linux-gnu/libvulkan.so.1";
const THREADS = String(Math.min(availableParallelism(), 8));
const local = (device: "auto" | "cpu" = "auto") =>
  resolveProvider({ name: "local", type: "local", engine: "parakeet", model: "ultra", device });

type Call = { cmd: string[]; opts?: Parameters<Runner>[1] };
let n = 0;

/**
 * A machine with the given builds installed (empty files) and a work dir with audio.ogg.
 * `cli` answers parakeet-cli runs by binary path; ffmpeg writes its output file.
 */
function machine(o: {
  builds: BuildId[]; vulkanLib?: boolean; platform?: "linux" | "darwin"; arch?: "x64" | "arm64";
  cli?: (bin: string, env: Record<string, string> | undefined) => { code: number; stdout: string; stderr: string };
}) {
  const dir = join(root, `m${n++}`);
  const env = { XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache") };
  const paths = localPaths(env, join(dir, "home"));
  for (const b of o.builds) {
    mkdirSync(paths.binDir(b), { recursive: true });
    writeFileSync(paths.cli(b), "");
  }
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const ogg = join(work, "audio.ogg");
  writeFileSync(ogg, "ogg");
  const calls: Call[] = [];
  const run: Runner = async (cmd, opts) => {
    calls.push({ cmd, opts });
    if (cmd[0] === "ffmpeg") {
      writeFileSync(cmd.at(-1)!, "wav");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0]!.endsWith("/parakeet-cli")) {
      // the wav must exist while parakeet-cli reads it
      expect(existsSync(cmd[cmd.indexOf("--input") + 1]!)).toBe(true);
      return (o.cli ?? (() => ({ code: 0, stdout: fixture, stderr: "" })))(cmd[0]!, opts?.env);
    }
    throw new Error(`unexpected command ${cmd.join(" ")}`);
  };
  const d = {
    run, env, home: join(dir, "home"), platform: o.platform ?? "linux", arch: o.arch ?? "x64",
    exists: (p: string) => (p === VULKAN_LIB ? !!o.vulkanLib : existsSync(p)),
  } as const;
  const parakeetCalls = () => calls.filter((c) => c.cmd[0]!.endsWith("/parakeet-cli"));
  return { d, paths, ogg, work, calls, parakeetCalls };
}

test("wordsToCues: breaks after . ? ! …, on gaps >= 1.0 s, and before a cue would exceed 30 s", () => {
  const cues = wordsToCues(JSON.parse(fixture).words);
  expect(cues).toEqual([
    { start: 0, end: 1.04, text: "Погнали, привет." },
    { start: 1.2, end: 3.2, text: "Сегодня говорим про миграцию" },
    { start: 4.4, end: 34.2, text: "и дальше мы смотрим как это всё работает на практике потому что без этого никак" },
    { start: 34.4, end: 40.2, text: "что думает чат?" },
  ]);
  const w = (text: string, start: number, end = start + 0.5) => ({ w: text, start, end });
  // timestamps come rounded to centiseconds: 4.1 - 3.1 is a 1.0 s gap even though floats say 0.99999…
  expect(wordsToCues([w("Да!", 0), w("Нет…", 1), w("Ну", 2), w("вот", 2.6), w("и", 4.1), w("всё", 5.59)]).map((c) => c.text))
    .toEqual(["Да!", "Нет…", "Ну вот", "и всё"]);
  // exactly 30 s still fits
  expect(wordsToCues([w("a", 0.1, 15.1), w("b", 15.1, 30.1)]).map((c) => c.text)).toEqual(["a b"]);
  expect(wordsToCues([])).toEqual([]);
});

test("transcribe: converts to 16 kHz mono wav, runs parakeet-cli transcribe --model <model> --input <wav> --vad --json --threads <min(cpus,8)> with timeoutMs 7200000", async () => {
  const m = machine({ builds: ["linux-cpu-x64"] });
  let t = 0;
  const r = await transcribeParakeet(m.ogg, local(), { ...m.d, clock: () => (t += 1_000) });
  expect(LOCAL_TIMEOUT_MS).toBe(7_200_000);
  const wav = join(m.work, "audio.wav");
  expect(m.calls).toEqual([
    {
      cmd: ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", m.ogg, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav],
      opts: undefined,
    },
    {
      cmd: [m.paths.cli("linux-cpu-x64"), "transcribe", "--model", m.paths.model, "--input", wav, "--vad", "--json", "--threads", THREADS],
      opts: { timeoutMs: 7_200_000 },
    },
  ]);
  expect(r).toEqual({
    cues: wordsToCues(JSON.parse(fixture).words), provider: "local", diarized: false, speakers: 0, language: null, device: "cpu",
    elapsedMs: 1_000,
  });
  // the wav is a temporary file
  expect(existsSync(wav)).toBe(false);
});

test("transcribe: GPU build fails -> CPU build (linux); result.device cpu; note names the last stderr line", async () => {
  const m = machine({
    builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true,
    cli: (bin) => bin.includes("vulkan")
      ? { code: 1, stdout: "", stderr: "ggml_vulkan: Found 0 Vulkan devices\nerror: no GPU device available\n\n" }
      : { code: 0, stdout: fixture, stderr: "" },
  });
  const r = await transcribeParakeet(m.ogg, local(), m.d);
  expect(m.parakeetCalls().map((c) => [c.cmd[0], c.opts?.env])).toEqual([
    [m.paths.cli("linux-vulkan-x64"), undefined],
    [m.paths.cli("linux-cpu-x64"), undefined],
  ]);
  expect(r.device).toBe("cpu");
  expect(r.notes).toEqual(["local: GPU run failed (error: no GPU device available), used CPU"]);
  expect(r.cues.length).toBe(4);
});

test("transcribe: GPU build fails -> PARAKEET_DEVICE=cpu with the same Metal build (darwin arm64)", async () => {
  const m = machine({
    builds: ["macos-metal-arm64"], platform: "darwin", arch: "arm64",
    cli: (_bin, env) => env?.PARAKEET_DEVICE === "cpu"
      ? { code: 0, stdout: fixture, stderr: "" }
      : { code: 134, stdout: "", stderr: "ggml_metal_init: error: failed to create command queue" },
  });
  const r = await transcribeParakeet(m.ogg, local(), m.d);
  const metal = m.paths.cli("macos-metal-arm64");
  expect(m.parakeetCalls().map((c) => [c.cmd[0], c.opts])).toEqual([
    [metal, { timeoutMs: 7_200_000 }],
    [metal, { timeoutMs: 7_200_000, env: { PARAKEET_DEVICE: "cpu" } }],
  ]);
  expect(r.device).toBe("cpu");
  expect(r.notes).toEqual(["local: GPU run failed (ggml_metal_init: error: failed to create command queue), used CPU"]);
});

test("transcribe: the GPU build works -> device gpu, no notes; the note uses the provider name", async () => {
  const m = machine({ builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true });
  const r = await transcribeParakeet(m.ogg, local(), m.d);
  expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-vulkan-x64")]);
  expect([r.device, r.notes]).toEqual(["gpu", undefined]);

  const failing = machine({
    builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true,
    cli: (bin) => bin.includes("vulkan") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: fixture, stderr: "" },
  });
  const named = resolveProvider({ name: "parakeet", type: "local", engine: "parakeet", model: "ultra", device: "auto" });
  const r2 = await transcribeParakeet(failing.ogg, named, failing.d);
  expect(r2.provider).toBe("parakeet");
  expect(r2.notes).toEqual(["parakeet: GPU run failed (exit code 1), used CPU"]);
});

test("transcribe: device cpu in config -> only the CPU run, no note", async () => {
  const m = machine({ builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true });
  const r = await transcribeParakeet(m.ogg, local("cpu"), m.d);
  expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-cpu-x64")]);
  expect([r.device, r.notes]).toEqual(["cpu", undefined]);

  const mac = machine({ builds: ["macos-metal-arm64"], platform: "darwin", arch: "arm64" });
  const r2 = await transcribeParakeet(mac.ogg, local("cpu"), mac.d);
  expect(mac.parakeetCalls().map((c) => c.opts?.env)).toEqual([{ PARAKEET_DEVICE: "cpu" }]);
  expect([r2.device, r2.notes]).toEqual(["cpu", undefined]);
});

test("transcribe: vulkan lib present but the vulkan build missing -> straight to CPU, no note", async () => {
  const m = machine({ builds: ["linux-cpu-x64"], vulkanLib: true });
  const r = await transcribeParakeet(m.ogg, local(), m.d);
  expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-cpu-x64")]);
  expect([r.device, r.notes]).toEqual(["cpu", undefined]);
});

test("transcribe: empty words -> UserError no speech recognized", async () => {
  const m = machine({
    builds: ["linux-cpu-x64"],
    cli: () => ({ code: 0, stdout: JSON.stringify({ text: "", frame_sec: 0.08, words: [], tokens: [] }), stderr: "" }),
  });
  const err = await transcribeParakeet(m.ogg, local(), m.d).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: no speech recognized");
  expect(existsSync(join(m.work, "audio.wav"))).toBe(false);
});

test("transcribe: timeout (code 124) -> error naming the timeout; a GPU timeout does not start a CPU run", async () => {
  const m = machine({
    builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true,
    cli: () => ({ code: 124, stdout: "", stderr: "[parakeet] pk::Backend using device: Vulkan0\ntimed out after 7200 s" }),
  });
  const err = await transcribeParakeet(m.ogg, local(), m.d).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: timed out after 7200 s");
  expect(m.parakeetCalls().length).toBe(1);
});

test("transcribe: CPU run fails -> UserError with the last stderr line; unparseable output -> UserError", async () => {
  const m = machine({ builds: ["linux-cpu-x64"], cli: () => ({ code: 1, stdout: "", stderr: "error: failed to load model\n" }) });
  const err = await transcribeParakeet(m.ogg, local(), m.d).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: parakeet-cli failed (error: failed to load model)");

  const bad = machine({ builds: ["linux-cpu-x64"], cli: () => ({ code: 0, stdout: "not json", stderr: "" }) });
  const err2 = await transcribeParakeet(bad.ogg, local(), bad.d).catch((e) => e);
  expect(err2).toBeInstanceOf(UserError);
  expect(err2.message).toBe("local: unexpected parakeet-cli output");
});

test("transcribe: ffmpeg fails -> UserError, parakeet-cli is not run", async () => {
  const m = machine({ builds: ["linux-cpu-x64"] });
  const run = m.d.run;
  const d = { ...m.d, run: (async (cmd, opts) => cmd[0] === "ffmpeg"
    ? { code: 1, stdout: "", stderr: "audio.ogg: Invalid data found when processing input\n" }
    : run(cmd, opts)) as Runner };
  const err = await transcribeParakeet(m.ogg, local(), d).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: ffmpeg could not convert audio to wav: audio.ogg: Invalid data found when processing input");
  expect(m.parakeetCalls()).toEqual([]);
});

test("plannedDevice: gpu only when the GPU build is installed and device is not cpu (same rule as the run)", () => {
  const both = ["linux-vulkan-x64", "linux-cpu-x64"] as BuildId[];
  expect(plannedDevice(local(), machine({ builds: both, vulkanLib: true }).d)).toBe("gpu");
  expect(plannedDevice(local("cpu"), machine({ builds: both, vulkanLib: true }).d)).toBe("cpu");
  // lib present but the Vulkan build not installed; build installed but the lib gone
  expect(plannedDevice(local(), machine({ builds: ["linux-cpu-x64"], vulkanLib: true }).d)).toBe("cpu");
  expect(plannedDevice(local(), machine({ builds: both }).d)).toBe("cpu");
  const mac = machine({ builds: ["macos-metal-arm64"], platform: "darwin", arch: "arm64" }).d;
  expect([plannedDevice(local(), mac), plannedDevice(local("cpu"), mac)]).toEqual(["gpu", "cpu"]);
});

test("transcribe: elapsedMs is the process time of the run that succeeded, not ffmpeg or a failed GPU run", async () => {
  let now = 0;
  const m = machine({
    builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true,
    cli: (bin) => {
      now += bin.includes("vulkan") ? 50_000 : 20_000;
      return bin.includes("vulkan") ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: fixture, stderr: "" };
    },
  });
  const run: Runner = async (cmd, opts) => {
    if (cmd[0] === "ffmpeg") now += 7_000;
    return m.d.run(cmd, opts);
  };
  const r = await transcribeParakeet(m.ogg, local(), { ...m.d, run, clock: () => now });
  expect([r.device, r.elapsedMs]).toEqual(["cpu", 20_000]);
});
