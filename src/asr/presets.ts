import type { ProviderConfig } from "../config";
import { UserError } from "../types";

export type ResolvedProvider = {
  name: string; type: "whisperx" | "openai-compatible"; url: string; model: string | null;
  format: "verbose_json" | "diarized_json" | null; diarize: boolean; local: boolean;
  maxBytes: number | null; maxSeconds: number | null; keyRequired: boolean; keyFile: string | null; keyEnv: string | null;
};

const GROQ = { url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" };

export function resolveProvider(p: ProviderConfig): ResolvedProvider {
  const keys = { keyFile: p.keyFile ?? null, keyEnv: p.keyEnv ?? null };
  const pick = <T>(own: T | null | undefined, preset: T): T | null => (own !== undefined ? own : preset);
  const trimUrl = (u: string) => u.replace(/\/+$/, "");

  if (p.type === "whisperx") {
    if (!p.url) throw new UserError(`config: provider ${p.name}: url is required`);
    return {
      name: p.name, type: p.type, url: trimUrl(p.url), model: null, format: null,
      diarize: p.diarize ?? true, local: p.local ?? true,
      maxBytes: p.maxBytes ?? null, maxSeconds: p.maxSeconds ?? null, keyRequired: false, ...keys,
    };
  }

  const local = p.local ?? false;
  let url = p.url, model = p.model;
  let presetBytes: number | null = null, presetSeconds: number | null = null;
  let diarize = false;
  let format: "verbose_json" | "diarized_json" = "verbose_json";

  if (p.preset === "groq") {
    url ??= GROQ.url;
    model ??= GROQ.model;
    if (p.tier === "dev") presetBytes = 100_000_000;
    else { presetBytes = 25_000_000; presetSeconds = 7000; }
  } else if (p.preset === "openai") {
    url ??= "https://api.openai.com/v1";
    diarize = p.diarize ?? false;
    model ??= diarize ? "gpt-4o-transcribe-diarize" : "whisper-1";
    if (diarize) format = "diarized_json";
    presetBytes = 25_000_000;
  } else {
    if (!url) throw new UserError(`config: provider ${p.name}: url is required`);
    if (!model) throw new UserError(`config: provider ${p.name}: model is required without preset`);
  }

  return {
    name: p.name, type: p.type, url: trimUrl(url), model, format, diarize, local,
    maxBytes: pick(p.maxBytes, presetBytes), maxSeconds: pick(p.maxSeconds, presetSeconds),
    keyRequired: !local, ...keys,
  };
}
