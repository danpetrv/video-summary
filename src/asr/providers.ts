import type { LocalProviderConfig, ProviderConfig, RemoteProviderConfig } from "../config";
import { UserError } from "../types";

/** A recognition server reached over HTTP. */
export type RemoteProvider = {
  name: string; type: "whisperx" | "openai-compatible"; url: string; model: string | null;
  diarize: boolean; keyFile: string | null; keyEnv: string | null; engine: null; device: null;
};
/** On-device recognition: no server, no key; speaker labels from a second on-device pass when `diarize`. */
export type LocalProvider = {
  name: string; type: "local"; url: null; model: "ultra"; diarize: boolean;
  keyFile: null; keyEnv: null; engine: "parakeet"; device: "auto" | "cpu";
};
export type ResolvedProvider = RemoteProvider | LocalProvider;

export function resolveProvider(p: RemoteProviderConfig): RemoteProvider;
export function resolveProvider(p: LocalProviderConfig): LocalProvider;
export function resolveProvider(p: ProviderConfig): ResolvedProvider;
export function resolveProvider(p: ProviderConfig): ResolvedProvider {
  if (p.type === "local") {
    return {
      name: p.name, type: "local", url: null, model: p.model, diarize: p.diarize,
      keyFile: null, keyEnv: null, engine: p.engine, device: p.device,
    };
  }
  const base = { keyFile: p.keyFile ?? null, keyEnv: p.keyEnv ?? null, engine: null, device: null };
  const url = p.url.replace(/\/+$/, "");
  if (p.type === "whisperx") return { name: p.name, type: p.type, url, model: null, diarize: p.diarize ?? true, ...base };
  if (!p.model) throw new UserError(`config: provider ${p.name}: model is required`);
  return { name: p.name, type: p.type, url, model: p.model, diarize: false, ...base };
}
