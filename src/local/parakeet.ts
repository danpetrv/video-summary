import { rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { LocalProvider } from "../asr/presets";
import type { AsrResult } from "../asr/types";
import { oneLine } from "../net";
import { type Cue, type Platform, type RunResult, type Runner, UserError } from "../types";
import { findVulkanLib, planBuilds } from "./builds";
import { assignSpeakers, diarModelReady, labelSpeakers, parseScene } from "./diarize";
import { localPaths } from "./paths";
import { BUILDS, type BuildId } from "./pins";

/** A local run of a long recording on CPU takes a while; HTTP providers keep ASR_TIMEOUT_MS. */
export const LOCAL_TIMEOUT_MS = 2 * 60 * 60_000;

const MAX_CUE_SEC = 30;
const PAUSE_SEC = 1.0;
const SENTENCE_END = /[.?!…]$/;
const UNK = "<unk>";
// Timestamps are centiseconds as floats: 4.1 - 3.1 = 0.9999999999999996 must count as 1.0.
const EPS = 1e-6;
// The Vulkan build with no usable device falls back to CPU in-process and exits 0; only this line
// (printed by the pinned v0.6.1 build when it picks a GPU) tells the two apart.
const VULKAN_DEVICE = /pk::Backend using device: Vulkan\d+/;

export type Word = { w: string; start: number; end: number; speaker?: string };

export type ParakeetDeps = {
  run: Runner; env: Record<string, string | undefined>; home: string;
  platform: Platform; arch: "x64" | "arm64"; exists: (p: string) => boolean;
  clock?: () => number; // ms; times the parakeet-cli run for the speed store (default Date.now)
};

/**
 * parakeet-cli gives words, not segments: group them into cues. A cue ends after a word ending
 * a sentence, before a pause of PAUSE_SEC or more, before a word that would make it longer than MAX_CUE_SEC,
 * and before a word of another speaker (words carry `speaker` only after diarization); the cue gets that speaker.
 */
export function wordsToCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Cue | null = null;
  for (const word of words) {
    // The model has no « »: it emits <unk> there (seen in Russian runs), which markdown would read as a tag.
    const text = word.w.replaceAll(UNK, "").trim();
    if (!text) continue;
    if (cur && (word.start - cur.end >= PAUSE_SEC - EPS || word.end - cur.start > MAX_CUE_SEC + EPS
      || cur.speaker !== word.speaker)) {
      cues.push(cur);
      cur = null;
    }
    if (cur) {
      cur.text += ` ${text}`;
      cur.end = word.end;
    } else {
      cur = { start: word.start, end: word.end, text };
      if (word.speaker !== undefined) cur.speaker = word.speaker;
    }
    if (SENTENCE_END.test(text)) {
      cues.push(cur);
      cur = null;
    }
  }
  if (cur) cues.push(cur);
  return cues;
}

const lastLine = (r: RunResult): string =>
  r.stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? `exit code ${r.code}`;

function parseWords(name: string, stdout: string): Word[] {
  let words: unknown;
  try {
    words = (JSON.parse(stdout) as { words?: unknown }).words;
  } catch {
    words = undefined;
  }
  const ok = Array.isArray(words) && words.every((x) =>
    typeof x?.w === "string" && Number.isFinite(x?.start) && Number.isFinite(x?.end));
  if (!ok) throw new UserError(`${name}: unexpected parakeet-cli output`);
  return words as Word[];
}

/** Builds a run uses: the GPU one only when planned (device not `cpu`) and its parakeet-cli is installed. */
function runBuilds(p: LocalProvider, d: Omit<ParakeetDeps, "run">): { gpu: BuildId | null; cpu: BuildId } {
  const plan = planBuilds({ platform: d.platform, arch: d.arch, vulkanLib: findVulkanLib(d.exists), device: p.device });
  const gpu = plan.gpu && d.exists(localPaths(d.env, d.home).cli(plan.gpu)) ? plan.gpu : null;
  // darwin arm64 has one build: its CPU run is the Metal build with PARAKEET_DEVICE=cpu.
  return { gpu, cpu: plan.cpu ?? plan.gpu! };
}

/** Device a run will start on (the slow-run estimate uses it). */
export const plannedDevice = (p: LocalProvider, d: Omit<ParakeetDeps, "run">): "gpu" | "cpu" =>
  runBuilds(p, d).gpu ? "gpu" : "cpu";

type Timed = RunResult & { elapsedMs: number; pathElapsedMs: number };
type TimedRun = (build: BuildId, args: string[], env?: Record<string, string>) => Promise<Timed>;

/**
 * Runs parakeet-cli of a build with LOCAL_TIMEOUT_MS, timed: the speed store wants the process time of
 * the run that succeeded and, under the planned device, the whole path from this runner's first run
 * (a failed GPU run included). One runner per pass, so each pass has its own path.
 */
function timedRunner(d: ParakeetDeps, cli: (b: BuildId) => string): TimedRun {
  const clock = d.clock ?? Date.now;
  let pathStarted: number | null = null;
  return async (build, args, env) => {
    const started = clock();
    pathStarted ??= started;
    const r = await d.run([cli(build), ...args], env ? { timeoutMs: LOCAL_TIMEOUT_MS, env } : { timeoutMs: LOCAL_TIMEOUT_MS });
    const ended = clock();
    return { ...r, elapsedMs: ended - started, pathElapsedMs: ended - pathStarted };
  };
}

type Diarized = { words: Word[]; diarized: boolean; speakers: number; diarization?: AsrResult["diarization"] };

/**
 * Second pass: `parakeet-cli scene --diar` on the same wav gives speaker segments, the words get speakers.
 * It runs where recognition actually ran: after a GPU run on the GPU build, once more on CPU if that fails
 * (not after a timeout); after a CPU run (GPU failed or found no device) straight on the CPU build.
 * Never fatal: on any problem the words come back unlabeled and `notes` says why.
 */
async function diarizeWords(
  p: LocalProvider, words: Word[], run: TimedRun, a: {
    diarModel: string; wav: string; device: "gpu" | "cpu"; plannedDevice: "gpu" | "cpu";
    gpuBuild: BuildId | null; cpuBuild: BuildId; cpuEnv: Record<string, string> | undefined;
  }, notes: string[],
): Promise<Diarized> {
  const skipped = (why: string): Diarized => {
    notes.push(`${p.name}: speaker labels skipped — ${why}`);
    return { words, diarized: false, speakers: 0 };
  };
  const args = ["scene", "--diar", a.diarModel, "--input", a.wav, "--json"];
  let device = a.device;
  let r = device === "gpu" ? await run(a.gpuBuild!, args) : await run(a.cpuBuild, args, a.cpuEnv);
  if (r.code !== 0 && r.code !== 124 && device === "gpu") {
    const gpuError = lastLine(r);
    device = "cpu";
    r = await run(a.cpuBuild, args, a.cpuEnv);
    if (r.code === 0) notes.push(`${p.name}: GPU diarization failed (${gpuError}), used CPU`);
  }
  if (r.code === 124) return skipped("diarization timed out");
  if (r.code !== 0) return skipped(`diarization failed (${lastLine(r)})`);

  let labeled: { words: Word[]; speakers: number };
  try {
    labeled = labelSpeakers(words, assignSpeakers(words, parseScene(r.stdout)));
  } catch {
    return skipped("unexpected parakeet-cli scene output");
  }
  if (labeled.speakers === 0) return skipped("no speech segments found");
  return {
    ...labeled, diarized: true,
    diarization: { device, plannedDevice: a.plannedDevice, elapsedMs: r.elapsedMs, pathElapsedMs: r.pathElapsedMs },
  };
}

/**
 * ogg -> 16 kHz mono wav (parakeet-cli reads only wav) -> `parakeet-cli transcribe --vad --json` -> words,
 * then with `o.diarize` `parakeet-cli scene --diar` on the same wav -> speaker labels (see diarizeWords) -> cues.
 * GPU first when its build is installed; if that run fails, the CPU run follows and `notes` says so.
 * A Vulkan run that exits 0 without reporting a GPU device ran on CPU: `device` is cpu, `notes` says so.
 * `language` is left null: the caller knows it, the engine does not report it.
 */
export async function transcribeParakeet(
  ogg: string, p: LocalProvider, d: ParakeetDeps, o: { diarize: boolean },
): Promise<AsrResult> {
  const paths = localPaths(d.env, d.home);
  const { gpu: gpuBuild, cpu: cpuBuild } = runBuilds(p, d);
  const cpuEnv = BUILDS[cpuBuild].gpu ? { PARAKEET_DEVICE: "cpu" } : undefined;
  const planned = gpuBuild ? "gpu" : "cpu";
  const wav = `${ogg.replace(/\.[^./]*$/, "")}.wav`;
  const threads = String(Math.min(availableParallelism(), 8));
  const transcribe = timedRunner(d, paths.cli);
  const args = ["transcribe", "--model", paths.model, "--input", wav, "--vad", "--json", "--threads", threads];
  const timedOut = () => new UserError(`${p.name}: timed out after ${LOCAL_TIMEOUT_MS / 1000} s`);

  try {
    const conv = await d.run([
      "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", ogg,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav,
    ]);
    if (conv.code !== 0) {
      throw new UserError(`${p.name}: ffmpeg could not convert audio to wav: ${oneLine(conv.stderr).slice(0, 300)}`);
    }

    const notes: string[] = [];
    let device: "gpu" | "cpu" = "cpu";
    let r: Timed | null = null;
    if (gpuBuild) {
      const g = await transcribe(gpuBuild, args);
      // Two more hours on CPU after a GPU timeout is not worth it.
      if (g.code === 124) throw timedOut();
      if (g.code === 0) {
        r = g;
        // Metal keeps the exit-code rule: its stderr wording is not verified.
        if (gpuBuild.startsWith("linux-vulkan-") && !VULKAN_DEVICE.test(g.stderr)) {
          notes.push(`${p.name}: no GPU device found, ran on CPU — set "device": "cpu" for ${p.name} to skip the GPU attempt`);
        } else {
          device = "gpu";
        }
      } else {
        notes.push(`${p.name}: GPU run failed (${lastLine(g)}), used CPU`);
      }
    }
    if (!r) {
      r = await transcribe(cpuBuild, args, cpuEnv);
      if (r.code === 124) throw timedOut();
      if (r.code !== 0) throw new UserError(`${p.name}: parakeet-cli failed (${lastLine(r)})`);
    }

    const words = parseWords(p.name, r.stdout);
    if (wordsToCues(words).length === 0) throw new UserError(`${p.name}: no speech recognized`);
    let dz: Diarized = { words, diarized: false, speakers: 0 };
    if (o.diarize) {
      if (diarModelReady(paths)) {
        dz = await diarizeWords(p, words, timedRunner(d, paths.cli), {
          diarModel: paths.diarModel, wav, device, plannedDevice: planned, gpuBuild, cpuBuild, cpuEnv,
        }, notes);
      } else {
        notes.push(`${p.name}: speaker labels skipped — diarization model not installed, run \`local install\``);
      }
    }

    const out: AsrResult = {
      cues: wordsToCues(dz.words), provider: p.name, diarized: dz.diarized, speakers: dz.speakers, language: null,
      device, elapsedMs: r.elapsedMs, plannedDevice: planned, pathElapsedMs: r.pathElapsedMs,
    };
    if (dz.diarization) out.diarization = dz.diarization;
    if (notes.length) out.notes = notes;
    return out;
  } finally {
    await rm(wav, { force: true });
  }
}
