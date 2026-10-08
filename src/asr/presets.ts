import type { ProviderConfig } from "../config";
import { UserError } from "../types";

export type ResolvedProvider = {
  name: string; type: "whisperx" | "openai-compatible"; url: string; model: string | null;
  diarize: boolean; keyFile: string | null; keyEnv: string | null;
};

export function resolveProvider(p: ProviderConfig): ResolvedProvider {
  const keys = { keyFile: p.keyFile ?? null, keyEnv: p.keyEnv ?? null };
  const url = p.url.replace(/\/+$/, "");
  if (p.type === "whisperx") return { name: p.name, type: p.type, url, model: null, diarize: p.diarize ?? true, ...keys };
  if (!p.model) throw new UserError(`config: provider ${p.name}: model is required`);
  return { name: p.name, type: p.type, url, model: p.model, diarize: false, ...keys };
}
