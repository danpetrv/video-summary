import { netErrorTag } from "../net";
import { type Cue, type Fetcher, UserError } from "../types";

export type AsrOptions = { language: string | null; diarize: boolean };
export type AsrResult = {
  cues: Cue[]; provider: string; diarized: boolean; speakers: number; language: string | null;
  device?: "gpu" | "cpu"; // local engine: where recognition actually ran
  elapsedMs?: number; // local engine: process time of the run that produced the result
  plannedDevice?: "gpu" | "cpu"; // local engine: the device the run started on (the slow-run estimate reads its speed)
  pathElapsedMs?: number; // local engine: time from the first engine run to the end of the one that succeeded
  // local engine, after a successful diarization pass: where it ran, the device the run started on, process time
  // of the scene run that succeeded and time from the first scene run (a failed GPU attempt included)
  diarization?: { device: "gpu" | "cpu"; plannedDevice: "gpu" | "cpu"; elapsedMs: number; pathElapsedMs: number };
  notes?: string[]; // non-fatal problems worth reporting (e.g. GPU failed, CPU used)
};

/** Primary language subtag, lower-case: "pt-BR" -> "pt". */
export const primaryLang = (l: string | null): string | null => (l ? (l.split(/[-_]/)[0]!.toLowerCase() || null) : null);

export const joinUrl = (base: string, path: string): string => base.replace(/\/+$/, "") + path;

export const authHeaders = (key: string | null): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

export const ASR_TIMEOUT_MS = 30 * 60_000;

/**
 * POST a recognition request and read the whole body. Network errors and timeouts become a
 * one-line UserError. `timeout: false` disables Bun's own fetch idle timeout (httpFetch on Node ignores it).
 */
export async function postAsr(
  name: string, f: Fetcher, url: string, headers: Record<string, string>, body: FormData, timeoutMs = ASR_TIMEOUT_MS,
): Promise<{ status: number; ok: boolean; text: string }> {
  try {
    const init = { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs), timeout: false };
    const r = await f(url, init as RequestInit);
    return { status: r.status, ok: r.ok, text: await r.text() };
  } catch (e) {
    throw new UserError(`${name}: request failed — ${netErrorTag(e)}`);
  }
}
