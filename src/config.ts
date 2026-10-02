import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./types";

export type KeyRef = { keyFile?: string | null; keyEnv?: string | null };
export type ProviderConfig = KeyRef & {
  name: string; type: "whisperx" | "openai-compatible"; preset?: "groq" | "openai";
  tier?: "free" | "dev"; url?: string; model?: string; diarize?: boolean; local?: boolean;
  maxBytes?: number | null; maxSeconds?: number | null;
};
export type ReadeckConfig = KeyRef & { url: string; label?: string };
export type Config = {
  outputDir: string; summaryLanguage: string; subtitles: "manual" | "manual+auto";
  bitrate: "adaptive" | "fixed"; providers: ProviderConfig[]; readeck: ReadeckConfig | null;
};

export const DEFAULT_CONFIG: Config = {
  outputDir: "~/Documents/video-summaries",
  summaryLanguage: "auto",
  subtitles: "manual",
  bitrate: "adaptive",
  providers: [],
  readeck: null,
};

const PRESETS = ["groq", "openai"];
const TOP_KEYS = Object.keys(DEFAULT_CONFIG);

export function configPath(env: Record<string, string | undefined>, home: string): string {
  if (env.VIDEO_SUMMARY_CONFIG) return env.VIDEO_SUMMARY_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "video-summary", "config.json");
}

export function expandHome(p: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) return join(home, p.slice(1));
  return p;
}

const fail = (path: string, problem: string): never => {
  throw new UserError(`config: ${path}: ${problem}`);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v === "") return fail(path, "must be a non-empty string");
  return v;
}

function optStr(o: Record<string, unknown>, k: string, path: string): string | null | undefined {
  const v = o[k];
  if (v === undefined || v === null) return v as null | undefined;
  return str(v, `${path}.${k}`);
}

function optBool(o: Record<string, unknown>, k: string, path: string): boolean | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") return fail(`${path}.${k}`, "must be true or false");
  return v;
}

function optLimit(o: Record<string, unknown>, k: string, path: string): number | null | undefined {
  const v = o[k];
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fail(`${path}.${k}`, "must be a positive number or null");
  return v;
}

function keyRef(o: Record<string, unknown>, path: string): KeyRef {
  const out: KeyRef = {};
  const f = optStr(o, "keyFile", path);
  const e = optStr(o, "keyEnv", path);
  if (f !== undefined) out.keyFile = f;
  if (e !== undefined) out.keyEnv = e;
  return out;
}

function checkKeys(o: Record<string, unknown>, allowed: string[], path: string) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(path ? `${path}.${k}` : k, "unknown key");
  }
}

function parseProvider(raw: unknown, i: number, seen: Set<string>): ProviderConfig {
  const path = `providers[${i}]`;
  if (!isObj(raw)) return fail(path, "must be an object");
  checkKeys(raw, ["name", "type", "preset", "tier", "url", "model", "diarize", "local", "maxBytes", "maxSeconds", "keyFile", "keyEnv"], path);
  const name = str(raw.name, `${path}.name`);
  if (seen.has(name)) fail(`${path}.name`, `duplicate "${name}"`);
  seen.add(name);
  if (raw.type !== "whisperx" && raw.type !== "openai-compatible") {
    return fail(`${path}.type`, `unknown type ${JSON.stringify(raw.type)} (whisperx, openai-compatible)`);
  }
  const p: ProviderConfig = { name, type: raw.type, ...keyRef(raw, path) };
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== "string" || !PRESETS.includes(raw.preset)) {
      fail(`${path}.preset`, `unknown preset ${JSON.stringify(raw.preset)} (${PRESETS.join(", ")})`);
    }
    if (raw.type !== "openai-compatible") fail(`${path}.preset`, "only allowed for type openai-compatible");
    p.preset = raw.preset as "groq" | "openai";
  }
  if (raw.tier !== undefined) {
    if (raw.tier !== "free" && raw.tier !== "dev") fail(`${path}.tier`, 'must be "free" or "dev"');
    p.tier = raw.tier as "free" | "dev";
  }
  const url = optStr(raw, "url", path);
  if (url !== undefined && url !== null) {
    p.url = url.replace(/\/+$/, "");
    if (!p.url) fail(`${path}.url`, "required");
  } else if (!p.preset) fail(`${path}.url`, "required");
  const model = optStr(raw, "model", path);
  if (model) p.model = model;
  else if (p.type === "openai-compatible" && !p.preset) fail(`${path}.model`, "required without preset");
  const diarize = optBool(raw, "diarize", path);
  if (diarize !== undefined) p.diarize = diarize;
  const local = optBool(raw, "local", path);
  if (local !== undefined) p.local = local;
  const mb = optLimit(raw, "maxBytes", path);
  if (mb !== undefined) p.maxBytes = mb;
  const ms = optLimit(raw, "maxSeconds", path);
  if (ms !== undefined) p.maxSeconds = ms;
  return p;
}

export function parseConfig(raw: unknown): Config {
  if (!isObj(raw)) return fail("(root)", "must be an object");
  checkKeys(raw, TOP_KEYS, "");
  const cfg: Config = { ...DEFAULT_CONFIG, providers: [], readeck: null };
  if (raw.outputDir !== undefined) cfg.outputDir = str(raw.outputDir, "outputDir");
  if (raw.summaryLanguage !== undefined) cfg.summaryLanguage = str(raw.summaryLanguage, "summaryLanguage");
  if (raw.subtitles !== undefined) {
    if (raw.subtitles !== "manual" && raw.subtitles !== "manual+auto") fail("subtitles", 'must be "manual" or "manual+auto"');
    cfg.subtitles = raw.subtitles as Config["subtitles"];
  }
  if (raw.bitrate !== undefined) {
    if (raw.bitrate !== "adaptive" && raw.bitrate !== "fixed") fail("bitrate", 'must be "adaptive" or "fixed"');
    cfg.bitrate = raw.bitrate as Config["bitrate"];
  }
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers)) return fail("providers", "must be an array");
    const seen = new Set<string>();
    cfg.providers = raw.providers.map((p, i) => parseProvider(p, i, seen));
  }
  if (raw.readeck !== undefined && raw.readeck !== null) {
    const r = raw.readeck;
    if (!isObj(r)) return fail("readeck", "must be an object or null");
    checkKeys(r, ["url", "label", "keyFile", "keyEnv"], "readeck");
    if (r.url === undefined) fail("readeck.url", "required");
    const rd: ReadeckConfig = { url: str(r.url, "readeck.url").replace(/\/+$/, ""), ...keyRef(r, "readeck") };
    if (!rd.url) fail("readeck.url", "required");
    const label = optStr(r, "label", "readeck");
    if (label) rd.label = label;
    cfg.readeck = rd;
  }
  return cfg;
}

export async function loadConfig(path: string): Promise<Config | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UserError(`config: ${path}: cannot read file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UserError(`config: ${path}: invalid JSON (${(e as Error).message})`);
  }
  return parseConfig(raw);
}

export async function saveConfig(path: string, cfg: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function setValue(cfg: Config, key: string, value: unknown): Config {
  const parts = key.split(".");
  const head = parts[0] as string;
  const rest = parts.slice(1);
  if (!TOP_KEYS.includes(head)) throw new UserError(`config: ${key}: unknown key`);
  const next: Record<string, unknown> = structuredClone(cfg);
  if (rest.length === 0) {
    next[head] = value;
  } else if (head === "readeck" && rest.length === 1) {
    const cur = isObj(next.readeck) ? next.readeck : {};
    cur[rest[0] as string] = value;
    next.readeck = cur;
  } else {
    throw new UserError(`config: ${key}: unknown key`);
  }
  return parseConfig(next);
}

export function keySource(ref: KeyRef): string | null {
  const parts = [ref.keyFile && `file ${ref.keyFile}`, ref.keyEnv && `env ${ref.keyEnv}`].filter(Boolean);
  return parts.length ? parts.join(" or ") : null;
}

/** Printable ASCII without spaces: anything else would end up in an invalid (and echoed) HTTP header. */
function checkedKey(v: string, source: string): string {
  if (/[^\x21-\x7e]/.test(v)) throw new UserError(`key in ${source} contains whitespace or control characters`);
  return v;
}

/** Key from keyFile (trimmed), else from the keyEnv variable. Key contents never appear in any error. */
export async function readKey(
  ref: KeyRef, env: Record<string, string | undefined>, home: string,
): Promise<string | null> {
  if (ref.keyFile) {
    const file = expandHome(ref.keyFile, home);
    let v = "";
    try {
      v = (await readFile(file, "utf8")).trim();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new UserError(`cannot read file ${ref.keyFile} (${code ?? "error"})`);
    }
    if (v) return checkedKey(v, `file ${ref.keyFile}`);
  }
  if (ref.keyEnv) {
    const v = env[ref.keyEnv]?.trim();
    if (v) return checkedKey(v, `env ${ref.keyEnv}`);
  }
  return null;
}
