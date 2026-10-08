import { rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { LocalProvider } from "../asr/presets";
import type { AsrResult } from "../asr/types";
import { oneLine } from "../net";
import { type Cue, type Platform, type RunResult, type Runner, UserError } from "../types";
import { findVulkanLib, planBuilds } from "./builds";
import { localPaths } from "./paths";
import { BUILDS, type BuildId } from "./pins";

/** A local run of a long recording on CPU takes a while; HTTP providers keep ASR_TIMEOUT_MS. */
export const LOCAL_TIMEOUT_MS = 2 * 60 * 60_000;

const MAX_CUE_SEC = 30;
const PAUSE_SEC = 1.0;
const SENTENCE_END = /[.?!…]$/;
// Timestamps are centiseconds as floats: 4.1 - 3.1 = 0.9999999999999996 must count as 1.0.
const EPS = 1e-6;

export type Word = { w: string; start: number; end: number };

export type ParakeetDeps = {
  run: Runner; env: Record<string, string | undefined>; home: string;
  platform: Platform; arch: "x64" | "arm64"; exists: (p: string) => boolean;
};

/**
 * parakeet-cli gives words, not segments: group them into cues. A cue ends after a word ending
 * a sentence, before a pause of PAUSE_SEC or more, and before a word that would make it longer than MAX_CUE_SEC.
 */
export function wordsToCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Cue | null = null;
  for (const word of words) {
    const text = word.w.trim();
    if (!text) continue;
    if (cur && (word.start - cur.end >= PAUSE_SEC - EPS || word.end - cur.start > MAX_CUE_SEC + EPS)) {
      cues.push(cur);
      cur = null;
    }
    if (cur) {
      cur.text += ` ${text}`;
      cur.end = word.end;
    } else {
      cur = { start: word.start, end: word.end, text };
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

/**
 * ogg -> 16 kHz mono wav (parakeet-cli reads only wav) -> `parakeet-cli --vad --json` -> cues.
 * GPU first when its build is installed; if that run fails, the CPU run follows and `notes` says so.
 * `language` is left null: the caller knows it, the engine does not report it.
 */
export async function transcribeParakeet(ogg: string, p: LocalProvider, d: ParakeetDeps): Promise<AsrResult> {
  const paths = localPaths(d.env, d.home);
  const plan = planBuilds({ platform: d.platform, arch: d.arch, vulkanLib: findVulkanLib(d.exists), device: p.device });
  // darwin arm64 has one build: its CPU run is the Metal build with PARAKEET_DEVICE=cpu.
  const cpuBuild: BuildId = plan.cpu ?? plan.gpu!;
  const gpuBuild = plan.gpu && d.exists(paths.cli(plan.gpu)) ? plan.gpu : null;
  const wav = `${ogg.replace(/\.[^./]*$/, "")}.wav`;
  const threads = String(Math.min(availableParallelism(), 8));

  const transcribe = (build: BuildId, env?: Record<string, string>) =>
    d.run(
      [paths.cli(build), "transcribe", "--model", paths.model, "--input", wav, "--vad", "--json", "--threads", threads],
      env ? { timeoutMs: LOCAL_TIMEOUT_MS, env } : { timeoutMs: LOCAL_TIMEOUT_MS },
    );
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
    let r: RunResult | null = null;
    if (gpuBuild) {
      const g = await transcribe(gpuBuild);
      // Two more hours on CPU after a GPU timeout is not worth it.
      if (g.code === 124) throw timedOut();
      if (g.code === 0) {
        r = g;
        device = "gpu";
      } else {
        notes.push(`${p.name}: GPU run failed (${lastLine(g)}), used CPU`);
      }
    }
    if (!r) {
      r = await transcribe(cpuBuild, BUILDS[cpuBuild].gpu ? { PARAKEET_DEVICE: "cpu" } : undefined);
      if (r.code === 124) throw timedOut();
      if (r.code !== 0) throw new UserError(`${p.name}: parakeet-cli failed (${lastLine(r)})`);
    }

    const cues = wordsToCues(parseWords(p.name, r.stdout));
    if (cues.length === 0) throw new UserError(`${p.name}: no speech recognized`);
    const out: AsrResult = { cues, provider: p.name, diarized: false, speakers: 0, language: null, device };
    if (notes.length) out.notes = notes;
    return out;
  } finally {
    await rm(wav, { force: true });
  }
}
