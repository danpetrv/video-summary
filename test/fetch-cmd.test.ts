import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type ProviderConfig, DEFAULT_CONFIG } from "../src/config";
import { type FetchDeps, type FetchFlags, fetchCmd } from "../src/fetch-cmd";
import { localPaths } from "../src/local/paths";
import { DIAR_MODEL, MODEL } from "../src/local/pins";
import { readMeta, writeMeta } from "../src/meta";
import { type Fetcher, type Runner, UserError } from "../src/types";

const FX = join(import.meta.dir, "fixtures");
const ytMeta = await Bun.file(join(FX, "ytdlp-meta.json")).json();
const vtt = await Bun.file(join(FX, "manual.en.vtt")).text();
const autoVtt = await Bun.file(join(FX, "auto.en.vtt")).text();
const srt = await Bun.file(join(FX, "sample.ru.srt")).text();
const wxJson = await Bun.file(join(FX, "whisperx-diarized.json")).json();
const verboseJson = await Bun.file(join(FX, "openai-verbose.json")).json();
const parakeetJson = await Bun.file(join(FX, "parakeet-words.json")).text();
const sceneJsonl = await Bun.file(join(FX, "parakeet-scene.jsonl")).text();
const root = mkdtempSync(join(tmpdir(), "vs-fetch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WX: ProviderConfig = { name: "wx", type: "whisperx", url: "http://wx:9000" };
const OWN_URL = "http://own:8000/v1";
const OWN: ProviderConfig = { name: "own", type: "openai-compatible", url: OWN_URL, model: "m" };
const LOCAL: ProviderConfig = { name: "local", type: "local", engine: "parakeet", model: "ultra", device: "auto", diarize: true };

type Env = {
  meta?: object; health?: number; asrStatus?: number; modelsStatus?: number; ownStatus?: number; oggDuration?: string;
  subsExt?: "vtt" | "srt"; cfg?: Partial<Config>; providers?: ProviderConfig[]; autoFail?: boolean;
};
let calls: { cmds: string[][]; urls: string[] };
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(root, "base-"));
  calls = { cmds: [], urls: [] };
});

const outArg = (cmd: string[]) => cmd[cmd.indexOf("-o") + 1]!;
function deps(env: Env = {}): FetchDeps {
  const run: Runner = async (cmd) => {
    calls.cmds.push(cmd);
    if (cmd[0] === "yt-dlp" && cmd.includes("--dump-single-json"))
      return { code: 0, stdout: JSON.stringify(env.meta ?? ytMeta), stderr: "" };
    if (cmd[0] === "yt-dlp" && cmd.includes("--write-auto-subs") && env.autoFail)
      return { code: 1, stdout: "", stderr: "ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests\n" };
    if (cmd[0] === "yt-dlp" && (cmd.includes("--write-subs") || cmd.includes("--write-auto-subs"))) {
      const lang = cmd[cmd.indexOf("--sub-langs") + 1];
      const ext = env.subsExt ?? "vtt";
      const body = cmd.includes("--write-auto-subs") ? autoVtt : ext === "vtt" ? vtt : srt;
      writeFileSync(outArg(cmd).replace("%(ext)s", `${lang}.${ext}`), body);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "yt-dlp") {
      writeFileSync(outArg(cmd).replace("%(ext)s", "webm"), "audio");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "ffmpeg") {
      writeFileSync(cmd.at(-1)!, Buffer.alloc(1000));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "ffprobe")
      return { code: 0, stdout: cmd.at(-1)!.endsWith(".ogg") ? (env.oggDuration ?? "213\n") : "120.5\n", stderr: "" };
    throw new Error(`unexpected command ${cmd.join(" ")}`);
  };
  const fetch: Fetcher = async (url) => {
    calls.urls.push(url);
    if (url.endsWith("/health")) return new Response("{}", { status: env.health ?? 200 });
    if (url.includes("/asr?")) return new Response(JSON.stringify(env.asrStatus ? { detail: "boom" } : wxJson), { status: env.asrStatus ?? 200 });
    if (url === `${OWN_URL}/models`) return new Response("{}", { status: env.modelsStatus ?? 200 });
    if (url === `${OWN_URL}/audio/transcriptions`) {
      return new Response(JSON.stringify(env.ownStatus ? { error: { message: "down" } } : verboseJson), { status: env.ownStatus ?? 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const cfg: Config = { ...DEFAULT_CONFIG, outputDir: base, providers: env.providers ?? [WX, OWN], ...env.cfg };
  return {
    run, fetch, cfg, env: {}, now: new Date(2026, 9, 2, 12), cwd: root, home: root,
    platform: "linux", arch: "x64", exists: () => false, has: () => false,
  };
}
const flags: FetchFlags = { diarize: true };
const ownCalled = () => calls.urls.includes(`${OWN_URL}/audio/transcriptions`);
const ffmpegRates = () => calls.cmds.filter((c) => c[0] === "ffmpeg").map((c) => c[c.indexOf("-b:a") + 1]);
const noMeta = { ...ytMeta, subtitles: { de: [] } };
const URL1 = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const asrCall = () => new URL(calls.urls.find((u) => u.includes("/asr?"))!);
const hasFormatDownload = () => calls.cmds.some((c) => c[0] === "yt-dlp" && c.includes("-f"));

test("URL with manual subs -> youtube-manual-subs, no ASR, url = webpage_url", async () => {
  const r = await fetchCmd("https://youtu.be/dQw4w9WgXcQ?t=42&list=PL1", flags, deps());
  expect(r.source).toBe("youtube-manual-subs");
  expect(r.asr_provider).toBeNull();
  expect(r.url).toBe(ytMeta.webpage_url);
  expect(calls.urls).toEqual([]);
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr.startsWith(`# ${ytMeta.title}\n\n[00:00:`)).toBe(true);
  const m = (await readMeta(r.dir))!;
  expect([m.source_key, m.url, m.language, m.duration, m.diarized]).toEqual(["Youtube:dQw4w9WgXcQ", ytMeta.webpage_url, "en", 213, false]);
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
  expect(r.summary_path).toBe(join(r.dir, "summary.md"));
});

test("thumbnail from yt-dlp is kept in meta for the Readeck cover; none -> null", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: { ...ytMeta, thumbnail: "https://i.ytimg.com/vi/x/maxresdefault.jpg" } }));
  expect((await readMeta(r.dir))!.thumbnail).toBe("https://i.ytimg.com/vi/x/maxresdefault.jpg");
  const r2 = await fetchCmd(URL1, { ...flags, force: true }, deps({ meta: { ...ytMeta, thumbnail: undefined } }));
  expect((await readMeta(r2.dir))!.thumbnail).toBeNull();
});

test("URL without manual subs -> audio -> whisperx with diarization", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect([r.source, r.asr_provider, r.diarized, r.speakers]).toEqual(["asr", "wx", true, 2]);
  expect([asrCall().searchParams.get("diarize"), asrCall().searchParams.get("language")]).toEqual(["true", "en"]);
  expect(await Bun.file(r.transcript_path).text()).toContain("**Speaker 2:** Привет! Начнём с вопросов.");
});

test("URL without manual subs, whisperx 502 -> own openai-compatible server", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, health: 502 }));
  expect([r.asr_provider, r.diarized]).toEqual(["own", false]);
  expect((await readMeta(r.dir))!.asr_provider).toBe("own");
});

test("openai-compatible whose /models does not answer is skipped before any download", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, health: 502, modelsStatus: 404 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("no ASR provider fits: wx: not reachable; own: not reachable");
  expect(hasFormatDownload()).toBe(false);
});

test("local provider not installed -> skipped before any download with the `local install` hint", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, providers: [LOCAL, WX], health: 502 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("no ASR provider fits: local: local engine not installed — run `local install`; wx: not reachable");
  expect(hasFormatDownload()).toBe(false);
});

// localDeps installs no diarization model: with speaker labels on, the local run says so.
const NO_DIAR_MODEL = "local: speaker labels skipped — diarization model not installed, run `local install`";

/** A successful parakeet-cli run; the Vulkan build reports the GPU it used, as the real one does. */
const parakeetOk = (bin: string, cmd: string[] = []) => ({
  code: 0, stdout: cmd.includes("scene") ? sceneJsonl : parakeetJson,
  stderr: bin.includes("vulkan") && !cmd.includes("scene") ? "[parakeet] pk::Backend using device: Vulkan0\n" : "",
});

type CliAnswer = { code: number; stdout: string; stderr: string };

/**
 * Fetch deps on a machine where the local engine is installed (CPU build, plus the Vulkan
 * build and library when `gpu`); `cli` answers parakeet-cli runs by binary path.
 */
function localDeps(env: Env, o: { gpu?: boolean; diar?: boolean; cli?: (bin: string, cmd: string[]) => CliAnswer } = {}): FetchDeps {
  const dir = mkdtempSync(join(root, "local-"));
  const xdg = { XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state") };
  const paths = localPaths(xdg, root);
  for (const b of o.gpu ? ["linux-vulkan-x64", "linux-cpu-x64"] as const : ["linux-cpu-x64"] as const) {
    mkdirSync(paths.binDir(b), { recursive: true });
    writeFileSync(paths.cli(b), "");
  }
  mkdirSync(join(paths.model, ".."), { recursive: true });
  writeFileSync(paths.model, "");
  truncateSync(paths.model, MODEL.size); // sparse
  if (o.diar) {
    writeFileSync(paths.diarModel, "");
    truncateSync(paths.diarModel, DIAR_MODEL.size); // sparse
  }
  const d = deps(env);
  const run: Runner = async (cmd, opts) => {
    if (!cmd[0]!.endsWith("/parakeet-cli")) return d.run(cmd, opts);
    calls.cmds.push(cmd);
    return (o.cli ?? parakeetOk)(cmd[0]!, cmd);
  };
  const vulkanLib = "/usr/lib/x86_64-linux-gnu/libvulkan.so.1";
  return { ...d, run, env: xdg, exists: (p: string) => (p === vulkanLib ? !!o.gpu : p.startsWith(dir) && existsSync(p)) };
}

test("local provider end to end: fetch with [local] -> source asr, asr_provider local, transcript from the words", async () => {
  const r = await fetchCmd(URL1, flags, localDeps({ meta: noMeta, providers: [LOCAL] }));
  expect([r.source, r.asr_provider, r.diarized, r.speakers, r.asr_failed]).toEqual(["asr", "local", false, 0, [NO_DIAR_MODEL]]);
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr).toContain("Погнали, привет.");
  expect(tr).toContain("что думает чат?");
  expect(calls.urls).toEqual([]);
  expect((await readMeta(r.dir))!.asr_provider).toBe("local");
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("local GPU fallback note appears in asr_failed", async () => {
  const d = localDeps({ meta: noMeta, providers: [LOCAL] }, {
    gpu: true,
    cli: (bin) => bin.includes("vulkan")
      ? { code: 1, stdout: "", stderr: "ggml_vulkan: Found 1 Vulkan devices\nerror: vk::Device::createBuffer: ErrorOutOfDeviceMemory\n" }
      : { code: 0, stdout: parakeetJson, stderr: "" },
  });
  const r = await fetchCmd(URL1, flags, d);
  expect(r.asr_provider).toBe("local");
  expect(r.asr_failed).toEqual(["local: GPU run failed (error: vk::Device::createBuffer: ErrorOutOfDeviceMemory), used CPU", NO_DIAR_MODEL]);
});

test("local no speech -> next provider (whisperx) is used, asr_failed names local", async () => {
  const empty = JSON.stringify({ text: "", frame_sec: 0.08, words: [], tokens: [] });
  const d = localDeps({ meta: noMeta, providers: [LOCAL, WX] }, { cli: () => ({ code: 0, stdout: empty, stderr: "" }) });
  const r = await fetchCmd(URL1, flags, d);
  expect(r.asr_provider).toBe("wx");
  expect(r.asr_failed).toEqual(["local: no speech recognized"]);
});

const speedsOf = (d: FetchDeps) => {
  const file = localPaths(d.env, d.home).speedFile;
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};
const SLOW = "no ASR provider fits: local: ~12 min on CPU (measured speed 8x); add --accept-slow to wait";

test("90-min video, only local, CPU default speed -> UserError with add --accept-slow before any audio download", async () => {
  const d = localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL] });
  const err = await fetchCmd(URL1, flags, d).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(SLOW);
  expect(hasFormatDownload()).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
  // with whisperx next in the list it is used instead, nothing reported as failed
  const r = await fetchCmd(URL1, flags, localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL, WX] }));
  expect([r.asr_provider, r.asr_failed]).toEqual(["wx", undefined]);
});

test("90-min video, only local, --accept-slow -> proceeds with local", async () => {
  const r = await fetchCmd(URL1, { ...flags, acceptSlow: true }, localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL] }));
  expect([r.source, r.asr_provider]).toEqual(["asr", "local"]);
});

test("slow gate uses the measured speed from speed.json and the GPU when it will run", async () => {
  // a 30-min video at a measured 2x on CPU -> 15 min (the 8x default would give ~4 min)
  const d = localDeps({ meta: { ...noMeta, duration: 1800 }, providers: [LOCAL] });
  const file = localPaths(d.env, d.home).speedFile;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ "parakeet:ultra:cpu": 2, "parakeet:ultra:gpu": 100 }));
  const err = await fetchCmd(URL1, flags, d).catch((e) => e);
  expect(err.message).toBe("no ASR provider fits: local: ~15 min on CPU (measured speed 2x); add --accept-slow to wait");
  // 90 min on the GPU build at the default 60x is 1.5 min: not gated
  const r = await fetchCmd(URL1, flags, localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL] }, { gpu: true }));
  expect(r.asr_provider).toBe("local");
});

test("unknown duration: the slow gate applies after compression, by the real duration", async () => {
  const meta = { ...noMeta, extractor_key: "Generic", id: "x4", duration: null };
  const err = await fetchCmd(URL1, flags, localDeps({ meta, oggDuration: "5400\n", providers: [LOCAL] })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(SLOW);
  expect(calls.cmds.some((c) => c[0]!.endsWith("/parakeet-cli"))).toBe(false);
});

/**
 * Local deps on a simulated clock: every ffmpeg run takes 7 s, a parakeet-cli run on the Vulkan
 * build `gpuMs`, on the CPU build `cpuMs`; `cli` answers by binary path as in localDeps.
 */
function timedDeps(env: Env, o: {
  gpuMs: number; cpuMs: number; diar?: boolean; cli?: (bin: string, cmd: string[]) => CliAnswer;
  /** per-pass duration overrides for the scene (diarization) runs */
  sceneGpuMs?: number; sceneCpuMs?: number;
}) {
  let now = 0;
  const d = localDeps(env, {
    gpu: true,
    ...(o.diar ? { diar: true } : {}),
    cli: (bin, cmd) => {
      const scene = cmd.includes("scene");
      const gpu = bin.includes("vulkan");
      now += scene ? (gpu ? o.sceneGpuMs : o.sceneCpuMs) ?? (gpu ? o.gpuMs : o.cpuMs) : gpu ? o.gpuMs : o.cpuMs;
      return (o.cli ?? parakeetOk)(bin, cmd);
    },
  });
  const run: Runner = async (cmd, opts) => {
    if (cmd[0] === "ffmpeg") now += 7_000;
    return d.run(cmd, opts);
  };
  return { ...d, run, clock: () => now };
}

test("after a local run speed.json is updated under the device that actually ran, timed by that run only", async () => {
  // 213 s of audio in a 10 s GPU run -> 21.3x; the ffmpeg time does not count
  const gpu = timedDeps({ meta: noMeta, providers: [LOCAL] }, { gpuMs: 10_000, cpuMs: 99_000 });
  await fetchCmd(URL1, flags, gpu);
  expect(speedsOf(gpu)).toEqual({ "parakeet:ultra:gpu": 21.3 });

  // GPU fails after 50 s, CPU recognizes in 20 s -> the cpu key gets 213 / 20, not 213 / 70; the gpu key
  // (what the slow gate reads on this machine) gets the whole path, 213 / 70
  const fallback = timedDeps({ meta: noMeta, providers: [LOCAL] }, {
    gpuMs: 50_000, cpuMs: 20_000,
    cli: (bin) => bin.includes("vulkan") ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: parakeetJson, stderr: "" },
  });
  await fetchCmd(URL1, { ...flags, force: true }, fallback);
  expect(speedsOf(fallback)).toEqual({ "parakeet:ultra:cpu": 10.65, "parakeet:ultra:gpu": 213 / 70 });

  // the Vulkan build finds no GPU device and recognizes on CPU in 20 s (exit 0): both keys get 213 / 20
  const noDevice = timedDeps({ meta: noMeta, providers: [LOCAL] }, {
    gpuMs: 20_000, cpuMs: 99_000, cli: () => ({ code: 0, stdout: parakeetJson, stderr: "ggml_vulkan: No devices found.\n" }),
  });
  const nd = await fetchCmd(URL1, { ...flags, force: true }, noDevice);
  expect(nd.asr_failed).toEqual(['local: no GPU device found, ran on CPU — set "device": "cpu" for local to skip the GPU attempt', NO_DIAR_MODEL]);
  expect(speedsOf(noDevice)).toEqual({ "parakeet:ultra:cpu": 10.65, "parakeet:ultra:gpu": 10.65 });

  // device cpu in config: only the cpu key
  const cpuOnly = timedDeps({ meta: noMeta, providers: [{ ...LOCAL, device: "cpu" } as ProviderConfig] }, { gpuMs: 1, cpuMs: 20_000 });
  await fetchCmd(URL1, { ...flags, force: true }, cpuOnly);
  expect(speedsOf(cpuOnly)).toEqual({ "parakeet:ultra:cpu": 10.65 });

  // a failed local run records nothing; neither does the non-local provider that took over
  const empty = JSON.stringify({ text: "", frame_sec: 0.08, words: [], tokens: [] });
  const failed = timedDeps({ meta: noMeta, providers: [LOCAL, WX] }, {
    gpuMs: 10_000, cpuMs: 10_000, cli: () => ({ code: 0, stdout: empty, stderr: "" }),
  });
  const r = await fetchCmd(URL1, { ...flags, force: true }, failed);
  expect(r.asr_provider).toBe("wx");
  expect(speedsOf(failed)).toBeNull();
});

const SLOW_DIAR =
  "no ASR provider fits: local: ~17 min on CPU with speaker labels (~12 without); add --accept-slow to wait";
const SLOW_DIAR_SHORT = (m: number, w: number) =>
  `no ASR provider fits: local: ~${m} min on CPU with speaker labels (~${w} without); add --accept-slow to wait, or --no-diarize to skip speaker labels`;

test("90-min video, local with the diarization model, CPU defaults -> the gate shows both numbers", async () => {
  // 5400 s: recognition 11.25 min at 8x + diarization 5.6 min at 16x = 16.9 -> ~17; without ~12 (still over 10)
  const d = localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL] }, { diar: true });
  const err = await fetchCmd(URL1, flags, d).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(SLOW_DIAR);
  expect(hasFormatDownload()).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
  // a 60-min video: 7.5 + 3.75 = 11.25 -> ~12, without 7.5 -> ~8: the --no-diarize hint
  const e2 = await fetchCmd(URL1, flags, localDeps({ meta: { ...noMeta, duration: 3600 }, providers: [LOCAL] }, { diar: true })).catch((e) => e);
  expect(e2.message).toBe(SLOW_DIAR_SHORT(12, 8));
});

test("slow gate: --no-diarize or a missing diarization model -> the v0.4 text", async () => {
  const meta = { ...noMeta, duration: 5400 };
  const off = await fetchCmd(URL1, { ...flags, diarize: false }, localDeps({ meta, providers: [LOCAL] }, { diar: true })).catch((e) => e);
  expect(off.message).toBe(SLOW);
  const noModel = await fetchCmd(URL1, flags, localDeps({ meta, providers: [LOCAL] })).catch((e) => e);
  expect(noModel.message).toBe(SLOW);
  const cfgOff = { ...LOCAL, diarize: false } as ProviderConfig;
  const providerOff = await fetchCmd(URL1, flags, localDeps({ meta, providers: [cfgOff] }, { diar: true })).catch((e) => e);
  expect(providerOff.message).toBe(SLOW);
});

test("slow gate: a model of the wrong size does not count as diarization", async () => {
  const d = localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL] }, { diar: true });
  truncateSync(localPaths(d.env, d.home).diarModel, DIAR_MODEL.size - 1);
  const err = await fetchCmd(URL1, flags, d).catch((e) => e);
  expect(err.message).toBe(SLOW);
});

test("slow gate uses the measured diarization speed from speed.json", async () => {
  // 30 min: recognition 30 min / 30x = 1 min, diarization at a measured 2x = 15 min -> ~16 total, ~1 without
  const d = localDeps({ meta: { ...noMeta, duration: 1800 }, providers: [LOCAL] }, { diar: true });
  const file = localPaths(d.env, d.home).speedFile;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ "parakeet:ultra:cpu": 30, "parakeet:diar:cpu": 2 }));
  const err = await fetchCmd(URL1, flags, d).catch((e) => e);
  expect(err.message).toBe(SLOW_DIAR_SHORT(16, 1));
});

test("with --accept-slow the 90-min local run with speaker labels proceeds", async () => {
  const r = await fetchCmd(URL1, { ...flags, acceptSlow: true }, localDeps({ meta: { ...noMeta, duration: 5400 }, providers: [LOCAL] }, { diar: true }));
  expect([r.asr_provider, r.diarized, r.speakers]).toEqual(["local", true, 2]);
});

test("diarization speed is recorded under parakeet:diar:<device> of the pass that ran", async () => {
  // GPU: recognition 10 s, scene 5 s -> 213/10 and 213/5
  const gpu = timedDeps({ meta: noMeta, providers: [LOCAL] }, { gpuMs: 10_000, cpuMs: 99_000, sceneGpuMs: 5_000, diar: true });
  const r = await fetchCmd(URL1, flags, gpu);
  expect([r.diarized, r.asr_failed]).toEqual([true, undefined]);
  expect(speedsOf(gpu)).toEqual({ "parakeet:ultra:gpu": 21.3, "parakeet:diar:gpu": 42.6 });

  // device cpu: only cpu keys
  const cpu = timedDeps({ meta: noMeta, providers: [{ ...LOCAL, device: "cpu" } as ProviderConfig] }, {
    gpuMs: 1, cpuMs: 20_000, sceneCpuMs: 10_000, diar: true,
  });
  await fetchCmd(URL1, { ...flags, force: true }, cpu);
  expect(speedsOf(cpu)).toEqual({ "parakeet:ultra:cpu": 10.65, "parakeet:diar:cpu": 21.3 });

  // planned GPU, recognition on GPU (10 s), diarization fails on GPU (30 s) and succeeds on CPU (5 s):
  // cpu key = 213/5, gpu key (the planned one) = the whole diarization path, 213/35
  const fallback = timedDeps({ meta: noMeta, providers: [LOCAL] }, {
    gpuMs: 10_000, cpuMs: 99_000, sceneGpuMs: 30_000, sceneCpuMs: 5_000, diar: true,
    cli: (bin, cmd) => cmd.includes("scene") && bin.includes("vulkan") ? { code: 1, stdout: "", stderr: "boom" } : parakeetOk(bin, cmd),
  });
  const fr = await fetchCmd(URL1, { ...flags, force: true }, fallback);
  expect(fr.diarized).toBe(true);
  expect(speedsOf(fallback)).toEqual({ "parakeet:ultra:gpu": 21.3, "parakeet:diar:cpu": 42.6, "parakeet:diar:gpu": 213 / 35 });

  // a failed diarization records no diarization speed
  const bad = timedDeps({ meta: noMeta, providers: [LOCAL] }, {
    gpuMs: 10_000, cpuMs: 99_000, sceneGpuMs: 5_000, diar: true,
    cli: (bin, cmd) => cmd.includes("scene") ? { code: 1, stdout: "", stderr: "boom" } : parakeetOk(bin, cmd),
  });
  await fetchCmd(URL1, { ...flags, force: true }, bad);
  expect(speedsOf(bad)).toEqual({ "parakeet:ultra:gpu": 21.3 });
});

test("local provider and a video in an unsupported language -> the next provider, before any download", async () => {
  const r = await fetchCmd(URL1, flags, localDeps({ meta: { ...noMeta, language: "ja" }, providers: [LOCAL, WX] }));
  expect([r.asr_provider, r.asr_failed]).toEqual(["wx", undefined]);
  expect(calls.cmds.some((c) => c[0]!.endsWith("/parakeet-cli"))).toBe(false);
  const err = await fetchCmd(URL1, { ...flags, force: true }, localDeps({ meta: { ...noMeta, language: "ja" }, providers: [LOCAL] }))
    .catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("no ASR provider fits: local: language ja not supported");
});

test("local file via ~ with sidecar .srt -> sidecar-subs, no ASR", async () => {
  mkdirSync(join(root, "rec"), { recursive: true });
  writeFileSync(join(root, "rec/Встреча 1.mp4"), "");
  writeFileSync(join(root, "rec/Встреча 1.srt"), srt);
  const r = await fetchCmd("~/rec/Встреча 1.mp4", flags, deps());
  expect([r.source, r.url, r.asr_provider]).toEqual(["sidecar-subs", null, null]);
  expect(calls.urls).toEqual([]);
  const m = (await readMeta(r.dir))!;
  expect([m.source_key, m.path, m.title, m.duration]).toEqual([
    `file:${join(root, "rec/Встреча 1.mp4")}`, join(root, "rec/Встреча 1.mp4"), "Встреча 1", 120.5,
  ]);
});

test("--allow-cloud is accepted and ignored: a local file goes to the own server with or without it", async () => {
  writeFileSync(join(root, "solo.m4a"), "");
  const r = await fetchCmd("solo.m4a", flags, deps({ health: 502 }));
  expect(r.asr_provider).toBe("own");
  // flags from an older caller still carrying allowCloud change nothing
  const legacy = { diarize: true, allowCloud: false, force: true } as FetchFlags;
  expect((await fetchCmd("solo.m4a", legacy, deps({ health: 502 }))).asr_provider).toBe("own");
});

test("--no-diarize -> whisperx gets diarize=false", async () => {
  await fetchCmd(URL1, { diarize: false }, deps({ meta: noMeta }));
  expect(asrCall().searchParams.get("diarize")).toBe("false");
});

test("rerun: same folder, summary.md untouched, readeck_bookmark_id kept", async () => {
  const first = await fetchCmd(URL1, flags, deps());
  writeFileSync(first.summary_path, "my summary");
  await writeMeta(first.dir, { ...(await readMeta(first.dir))!, readeck_bookmark_id: "bk1" });
  const again = await fetchCmd("https://youtu.be/dQw4w9WgXcQ", flags, deps());
  expect(again.dir).toBe(first.dir);
  expect(again.summary_exists).toBe(true);
  expect(await Bun.file(again.summary_path).text()).toBe("my summary");
  expect((await readMeta(again.dir))!.readeck_bookmark_id).toBe("bk1");
  expect(readdirSync(base).length).toBe(1);
});

test("whisperx up but /asr 502 (GPU busy) -> the next provider, the failure is reported in asr_failed", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 502 }));
  expect(r.asr_provider).toBe("own");
  expect(r.asr_failed).toEqual(["wx: whisperx responded 502: {\"detail\":\"boom\"}"]);
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
  // a repeated fetch returns the stored result: the old failure is not reported again
  expect((await fetchCmd(URL1, flags, deps({ meta: noMeta }))).asr_failed).toBeUndefined();
});

test("success on the first provider -> no asr_failed", async () => {
  expect((await fetchCmd(URL1, flags, deps({ meta: noMeta }))).asr_failed).toBeUndefined();
});

test("whisperx /asr fails and the other provider is down -> UserError with both reasons", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500, modelsStatus: 503 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe('speech recognition failed: wx: whisperx responded 500: {"detail":"boom"}; ' +
    "no other provider fits: own: not reachable");
  expect(ownCalled()).toBe(false);
});

test("the only provider fails -> UserError (not an unexpected error) naming it", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500, providers: [WX] })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe('speech recognition failed: wx: whisperx responded 500: {"detail":"boom"}');
});

test("every provider fails -> UserError listing each, .work/audio.ogg stays; retry reuses it", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500, ownStatus: 500 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe('speech recognition failed: wx: whisperx responded 500: {"detail":"boom"}; ' +
    'own responded 500: {"error":{"message":"down"}}');
  const dir = join(base, readdirSync(base)[0]!);
  expect(existsSync(join(dir, ".work/audio.ogg"))).toBe(true);
  expect(existsSync(join(dir, ".work/src.webm"))).toBe(false);

  calls.cmds = [];
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(calls.cmds.some((c) => c[0] === "ffmpeg" || c.includes("bestaudio/best"))).toBe(false);
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("missing file -> UserError 'file not found: <path>'", async () => {
  const err = await fetchCmd("nope.mp4", flags, deps()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(`file not found: ${join(root, "nope.mp4")}`);
});

test("truncated audio.ogg from an interrupted run is not reused", async () => {
  await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500, ownStatus: 500 })).catch(() => {});
  calls.cmds = [];
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, oggDuration: "60\n" }));
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(true);
  expect(r.asr_provider).toBe("wx");
});

test("regional language en-US goes to ASR as en", async () => {
  await fetchCmd(URL1, flags, deps({ meta: { ...noMeta, language: "en-US" } }));
  expect(asrCall().searchParams.get("language")).toBe("en");
});

test("rerun after successful ASR does not download/transcribe again; --force does", async () => {
  const first = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  writeFileSync(first.summary_path, "summary");
  calls.cmds = [];
  calls.urls = [];
  const again = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(calls.urls).toEqual([]);
  expect(calls.cmds.filter((c) => !c.includes("--dump-single-json"))).toEqual([]);
  expect([again.dir, again.source, again.asr_provider, again.summary_exists, again.diarized]).toEqual([first.dir, "asr", "wx", true, true]);
  await fetchCmd(URL1, { ...flags, force: true }, deps({ meta: noMeta }));
  expect(calls.urls.some((u) => u.includes("/asr?"))).toBe(true);
});

test("subtitles arriving as srt are parsed as srt", async () => {
  const r = await fetchCmd(URL1, flags, deps({ subsExt: "srt" }));
  expect(await Bun.file(r.transcript_path).text()).toContain("Добрый вечер, это стрим про миграцию.");
});

test("compression is always 32k (6805 s stream)", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: { ...noMeta, duration: 6805 }, oggDuration: "6805\n", providers: [OWN] }));
  expect(ffmpegRates()).toEqual(["32k"]);
  expect(r.asr_provider).toBe("own");
});

test("auto captions: manual+auto, no manual -> youtube-auto-subs, no ASR, rolling dupes removed", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, cfg: { subtitles: "manual+auto" } }));
  expect(r.source).toBe("youtube-auto-subs");
  expect(calls.urls).toEqual([]);
  expect(hasFormatDownload()).toBe(false);
  const sub = calls.cmds.find((c) => c.includes("--write-auto-subs"))!;
  expect(sub[sub.indexOf("--sub-langs") + 1]).toBe("en-orig");
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr.match(/this is Bobby Bobby has to do a report/g)?.length).toBe(1);
});

test("auto captions off (manual) -> ASR even if auto exists", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(r.source).toBe("asr");
  expect(calls.cmds.some((c) => c.includes("--write-auto-subs"))).toBe(false);
});

test("provider is chosen BEFORE download: none fits -> UserError, no yt-dlp -f, no ffmpeg", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, health: 502, providers: [WX] })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("no ASR provider fits: wx: not reachable");
  expect(hasFormatDownload()).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
});

test("after compression src.* is removed; .work removed after success", async () => {
  await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500, ownStatus: 500 })).catch(() => {});
  const dir = join(base, readdirSync(base)[0]!);
  expect(readdirSync(join(dir, ".work")).filter((f) => f.startsWith("src."))).toEqual([]);
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("manual subs from a non-YouTube extractor -> manual-subs", async () => {
  const r = await fetchCmd("https://vimeo.com/1", flags, deps({ meta: { ...ytMeta, extractor_key: "Vimeo", id: "1" } }));
  expect(r.source).toBe("manual-subs");
});

test("link without scheme -> 'file not found: ... — if this is a link, add https://'", async () => {
  const err = await fetchCmd("youtube.com/watch?v=x", flags, deps()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(`file not found: ${join(root, "youtube.com/watch?v=x")} — if this is a link, add https://`);
});

test("retry with another provider reuses the leftover audio.ogg as is", async () => {
  const meta = { ...noMeta, duration: 6805 };
  await fetchCmd(URL1, flags, deps({ meta, oggDuration: "6805\n", asrStatus: 500, ownStatus: 500 })).catch(() => {});
  calls.cmds = [];
  const r = await fetchCmd(URL1, flags, deps({ meta, oggDuration: "6805\n", health: 502 }));
  expect(ffmpegRates()).toEqual([]);
  expect(hasFormatDownload()).toBe(false);
  expect(r.asr_provider).toBe("own");
});

test("summaryLanguage ru -> sidecar a.ru.srt preferred over a.en.srt", async () => {
  mkdirSync(join(root, "sc"), { recursive: true });
  writeFileSync(join(root, "sc/a.mp4"), "");
  writeFileSync(join(root, "sc/a.en.srt"), "1\n00:00:00,000 --> 00:00:02,000\nEnglish line\n");
  writeFileSync(join(root, "sc/a.ru.srt"), srt);
  const r = await fetchCmd("sc/a.mp4", flags, deps({ cfg: { summaryLanguage: "ru" } }));
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr).toContain("Добрый вечер");
  expect(tr).not.toContain("English line");
});

test("outputDir from config with ~ is expanded", async () => {
  const d = deps({ cfg: { outputDir: "~/out-tilde" } });
  const r = await fetchCmd(URL1, flags, d);
  expect(r.dir.startsWith(join(root, "out-tilde"))).toBe(true);
});

test("unknown duration, no provider available -> UserError before any download", async () => {
  const meta = { ...noMeta, extractor_key: "Generic", id: "x2", duration: null };
  const err = await fetchCmd(URL1, flags, deps({ meta, providers: [OWN], modelsStatus: 502 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("no ASR provider fits: own: not reachable");
  expect(hasFormatDownload()).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
});

test("unknown duration (Generic link): compressed once at 32k, own server used", async () => {
  const meta = { ...noMeta, extractor_key: "Generic", id: "x3", duration: null };
  const r = await fetchCmd(URL1, flags, deps({ meta, oggDuration: "6805\n", providers: [OWN] }));
  expect(ffmpegRates()).toEqual(["32k"]);
  expect(r.asr_provider).toBe("own");
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("#3: auto-caption download fails → falls back to speech recognition", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, cfg: { subtitles: "manual+auto" }, autoFail: true }));
  expect([r.source, r.asr_provider]).toEqual(["asr", "wx"]);
  expect(hasFormatDownload()).toBe(true);
});

test("#3: auto captions fail and no ASR provider → one error naming both reasons", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, cfg: { subtitles: "manual+auto" }, providers: [], autoFail: true }))
    .catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("auto captions could not be downloaded");
  expect(err.message).toContain("HTTP Error 429");
  expect(err.message).toContain("no ASR providers configured");
});

test("config warnings from deps are returned by fetch, also on the early 'text already exists' return", async () => {
  const warnings = ['providers[0] "own": now treated as your own server — local files are sent to it without asking'];
  const r = await fetchCmd(URL1, flags, { ...deps(), warnings });
  expect(r.warnings).toEqual(warnings);
  const again = await fetchCmd(URL1, flags, { ...deps(), warnings });
  expect(again.dir).toBe(r.dir);
  expect(again.warnings).toEqual(warnings);
});

test("no config warnings -> no `warnings` key (absent and empty)", async () => {
  const r = await fetchCmd(URL1, flags, deps());
  expect("warnings" in r).toBe(false);
  const again = await fetchCmd(URL1, flags, { ...deps(), warnings: [] });
  expect("warnings" in again).toBe(false);
  const forced = await fetchCmd(URL1, { ...flags, force: true }, { ...deps(), warnings: [] });
  expect("warnings" in forced).toBe(false);
});

test("warnings sit next to asr_failed without replacing it", async () => {
  const warnings = ["w"];
  const r = await fetchCmd(URL1, flags, { ...deps({ meta: noMeta, asrStatus: 500 }), warnings });
  expect(r.source).toBe("asr");
  expect(r.asr_failed?.length).toBeGreaterThan(0);
  expect(r.warnings).toEqual(warnings);
});
