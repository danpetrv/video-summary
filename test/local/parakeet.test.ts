import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProvider } from "../../src/asr/providers";
import { LOCAL_TIMEOUT_MS, plannedDevice, transcribeParakeet, wordsToCues } from "../../src/local/parakeet";
import { localPaths } from "../../src/local/paths";
import { type BuildId, DIAR_MODEL } from "../../src/local/pins";
import { type Runner, UserError } from "../../src/types";

const FX = join(import.meta.dir, "../fixtures");
const fixture = await Bun.file(join(FX, "parakeet-words.json")).text();
const scene = await Bun.file(join(FX, "parakeet-scene.jsonl")).text();
const root = mkdtempSync(join(tmpdir(), "vs-parakeet-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const VULKAN_LIB = "/usr/lib/x86_64-linux-gnu/libvulkan.so.1";
const THREADS = String(Math.min(availableParallelism(), 8));
const local = (device: "auto" | "cpu" = "auto") =>
  resolveProvider({ name: "local", type: "local", engine: "parakeet", model: "ultra", device, diarize: true });

// Recognition alone; the diarization tests pass ON.
const OFF = { diarize: false };
const ON = { diarize: true };

type Call = { cmd: string[]; opts?: Parameters<Runner>[1] };
type Answer = { code: number; stdout: string; stderr: string };
let n = 0;

const defaultCli = (_bin: string, _env: unknown, cmd: string[]): Answer =>
  ({ code: 0, stdout: cmd[1] === "scene" ? scene : fixture, stderr: "" });

/**
 * A machine with the given builds installed (empty files), the diarization model when `diarModel`
 * (sparse, pinned size) and a work dir with audio.ogg. `cli` answers parakeet-cli runs by binary path
 * and command (`cmd[1]` is transcribe or scene; by default the words and the two-speaker scene fixtures);
 * ffmpeg writes its output file.
 */
function machine(o: {
  builds: BuildId[]; vulkanLib?: boolean; platform?: "linux" | "darwin"; arch?: "x64" | "arm64"; diarModel?: boolean;
  cli?: (bin: string, env: Record<string, string> | undefined, cmd: string[]) => Answer;
}) {
  const dir = join(root, `m${n++}`);
  const env = { XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache") };
  const paths = localPaths(env, join(dir, "home"));
  for (const b of o.builds) {
    mkdirSync(paths.binDir(b), { recursive: true });
    writeFileSync(paths.cli(b), "");
  }
  if (o.diarModel) {
    mkdirSync(join(paths.diarModel, ".."), { recursive: true });
    writeFileSync(paths.diarModel, "");
    truncateSync(paths.diarModel, DIAR_MODEL.size);
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
      return (o.cli ?? defaultCli)(cmd[0]!, opts?.env, cmd);
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

test("wordsToCues: speaker change starts a new cue even without a pause; cues copy the speaker", () => {
  const w = (text: string, start: number, speaker?: string) =>
    speaker ? { w: text, start, end: start + 0.5, speaker } : { w: text, start, end: start + 0.5 };
  expect(wordsToCues([w("Да", 0, "Speaker 1"), w("ну", 0.5, "Speaker 1"), w("нет", 1, "Speaker 2"), w("вот", 1.5, "Speaker 2")]))
    .toEqual([
      { start: 0, end: 1, text: "Да ну", speaker: "Speaker 1" },
      { start: 1, end: 2, text: "нет вот", speaker: "Speaker 2" },
    ]);
  // words without a speaker: same cues as before, and no speaker key on the cue
  const plain = wordsToCues([w("Да", 0), w("ну", 0.5), w("нет", 1)]);
  expect(plain).toEqual([{ start: 0, end: 1.5, text: "Да ну нет" }]);
  expect("speaker" in plain[0]!).toBe(false);
});

test("wordsToCues: drops the engine's <unk> token (it stands for « » in Russian speech); a word of only <unk> is skipped", () => {
  const w = (text: string, start: number) => ({ w: text, start, end: start + 0.5 });
  expect(wordsToCues([w("Читали", 0), w("<unk>Проект", 0.5), w("Феникс<unk>?", 1), w("<unk>", 1.5), w("Да.<unk>", 2)]))
    .toEqual([
      { start: 0, end: 1.5, text: "Читали Проект Феникс?" },
      { start: 2, end: 2.5, text: "Да." },
    ]);
});

test("transcribe: converts to 16 kHz mono wav, runs parakeet-cli transcribe --model <model> --input <wav> --vad --json --threads <min(cpus,8)> with timeoutMs 7200000", async () => {
  const m = machine({ builds: ["linux-cpu-x64"] });
  let t = 0;
  const r = await transcribeParakeet(m.ogg, local(), { ...m.d, clock: () => (t += 1_000) }, OFF);
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
    elapsedMs: 1_000, plannedDevice: "cpu", pathElapsedMs: 1_000,
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
  const r = await transcribeParakeet(m.ogg, local(), m.d, OFF);
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
  const r = await transcribeParakeet(m.ogg, local(), m.d, OFF);
  const metal = m.paths.cli("macos-metal-arm64");
  expect(m.parakeetCalls().map((c) => [c.cmd[0], c.opts])).toEqual([
    [metal, { timeoutMs: 7_200_000 }],
    [metal, { timeoutMs: 7_200_000, env: { PARAKEET_DEVICE: "cpu" } }],
  ]);
  expect(r.device).toBe("cpu");
  expect(r.notes).toEqual(["local: GPU run failed (ggml_metal_init: error: failed to create command queue), used CPU"]);
});

// What the pinned v0.6.1 Vulkan build prints when it finds a GPU (observed on a real run).
const VULKAN_OK = "ggml_vulkan: Found 1 Vulkan devices:\n[parakeet] pk::Backend using device: Vulkan0\n";
const vulkanOk = (bin: string) => ({ code: 0, stdout: fixture, stderr: bin.includes("vulkan") ? VULKAN_OK : "" });

test("transcribe: the GPU build works -> device gpu, no notes; the note uses the provider name", async () => {
  const m = machine({ builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true, cli: vulkanOk });
  const r = await transcribeParakeet(m.ogg, local(), m.d, OFF);
  expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-vulkan-x64")]);
  expect([r.device, r.notes, r.plannedDevice]).toEqual(["gpu", undefined, "gpu"]);

  const failing = machine({
    builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true,
    cli: (bin) => bin.includes("vulkan") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: fixture, stderr: "" },
  });
  const named = resolveProvider({ name: "parakeet", type: "local", engine: "parakeet", model: "ultra", device: "auto", diarize: true });
  const r2 = await transcribeParakeet(failing.ogg, named, failing.d, OFF);
  expect(r2.provider).toBe("parakeet");
  expect(r2.notes).toEqual(["parakeet: GPU run failed (exit code 1), used CPU"]);
});

test("transcribe: the Vulkan build exits 0 without using a GPU device -> device cpu, note says so, no second run", async () => {
  // observed: empty stderr (no Vulkan driver), "No devices found" (software Vulkan only), PARAKEET_DEVICE fallback
  for (const stderr of ["", "ggml_vulkan: No devices found.\n", "[parakeet] pk::Backend: PARAKEET_DEVICE=Vulkan0 not found; falling back to CPU\n"]) {
    const m = machine({
      builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true, cli: () => ({ code: 0, stdout: fixture, stderr }),
    });
    const r = await transcribeParakeet(m.ogg, local(), m.d, OFF);
    expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-vulkan-x64")]);
    expect([r.device, r.plannedDevice, r.notes]).toEqual(["cpu", "gpu", ["local: no GPU device found, ran on CPU — set \"device\": \"cpu\" for local to skip the GPU attempt"]]);
    expect(r.cues.length).toBe(4);
  }
});

test("transcribe: the Metal build keeps the exit-code rule: exit 0 is a GPU run whatever stderr says", async () => {
  const m = machine({ builds: ["macos-metal-arm64"], platform: "darwin", arch: "arm64" });
  const r = await transcribeParakeet(m.ogg, local(), m.d, OFF);
  expect([r.device, r.plannedDevice, r.notes]).toEqual(["gpu", "gpu", undefined]);
});

test("transcribe: device cpu in config -> only the CPU run, no note", async () => {
  const m = machine({ builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true });
  const r = await transcribeParakeet(m.ogg, local("cpu"), m.d, OFF);
  expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-cpu-x64")]);
  expect([r.device, r.notes]).toEqual(["cpu", undefined]);

  const mac = machine({ builds: ["macos-metal-arm64"], platform: "darwin", arch: "arm64" });
  const r2 = await transcribeParakeet(mac.ogg, local("cpu"), mac.d, OFF);
  expect(mac.parakeetCalls().map((c) => c.opts?.env)).toEqual([{ PARAKEET_DEVICE: "cpu" }]);
  expect([r2.device, r2.notes]).toEqual(["cpu", undefined]);
});

test("transcribe: vulkan lib present but the vulkan build missing -> straight to CPU, no note", async () => {
  const m = machine({ builds: ["linux-cpu-x64"], vulkanLib: true });
  const r = await transcribeParakeet(m.ogg, local(), m.d, OFF);
  expect(m.parakeetCalls().map((c) => c.cmd[0])).toEqual([m.paths.cli("linux-cpu-x64")]);
  expect([r.device, r.notes]).toEqual(["cpu", undefined]);
});

test("transcribe: empty words -> UserError no speech recognized", async () => {
  const m = machine({
    builds: ["linux-cpu-x64"],
    cli: () => ({ code: 0, stdout: JSON.stringify({ text: "", frame_sec: 0.08, words: [], tokens: [] }), stderr: "" }),
  });
  const err = await transcribeParakeet(m.ogg, local(), m.d, OFF).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: no speech recognized");
  expect(existsSync(join(m.work, "audio.wav"))).toBe(false);
});

test("transcribe: timeout (code 124) -> error naming the timeout; a GPU timeout does not start a CPU run", async () => {
  const m = machine({
    builds: ["linux-vulkan-x64", "linux-cpu-x64"], vulkanLib: true,
    cli: () => ({ code: 124, stdout: "", stderr: "[parakeet] pk::Backend using device: Vulkan0\ntimed out after 7200 s" }),
  });
  const err = await transcribeParakeet(m.ogg, local(), m.d, OFF).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: timed out after 7200 s");
  expect(m.parakeetCalls().length).toBe(1);
});

test("transcribe: CPU run fails -> UserError with the last stderr line; unparseable output -> UserError", async () => {
  const m = machine({ builds: ["linux-cpu-x64"], cli: () => ({ code: 1, stdout: "", stderr: "error: failed to load model\n" }) });
  const err = await transcribeParakeet(m.ogg, local(), m.d, OFF).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("local: parakeet-cli failed (error: failed to load model)");

  const bad = machine({ builds: ["linux-cpu-x64"], cli: () => ({ code: 0, stdout: "not json", stderr: "" }) });
  const err2 = await transcribeParakeet(bad.ogg, local(), bad.d, OFF).catch((e) => e);
  expect(err2).toBeInstanceOf(UserError);
  expect(err2.message).toBe("local: unexpected parakeet-cli output");
});

test("transcribe: ffmpeg fails -> UserError, parakeet-cli is not run", async () => {
  const m = machine({ builds: ["linux-cpu-x64"] });
  const run = m.d.run;
  const d = { ...m.d, run: (async (cmd, opts) => cmd[0] === "ffmpeg"
    ? { code: 1, stdout: "", stderr: "audio.ogg: Invalid data found when processing input\n" }
    : run(cmd, opts)) as Runner };
  const err = await transcribeParakeet(m.ogg, local(), d, OFF).catch((e) => e);
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
  const r = await transcribeParakeet(m.ogg, local(), { ...m.d, run, clock: () => now }, OFF);
  expect([r.device, r.elapsedMs]).toEqual(["cpu", 20_000]);
  // the whole path planned on the GPU: failed GPU run + CPU run, still without ffmpeg
  expect([r.plannedDevice, r.pathElapsedMs]).toEqual(["gpu", 70_000]);
});

const VK: BuildId[] = ["linux-vulkan-x64", "linux-cpu-x64"];
const plainCues = () => wordsToCues(JSON.parse(fixture).words);
// The fixture scene: speaker 0 for 0–3.3 s and 34.3–40.3 s, speaker 1 for 4.3–33 s.
const labeledCues = () => {
  const [a, b, c, d] = plainCues();
  return [{ ...a!, speaker: "Speaker 1" }, { ...b!, speaker: "Speaker 1" }, { ...c!, speaker: "Speaker 2" }, { ...d!, speaker: "Speaker 1" }];
};
/** [binary, command, env] of every parakeet-cli run. */
const runs = (m: ReturnType<typeof machine>) => m.parakeetCalls().map((c) => [c.cmd[0], c.cmd[1], c.opts?.env]);

test("diarize: scene runs after transcribe on the same wav with --diar <diarModel> --input <wav> --json; two speakers -> Speaker 1/2 cues", async () => {
  const m = machine({
    builds: VK, vulkanLib: true, diarModel: true,
    cli: (bin, _env, cmd) => (cmd[1] === "scene" ? { code: 0, stdout: scene, stderr: VULKAN_OK } : vulkanOk(bin)),
  });
  let t = 0;
  const r = await transcribeParakeet(m.ogg, local(), { ...m.d, clock: () => (t += 1_000) }, ON);
  const wav = join(m.work, "audio.wav");
  const vk = m.paths.cli("linux-vulkan-x64");
  expect(m.parakeetCalls()).toEqual([
    { cmd: [vk, "transcribe", "--model", m.paths.model, "--input", wav, "--vad", "--json", "--threads", THREADS], opts: { timeoutMs: LOCAL_TIMEOUT_MS } },
    { cmd: [vk, "scene", "--diar", m.paths.diarModel, "--input", wav, "--json"], opts: { timeoutMs: LOCAL_TIMEOUT_MS } },
  ]);
  // each pass is timed on its own: the scene path starts at the scene run, not at the transcribe run
  expect(r).toEqual({
    cues: labeledCues(), provider: "local", diarized: true, speakers: 2, language: null,
    device: "gpu", elapsedMs: 1_000, plannedDevice: "gpu", pathElapsedMs: 1_000,
    diarization: { device: "gpu", plannedDevice: "gpu", elapsedMs: 1_000, pathElapsedMs: 1_000 },
  });
  expect(existsSync(wav)).toBe(false);
});

test("diarize: one speaker -> no labels, diarized true, speakers 1", async () => {
  const one = `${JSON.stringify({ t: 40.4, speakers: [{ speaker: 3, start: 0, end: 40.3 }], active: { speakers: [] } })}\n`;
  const m = machine({
    builds: ["linux-cpu-x64"], diarModel: true,
    cli: (_bin, _env, cmd) => ({ code: 0, stdout: cmd[1] === "scene" ? one : fixture, stderr: "" }),
  });
  const r = await transcribeParakeet(m.ogg, local(), m.d, ON);
  expect([r.cues, r.diarized, r.speakers, r.notes, r.diarization?.device]).toEqual([plainCues(), true, 1, undefined, "cpu"]);
  expect(r.cues.some((c) => "speaker" in c)).toBe(false);
});

test("diarize: transcribe fell back to CPU (GPU failed) -> scene runs only on the CPU build", async () => {
  const m = machine({
    builds: VK, vulkanLib: true, diarModel: true,
    cli: (bin, env, cmd) => (bin.includes("vulkan") ? { code: 1, stdout: "", stderr: "" } : defaultCli(bin, env, cmd)),
  });
  const r = await transcribeParakeet(m.ogg, local(), m.d, ON);
  const cpu = m.paths.cli("linux-cpu-x64");
  expect(runs(m)).toEqual([[m.paths.cli("linux-vulkan-x64"), "transcribe", undefined], [cpu, "transcribe", undefined], [cpu, "scene", undefined]]);
  expect([r.device, r.diarized, r.speakers, r.notes]).toEqual(["cpu", true, 2, ["local: GPU run failed (exit code 1), used CPU"]]);
  expect([r.diarization?.device, r.diarization?.plannedDevice]).toEqual(["cpu", "gpu"]);
});

test("diarize: Vulkan found no device -> scene runs on the CPU build; note has the device hint", async () => {
  const m = machine({
    builds: VK, vulkanLib: true, diarModel: true,
    cli: (_bin, _env, cmd) => ({ code: 0, stdout: cmd[1] === "scene" ? scene : fixture, stderr: "ggml_vulkan: No devices found.\n" }),
  });
  const r = await transcribeParakeet(m.ogg, local(), m.d, ON);
  expect(runs(m)).toEqual([[m.paths.cli("linux-vulkan-x64"), "transcribe", undefined], [m.paths.cli("linux-cpu-x64"), "scene", undefined]]);
  expect([r.device, r.cues, r.speakers]).toEqual(["cpu", labeledCues(), 2]);
  expect(r.notes).toEqual(['local: no GPU device found, ran on CPU — set "device": "cpu" for local to skip the GPU attempt']);
  expect([r.diarization?.device, r.diarization?.plannedDevice]).toEqual(["cpu", "gpu"]);
});

test("diarize: GPU scene fails, CPU scene succeeds -> labels, note, diarization.device cpu, plannedDevice gpu; timed from the GPU attempt", async () => {
  let now = 0;
  const m = machine({
    builds: VK, vulkanLib: true, diarModel: true,
    cli: (bin, env, cmd) => {
      const gpu = bin.includes("vulkan");
      now += cmd[1] === "transcribe" ? 10_000 : gpu ? 5_000 : 3_000;
      if (cmd[1] === "scene" && gpu) return { code: 1, stdout: "", stderr: "ggml_vulkan: out of device memory\n" };
      return gpu ? vulkanOk(bin) : defaultCli(bin, env, cmd);
    },
  });
  const r = await transcribeParakeet(m.ogg, local(), { ...m.d, clock: () => now }, ON);
  const vk = m.paths.cli("linux-vulkan-x64");
  expect(runs(m)).toEqual([[vk, "transcribe", undefined], [vk, "scene", undefined], [m.paths.cli("linux-cpu-x64"), "scene", undefined]]);
  expect([r.device, r.cues, r.diarized, r.speakers]).toEqual(["gpu", labeledCues(), true, 2]);
  expect(r.notes).toEqual(["local: GPU diarization failed (ggml_vulkan: out of device memory), used CPU"]);
  expect(r.diarization).toEqual({ device: "cpu", plannedDevice: "gpu", elapsedMs: 3_000, pathElapsedMs: 8_000 });
});

test("diarize: darwin arm64 GPU scene fails -> retry is the Metal build with PARAKEET_DEVICE=cpu", async () => {
  const m = machine({
    builds: ["macos-metal-arm64"], platform: "darwin", arch: "arm64", diarModel: true,
    cli: (bin, env, cmd) => (cmd[1] === "scene" && env?.PARAKEET_DEVICE !== "cpu"
      ? { code: 134, stdout: "", stderr: "ggml_metal_init: error: failed to create command queue" }
      : defaultCli(bin, env, cmd)),
  });
  const r = await transcribeParakeet(m.ogg, local(), m.d, ON);
  const metal = m.paths.cli("macos-metal-arm64");
  expect(runs(m)).toEqual([[metal, "transcribe", undefined], [metal, "scene", undefined], [metal, "scene", { PARAKEET_DEVICE: "cpu" }]]);
  expect([r.device, r.speakers, r.diarization?.device]).toEqual(["gpu", 2, "cpu"]);
  expect(r.notes).toEqual(["local: GPU diarization failed (ggml_metal_init: error: failed to create command queue), used CPU"]);
});

test("diarize: scene fails on CPU / times out / prints garbage / only empty events -> unlabeled transcript, diarized false, the matching note", async () => {
  const empty = [
    JSON.stringify({ t: 0.2, speakers: [], active: { speakers: [] } }),
    JSON.stringify({ t: 0.4, speakers: [], active: { speakers: [{ speaker: 0, start: 0.1 }] } }),
  ].join("\n");
  const cases: [Answer, string][] = [
    [{ code: 1, stdout: "", stderr: "loading model\nerror: failed to load diarization model\n" },
      "local: speaker labels skipped — diarization failed (error: failed to load diarization model)"],
    [{ code: 124, stdout: "", stderr: "timed out after 7200 s" }, "local: speaker labels skipped — diarization timed out"],
    [{ code: 0, stdout: "garbage\n", stderr: "" }, "local: speaker labels skipped — unexpected parakeet-cli scene output"],
    [{ code: 0, stdout: '{"t":1,"speakers":[{"speaker":"a"}]}\n', stderr: "" }, "local: speaker labels skipped — unexpected parakeet-cli scene output"],
    [{ code: 0, stdout: empty, stderr: "" }, "local: speaker labels skipped — no speech segments found"],
  ];
  for (const [answer, note] of cases) {
    const m = machine({
      builds: ["linux-cpu-x64"], diarModel: true,
      cli: (bin, env, cmd) => (cmd[1] === "scene" ? answer : defaultCli(bin, env, cmd)),
    });
    const r = await transcribeParakeet(m.ogg, local(), m.d, ON);
    expect(runs(m).map((x) => x[1])).toEqual(["transcribe", "scene"]);
    expect([r.cues, r.diarized, r.speakers, r.notes, r.diarization]).toEqual([plainCues(), false, 0, [note], undefined]);
    expect(existsSync(join(m.work, "audio.wav"))).toBe(false);
  }
});

test("diarize: a GPU scene timeout is not retried on CPU; GPU then CPU scene failing -> one note with the CPU error", async () => {
  const timeout = machine({
    builds: VK, vulkanLib: true, diarModel: true,
    cli: (bin, _env, cmd) => (cmd[1] === "scene" ? { code: 124, stdout: "", stderr: VULKAN_OK } : vulkanOk(bin)),
  });
  const r = await transcribeParakeet(timeout.ogg, local(), timeout.d, ON);
  expect(runs(timeout).map((x) => x[1])).toEqual(["transcribe", "scene"]);
  expect([r.diarized, r.speakers, r.notes]).toEqual([false, 0, ["local: speaker labels skipped — diarization timed out"]]);

  const both = machine({
    builds: VK, vulkanLib: true, diarModel: true,
    cli: (bin, _env, cmd) => (cmd[1] === "scene"
      ? { code: 1, stdout: "", stderr: bin.includes("vulkan") ? "gpu boom" : "cpu boom" }
      : vulkanOk(bin)),
  });
  const r2 = await transcribeParakeet(both.ogg, local(), both.d, ON);
  expect(runs(both).map((x) => x[1])).toEqual(["transcribe", "scene", "scene"]);
  expect([r2.device, r2.cues, r2.diarized, r2.speakers, r2.diarization]).toEqual(["gpu", plainCues(), false, 0, undefined]);
  expect(r2.notes).toEqual(["local: speaker labels skipped — diarization failed (cpu boom)"]);
});

test("diarize: off (o.diarize false) or model missing -> scene never runs; only the missing model adds a note", async () => {
  const off = machine({ builds: ["linux-cpu-x64"], diarModel: true });
  const r = await transcribeParakeet(off.ogg, local(), off.d, OFF);
  expect(runs(off).map((x) => x[1])).toEqual(["transcribe"]);
  expect([r.cues, r.diarized, r.speakers, r.notes, r.diarization]).toEqual([plainCues(), false, 0, undefined, undefined]);

  const missing = machine({ builds: ["linux-cpu-x64"] });
  const r2 = await transcribeParakeet(missing.ogg, local(), missing.d, ON);
  expect(runs(missing).map((x) => x[1])).toEqual(["transcribe"]);
  expect([r2.cues, r2.diarized, r2.speakers]).toEqual([plainCues(), false, 0]);
  expect(r2.notes).toEqual(["local: speaker labels skipped — diarization model not installed, run `local install`"]);

  // a partial download (wrong size) counts as missing
  const partial = machine({ builds: ["linux-cpu-x64"] });
  mkdirSync(join(partial.paths.diarModel, ".."), { recursive: true });
  writeFileSync(partial.paths.diarModel, "part");
  const r3 = await transcribeParakeet(partial.ogg, local(), partial.d, ON);
  expect(runs(partial).map((x) => x[1])).toEqual(["transcribe"]);
  expect(r3.notes).toEqual(["local: speaker labels skipped — diarization model not installed, run `local install`"]);
});
