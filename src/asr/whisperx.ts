import { openAsBlob } from "node:fs";
import { normalizeLanguage } from "./language";
import { oneLine } from "../net";
import { type Fetcher } from "../types";
import type { RemoteProvider } from "./providers";
import { type AsrOptions, type AsrResult, authHeaders, joinUrl, postAsr, primaryLang } from "./types";

type Segment = { start: number; end: number; text: string; speaker?: string };

export async function whisperxHealthy(url: string, f: Fetcher, key: string | null): Promise<boolean> {
  try {
    const r = await f(joinUrl(url, "/health"), { headers: authHeaders(key), signal: AbortSignal.timeout(5_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** SPEAKER_xx -> "Speaker N" by order of first appearance. */
export function parseWhisperx(json: unknown, provider: string): AsrResult {
  const body = json as { language?: string; segments?: Segment[] };
  const names = new Map<string, string>();
  const labeled: { start: number; end: number; text: string; speaker?: string }[] = (body.segments ?? []).map((s) => {
    const cue = { start: s.start, end: s.end, text: s.text.trim() };
    if (!s.speaker) return cue;
    if (!names.has(s.speaker)) names.set(s.speaker, `Speaker ${names.size + 1}`);
    return { ...cue, speaker: names.get(s.speaker)! };
  });
  // One speaker carries no labels: "Speaker 1" on every cue adds nothing.
  const cues = labeled.map((c) => (names.size === 1 ? { start: c.start, end: c.end, text: c.text } : c));
  return { cues, provider, diarized: names.size > 0, speakers: names.size, language: normalizeLanguage(body.language) };
}

export async function transcribeWhisperx(
  file: string, o: AsrOptions, p: RemoteProvider, key: string | null, f: Fetcher,
): Promise<AsrResult> {
  const q = new URLSearchParams({ output: "json", diarize: String(o.diarize && p.diarize), word_timestamps: "false" });
  const lang = primaryLang(o.language);
  if (lang) q.set("language", lang);
  const form = new FormData();
  form.append("audio_file", await openAsBlob(file), "audio.ogg");
  const r = await postAsr(p.name, f, `${joinUrl(p.url, "/asr")}?${q}`, authHeaders(key), form);
  if (!r.ok) throw new Error(`${p.name}: whisperx responded ${r.status}: ${oneLine(r.text).slice(0, 500)}`);
  return parseWhisperx(JSON.parse(r.text), p.name);
}
