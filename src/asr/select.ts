import { keySource, readKey } from "../config";
import { HEADROOM, usableBytes } from "../limits";
import { type Fetcher, UserError } from "../types";
import { modelsReachable, transcribeOpenAI } from "./openai-compatible";
import type { ResolvedProvider } from "./presets";
import type { AsrOptions, AsrResult } from "./types";
import { transcribeWhisperx, whisperxHealthy } from "./whisperx";

export type Candidate = { provider: ResolvedProvider; available: boolean; keyMissing: string | null };

export async function probeProviders(
  ps: ResolvedProvider[], f: Fetcher, env: Record<string, string | undefined>, home: string,
): Promise<Candidate[]> {
  return Promise.all(ps.map(async (provider) => {
    let key: string | null = null;
    let keyMissing: string | null = null;
    try {
      key = await readKey(provider, env, home);
      if (provider.keyRequired && key === null) keyMissing = keySource(provider) ?? "no key configured";
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      // Unreadable or malformed key: report it, keep check/selection going. Not probed (like cloud
      // providers): without the key a 401 would read as "not reachable" and hide the real problem.
      return { provider, available: true, keyMissing: e.message };
    }
    let available = true;
    if (provider.type === "whisperx") available = await whisperxHealthy(provider.url, f, key);
    else if (provider.local) available = await modelsReachable(provider.url, f, key);
    return { provider, available, keyMissing };
  }));
}

export type SelectInput = { candidates: Candidate[]; durationSec: number; kbps: number; privateSource: boolean; allowCloud: boolean };

const hms = (sec: number): string => {
  const s = Math.floor(sec);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const mb = (b: number): string => `${(b / 1_000_000).toFixed(1)} MB`;

function reject(c: Candidate, i: SelectInput): string | null {
  const p = c.provider;
  if (!c.available) return "not reachable";
  if (c.keyMissing) return `no API key (${c.keyMissing})`;
  if (p.maxSeconds !== null && i.durationSec > p.maxSeconds) {
    return `${hms(i.durationSec)} exceeds duration limit ${hms(p.maxSeconds)}`;
  }
  const bytes = (i.durationSec * i.kbps * 1000) / 8;
  const usable = usableBytes(p); // 96% of maxBytes: the real opus size drifts from the bitrate math
  if (p.maxBytes !== null && usable !== null && bytes > usable) {
    return `~${mb(bytes)} exceeds ${Math.round(HEADROOM * 100)}% of file limit ${mb(p.maxBytes)}`;
  }
  if (!p.local && i.privateSource && !i.allowCloud) return "cloud provider, needs --allow-cloud";
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

export async function transcribeWith(
  p: ResolvedProvider, file: string, o: AsrOptions, f: Fetcher,
  env: Record<string, string | undefined>, home: string,
): Promise<AsrResult> {
  const key = await readKey(p, env, home);
  if (p.keyRequired && key === null) throw new UserError(`${p.name}: no API key (${keySource(p) ?? "no key configured"})`);
  return p.type === "whisperx" ? transcribeWhisperx(file, o, p, key, f) : transcribeOpenAI(file, o, p, key, f);
}
