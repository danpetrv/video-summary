import { readKey } from "../config";
import { transcribeParakeet } from "../local/parakeet";
import { LANGUAGES } from "../local/pins";
import { SLOW_MINUTES } from "../local/speed";
import { type Fetcher, type Platform, type Runner, UserError } from "../types";
import { modelsReachable, transcribeOpenAI } from "./openai-compatible";
import type { ResolvedProvider } from "./presets";
import { type AsrOptions, type AsrResult, primaryLang } from "./types";
import { transcribeWhisperx, whisperxHealthy } from "./whisperx";

export type Candidate = { provider: ResolvedProvider; available: boolean; keyMissing: string | null };

/** `local`: install status of the local engine (`localStatus`); without it a local provider is unavailable. */
export async function probeProviders(
  ps: ResolvedProvider[], f: Fetcher, env: Record<string, string | undefined>, home: string,
  local?: { installed: boolean },
): Promise<Candidate[]> {
  return Promise.all(ps.map(async (provider): Promise<Candidate> => {
    if (provider.type === "local") return { provider, available: local?.installed ?? false, keyMissing: null };
    let key: string | null = null;
    try {
      key = await readKey(provider, env, home);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      // Unreadable or malformed key: report it, keep check/selection going. Not probed:
      // without the key a 401 would read as "not reachable" and hide the real problem.
      return { provider, available: true, keyMissing: e.message };
    }
    const available = provider.type === "whisperx"
      ? await whisperxHealthy(provider.url, f, key)
      : await modelsReachable(provider.url, f, key);
    return { provider, available, keyMissing: null };
  }));
}

/** Expected wall time of a slow (local CPU) run; used by the slow-run gate. */
export type SlowEstimate = { minutes: number; device: "gpu" | "cpu"; speed: number };

export type SelectInput = {
  candidates: Candidate[]; durationSec: number; language: string | null; acceptSlow: boolean;
  estimate: (p: ResolvedProvider, durationSec: number) => SlowEstimate | null;
};

function reject(c: Candidate, i: SelectInput): string | null {
  // Checked first: installing the engine would not help.
  const lang = primaryLang(i.language);
  if (c.provider.type === "local" && lang && !LANGUAGES.includes(lang)) return `language ${lang} not supported`;
  if (!c.available) return c.provider.type === "local" ? "local engine not installed — run `local install`" : "not reachable";
  if (c.keyMissing) return `no API key (${c.keyMissing})`;
  // Only the local engine can be slow enough to ask first; servers are never gated.
  if (c.provider.type === "local" && !i.acceptSlow) {
    const e = i.estimate(c.provider, i.durationSec);
    if (e && e.minutes > SLOW_MINUTES) {
      return `~${Math.ceil(e.minutes)} min on ${e.device.toUpperCase()} (measured speed ${Math.round(e.speed)}x); add --accept-slow to wait`;
    }
  }
  return null;
}

export function chooseProvider(i: SelectInput): { provider: ResolvedProvider } | { error: string } {
  if (i.candidates.length === 0) return { error: "no ASR providers configured — run setup (see references/setup.md)" };
  const reasons: string[] = [];
  for (const c of i.candidates) {
    const why = reject(c, i);
    if (why === null) return { provider: c.provider };
    reasons.push(`${c.provider.name}: ${why}`);
  }
  return { error: `no ASR provider fits: ${reasons.join("; ")}` };
}

/** What recognition needs: HTTP for servers; processes, paths and the platform for the local engine. */
export type AsrDeps = {
  fetch: Fetcher; env: Record<string, string | undefined>; home: string;
  run: Runner; platform: Platform; arch: "x64" | "arm64"; exists: (p: string) => boolean;
  clock?: () => number;
};

export async function transcribeWith(p: ResolvedProvider, file: string, o: AsrOptions, d: AsrDeps): Promise<AsrResult> {
  if (p.type === "local") {
    return { ...(await transcribeParakeet(file, p, d, { diarize: o.diarize && p.diarize })), language: o.language };
  }
  const key = await readKey(p, d.env, d.home);
  return p.type === "whisperx" ? transcribeWhisperx(file, o, p, key, d.fetch) : transcribeOpenAI(file, o, p, key, d.fetch);
}
