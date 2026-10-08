import { readKey } from "../config";
import { type Fetcher, UserError } from "../types";
import { modelsReachable, transcribeOpenAI } from "./openai-compatible";
import type { ResolvedProvider } from "./presets";
import type { AsrOptions, AsrResult } from "./types";
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

function reject(c: Candidate): string | null {
  if (!c.available) return c.provider.type === "local" ? "local engine not installed — run `local install`" : "not reachable";
  if (c.keyMissing) return `no API key (${c.keyMissing})`;
  return null;
}

export function chooseProvider(i: SelectInput): { provider: ResolvedProvider } | { error: string } {
  if (i.candidates.length === 0) return { error: "no ASR providers configured — run setup (see references/setup.md)" };
  const reasons: string[] = [];
  for (const c of i.candidates) {
    const why = reject(c);
    if (why === null) return { provider: c.provider };
    reasons.push(`${c.provider.name}: ${why}`);
  }
  return { error: `no ASR provider fits: ${reasons.join("; ")}` };
}

export async function transcribeWith(
  p: ResolvedProvider, file: string, o: AsrOptions, f: Fetcher,
  env: Record<string, string | undefined>, home: string,
): Promise<AsrResult> {
  // Placeholder until local recognition lands; a UserError, so fetch fails over to the next provider.
  if (p.type === "local") throw new UserError("local recognition is not implemented yet");
  const key = await readKey(p, env, home);
  return p.type === "whisperx" ? transcribeWhisperx(file, o, p, key, f) : transcribeOpenAI(file, o, p, key, f);
}
