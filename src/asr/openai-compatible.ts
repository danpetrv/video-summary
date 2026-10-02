import { openAsBlob } from "node:fs";
import { oneLine } from "../net";
import { type Fetcher, UserError } from "../types";
import type { ResolvedProvider } from "./presets";
import { type AsrOptions, type AsrResult, authHeaders, joinUrl, postAsr, primaryLang } from "./types";

type Segment = { start: number; end: number; text: string; speaker?: string };

export async function modelsReachable(url: string, f: Fetcher, key: string | null): Promise<boolean> {
  try {
    const r = await f(joinUrl(url, "/models"), { headers: authHeaders(key), signal: AbortSignal.timeout(5_000) });
    return r.ok;
  } catch {
    return false;
  }
}

export function parseVerbose(json: unknown, provider: string): AsrResult {
  const body = json as { language?: string; segments?: Segment[] };
  const cues = (body.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
  return { cues, provider, diarized: false, speakers: 0, language: body.language?.toLowerCase() ?? null };
}

/** Speaker "A","B" -> "Speaker 1","Speaker 2" by order of first appearance. */
export function parseDiarized(json: unknown, provider: string): AsrResult {
  const body = json as { language?: string; segments?: Segment[] };
  const names = new Map<string, string>();
  const cues = (body.segments ?? []).map((s) => {
    const cue = { start: s.start, end: s.end, text: s.text.trim() };
    if (!s.speaker) return cue;
    if (!names.has(s.speaker)) names.set(s.speaker, `Speaker ${names.size + 1}`);
    return { ...cue, speaker: names.get(s.speaker)! };
  });
  return { cues, provider, diarized: names.size > 0, speakers: names.size, language: body.language?.toLowerCase() ?? null };
}

export async function transcribeOpenAI(
  file: string, o: AsrOptions, p: ResolvedProvider, key: string | null, f: Fetcher,
): Promise<AsrResult> {
  const diarized = p.format === "diarized_json";
  const lang = primaryLang(o.language);
  const form = new FormData();
  form.append("file", await openAsBlob(file), "audio.ogg");
  form.append("model", p.model ?? "");
  form.append("response_format", diarized ? "diarized_json" : "verbose_json");
  if (diarized) form.append("chunking_strategy", "auto");
  else form.append("timestamp_granularities[]", "segment");
  if (lang) form.append("language", lang);
  const r = await postAsr(p.name, f, joinUrl(p.url, "/audio/transcriptions"), authHeaders(key), form);
  const text = r.text;
  if (r.status === 429) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message ?? text; } catch {}
    throw new UserError(`${p.name}: rate limit — ${oneLine(String(msg)).slice(0, 500)}`);
  }
  if (!r.ok) throw new Error(`${p.name} responded ${r.status}: ${oneLine(text).slice(0, 500)}`);
  const res = (diarized ? parseDiarized : parseVerbose)(JSON.parse(text), p.name);
  // Servers may return the language as a word ("English"); a known code is more precise.
  return lang ? { ...res, language: lang } : res;
}
