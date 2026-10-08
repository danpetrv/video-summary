import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./types";

export type KeyRef = { keyFile?: string | null; keyEnv?: string | null };
/** `diarize` is only meaningful for whisperx. */
export type RemoteProviderConfig = KeyRef & {
  name: string; type: "whisperx" | "openai-compatible"; url: string; model?: string; diarize?: boolean;
};
/** On-device recognition; parsing fills in the defaults, so a parsed config always has all fields. */
export type LocalProviderConfig = {
  name: string; type: "local"; engine: "parakeet"; model: "ultra"; device: "auto" | "cpu";
};
export type ProviderConfig = RemoteProviderConfig | LocalProviderConfig;
export type ReadeckConfig = KeyRef & { url: string; label?: string };
export type Config = {
  outputDir: string; summaryLanguage: string; summaryLength: string; subtitles: "manual" | "manual+auto";
  providers: ProviderConfig[]; readeck: ReadeckConfig | null;
};

export const DEFAULT_CONFIG: Config = {
  outputDir: "~/Documents/video-summaries",
  summaryLanguage: "auto",
  summaryLength: "medium",
  subtitles: "manual",
  providers: [],
  readeck: null,
};

/** short | medium | long, or a target reading time of 1-60 minutes ("5m"). */
const SUMMARY_LENGTH = /^(short|medium|long|([1-9]|[1-5]\d|60)m)$/;
const TOP_KEYS = Object.keys(DEFAULT_CONFIG);
/** Provider keys of the cloud era (v0.3): an old config still loads, these are dropped with a warning. */
const REMOVED_PROVIDER_KEYS = ["tier", "maxBytes", "maxSeconds", "local"];
const removed = (path: string) => `${path}: removed in v0.4.0 — ignored`;

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

function providerName(raw: Record<string, unknown>, path: string, seen: Set<string>): string {
  const name = str(raw.name, `${path}.name`);
  if (seen.has(name)) fail(`${path}.name`, `duplicate "${name}"`);
  seen.add(name);
  return name;
}

const LOCAL_KEYS = ["name", "type", "engine", "model", "device"];
/** Keys of the other provider types, current and removed: named as such rather than as unknown. */
const REMOTE_KEYS = ["url", "diarize", "keyFile", "keyEnv", "preset", ...REMOVED_PROVIDER_KEYS];

/** Value of `o[k]` from `allowed`; absent -> the first (default) one. */
function oneOf<T extends string>(o: Record<string, unknown>, k: string, allowed: readonly T[], path: string): T {
  const v = o[k];
  if (v === undefined) return allowed[0] as T;
  if (!allowed.includes(v as T)) fail(`${path}.${k}`, `must be ${allowed.map((a) => JSON.stringify(a)).join(" or ")}`);
  return v as T;
}

/** The local type is new in v0.4.0: no old configs to migrate, so any other field is an error. */
function parseLocal(raw: Record<string, unknown>, path: string, seen: Set<string>): LocalProviderConfig {
  for (const k of Object.keys(raw)) {
    if (!LOCAL_KEYS.includes(k)) fail(`${path}.${k}`, REMOTE_KEYS.includes(k) ? "not allowed for type local" : "unknown key");
  }
  return {
    name: providerName(raw, path, seen), type: "local",
    engine: oneOf(raw, "engine", ["parakeet"], path),
    model: oneOf(raw, "model", ["ultra"], path),
    device: oneOf(raw, "device", ["auto", "cpu"], path),
  };
}

/** null = an old cloud preset provider, skipped with a warning. */
function parseProvider(raw: unknown, i: number, seen: Set<string>, warnings: string[]): ProviderConfig | null {
  const path = `providers[${i}]`;
  if (!isObj(raw)) return fail(path, "must be an object");
  if (raw.type === "local") return parseLocal(raw, path, seen);
  if (raw.preset !== undefined) {
    const label = typeof raw.name === "string" && raw.name ? `${path} ${JSON.stringify(raw.name)}` : path;
    warnings.push(`${label}: cloud providers were removed in v0.4.0 — skipped`);
    return null;
  }
  // Speaker labels over openai-compatible existed only for the openai preset.
  const legacy = raw.type === "openai-compatible" ? [...REMOVED_PROVIDER_KEYS, "diarize"] : REMOVED_PROVIDER_KEYS;
  for (const k of legacy) if (raw[k] !== undefined) warnings.push(removed(`${path}.${k}`));
  checkKeys(raw, ["name", "type", "url", "model", "diarize", "keyFile", "keyEnv", ...legacy], path);
  const name = providerName(raw, path, seen);
  if (raw.type !== "whisperx" && raw.type !== "openai-compatible") {
    return fail(`${path}.type`, `unknown type ${JSON.stringify(raw.type)} (whisperx, openai-compatible, local)`);
  }
  const url = optStr(raw, "url", path)?.replace(/\/+$/, "");
  if (!url) return fail(`${path}.url`, "required");
  const p: RemoteProviderConfig = { name, type: raw.type, url, ...keyRef(raw, path) };
  const model = optStr(raw, "model", path);
  if (model) p.model = model;
  else if (p.type === "openai-compatible") fail(`${path}.model`, "required");
  if (p.type === "whisperx") {
    const diarize = optBool(raw, "diarize", path);
    if (diarize !== undefined) p.diarize = diarize;
  }
  return p;
}

/** Settings removed in v0.4.0 are dropped, each with a line in `warnings`; anything else unknown is an error. */
export function parseConfig(raw: unknown, warnings: string[] = []): Config {
  if (!isObj(raw)) return fail("(root)", "must be an object");
  if (raw.bitrate !== undefined) warnings.push(removed("bitrate"));
  checkKeys(raw, [...TOP_KEYS, "bitrate"], "");
  const cfg: Config = { ...DEFAULT_CONFIG, providers: [], readeck: null };
  if (raw.outputDir !== undefined) cfg.outputDir = str(raw.outputDir, "outputDir");
  if (raw.summaryLanguage !== undefined) cfg.summaryLanguage = str(raw.summaryLanguage, "summaryLanguage");
  if (raw.summaryLength !== undefined) {
    if (typeof raw.summaryLength !== "string" || !SUMMARY_LENGTH.test(raw.summaryLength)) {
      fail("summaryLength", "must be short, medium, long or <N>m (1-60)");
    }
    cfg.summaryLength = raw.summaryLength as string;
  }
  if (raw.subtitles !== undefined) {
    if (raw.subtitles !== "manual" && raw.subtitles !== "manual+auto") fail("subtitles", 'must be "manual" or "manual+auto"');
    cfg.subtitles = raw.subtitles as Config["subtitles"];
  }
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers)) return fail("providers", "must be an array");
    const seen = new Set<string>();
    cfg.providers = raw.providers
      .map((p, i) => parseProvider(p, i, seen, warnings))
      .filter((p): p is ProviderConfig => p !== null);
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

export async function loadConfig(path: string, warnings?: string[]): Promise<Config | null> {
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
  return parseConfig(raw, warnings);
}

/** Writes the parsed config: after a migration this is the cleaned one. */
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
  // `cfg` is already clean, so any warning comes from the new value: refuse it rather than drop it silently.
  const warnings: string[] = [];
  const parsed = parseConfig(next, warnings);
  if (warnings.length) throw new UserError(`config: ${key}: ${warnings.join("; ")}`);
  return parsed;
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
