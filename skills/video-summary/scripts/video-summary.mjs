// src/main.ts
import { homedir } from "node:os";

// src/cli.ts
import { stat as stat3 } from "node:fs/promises";

// src/config.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/types.ts
class UserError extends Error {
}

// src/config.ts
var DEFAULT_CONFIG = {
  outputDir: "~/Documents/video-summaries",
  summaryLanguage: "auto",
  summaryLength: "medium",
  subtitles: "manual",
  bitrate: "adaptive",
  providers: [],
  readeck: null
};
var PRESETS = ["groq", "openai"];
var SUMMARY_LENGTH = /^(short|medium|long|([1-9]|[1-5]\d|60)m)$/;
var TOP_KEYS = Object.keys(DEFAULT_CONFIG);
function configPath(env, home) {
  if (env.VIDEO_SUMMARY_CONFIG)
    return env.VIDEO_SUMMARY_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "video-summary", "config.json");
}
function expandHome(p, home) {
  if (p === "~" || p.startsWith("~/"))
    return join(home, p.slice(1));
  return p;
}
var fail = (path, problem) => {
  throw new UserError(`config: ${path}: ${problem}`);
};
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function str(v, path) {
  if (typeof v !== "string" || v === "")
    return fail(path, "must be a non-empty string");
  return v;
}
function optStr(o, k, path) {
  const v = o[k];
  if (v === undefined || v === null)
    return v;
  return str(v, `${path}.${k}`);
}
function optBool(o, k, path) {
  const v = o[k];
  if (v === undefined)
    return;
  if (typeof v !== "boolean")
    return fail(`${path}.${k}`, "must be true or false");
  return v;
}
function optLimit(o, k, path) {
  const v = o[k];
  if (v === undefined || v === null)
    return v;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
    return fail(`${path}.${k}`, "must be a positive number or null");
  return v;
}
function keyRef(o, path) {
  const out = {};
  const f = optStr(o, "keyFile", path);
  const e = optStr(o, "keyEnv", path);
  if (f !== undefined)
    out.keyFile = f;
  if (e !== undefined)
    out.keyEnv = e;
  return out;
}
function checkKeys(o, allowed, path) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k))
      fail(path ? `${path}.${k}` : k, "unknown key");
  }
}
function parseProvider(raw, i, seen) {
  const path = `providers[${i}]`;
  if (!isObj(raw))
    return fail(path, "must be an object");
  checkKeys(raw, ["name", "type", "preset", "tier", "url", "model", "diarize", "local", "maxBytes", "maxSeconds", "keyFile", "keyEnv"], path);
  const name = str(raw.name, `${path}.name`);
  if (seen.has(name))
    fail(`${path}.name`, `duplicate "${name}"`);
  seen.add(name);
  if (raw.type !== "whisperx" && raw.type !== "openai-compatible") {
    return fail(`${path}.type`, `unknown type ${JSON.stringify(raw.type)} (whisperx, openai-compatible)`);
  }
  const p = { name, type: raw.type, ...keyRef(raw, path) };
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== "string" || !PRESETS.includes(raw.preset)) {
      fail(`${path}.preset`, `unknown preset ${JSON.stringify(raw.preset)} (${PRESETS.join(", ")})`);
    }
    if (raw.type !== "openai-compatible")
      fail(`${path}.preset`, "only allowed for type openai-compatible");
    p.preset = raw.preset;
  }
  if (raw.tier !== undefined) {
    if (raw.tier !== "free" && raw.tier !== "dev")
      fail(`${path}.tier`, 'must be "free" or "dev"');
    if (p.preset !== "groq")
      fail(`${path}.tier`, 'only allowed with preset "groq"');
    p.tier = raw.tier;
  }
  const url = optStr(raw, "url", path);
  if (url !== undefined && url !== null) {
    p.url = url.replace(/\/+$/, "");
    if (!p.url)
      fail(`${path}.url`, "required");
  } else if (!p.preset)
    fail(`${path}.url`, "required");
  const model = optStr(raw, "model", path);
  if (model)
    p.model = model;
  else if (p.type === "openai-compatible" && !p.preset)
    fail(`${path}.model`, "required without preset");
  const diarize = optBool(raw, "diarize", path);
  if (diarize === true && p.type !== "whisperx" && p.preset !== "openai") {
    fail(`${path}.diarize`, "speaker labels are only supported by whisperx and the openai preset");
  }
  if (diarize !== undefined)
    p.diarize = diarize;
  const local = optBool(raw, "local", path);
  if (local !== undefined)
    p.local = local;
  const mb = optLimit(raw, "maxBytes", path);
  if (mb !== undefined)
    p.maxBytes = mb;
  const ms = optLimit(raw, "maxSeconds", path);
  if (ms !== undefined)
    p.maxSeconds = ms;
  return p;
}
function parseConfig(raw) {
  if (!isObj(raw))
    return fail("(root)", "must be an object");
  checkKeys(raw, TOP_KEYS, "");
  const cfg = { ...DEFAULT_CONFIG, providers: [], readeck: null };
  if (raw.outputDir !== undefined)
    cfg.outputDir = str(raw.outputDir, "outputDir");
  if (raw.summaryLanguage !== undefined)
    cfg.summaryLanguage = str(raw.summaryLanguage, "summaryLanguage");
  if (raw.summaryLength !== undefined) {
    if (typeof raw.summaryLength !== "string" || !SUMMARY_LENGTH.test(raw.summaryLength)) {
      fail("summaryLength", "must be short, medium, long or <N>m (1-60)");
    }
    cfg.summaryLength = raw.summaryLength;
  }
  if (raw.subtitles !== undefined) {
    if (raw.subtitles !== "manual" && raw.subtitles !== "manual+auto")
      fail("subtitles", 'must be "manual" or "manual+auto"');
    cfg.subtitles = raw.subtitles;
  }
  if (raw.bitrate !== undefined) {
    if (raw.bitrate !== "adaptive" && raw.bitrate !== "fixed")
      fail("bitrate", 'must be "adaptive" or "fixed"');
    cfg.bitrate = raw.bitrate;
  }
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers))
      return fail("providers", "must be an array");
    const seen = new Set;
    cfg.providers = raw.providers.map((p, i) => parseProvider(p, i, seen));
  }
  if (raw.readeck !== undefined && raw.readeck !== null) {
    const r = raw.readeck;
    if (!isObj(r))
      return fail("readeck", "must be an object or null");
    checkKeys(r, ["url", "label", "keyFile", "keyEnv"], "readeck");
    if (r.url === undefined)
      fail("readeck.url", "required");
    const rd = { url: str(r.url, "readeck.url").replace(/\/+$/, ""), ...keyRef(r, "readeck") };
    if (!rd.url)
      fail("readeck.url", "required");
    const label = optStr(r, "label", "readeck");
    if (label)
      rd.label = label;
    cfg.readeck = rd;
  }
  return cfg;
}
async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      return null;
    throw new UserError(`config: ${path}: cannot read file (${e.code ?? "error"})`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UserError(`config: ${path}: invalid JSON (${e.message})`);
  }
  return parseConfig(raw);
}
async function saveConfig(path, cfg) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + `
`);
}
function setValue(cfg, key, value) {
  const parts = key.split(".");
  const head = parts[0];
  const rest = parts.slice(1);
  if (!TOP_KEYS.includes(head))
    throw new UserError(`config: ${key}: unknown key`);
  const next = structuredClone(cfg);
  if (rest.length === 0) {
    next[head] = value;
  } else if (head === "readeck" && rest.length === 1) {
    const cur = isObj(next.readeck) ? next.readeck : {};
    cur[rest[0]] = value;
    next.readeck = cur;
  } else {
    throw new UserError(`config: ${key}: unknown key`);
  }
  return parseConfig(next);
}
function keySource(ref) {
  const parts = [ref.keyFile && `file ${ref.keyFile}`, ref.keyEnv && `env ${ref.keyEnv}`].filter(Boolean);
  return parts.length ? parts.join(" or ") : null;
}
function checkedKey(v, source) {
  if (/[^\x21-\x7e]/.test(v))
    throw new UserError(`key in ${source} contains whitespace or control characters`);
  return v;
}
async function readKey(ref, env, home) {
  if (ref.keyFile) {
    const file = expandHome(ref.keyFile, home);
    let v = "";
    try {
      v = (await readFile(file, "utf8")).trim();
    } catch (e) {
      const code = e.code;
      if (code !== "ENOENT")
        throw new UserError(`cannot read file ${ref.keyFile} (${code ?? "error"})`);
    }
    if (v)
      return checkedKey(v, `file ${ref.keyFile}`);
  }
  if (ref.keyEnv) {
    const v = env[ref.keyEnv]?.trim();
    if (v)
      return checkedKey(v, `env ${ref.keyEnv}`);
  }
  return null;
}

// src/deps.ts
var STALE_DAYS = 60;
var YTDLP = '"yt-dlp[default]"';
var PIPX_NOTE = "pipx installs into ~/.local/bin: if yt-dlp is not found afterwards, run `pipx ensurepath` and open a new shell (or re-login)";
var PROBES = [
  { name: "yt-dlp", cmd: ["yt-dlp", "--version"], parse: (r) => r.stdout.trim() || null },
  {
    name: "yt-dlp-ejs",
    cmd: ["yt-dlp", "-v", "--simulate"],
    parse: (r) => r.stderr.match(/Optional libraries:.*?\byt_dlp_ejs-([^\s,]+)/)?.[1] ?? null,
    anyExit: true
  },
  { name: "ffmpeg", cmd: ["ffmpeg", "-version"], parse: (r) => r.stdout.match(/^ffmpeg version (\S+)/)?.[1] ?? null },
  { name: "ffprobe", cmd: ["ffprobe", "-version"], parse: (r) => r.stdout.match(/^ffprobe version (\S+)/)?.[1] ?? null }
];
async function probeDeps(run) {
  return Promise.all(PROBES.map(async (p) => {
    const r = await run(p.cmd);
    if (r.code === 127 || r.code !== 0 && !p.anyExit)
      return { name: p.name, found: false, version: null };
    const version = p.parse(r);
    return p.anyExit ? { name: p.name, found: version !== null, version } : { name: p.name, found: true, version };
  }));
}
function pickManager(platform, has) {
  if (has("uv"))
    return "uv";
  if (has("pipx"))
    return "pipx";
  return platform === "darwin" ? "brew" : "apt-pipx";
}
function ytdlpInstall(m) {
  return {
    uv: `uv tool install ${YTDLP}`,
    pipx: `pipx install ${YTDLP}`,
    brew: "brew install yt-dlp",
    "apt-pipx": `sudo apt install pipx && pipx install ${YTDLP}`
  }[m];
}
function ytdlpReinstall(m) {
  return {
    uv: `uv tool install --force ${YTDLP}`,
    pipx: `pipx install --force ${YTDLP}`,
    brew: "brew upgrade yt-dlp",
    "apt-pipx": `sudo apt install pipx && pipx install --force ${YTDLP}`
  }[m];
}
function ytdlpUpgrade(m) {
  return {
    uv: "uv tool upgrade yt-dlp",
    pipx: "pipx upgrade yt-dlp",
    brew: "brew upgrade yt-dlp",
    "apt-pipx": `sudo apt install pipx && pipx install --force ${YTDLP}`
  }[m];
}
function ytdlpAgeDays(version, today) {
  const m = version.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m)
    return null;
  const released = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((now - released) / 86400000);
}
function buildReport(statuses, platform, runtime, today, has) {
  const mgr = pickManager(platform, has);
  const found = (n) => statuses.find((s) => s.name === n)?.found ?? false;
  const missing = [];
  const add = (item) => {
    if (!missing.some((m) => m.install === item.install))
      missing.push(item);
  };
  const sudo = mgr === "apt-pipx";
  const pipxHint = sudo ? { needsSudo: true, note: PIPX_NOTE } : { needsSudo: false };
  if (!found("yt-dlp"))
    add({ name: "yt-dlp", install: ytdlpInstall(mgr), ...pipxHint });
  else if (!found("yt-dlp-ejs"))
    add({ name: "yt-dlp-ejs", install: ytdlpReinstall(mgr), ...pipxHint });
  if (!found("ffmpeg") || !found("ffprobe")) {
    add({
      name: "ffmpeg",
      install: platform === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg",
      needsSudo: platform !== "darwin"
    });
  }
  const stale = [];
  const yt = statuses.find((s) => s.name === "yt-dlp");
  if (yt?.found && yt.version) {
    const age = ytdlpAgeDays(yt.version, today);
    if (age !== null && age > STALE_DAYS) {
      stale.push({ name: "yt-dlp", version: yt.version, ageDays: age, upgrade: ytdlpUpgrade(mgr), ...pipxHint });
    }
  }
  return { ok: missing.length === 0, platform, runtime, missing, stale };
}

// src/fetch-cmd.ts
import { existsSync, statSync } from "node:fs";
import { mkdir as mkdir3, readdir as readdir3, readFile as readFile4, rm as rm2, writeFile as writeFile3 } from "node:fs/promises";
import { basename as basename2, extname as extname2, join as join5 } from "node:path";

// src/asr/presets.ts
var GROQ = { url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" };
function resolveProvider(p) {
  const keys = { keyFile: p.keyFile ?? null, keyEnv: p.keyEnv ?? null };
  const pick = (own, preset) => own !== undefined ? own : preset;
  const trimUrl = (u) => u.replace(/\/+$/, "");
  if (p.type === "whisperx") {
    if (!p.url)
      throw new UserError(`config: provider ${p.name}: url is required`);
    return {
      name: p.name,
      type: p.type,
      url: trimUrl(p.url),
      model: null,
      format: null,
      diarize: p.diarize ?? true,
      local: p.local ?? true,
      maxBytes: p.maxBytes ?? null,
      maxSeconds: p.maxSeconds ?? null,
      keyRequired: false,
      ...keys
    };
  }
  const local = p.local ?? false;
  let { url, model } = p;
  let presetBytes = null, presetSeconds = null;
  let diarize = false;
  let format = "verbose_json";
  if (p.preset === "groq") {
    url ??= GROQ.url;
    model ??= GROQ.model;
    if (p.tier === "dev")
      presetBytes = 1e8;
    else {
      presetBytes = 25000000;
      presetSeconds = 7000;
    }
  } else if (p.preset === "openai") {
    url ??= "https://api.openai.com/v1";
    diarize = p.diarize ?? false;
    model ??= diarize ? "gpt-4o-transcribe-diarize" : "whisper-1";
    if (diarize)
      format = "diarized_json";
    presetBytes = 25000000;
  } else {
    if (!url)
      throw new UserError(`config: provider ${p.name}: url is required`);
    if (!model)
      throw new UserError(`config: provider ${p.name}: model is required without preset`);
  }
  return {
    name: p.name,
    type: p.type,
    url: trimUrl(url),
    model,
    format,
    diarize,
    local,
    maxBytes: pick(p.maxBytes, presetBytes),
    maxSeconds: pick(p.maxSeconds, presetSeconds),
    keyRequired: !local,
    ...keys
  };
}

// src/limits.ts
var HEADROOM = 0.96;
var usableBytes = (p) => p.maxBytes === null ? null : Math.floor(HEADROOM * p.maxBytes);
function targetBytes(ps) {
  const caps = ps.filter((p) => !p.local && p.maxBytes !== null).map((p) => p.maxBytes);
  return caps.length ? Math.floor(HEADROOM * Math.min(...caps)) : null;
}
function bitrateFor(durationSec, mode, target) {
  if (mode === "fixed" || target === null || durationSec === null || durationSec <= 0)
    return 32;
  return Math.min(32, Math.max(16, Math.floor(target * 8 / durationSec / 1000)));
}
function maxDurationFor(p, kbps) {
  const usable = usableBytes(p);
  const byBytes = usable === null ? null : Math.floor(usable * 8 / (kbps * 1000));
  if (byBytes === null)
    return p.maxSeconds;
  return p.maxSeconds === null ? byBytes : Math.min(p.maxSeconds, byBytes);
}
function limitsReport(ps) {
  return ps.map((p) => ({ provider: p.name, adaptiveSec: maxDurationFor(p, 16), fixedSec: maxDurationFor(p, 32) }));
}

// src/asr/openai-compatible.ts
import { openAsBlob } from "node:fs";

// src/asr/language.ts
var WHISPER_NAMES = {
  english: "en",
  chinese: "zh",
  german: "de",
  spanish: "es",
  russian: "ru",
  korean: "ko",
  french: "fr",
  japanese: "ja",
  portuguese: "pt",
  turkish: "tr",
  polish: "pl",
  catalan: "ca",
  dutch: "nl",
  arabic: "ar",
  swedish: "sv",
  italian: "it",
  indonesian: "id",
  hindi: "hi",
  finnish: "fi",
  vietnamese: "vi",
  hebrew: "he",
  ukrainian: "uk",
  greek: "el",
  malay: "ms",
  czech: "cs",
  romanian: "ro",
  danish: "da",
  hungarian: "hu",
  tamil: "ta",
  norwegian: "no",
  thai: "th",
  urdu: "ur",
  croatian: "hr",
  bulgarian: "bg",
  lithuanian: "lt",
  latin: "la",
  maori: "mi",
  malayalam: "ml",
  welsh: "cy",
  slovak: "sk",
  telugu: "te",
  persian: "fa",
  latvian: "lv",
  bengali: "bn",
  serbian: "sr",
  azerbaijani: "az",
  slovenian: "sl",
  kannada: "kn",
  estonian: "et",
  macedonian: "mk",
  breton: "br",
  basque: "eu",
  icelandic: "is",
  armenian: "hy",
  nepali: "ne",
  mongolian: "mn",
  bosnian: "bs",
  kazakh: "kk",
  albanian: "sq",
  swahili: "sw",
  galician: "gl",
  marathi: "mr",
  punjabi: "pa",
  sinhala: "si",
  khmer: "km",
  shona: "sn",
  yoruba: "yo",
  somali: "so",
  afrikaans: "af",
  occitan: "oc",
  georgian: "ka",
  belarusian: "be",
  tajik: "tg",
  sindhi: "sd",
  gujarati: "gu",
  amharic: "am",
  yiddish: "yi",
  lao: "lo",
  uzbek: "uz",
  faroese: "fo",
  "haitian creole": "ht",
  pashto: "ps",
  turkmen: "tk",
  nynorsk: "nn",
  maltese: "mt",
  sanskrit: "sa",
  luxembourgish: "lb",
  myanmar: "my",
  tibetan: "bo",
  tagalog: "tl",
  malagasy: "mg",
  assamese: "as",
  tatar: "tt",
  hawaiian: "haw",
  lingala: "ln",
  hausa: "ha",
  bashkir: "ba",
  javanese: "jw",
  sundanese: "su",
  cantonese: "yue"
};
function normalizeLanguage(raw) {
  const v = raw?.trim().toLowerCase();
  if (!v)
    return null;
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(v) && !(v in WHISPER_NAMES))
    return v.split("-")[0];
  return WHISPER_NAMES[v] ?? null;
}

// src/net.ts
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
var oneLine = (s) => s.replace(/\s+/g, " ").trim();
var GENERIC = new Set(["Error", "TypeError"]);
function netErrorTag(e) {
  if (typeof e !== "object" || e === null)
    return "unknown error";
  const err = e;
  for (const c of [err.cause?.code, err.code])
    if (typeof c === "string" && c)
      return c;
  for (const n of [err.cause?.name, err.name])
    if (typeof n === "string" && n && !GENERIC.has(n))
      return n;
  return typeof err.name === "string" && err.name ? err.name : "unknown error";
}
var runtimeFetch = (versions) => versions.bun ? globalThis.fetch : httpFetch;
var NULL_BODY = new Set([204, 205, 304]);
var REDIRECT = new Set([301, 302, 303, 307, 308]);
var MAX_REDIRECTS = 5;
var CROSS_ORIGIN_DROP = ["authorization", "proxy-authorization", "cookie"];
var httpFetch = (input, init = {}) => send(new URL(input), init, MAX_REDIRECTS);
async function send(url, init, redirects) {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const signal = init.signal ?? undefined;
  let body;
  if (typeof init.body === "string") {
    body = init.body;
  } else if (init.body instanceof FormData) {
    const encoded = new Response(init.body);
    headers.set("content-type", encoded.headers.get("content-type"));
    body = Readable.fromWeb(encoded.body);
  } else if (init.body != null) {
    throw new TypeError("httpFetch: unsupported body type");
  }
  const res = await new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers: Object.fromEntries(headers), signal }, resolve);
    req.on("error", (e) => {
      if (body instanceof Readable)
        body.destroy();
      reject(signal?.aborted ? signal.reason : e);
    });
    if (body instanceof Readable) {
      body.on("error", (e) => req.destroy(e));
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
  const status = res.statusCode ?? 0;
  const location = res.headers.location;
  if (REDIRECT.has(status) && location && (method === "GET" || method === "HEAD") && redirects > 0) {
    res.resume();
    const next = new URL(location, url);
    if (next.origin === url.origin)
      return send(next, init, redirects - 1);
    const stripped = new Headers(init.headers);
    for (const h of CROSS_ORIGIN_DROP)
      stripped.delete(h);
    return send(next, { ...init, headers: stripped }, redirects - 1);
  }
  const out = new Headers;
  for (let i = 0;i < res.rawHeaders.length; i += 2)
    out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  if (NULL_BODY.has(status) || method === "HEAD") {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers: out });
  }
  const onAbort = () => res.destroy(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  res.on("close", () => signal?.removeEventListener("abort", onAbort));
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
  let stream = res;
  if (decoder) {
    res.on("error", (e) => decoder.destroy(e));
    stream = res.pipe(decoder);
    out.delete("content-encoding");
    out.delete("content-length");
  }
  return new Response(Readable.toWeb(stream), { status, statusText: res.statusMessage, headers: out });
}

// src/asr/types.ts
var primaryLang = (l) => l ? l.split(/[-_]/)[0].toLowerCase() || null : null;
var joinUrl = (base, path) => base.replace(/\/+$/, "") + path;
var authHeaders = (key) => key ? { Authorization: `Bearer ${key}` } : {};
var ASR_TIMEOUT_MS = 30 * 60000;
async function postAsr(name, f, url, headers, body, timeoutMs = ASR_TIMEOUT_MS) {
  try {
    const init = { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs), timeout: false };
    const r = await f(url, init);
    return { status: r.status, ok: r.ok, text: await r.text() };
  } catch (e) {
    throw new UserError(`${name}: request failed — ${netErrorTag(e)}`);
  }
}

// src/asr/openai-compatible.ts
async function modelsReachable(url, f, key) {
  try {
    const r = await f(joinUrl(url, "/models"), { headers: authHeaders(key), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}
function parseVerbose(json, provider) {
  const body = json;
  const cues = (body.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
  return { cues, provider, diarized: false, speakers: 0, language: normalizeLanguage(body.language) };
}
function parseDiarized(json, provider) {
  const body = json;
  const names = new Map;
  const cues = (body.segments ?? []).map((s) => {
    const cue = { start: s.start, end: s.end, text: s.text.trim() };
    if (!s.speaker)
      return cue;
    if (!names.has(s.speaker))
      names.set(s.speaker, `Speaker ${names.size + 1}`);
    return { ...cue, speaker: names.get(s.speaker) };
  });
  return { cues, provider, diarized: names.size > 0, speakers: names.size, language: normalizeLanguage(body.language) };
}
async function transcribeOpenAI(file, o, p, key, f) {
  const diarized = p.format === "diarized_json";
  const lang = primaryLang(o.language);
  const form = new FormData;
  form.append("file", await openAsBlob(file), "audio.ogg");
  form.append("model", p.model ?? "");
  form.append("response_format", diarized ? "diarized_json" : "verbose_json");
  if (diarized)
    form.append("chunking_strategy", "auto");
  else
    form.append("timestamp_granularities[]", "segment");
  if (lang)
    form.append("language", lang);
  const r = await postAsr(p.name, f, joinUrl(p.url, "/audio/transcriptions"), authHeaders(key), form);
  const text = r.text;
  if (r.status === 429) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {}
    throw new UserError(`${p.name}: rate limit — ${oneLine(String(msg)).slice(0, 500)}`);
  }
  if (!r.ok)
    throw new Error(`${p.name} responded ${r.status}: ${oneLine(text).slice(0, 500)}`);
  const res = (diarized ? parseDiarized : parseVerbose)(JSON.parse(text), p.name);
  return lang ? { ...res, language: lang } : res;
}

// src/asr/whisperx.ts
import { openAsBlob as openAsBlob2 } from "node:fs";
async function whisperxHealthy(url, f, key) {
  try {
    const r = await f(joinUrl(url, "/health"), { headers: authHeaders(key), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}
function parseWhisperx(json, provider) {
  const body = json;
  const names = new Map;
  const cues = (body.segments ?? []).map((s) => {
    const cue = { start: s.start, end: s.end, text: s.text.trim() };
    if (!s.speaker)
      return cue;
    if (!names.has(s.speaker))
      names.set(s.speaker, `Speaker ${names.size + 1}`);
    return { ...cue, speaker: names.get(s.speaker) };
  });
  return { cues, provider, diarized: names.size > 0, speakers: names.size, language: normalizeLanguage(body.language) };
}
async function transcribeWhisperx(file, o, p, key, f) {
  const q = new URLSearchParams({ output: "json", diarize: String(o.diarize && p.diarize), word_timestamps: "false" });
  const lang = primaryLang(o.language);
  if (lang)
    q.set("language", lang);
  const form = new FormData;
  form.append("audio_file", await openAsBlob2(file), "audio.ogg");
  const r = await postAsr(p.name, f, `${joinUrl(p.url, "/asr")}?${q}`, authHeaders(key), form);
  if (!r.ok)
    throw new Error(`${p.name}: whisperx responded ${r.status}: ${oneLine(r.text).slice(0, 500)}`);
  return parseWhisperx(JSON.parse(r.text), p.name);
}

// src/asr/select.ts
async function probeProviders(ps, f, env, home) {
  return Promise.all(ps.map(async (provider) => {
    let key = null;
    let keyMissing = null;
    try {
      key = await readKey(provider, env, home);
      if (provider.keyRequired && key === null)
        keyMissing = keySource(provider) ?? "no key configured";
    } catch (e) {
      if (!(e instanceof UserError))
        throw e;
      return { provider, available: true, keyMissing: e.message };
    }
    let available = true;
    if (provider.type === "whisperx")
      available = await whisperxHealthy(provider.url, f, key);
    else if (provider.local)
      available = await modelsReachable(provider.url, f, key);
    return { provider, available, keyMissing };
  }));
}
var hms = (sec) => {
  const s = Math.floor(sec);
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
};
var mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
function reject(c, i) {
  const p = c.provider;
  if (!c.available)
    return "not reachable";
  if (c.keyMissing)
    return `no API key (${c.keyMissing})`;
  if (p.maxSeconds !== null && i.durationSec > p.maxSeconds) {
    return `${hms(i.durationSec)} exceeds duration limit ${hms(p.maxSeconds)}`;
  }
  const bytes = i.durationSec * i.kbps * 1000 / 8;
  const usable = usableBytes(p);
  if (p.maxBytes !== null && usable !== null && bytes > usable) {
    return `~${mb(bytes)} exceeds ${Math.round(HEADROOM * 100)}% of file limit ${mb(p.maxBytes)}`;
  }
  if (!p.local && i.privateSource && !i.allowCloud)
    return "cloud provider, needs --allow-cloud";
  return null;
}
function chooseProvider(i) {
  if (i.candidates.length === 0)
    return { error: "no ASR providers configured — run setup (see references/setup.md)" };
  const reasons = [];
  for (const c of i.candidates) {
    const why = reject(c, i);
    if (why === null)
      return { provider: c.provider };
    reasons.push(`${c.provider.name}: ${why}`);
  }
  return { error: `no ASR provider fits: ${reasons.join("; ")}` };
}
async function transcribeWith(p, file, o, f, env, home) {
  const key = await readKey(p, env, home);
  if (p.keyRequired && key === null)
    throw new UserError(`${p.name}: no API key (${keySource(p) ?? "no key configured"})`);
  return p.type === "whisperx" ? transcribeWhisperx(file, o, p, key, f) : transcribeOpenAI(file, o, p, key, f);
}

// src/audio.ts
import { rename, rm } from "node:fs/promises";
async function compressAudio(input, outOgg, run, kbps = 32) {
  const tmp = `${outOgg}.tmp`;
  const r = await run([
    "ffmpeg",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-b:a",
    `${kbps}k`,
    "-f",
    "ogg",
    tmp
  ]);
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    throw new Error(`ffmpeg: ${r.stderr.trim()}`);
  }
  await rename(tmp, outOgg);
}
async function probeDuration(file, run) {
  const r = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const sec = Number.parseFloat(r.stdout.trim());
  if (r.code !== 0 || !Number.isFinite(sec))
    throw new UserError(`could not determine duration: ${file}`);
  return sec;
}

// src/captions.ts
var TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
function parseTime(t) {
  const parts = t.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function parseBlocks(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, `
`).split(/\n[ \t]*\n/)) {
    const lines = block.split(`
`);
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i === -1)
      continue;
    const m = lines[i].match(TIMING);
    const body = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean).join(" ");
    cues.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: body });
  }
  return cues;
}
function parseVtt(text) {
  return parseBlocks(text);
}
function parseSrt(text) {
  return parseBlocks(text);
}
var NOISE = new Set(["music", "музыка", "applause", "аплодисменты", "laughter", "смех", "silence", "тишина"]);
var ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
var TAGS = /<\/?(?:(?:c|i|b|u|ruby|rt)(?:\.[^>\s]*)*|(?:v|lang)(?:\.[^>\s]*)*(?:\s[^>]*)?)>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/g;
function cleanText(t) {
  return t.replace(TAGS, "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]).replace(/[♪♫]/g, "").replace(/\s+/g, " ").trim();
}
function isNoise(t) {
  const m = t.match(/^[[(](.*)[\])]$/);
  if (!m)
    return false;
  const inner = m[1].trim().toLowerCase();
  return inner === "" || NOISE.has(inner);
}
function cleanCues(cues) {
  const out = [];
  for (const c of cues) {
    const text = cleanText(c.text);
    if (!text || isNoise(text))
      continue;
    const prev = out.at(-1);
    if (prev && prev.text === text && prev.speaker === c.speaker)
      continue;
    out.push({ ...c, text });
  }
  return out;
}
var SENTENCE_END = /[.!?…]["»”)]?$/;
function toParagraphs(cues) {
  const ps = [];
  let para = null;
  let prev = null;
  for (const c of cues) {
    const span = para ? c.start - para.start : 0;
    const split = !para || !prev || c.speaker !== para.speaker || span >= 120 || span >= 60 && SENTENCE_END.test(prev.text) || c.start - prev.end >= 3 && span >= 20;
    if (split) {
      para = c.speaker ? { start: c.start, speaker: c.speaker, text: c.text } : { start: c.start, text: c.text };
      ps.push(para);
    } else {
      para.text += ` ${c.text}`;
    }
    prev = c;
  }
  return ps;
}
function formatTs(sec) {
  const s = Math.floor(sec);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
}
function renderTranscript(title, ps) {
  const body = ps.map((p) => `[${formatTs(p.start)}] ${p.speaker ? `**${p.speaker}:** ` : ""}${p.text}`);
  return `# ${title}

${body.join(`

`)}
`;
}
function dedupeRolling(cues) {
  const out = [];
  let prev = [];
  for (const c of cues) {
    const cur = c.text.split(/\s+/).filter(Boolean);
    let cut = 0;
    for (let n = Math.min(prev.length, cur.length);n > 0; n--) {
      if (prev.slice(-n).every((w, i) => w === cur[i])) {
        cut = n;
        break;
      }
    }
    prev = cur;
    const text = cur.slice(cut).join(" ");
    if (text)
      out.push({ ...c, text });
  }
  return out;
}

// src/meta.ts
import { access, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
async function readMeta(dir) {
  const p = join2(dir, "meta.json");
  try {
    await access(p);
  } catch {
    return null;
  }
  return JSON.parse(await readFile2(p, "utf8"));
}
async function writeMeta(dir, m) {
  await writeFile2(join2(dir, "meta.json"), JSON.stringify(m, null, 2) + `
`);
}
function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

// src/paths.ts
import { mkdir as mkdir2, readdir, readFile as readFile3 } from "node:fs/promises";
import { basename, dirname as dirname2, extname, join as join3, resolve } from "node:path";
function slugify(title) {
  const s = title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const cut = Array.from(s).slice(0, 60).join("").replace(/-+$/g, "");
  return cut || "video";
}
function resolveInputPath(p, cwd, home) {
  if (p === "~" || p.startsWith("~/"))
    return join3(home, p.slice(1));
  return resolve(cwd, p);
}
async function findSidecarSubs(absFile, preferLang) {
  const dir = dirname2(absFile);
  const stem = basename(absFile, extname(absFile));
  const rests = (await readdir(dir)).filter((e) => e.startsWith(`${stem}.`)).map((e) => ({ e, rest: e.slice(stem.length + 1) }));
  for (const ext of ["srt", "vtt"]) {
    const hit = rests.find((r) => r.rest.toLowerCase() === ext);
    if (hit)
      return join3(dir, hit.e);
  }
  const lang = rests.filter((r) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*\.(srt|vtt)$/i.test(r.rest)).map((r) => r.e).sort();
  if (!lang.length)
    return null;
  const want = preferLang?.toLowerCase().split("-")[0];
  const hit = want ? lang.find((e) => e.slice(stem.length + 1).split(".")[0].toLowerCase().split("-")[0] === want) : undefined;
  return join3(dir, hit ?? lang[0]);
}
function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
async function sourceKeyOf(dir) {
  try {
    return JSON.parse(await readFile3(join3(dir, "meta.json"), "utf8")).source_key ?? null;
  } catch {
    return null;
  }
}
async function resolveItemDir(baseDir, sourceKey, title, today) {
  await mkdir2(baseDir, { recursive: true });
  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && await sourceKeyOf(join3(baseDir, e.name)) === sourceKey)
      return join3(baseDir, e.name);
  }
  const names = new Set(entries.map((e) => e.name));
  const stem = `${localDate(today)}-${slugify(title)}`;
  let name = stem;
  for (let i = 2;names.has(name); i++)
    name = `${stem}-${i}`;
  const dir = join3(baseDir, name);
  await mkdir2(dir, { recursive: true });
  return dir;
}

// src/ytdlp.ts
import { readdir as readdir2 } from "node:fs/promises";
import { join as join4 } from "node:path";
var YTDLP_BASE = ["yt-dlp", "--js-runtimes", "node", "--js-runtimes", "bun", "--no-playlist"];
function ytdlpError(stderr) {
  const lines = stderr.split(`
`).filter((l) => l.startsWith("ERROR:"));
  return new UserError(`yt-dlp: ${lines.at(-1) ?? stderr.trim().split(`
`).at(-1) ?? "unknown error"}`);
}
async function fetchMeta(url, run) {
  const r = await run([...YTDLP_BASE, "--dump-single-json", "--flat-playlist", "--skip-download", "--no-warnings", url]);
  if (r.code !== 0)
    throw ytdlpError(r.stderr);
  const m = JSON.parse(r.stdout);
  if (m._type === "playlist")
    throw new UserError("this is a playlist — give a link to a single video");
  if (m.is_live)
    throw new UserError("the stream is still live — wait for the recording");
  return m;
}
function pickManualTrack(m) {
  const tracks = Object.keys(m.subtitles ?? {}).filter((k) => k !== "live_chat");
  if (!m.language)
    return tracks.length === 1 ? tracks[0] : null;
  const lang = m.language.toLowerCase();
  const exact = tracks.find((t) => t.toLowerCase() === lang);
  if (exact)
    return exact;
  const primary = lang.split("-")[0];
  const same = tracks.filter((t) => t.toLowerCase().split("-")[0] === primary).sort();
  return same[0] ?? null;
}
function pickAutoTrack(m) {
  if (!m.language)
    return null;
  const lang = m.language.toLowerCase();
  const keys = Object.keys(m.automatic_captions ?? {});
  const primary = lang.split("-")[0];
  for (const want of [`${lang}-orig`, `${primary}-orig`, lang, primary]) {
    const hit = keys.find((k) => k.toLowerCase() === want);
    if (hit)
      return hit;
  }
  return null;
}
async function findOne(dir, prefix, exts) {
  const hit = (await readdir2(dir)).filter((f) => f.startsWith(prefix) && !f.endsWith(".part") && !f.endsWith(".ytdl") && (!exts || exts.some((x) => f.endsWith(x)))).sort();
  return hit.length ? join4(dir, hit[0]) : null;
}
var RETRY_DELAYS_MS = [2000, 5000];
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runDownload(cmd, run, sleep) {
  for (let attempt = 0;; attempt++) {
    const r = await run(cmd);
    if (r.code === 0)
      return;
    if (!/HTTP Error 403/.test(r.stderr) || attempt >= RETRY_DELAYS_MS.length)
      throw ytdlpError(r.stderr);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}
async function downloadSubs(url, lang, workDir, run, auto = false, sleep = defaultSleep) {
  await runDownload([
    ...YTDLP_BASE,
    "--skip-download",
    auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    lang,
    "--sub-format",
    "vtt/srt/best",
    "-o",
    join4(workDir, "subs.%(ext)s"),
    url
  ], run, sleep);
  const f = await findOne(workDir, "subs.", [".vtt", ".srt"]);
  if (!f)
    throw new UserError(`yt-dlp did not download ${lang} subtitles in vtt or srt format`);
  return f;
}
async function downloadAudio(url, workDir, run, sleep = defaultSleep) {
  await runDownload([...YTDLP_BASE, "-f", "bestaudio/best", "-o", join4(workDir, "src.%(ext)s"), url], run, sleep);
  const f = await findOne(workDir, "src.");
  if (!f)
    throw new UserError("yt-dlp did not download the audio");
  return f;
}

// src/fetch-cmd.ts
async function coversDuration(ogg, expected, run) {
  try {
    return Math.abs(await probeDuration(ogg, run) - expected) <= Math.max(5, expected * 0.02);
  } catch {
    return false;
  }
}
async function readSubs(file) {
  const text = await readFile4(file, "utf8");
  return file.endsWith(".srt") ? parseSrt(text) : parseVtt(text);
}
async function recognize(getAudio, work, item, flags, d) {
  const providers = d.cfg.providers.map(resolveProvider);
  const candidates = await probeProviders(providers, d.fetch, d.env, d.home);
  const kbps = bitrateFor(item.duration, d.cfg.bitrate, targetBytes(providers));
  const pick = (durationSec, rate = kbps) => {
    const c = chooseProvider({ candidates, durationSec, kbps: rate, privateSource: item.privateSource, allowCloud: flags.allowCloud });
    if ("error" in c)
      throw new UserError(c.error);
    return c.provider;
  };
  let durationSec = item.duration;
  let rate = kbps;
  let provider = durationSec !== null ? pick(durationSec) : null;
  if (!provider)
    pick(0);
  const ogg = join5(work, "audio.ogg");
  if (existsSync(ogg)) {
    const covers = item.duration === null || await coversDuration(ogg, item.duration, d.run);
    const fits = !provider || provider.maxBytes === null || statSync(ogg).size <= provider.maxBytes;
    if (!covers || !fits)
      await rm2(ogg, { force: true });
  }
  if (!existsSync(ogg)) {
    const src = await getAudio();
    await compressAudio(src, ogg, d.run, kbps);
    if (!provider) {
      const real = await probeDuration(ogg, d.run);
      const better = bitrateFor(real, d.cfg.bitrate, targetBytes(providers));
      rate = Math.min(better, kbps);
      if (better < kbps)
        await compressAudio(src, ogg, d.run, better);
      durationSec = real;
      provider = pick(real, rate);
    }
    for (const f of await readdir3(work))
      if (f.startsWith("src."))
        await rm2(join5(work, f), { force: true });
  }
  if (durationSec === null)
    durationSec = await probeDuration(ogg, d.run);
  if (!provider)
    provider = pick(durationSec);
  const failed = [];
  const tried = new Set;
  const size = statSync(ogg).size;
  for (;; ) {
    tried.add(provider.name);
    if (provider.maxBytes !== null && size > provider.maxBytes) {
      failed.push(`${provider.name}: compressed audio is ${size} bytes, over the file limit ${provider.maxBytes}`);
    } else {
      try {
        const opts = { language: primaryLang(item.language), diarize: flags.diarize };
        return { asr: await transcribeWith(provider, ogg, opts, d.fetch, d.env, d.home), failed };
      } catch (e) {
        failed.push(e.message);
      }
    }
    const rest = candidates.filter((c) => !tried.has(c.provider.name));
    const next = chooseProvider({ candidates: rest, durationSec, kbps: rate, privateSource: item.privateSource, allowCloud: flags.allowCloud });
    if ("error" in next) {
      const why = rest.length ? `; no other provider fits: ${next.error.replace(/^no ASR provider fits: /, "")}` : "";
      throw new UserError(`speech recognition failed: ${failed.join("; ")}${why}`);
    }
    provider = next.provider;
  }
}
var looksLikeLink = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(s);
async function fetchCmd(input, flags, d) {
  const isUrl = /^https?:\/\//i.test(input);
  let item;
  let get;
  if (isUrl) {
    const vm = await fetchMeta(input, d.run);
    item = {
      sourceKey: `${vm.extractor_key}:${vm.id}`,
      title: vm.title,
      url: vm.webpage_url,
      path: null,
      id: vm.id,
      uploader: vm.uploader,
      upload_date: vm.upload_date,
      duration: vm.duration,
      language: vm.language,
      thumbnail: vm.thumbnail ?? null,
      privateSource: vm.extractor_key === "Generic"
    };
    const manual = pickManualTrack(vm);
    const auto = !manual && d.cfg.subtitles === "manual+auto" ? pickAutoTrack(vm) : null;
    get = async (work) => {
      if (manual) {
        const cues = await readSubs(await downloadSubs(vm.webpage_url, manual, work, d.run));
        return { cues, source: vm.extractor_key === "Youtube" ? "youtube-manual-subs" : "manual-subs", asr: null };
      }
      const viaAsr = async () => {
        const { asr, failed } = await recognize(() => downloadAudio(vm.webpage_url, work, d.run), work, item, flags, d);
        return { cues: asr.cues, source: "asr", asr, asrFailed: failed };
      };
      if (!auto)
        return viaAsr();
      let autoError;
      try {
        const cues = await readSubs(await downloadSubs(vm.webpage_url, auto, work, d.run, true));
        return { cues: dedupeRolling(cues), source: "youtube-auto-subs", asr: null };
      } catch (e) {
        if (!(e instanceof UserError))
          throw e;
        autoError = e;
      }
      try {
        return await viaAsr();
      } catch (e) {
        if (!(e instanceof UserError))
          throw e;
        throw new UserError(`auto captions could not be downloaded (${autoError.message}); ${e.message}`);
      }
    };
  } else {
    const abs = resolveInputPath(input, d.cwd, d.home);
    if (!existsSync(abs)) {
      throw new UserError(`file not found: ${abs}${looksLikeLink(input) ? " — if this is a link, add https://" : ""}`);
    }
    item = {
      sourceKey: `file:${abs}`,
      title: basename2(abs, extname2(abs)),
      url: null,
      path: abs,
      id: null,
      uploader: null,
      upload_date: null,
      duration: await probeDuration(abs, d.run),
      language: null,
      thumbnail: null,
      privateSource: true
    };
    get = async (work) => {
      const lang = d.cfg.summaryLanguage === "auto" ? null : d.cfg.summaryLanguage;
      const side = await findSidecarSubs(abs, lang);
      if (side)
        return { cues: await readSubs(side), source: "sidecar-subs", asr: null };
      const { asr, failed } = await recognize(async () => abs, work, item, flags, d);
      return { cues: asr.cues, source: "asr", asr, asrFailed: failed };
    };
  }
  const dir = await resolveItemDir(expandHome(d.cfg.outputDir, d.home), item.sourceKey, item.title, d.now);
  const prev = await readMeta(dir);
  if (!prev)
    await writeFile3(join5(dir, "meta.json"), JSON.stringify({ source_key: item.sourceKey }) + `
`);
  const transcriptPath = join5(dir, "transcript.md");
  const summaryPath = join5(dir, "summary.md");
  if (prev?.source && existsSync(transcriptPath) && !flags.force)
    return toResult(prev, dir, transcriptPath, summaryPath);
  const work = join5(dir, ".work");
  await mkdir3(work, { recursive: true });
  const got = await get(work);
  await rm2(work, { recursive: true, force: true });
  const transcript = renderTranscript(item.title, toParagraphs(cleanCues(got.cues)));
  await writeFile3(transcriptPath, transcript);
  const meta = {
    source_key: item.sourceKey,
    source: got.source,
    asr_provider: got.asr?.provider ?? null,
    diarized: got.asr?.diarized ?? false,
    speakers: got.asr?.speakers ?? 0,
    url: item.url,
    path: item.path,
    id: item.id,
    title: item.title,
    uploader: item.uploader,
    upload_date: item.upload_date,
    duration: item.duration,
    language: item.language ?? got.asr?.language ?? null,
    created_at: d.now.toISOString(),
    transcript_tokens: estimateTokens(transcript),
    readeck_bookmark_id: prev?.readeck_bookmark_id ?? null,
    readeck_summary_sha: prev?.readeck_summary_sha ?? null,
    thumbnail: item.thumbnail
  };
  await writeMeta(dir, meta);
  const result = toResult(meta, dir, transcriptPath, summaryPath);
  return got.asrFailed?.length ? { ...result, asr_failed: got.asrFailed } : result;
}
function toResult(meta, dir, transcriptPath, summaryPath) {
  return {
    dir,
    transcript_path: transcriptPath,
    summary_path: summaryPath,
    summary_exists: existsSync(summaryPath),
    source: meta.source,
    asr_provider: meta.asr_provider,
    diarized: meta.diarized,
    speakers: meta.speakers,
    language: meta.language,
    duration: meta.duration,
    transcript_tokens: meta.transcript_tokens,
    url: meta.url
  };
}

// src/readeck.ts
import { createHash } from "node:crypto";
import { readFile as readFile6, stat as stat2 } from "node:fs/promises";
import { join as join7 } from "node:path";

// node_modules/marked/lib/marked.esm.js
function I() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var y = I();
function W(l) {
  y = l;
}
var A = { exec: () => null };
function C(l) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
    return s || (s = l(n), e[n] = s), s;
  };
}
function h(l, e = "") {
  let t = typeof l == "string" ? l : l.source, n = { replace: (s, r) => {
    let o = typeof r == "string" ? r : r.source;
    return o = o.replace(x.caret, "$1"), t = t.replace(s, o), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var _e = ((l = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l);
  } catch {
    return false;
  }
})();
var x = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l) => new RegExp(`^( {0,3}${l})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: C((l) => new RegExp(`^ {0,${l}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: C((l) => new RegExp(`^ {0,${l}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: C((l) => new RegExp(`^ {0,${l}}(?:\`\`\`|~~~)`)), headingBeginRegex: C((l) => new RegExp(`^ {0,${l}}#`)), htmlBeginRegex: C((l) => new RegExp(`^ {0,${l}}(?:</?(?:${N})(?: +|$|/?>)|<(?:script|pre|style|textarea|!--))`, "i")), blockquoteBeginRegex: C((l) => new RegExp(`^ {0,${l}}>`)) };
var $e = /^(?:[ \t]*(?:\n|$))+/;
var Le = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var ze = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var G = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Ae = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var J = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var ce = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var he = h(ce).replace(/bull/g, J).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Ee = h(ce).replace(/bull/g, J).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var V = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var Me = /^[^\n]+/;
var Y = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var Ie = h(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", Y).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var Ce = h(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, J).getRegex();
var N = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var ee = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var Be = h("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i").replace("comment", ee).replace("tag", N).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var de = (l) => h(V).replace("hr", G).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", l).replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", N).getRegex();
var De = de(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var qe = de(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var ve = h(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", qe).getRegex();
var te = { blockquote: ve, code: Le, def: Ie, fences: ze, heading: Ae, hr: G, html: Be, lheading: he, list: Ce, newline: $e, paragraph: De, table: A, text: Me };
var le = h("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", G).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}\t)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", N).getRegex();
var Ze = { ...te, lheading: Ee, table: le, paragraph: h(V).replace("hr", G).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", le).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", N).getRegex() };
var He = { ...te, html: h(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", ee).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: A, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: h(V).replace("hr", G).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", he).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Ge = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var Ne = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var ke = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
var Qe = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var $ = /[\p{P}\p{S}]/u;
var B = /[\s\p{P}\p{S}]/u;
var Q = /[^\s\p{P}\p{S}]/u;
var je = h(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, B).getRegex();
var Fe = /[\p{Pi}\p{Ps}"']/u;
var ge = /(?!~)[\p{P}\p{S}]/u;
var Ue = /(?!~)[\s\p{P}\p{S}]/u;
var Ke = /(?:[^\s\p{P}\p{S}]|~)/u;
var We = h(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", _e ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var fe = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var Xe = h(fe, "u").replace(/punct/g, $).getRegex();
var Je = h(fe, "u").replace(/punct/g, ge).getRegex();
var Ve = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
var Ye = h(Ve, "u").replace(/openQuote/g, Fe).replace(/punct/g, $).getRegex();
var me = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var et = h(me, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
var tt = h(me, "gu").replace(/notPunctSpace/g, Ke).replace(/punctSpace/g, Ue).replace(/punct/g, ge).getRegex();
var nt = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
var rt = h(nt, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
var st = h("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
var it = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
var ot = h(it, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
var at = h(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, $).getRegex();
var lt = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var ut = h(lt, "gu").replace(/notPunctSpace/g, Q).replace(/punctSpace/g, B).replace(/punct/g, $).getRegex();
var pt = h(/\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var ct = h(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var ht = h(ee).replace("(?:-->|$)", "-->").getRegex();
var dt = h("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", ht).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var xe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
var U = h(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", xe).getRegex();
var kt = h(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", U).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var gt = h(/^!?\[(label)\]\[(ref)\]/).replace("label", U).replace("ref", Y).getRegex();
var ft = h(/^!?\[(ref)\](?:\[\])?/).replace("ref", Y).getRegex();
var ue = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
var mt = h(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", xe).getRegex();
var xt = h("reflink|nolink(?!\\()", "g").replace("reflink", h(/^!?\[(label)\]\[(ref)\]/).replace("label", mt).replace("ref", ue).getRegex()).replace("nolink", h(/^!?\[(ref)\](?:\[\])?/).replace("ref", ue).getRegex()).getRegex();
var pe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var bt = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
var Rt = h(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, bt).getRegex();
var ne = { _backpedal: A, anyPunctuation: pt, autolink: ct, blockSkip: We, br: ke, code: Ne, del: A, delLDelim: A, delRDelim: A, emStrongLDelim: Xe, emStrongRDelimAst: et, emStrongRDelimUnd: st, escape: Ge, link: kt, nolink: ft, punctuation: je, reflink: gt, reflinkSearch: xt, tag: dt, text: Qe, url: A };
var Tt = { ...ne, emStrongLDelim: Ye, emStrongRDelimAst: rt, emStrongRDelimUnd: ot, link: h(/^!?\[(label)\]\((.*?)\)/).replace("label", U).getRegex(), reflink: h(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", U).getRegex() };
var X = { ...ne, emStrongRDelimAst: tt, emStrongLDelim: Je, delLDelim: at, delRDelim: ut, url: h(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", Rt).replace("protocol", pe).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: h(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", pe).replace(/emailProtocol/g, /(?:mailto|xmpp):/).getRegex() };
var Ot = { ...X, br: h(ke).replace("{2,}", "*").getRegex(), text: h(X.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var j = { normal: te, gfm: Ze, pedantic: He };
var D = { normal: ne, gfm: X, breaks: Ot, pedantic: Tt };
var wt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var be = (l) => wt[l];
function O(l, e) {
  if (e) {
    if (x.escapeTest.test(l))
      return l.replace(x.escapeReplace, be);
  } else if (x.escapeTestNoEncode.test(l))
    return l.replace(x.escapeReplaceNoEncode, be);
  return l;
}
function Re(l) {
  return l.replace(x.numericCharacterReference, (e, t, n) => {
    let s = t === undefined ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    return s === 0 || s > 1114111 || s >= 55296 && s <= 57343 ? "�" : String.fromCodePoint(s);
  });
}
function re(l) {
  try {
    l = encodeURI(l).replace(x.percentDecode, "%");
  } catch {
    return null;
  }
  return l;
}
function se(l, e) {
  let t = l.replace(x.findPipe, (r, o, i) => {
    let u = false, a = o;
    for (;--a >= 0 && i[a] === "\\"; )
      u = !u;
    return u ? "|" : " |";
  }), n = t.split(x.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e)
    if (n.length > e)
      n.splice(e);
    else
      for (;n.length < e; )
        n.push("");
  for (;s < n.length; s++)
    n[s] = n[s].trim().replace(x.slashPipe, "|");
  return n;
}
function L(l, e, t) {
  let n = l.length;
  if (n === 0)
    return "";
  let s = 0;
  for (;s < n; ) {
    let r = l.charAt(n - s - 1);
    if (r === e && !t)
      s++;
    else if (r !== e && t)
      s++;
    else
      break;
  }
  return l.slice(0, n - s);
}
function ie(l) {
  let e = l.split(`
`), t = e.length - 1;
  for (;t >= 0 && x.blankLine.test(e[t]); )
    t--;
  return e.length - t <= 2 ? l : e.slice(0, t + 1).join(`
`);
}
function q(l) {
  return l.trim().toLowerCase().toUpperCase().toLowerCase();
}
function Te(l, e) {
  if (l.indexOf(e[1]) === -1)
    return -1;
  let t = 0;
  for (let n = 0;n < l.length; n++)
    if (l[n] === "\\")
      n++;
    else if (l[n] === e[0])
      t++;
    else if (l[n] === e[1] && (t--, t < 0))
      return n;
  return t > 0 ? -2 : -1;
}
function oe(l, e = 0) {
  let t = e, n = "";
  for (let s of l)
    if (s === "\t") {
      let r = 4 - t % 4;
      n += " ".repeat(r), t += r;
    } else
      n += s, t++;
  return n;
}
function Oe(l, e, t, n, s) {
  let r = e.href, o = e.title || null, i = l[1].replace(s.other.outputLinkReplace, "$1"), u = l[0].charAt(0) === "!";
  n.state.inLink = true;
  let a = n.state.linkEmitted, p = n.state.inRawBlock;
  n.state.linkEmitted = false;
  let c = n.inlineTokens(i), d = n.state.linkEmitted;
  if (n.state.linkEmitted = a, n.state.inLink = false, !u) {
    if (d) {
      n.state.inRawBlock = p;
      return;
    }
    n.state.linkEmitted = true;
  }
  return { type: u ? "image" : "link", raw: t, href: r, title: o, text: i, tokens: c };
}
function yt(l, e, t) {
  let n = l.match(t.other.indentCodeCompensation);
  if (n === null)
    return e;
  let s = n[1];
  return e.split(`
`).map((r) => {
    let o = r.match(t.other.beginningSpace);
    if (o === null)
      return r;
    let [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join(`
`);
}
function we(l, e, t, n) {
  if (!e.includes("<"))
    return false;
  for (let s = 0;s < e.length; s++) {
    if (e[s] === "\\") {
      s++;
      continue;
    }
    if (e[s] === "`") {
      let i = n.inline.code.exec(e.slice(s));
      if (i) {
        s += i[0].length - 1;
        continue;
      }
    }
    if (e[s] !== "<")
      continue;
    let r = l.slice(t + s), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
    if (o) {
      if (o[0].length > e.length - s)
        return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
var P = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || y;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0)
      return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ie(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], s = yt(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let s = L(n, "#");
        (this.options.pedantic || !s || this.rules.other.endingSpaceTabChar.test(s)) && (n = s.trim());
      }
      return { type: "heading", raw: L(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t)
      return { type: "hr", raw: L(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = L(t[0], `
`).split(`
`), s = "", r = "", o = [];
      for (;n.length > 0; ) {
        let i = false, u = [], a;
        for (a = 0;a < n.length; a++)
          if (this.rules.other.blockquoteStart.test(n[a]))
            u.push(n[a]), i = true;
          else if (!i)
            u.push(n[a]);
          else
            break;
        n = n.slice(a);
        let p = u.join(`
`), c = p.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        s = s ? `${s}
${p}` : p, r = r ? `${r}
${c}` : c;
        let d = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(c, o, true), this.lexer.state.top = d, n.length === 0)
          break;
        let m = o.at(-1);
        if (m?.type === "code")
          break;
        if (m?.type === "blockquote") {
          let b = m, g = n.join(`
`), w = b.raw + `
` + g.replace(this.rules.other.blockquoteSetextReplace2, ""), f = this.blockquote(w);
          o[o.length - 1] = f;
          let M = w.substring(f.raw.length).replace(/^\n/, ""), v = M ? M.split(`
`).length : 0, Z = v ? n.slice(0, -v) : n;
          Z.length > 0 && (s = `${s}
${Z.join(`
`)}`), r = r.substring(0, r.length - b.text.length) + f.text;
          break;
        } else if (m?.type === "list") {
          let b = m, g = b.raw + `
` + n.join(`
`), w = this.list(g);
          o[o.length - 1] = w, s = s.substring(0, s.length - m.raw.length) + w.raw, r = r.substring(0, r.length - b.raw.length) + w.raw, n = g.substring(o.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: s, tokens: o, text: r };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = t[1].trim(), s = n.length > 1, r = { type: "list", raw: "", ordered: s, start: s ? +n.slice(0, -1) : "", loose: false, items: [] };
      n = s ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = s ? n : "[*+-]");
      let o = this.rules.other.listItemRegex(n), i = false;
      for (;e; ) {
        let a = false, p = "", c = "";
        if (!(t = o.exec(e)) || this.rules.block.hr.test(e))
          break;
        p = t[0], e = e.substring(p.length);
        let d = t[2].split(`
`, 1)[0], m = t[1].length, b = this.options.pedantic ? oe(d, m) : d.replace(this.rules.other.leadingSpaceTab, (M) => oe(M, m)), g = e.split(`
`, 1)[0], w = !b.trim(), f = 0;
        if (this.options.pedantic ? (f = 2, c = b.trimStart()) : w ? f = m + 1 : (f = b.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, c = b.slice(f), f += m), w && this.rules.other.blankLine.test(g) && (p += g + `
`, e = e.substring(g.length + 1), a = true), !a) {
          let M = this.rules.other.nextBulletRegex(f), v = this.rules.other.hrRegex(f), Z = this.rules.other.fencesBeginRegex(f), ae = this.rules.other.headingBeginRegex(f), ye = this.rules.other.htmlBeginRegex(f), Pe = this.rules.other.blockquoteBeginRegex(f);
          for (;e; ) {
            let K = e.split(`
`, 1)[0], H;
            if (g = K, this.options.pedantic ? (g = g.replace(this.rules.other.listReplaceNesting, "  "), H = g) : H = g.replace(this.rules.other.leadingSpaceTab, (Se) => Se.replace(this.rules.other.tabCharGlobal, "    ")), Z.test(g) || ae.test(g) || ye.test(g) || Pe.test(g) || M.test(g) || v.test(g))
              break;
            if (H.search(this.rules.other.nonSpaceChar) >= f || !g.trim())
              c += `
` + H.slice(f);
            else {
              if (w || b.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || Z.test(b) || ae.test(b) || v.test(b))
                break;
              c += `
` + g;
            }
            w = !g.trim(), p += K + `
`, e = e.substring(K.length + 1), b = H.slice(f);
          }
        }
        r.loose || (i ? r.loose = true : this.rules.other.doubleBlankLine.test(p) && (i = true)), r.items.push({ type: "list_item", raw: p, task: !!this.options.gfm && this.rules.other.listIsTask.test(c), loose: false, text: c, tokens: [] }), r.raw += p;
      }
      let u = r.items.at(-1);
      if (u)
        u.raw = u.raw.trimEnd(), u.text = u.text.trimEnd();
      else
        return;
      r.raw = r.raw.trimEnd();
      for (let a of r.items)
        if (this.lexer.state.top = false, a.tokens = this.lexer.blockTokens(a.text, []), !r.loose) {
          let p = a.tokens.filter((d) => d.type === "space"), c = p.length > 0 && p.some((d) => this.rules.other.anyLine.test(d.raw));
          r.loose = c;
        }
      for (let a of r.items) {
        let p = a.tokens[0];
        if (a.task && (p?.type === "text" || p?.type === "paragraph")) {
          a.text = a.text.replace(this.rules.other.listReplaceTask, ""), p.raw = p.raw.replace(this.rules.other.listReplaceTask, ""), p.text = p.text.replace(this.rules.other.listReplaceTask, "");
          for (let d = this.lexer.inlineQueue.length - 1;d >= 0; d--)
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[d].src)) {
              this.lexer.inlineQueue[d].src = this.lexer.inlineQueue[d].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          let c = this.rules.other.listTaskCheckbox.exec(a.raw);
          if (c) {
            let d = { type: "checkbox", raw: c[0] + " ", checked: c[0] !== "[ ]" };
            a.checked = d.checked, r.loose ? a.tokens[0] && ["paragraph", "text"].includes(a.tokens[0].type) && "tokens" in a.tokens[0] && a.tokens[0].tokens ? (a.tokens[0].raw = d.raw + a.tokens[0].raw, a.tokens[0].text = d.raw + a.tokens[0].text, a.tokens[0].tokens.unshift(d)) : a.tokens.unshift({ type: "paragraph", raw: d.raw, text: d.raw, tokens: [d] }) : a.tokens.unshift(d);
          }
        } else
          a.task && (a.task = false);
      }
      if (r.loose)
        for (let a of r.items) {
          a.loose = true;
          for (let p of a.tokens)
            p.type === "text" && (p.type = "paragraph");
        }
      return r;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ie(t[0]);
      return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let n = q(t[1]).replace(this.rules.other.multipleSpaceGlobal, " "), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: L(t[0], `
`), href: s, title: r };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2]))
      return;
    let n = se(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: L(t[0], `
`), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (let i of s)
        this.rules.other.tableAlignRight.test(i) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(i) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(i) ? o.align.push("left") : o.align.push(null);
      for (let i = 0;i < n.length; i++)
        o.header.push({ text: n[i], tokens: this.lexer.inline(n[i]), header: true, align: o.align[i] });
      for (let i of r)
        o.rows.push(se(i, o.header.length).map((u, a) => ({ text: u, tokens: this.lexer.inline(u), header: false, align: o.align[a] })));
      return o;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: L(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t)
      return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t)
      return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t)
      return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && we(e, t[1], n, this.rules))
        return;
      let s = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(s)) {
        if (!this.rules.other.endAngleBracket.test(s))
          return;
        let i = L(s.slice(0, -1), "\\");
        if ((s.length - i.length) % 2 === 0)
          return;
      } else {
        let i = Te(t[2], "()");
        if (i === -2)
          return;
        if (i > -1) {
          let a = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
          t[2] = t[2].substring(0, i), t[0] = t[0].substring(0, a).trim(), t[3] = "";
        }
      }
      let r = t[2], o = "";
      if (this.options.pedantic) {
        let i = this.rules.other.pedanticHrefTitle.exec(r);
        i && (r = i[1], o = i[3]);
      } else
        o = t[3] ? t[3].slice(1, -1) : "";
      return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(s) ? r = r.slice(1) : r = r.slice(1, -1)), Oe(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let s = n[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && we(e, n[1], s, this.rules))
        return;
      let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), o = t[q(r)];
      if (!o) {
        let i = n[0].charAt(0);
        return { type: "text", raw: i, text: i };
      }
      return Oe(n, o, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (!s || !s[1] && !s[2] && !s[3] && !s[4] || s[4] && n.match(this.rules.other.unicodeAlphaNumeric))
      return;
    if (!(s[1] || s[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...s[0]].length - 1, i, u, a = o, p = 0, c = s[0][0], d = n === c, m = c === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (m.lastIndex = 0, t = t.slice(-1 * e.length + o);(s = m.exec(t)) !== null; ) {
        if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i)
          continue;
        if (u = [...i].length, s[3] || s[4]) {
          a += u;
          continue;
        } else if (s[5] || s[6]) {
          if (o % 3 && !((o + u) % 3)) {
            p += u;
            continue;
          }
          if (d)
            break;
        }
        if (a -= u, a > 0)
          continue;
        u = Math.min(u, u + a + p);
        let b = [...s[0]][0].length, g = e.slice(0, o + s.index + b + u);
        if (Math.min(o, u) % 2) {
          let f = g.slice(1, -1);
          return { type: "em", raw: g, text: f, tokens: this.lexer.inlineTokens(f) };
        }
        let w = g.slice(2, -2);
        return { type: "strong", raw: g, text: w, tokens: this.lexer.inlineTokens(w) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t)
      return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s)
      return;
    if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let o = [...s[0]].length - 1, i, u, a = o, p = this.rules.inline.delRDelim;
      for (p.lastIndex = 0, t = t.slice(-1 * e.length + o);(s = p.exec(t)) !== null; ) {
        if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (u = [...i].length, u !== o))
          continue;
        if (s[3] || s[4]) {
          a += u;
          continue;
        }
        if (a -= u, a > 0)
          continue;
        u = Math.min(u, u + a);
        let c = [...s[0]][0].length, d = e.slice(0, o + s.index + c + u), m = d.slice(o, -o);
        return { type: "del", raw: d, text: m, tokens: this.lexer.inlineTokens(m) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, s;
      return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, s;
      if (t[2] === "@")
        n = t[0], s = "mailto:" + n;
      else {
        let r;
        do
          r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (r !== t[0]);
        n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: n ? t[0] : Re(t[0]), escaped: n };
    }
  }
};
var R = class l {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = Object.create(null), this.options = e || y, this.options.tokenizer = this.options.tokenizer || new P, this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, top: true };
    let t = { other: x, block: j.normal, inline: D.normal };
    this.options.pedantic ? (t.block = j.pedantic, t.inline = D.pedantic) : this.options.gfm && (t.block = j.gfm, this.options.breaks ? t.inline = D.breaks : t.inline = D.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: j, inline: D };
  }
  static lex(e, t) {
    return new l(t).lex(e);
  }
  static lexInline(e, t) {
    return new l(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(x.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0;t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(x.tabCharGlobal, "    ").replace(x.spaceLine, ""));
    let s = 1 / 0;
    for (;e; ) {
      if (e.length < s)
        s = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (this.options.extensions?.block?.some((i) => (r = i.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false))
        continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        r.raw.length === 1 && i !== undefined ? i.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.at(-1).src = i.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        i?.type === "paragraph" || i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.raw, this.inlineQueue.at(-1).src = i.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let i = 1 / 0, u = e.slice(1), a;
        this.options.extensions.startBlock.forEach((p) => {
          a = p.call({ lexer: this }, u), typeof a == "number" && a >= 0 && (i = Math.min(i, a));
        }), i < 1 / 0 && i >= 0 && (o = e.substring(0, i + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        let i = t.at(-1);
        n && i?.type === "paragraph" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let i = t.at(-1);
        i?.type === "text" ? (i.raw += (i.raw.endsWith(`
`) ? "" : `
`) + r.raw, i.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = i.text) : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  linkInText(e) {
    if (!e.includes("["))
      return false;
    let t = this.tokenizer.rules.inline.link;
    for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip))
      if (t.test(n[0]) && e.charAt(n.index - 1) !== "!")
        return true;
    for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      let s = n[0], r = s.lastIndexOf("[");
      if (!(s.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, q(s.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(s.slice(1, r - 1))))
        return true;
    }
    return false;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = e;
    if (this.tokens.links && e.includes("[")) {
      let i = this.tokenizer.rules.inline.reflinkSearch, u = (a) => {
        let p = a.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, q(a.slice(p + 1, -1))))
          return a;
        if (p > 1 && a.charAt(0) !== "!") {
          let c = a.slice(1, p - 1);
          if (this.linkInText(c))
            return "[" + c.replace(i, u) + "][" + "a".repeat(a.length - p - 2) + "]";
        }
        return "[" + "a".repeat(a.length - 2) + "]";
      };
      n = n.replace(i, u);
    }
    n = n.replace(this.tokenizer.rules.inline.anyPunctuation, (i) => "+".repeat(i.length)), n = n.replace(this.tokenizer.rules.inline.blockSkip, (i, u, a) => {
      let p = a ? a.length : 0;
      return i.slice(0, p) + "[" + "a".repeat(i.length - p - 2) + "]";
    }), n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let s = false, r = "", o = 1 / 0;
    for (;e; ) {
      if (e.length < o)
        o = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      s || (r = ""), s = false;
      let i;
      if (this.options.extensions?.inline?.some((a) => (i = a.call({ lexer: this }, e, t)) ? (e = e.substring(i.raw.length), t.push(i), true) : false))
        continue;
      if (i = this.tokenizer.escape(e)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.tag(e)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.link(e)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(i.raw.length);
        let a = t.at(-1);
        i.type === "text" && a?.type === "text" ? (a.raw += i.raw, a.text += i.text) : t.push(i);
        continue;
      }
      if (i = this.tokenizer.emStrong(e, n, r)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.codespan(e)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.br(e)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.del(e, n, r)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (i = this.tokenizer.autolink(e)) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      if (!this.state.inLink && (i = this.tokenizer.url(e))) {
        e = e.substring(i.raw.length), t.push(i);
        continue;
      }
      let u = e;
      if (this.options.extensions?.startInline) {
        let a = 1 / 0, p = e.slice(1), c;
        this.options.extensions.startInline.forEach((d) => {
          c = d.call({ lexer: this }, p), typeof c == "number" && c >= 0 && (a = Math.min(a, c));
        }), a < 1 / 0 && a >= 0 && (u = e.substring(0, a + 1));
      }
      if (i = this.tokenizer.inlineText(u)) {
        e = e.substring(i.raw.length), i.raw.slice(-1) !== "_" && (r = i.raw.slice(-1)), s = true;
        let a = t.at(-1);
        a?.type === "text" ? (a.raw += i.raw, a.text += i.text) : t.push(i);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent)
      console.error(t);
    else
      throw new Error(t);
  }
};
var S = class {
  options;
  parser;
  constructor(e) {
    this.options = e || y;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let s = (t || "").match(x.notSpaceStart)?.[0], r = e ? e.replace(x.endingNewline, "") + `
` : "";
    return s ? '<pre><code class="language-' + O(s) + '">' + (n ? r : O(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : O(r, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let { ordered: t, start: n } = e, s = "";
    for (let i = 0;i < e.items.length; i++) {
      let u = e.items[i];
      s += this.listitem(u);
    }
    let r = t ? "ol" : "ul", o = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + r + o + `>
` + s + "</" + r + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let r = 0;r < e.header.length; r++)
      n += this.tablecell(e.header[r]);
    t += this.tablerow({ text: n });
    let s = "";
    for (let r = 0;r < e.rows.length; r++) {
      let o = e.rows[r];
      n = "";
      for (let i = 0;i < o.length; i++)
        n += this.tablecell(o[i]);
      s += this.tablerow({ text: n });
    }
    return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${O(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, text: n, tokens: s, autolink: r }) {
    let o = r ? O(n, true) : this.parser.parseInline(s), i = re(e);
    if (i === null)
      return o;
    e = O(i, r);
    let u = '<a href="' + e + '"';
    return t && (u += ' title="' + O(t) + '"'), u += ">" + o + "</a>", u;
  }
  image({ href: e, title: t, text: n, tokens: s }) {
    s && (n = this.parser.parseInline(s, this.parser.textRenderer));
    let r = re(e);
    if (r === null)
      return O(n);
    e = r;
    let o = `<img src="${O(e)}" alt="${O(n)}"`;
    return t && (o += ` title="${O(t)}"`), o += ">", o;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : ("escaped" in e) && e.escaped ? e.text : O(e.text);
  }
};
var z = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var T = class l {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || y, this.options.renderer = this.options.renderer || new S, this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new z;
  }
  static parse(e, t) {
    return new l(t).parse(e);
  }
  static parseInline(e, t) {
    return new l(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0;n < e.length; n++) {
      let s = e[n];
      if (this.options.extensions?.renderers?.[s.type]) {
        let o = s, i = this.options.extensions.renderers[o.type].call({ parser: this }, o);
        if (i !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
          t += i || "";
          continue;
        }
      }
      let r = s;
      switch (r.type) {
        case "space": {
          t += this.renderer.space(r);
          break;
        }
        case "hr": {
          t += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t += this.renderer.heading(r);
          break;
        }
        case "code": {
          t += this.renderer.code(r);
          break;
        }
        case "table": {
          t += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t += this.renderer.html(r);
          break;
        }
        case "def": {
          t += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t += this.renderer.text(r);
          break;
        }
        default: {
          let o = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent)
            return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let s = 0;s < e.length; s++) {
      let r = e[s];
      if (this.options.extensions?.renderers?.[r.type]) {
        let i = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (i !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
          n += i || "";
          continue;
        }
      }
      let o = r;
      switch (o.type) {
        case "escape": {
          n += t.text(o);
          break;
        }
        case "html": {
          n += t.html(o);
          break;
        }
        case "link": {
          n += t.link(o);
          break;
        }
        case "image": {
          n += t.image(o);
          break;
        }
        case "checkbox": {
          n += t.checkbox(o);
          break;
        }
        case "strong": {
          n += t.strong(o);
          break;
        }
        case "em": {
          n += t.em(o);
          break;
        }
        case "codespan": {
          n += t.codespan(o);
          break;
        }
        case "br": {
          n += t.br(o);
          break;
        }
        case "del": {
          n += t.del(o);
          break;
        }
        case "text": {
          n += t.text(o);
          break;
        }
        default: {
          let i = 'Token with "' + o.type + '" type was not found.';
          if (this.options.silent)
            return console.error(i), "";
          throw new Error(i);
        }
      }
    }
    return n;
  }
};
var _ = class {
  options;
  block;
  constructor(e) {
    this.options = e || y;
  }
  static passThroughHooks = new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? R.lex : R.lexInline;
  }
  provideParser(e = this.block) {
    return e ? T.parse : T.parseInline;
  }
};
var F = class {
  defaults = I();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = T;
  Renderer = S;
  TextRenderer = z;
  Lexer = R;
  Tokenizer = P;
  Hooks = _;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let s of e)
      switch (n = n.concat(t.call(this, s)), s.type) {
        case "table": {
          let r = s;
          for (let o of r.header)
            n = n.concat(this.walkTokens(o.tokens, t));
          for (let o of r.rows)
            for (let i of o)
              n = n.concat(this.walkTokens(i.tokens, t));
          break;
        }
        case "list": {
          let r = s;
          n = n.concat(this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = s;
          this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
            let i = r[o].flat(1 / 0);
            n = n.concat(this.walkTokens(i, t));
          }) : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t)));
        }
      }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let s = { ...n };
      if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
        if (!r.name)
          throw new Error("extension name required");
        if ("renderer" in r) {
          let o = t.renderers[r.name];
          o ? t.renderers[r.name] = function(...i) {
            let u = r.renderer.apply(this, i);
            return u === false && (u = o.apply(this, i)), u;
          } : t.renderers[r.name] = r.renderer;
        }
        if ("tokenizer" in r) {
          if (!r.level || r.level !== "block" && r.level !== "inline")
            throw new Error("extension level must be 'block' or 'inline'");
          let o = t[r.level];
          o ? o.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
        }
        "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
      }), s.extensions = t), n.renderer) {
        let r = this.defaults.renderer || new S(this.defaults);
        for (let o in n.renderer) {
          if (!(o in r))
            throw new Error(`renderer '${o}' does not exist`);
          if (["options", "parser"].includes(o))
            continue;
          let i = o, u = n.renderer[i], a = r[i];
          r[i] = (...p) => {
            let c = u.apply(r, p);
            return c === false && (c = a.apply(r, p)), c || "";
          };
        }
        s.renderer = r;
      }
      if (n.tokenizer) {
        let r = this.defaults.tokenizer || new P(this.defaults);
        for (let o in n.tokenizer) {
          if (!(o in r))
            throw new Error(`tokenizer '${o}' does not exist`);
          if (["options", "rules", "lexer"].includes(o))
            continue;
          let i = o, u = n.tokenizer[i], a = r[i];
          r[i] = (...p) => {
            let c = u.apply(r, p);
            return c === false && (c = a.apply(r, p)), c;
          };
        }
        s.tokenizer = r;
      }
      if (n.hooks) {
        let r = this.defaults.hooks || new _;
        for (let o in n.hooks) {
          if (!(o in r))
            throw new Error(`hook '${o}' does not exist`);
          if (["options", "block"].includes(o))
            continue;
          let i = o, u = n.hooks[i], a = r[i];
          _.passThroughHooks.has(o) ? r[i] = (p) => {
            if (this.defaults.async && _.passThroughHooksRespectAsync.has(o))
              return (async () => {
                let d = await u.call(r, p);
                return a.call(r, d);
              })();
            let c = u.call(r, p);
            return a.call(r, c);
          } : r[i] = (...p) => {
            if (this.defaults.async)
              return (async () => {
                let d = await u.apply(r, p);
                return d === false && (d = await a.apply(r, p)), d;
              })();
            let c = u.apply(r, p);
            return c === false && (c = a.apply(r, p)), c;
          };
        }
        s.hooks = r;
      }
      if (n.walkTokens) {
        let r = this.defaults.walkTokens, o = n.walkTokens;
        s.walkTokens = function(i) {
          let u = [];
          return u.push(o.call(this, i)), r && (u = u.concat(r.call(this, i))), u;
        };
      }
      this.defaults = { ...this.defaults, ...s };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return R.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return T.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, s) => {
      let r = { ...s }, o = { ...this.defaults, ...r }, i = this.onError(!!o.silent, !!o.async);
      if (this.defaults.async === true && r.async === false)
        return i(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null)
        return i(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string")
        return i(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async)
        return (async () => {
          let u = o.hooks ? await o.hooks.preprocess(n) : n, p = await (o.hooks ? await o.hooks.provideLexer(e) : e ? R.lex : R.lexInline)(u, o), c = o.hooks ? await o.hooks.processAllTokens(p) : p;
          o.walkTokens && await Promise.all(this.walkTokens(c, o.walkTokens));
          let m = await (o.hooks ? await o.hooks.provideParser(e) : e ? T.parse : T.parseInline)(c, o);
          return o.hooks ? await o.hooks.postprocess(m) : m;
        })().catch(i);
      try {
        o.hooks && (n = o.hooks.preprocess(n));
        let a = (o.hooks ? o.hooks.provideLexer(e) : e ? R.lex : R.lexInline)(n, o);
        o.hooks && (a = o.hooks.processAllTokens(a)), o.walkTokens && this.walkTokens(a, o.walkTokens);
        let c = (o.hooks ? o.hooks.provideParser(e) : e ? T.parse : T.parseInline)(a, o);
        return o.hooks && (c = o.hooks.postprocess(c)), c;
      } catch (u) {
        return i(u);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let s = "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(s) : s;
      }
      if (t)
        return Promise.reject(n);
      throw n;
    };
  }
};
var E = new F;
function k(l, e) {
  return E.parse(l, e);
}
k.options = k.setOptions = function(l) {
  return E.setOptions(l), k.defaults = E.defaults, W(k.defaults), k;
};
k.getDefaults = I;
k.defaults = y;
function Pt(...l) {
  return E.use(...l), k.defaults = E.defaults, W(k.defaults), k;
}
k.use = Pt;
k.walkTokens = function(l, e) {
  return E.walkTokens(l, e);
};
k.parseInline = E.parseInline;
k.Parser = T;
k.parser = T.parse;
k.Renderer = S;
k.TextRenderer = z;
k.Lexer = R;
k.lexer = R.lex;
k.Tokenizer = P;
k.Hooks = _;
k.parse = k;
var gn = k.options;
var fn = k.setOptions;
var mn = k.walkTokens;
var xn = k.parseInline;
var Rn = T.parse;
var Tn = R.lex;

// src/cover.ts
import { access as access2, mkdtemp, readFile as readFile5, rm as rm3, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join6 } from "node:path";
var SCAN_SECONDS = "60";
var MIN_LUMA = "24";
var SCALE = "scale='min(1280,iw)':-2";
async function coverFor(meta, run) {
  if (meta.thumbnail)
    return { src: meta.thumbnail, remote: true };
  if (meta.source_key.startsWith("Youtube:") && meta.id) {
    return { src: `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg`, remote: true };
  }
  if (!meta.path || !run)
    return null;
  const exists = await access2(meta.path).then(() => true, () => false);
  if (!exists)
    return null;
  const work = await mkdtemp(join6(tmpdir(), "vs-cover-"));
  try {
    const out = join6(work, "cover.jpg");
    const nonBlack = `signalstats,metadata=select:key=lavfi.signalstats.YAVG:value=${MIN_LUMA}:function=greater,${SCALE}`;
    for (const vf of [nonBlack, SCALE]) {
      await run([
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-t",
        SCAN_SECONDS,
        "-i",
        meta.path,
        "-vf",
        vf,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        out
      ]);
      const size = await stat(out).then((s) => s.size, () => 0);
      if (size > 0)
        return { src: `data:image/jpeg;base64,${(await readFile5(out)).toString("base64")}`, remote: false };
    }
    return null;
  } finally {
    await rm3(work, { recursive: true, force: true });
  }
}

// src/readeck.ts
var POLLS = 15;
var TIMEOUT_MS = 15000;
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function renderHtml(markdown, title, cover, link) {
  const tokens = k.lexer(markdown);
  const section = tokens.findIndex((t) => t.type === "heading" && t.depth > 1);
  const i = tokens.findIndex((t, n) => t.type === "blockquote" && (section < 0 || n < section));
  if (i >= 0)
    tokens.splice(i, 1, ...k.lexer(tokens[i].text, { gfm: true, breaks: true }));
  let body = k.parser(tokens, { async: false });
  let head = "";
  if (cover?.remote) {
    head = `<meta property="og:image" content="${esc(cover.src)}">`;
  } else if (cover) {
    const img = `<img src="${esc(cover.src)}" alt="">`;
    const p = `<p>${link ? `<a href="${esc(link)}">${img}</a>` : img}</p>
`;
    const h1 = body.startsWith("<h1") ? body.indexOf(`</h1>
`) : -1;
    body = h1 >= 0 ? body.slice(0, h1 + 6) + p + body.slice(h1 + 6) : p + body;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
}

class NetError extends Error {
}
async function sendToReadeck(dir, d) {
  if (!d.readeck)
    return { status: "disabled", bookmark_id: null };
  const rd = d.readeck;
  const summaryPath = join7(dir, "summary.md");
  const exists = await stat2(summaryPath).then(() => true, () => false);
  if (!exists)
    throw new UserError(`write summary.md first in ${dir}`);
  const meta = await readMeta(dir);
  if (!meta?.title)
    throw new UserError(`no meta.json in ${dir} — run fetch first`);
  const key = await readKey(rd, d.env, d.home);
  if (!key)
    return { status: "skipped", bookmark_id: null, reason: `no API key (${keySource(rd) ?? "not configured"})` };
  const base = rd.url.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${key}` };
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const call = async (url, init) => {
    try {
      return await d.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new NetError(netErrorTag(e));
    }
  };
  const markdown = await readFile6(summaryPath, "utf8");
  const sha = createHash("sha256").update(markdown).digest("hex");
  let replaced = null;
  try {
    const old = meta.readeck_bookmark_id;
    const same = !meta.readeck_summary_sha || meta.readeck_summary_sha === sha;
    let drop = false;
    if (old && same) {
      const r = await call(`${base}/api/bookmarks/${old}`, { headers: auth });
      if (r.ok) {
        const b = await r.json().catch(() => ({}));
        if (!(b.loaded && b.state === 1))
          return { status: "already-sent", bookmark_id: old };
        drop = true;
      } else if (r.status !== 404) {
        return { status: "skipped", bookmark_id: null, reason: `Readeck answered ${r.status} while checking the bookmark` };
      }
    } else if (old) {
      drop = true;
    }
    if (drop && old) {
      const r = await call(`${base}/api/bookmarks/${old}`, { method: "DELETE", headers: auth });
      if (!r.ok && r.status !== 404) {
        return { status: "skipped", bookmark_id: null, reason: `Readeck refused to delete old bookmark ${old} (${r.status})` };
      }
      replaced = old;
    }
    const form = new FormData;
    form.append("url", meta.url ?? `https://local.invalid/${slugify(meta.title)}`);
    form.append("title", meta.title);
    form.append("labels", rd.label || "video-summary");
    const html = renderHtml(markdown, meta.title, await coverFor(meta, d.run), meta.url);
    form.append("html", new File([html], "_", { type: "text/html" }));
    const r = await call(`${base}/api/bookmarks`, { method: "POST", headers: auth, body: form });
    if (r.status === 401)
      return { status: "skipped", bookmark_id: null, reason: "Readeck rejected the token (401)" };
    const id = r.headers.get("Bookmark-Id");
    if (r.status !== 202 || !id) {
      throw new UserError(`Readeck rejected the bookmark (${r.status}): ${oneLine(await r.text()).slice(0, 300)}`);
    }
    await writeMeta(dir, { ...meta, readeck_bookmark_id: id, readeck_summary_sha: sha });
    const note = replaced ? `summary changed — replaced old bookmark ${replaced}` : undefined;
    const done = (extra) => {
      const reason = [note, extra].filter(Boolean).join("; ");
      return reason ? { status: "sent", bookmark_id: id, reason } : { status: "sent", bookmark_id: id };
    };
    for (let i = 0;i < POLLS; i++) {
      await sleep(1000);
      let g;
      try {
        g = await call(`${base}/api/bookmarks/${id}`, { headers: auth });
      } catch (e) {
        if (e instanceof NetError)
          return done(`could not check status — Readeck unreachable: ${e.message}`);
        throw e;
      }
      if (!g.ok)
        return done(`could not check status (${g.status})`);
      const b = await g.json().catch(() => ({}));
      if (!b.loaded)
        continue;
      if (b.state === 1)
        throw new UserError(`Readeck could not process bookmark ${id}`);
      return done();
    }
    return done("Readeck is still processing — check later");
  } catch (e) {
    if (e instanceof NetError)
      return { status: "skipped", bookmark_id: null, reason: `Readeck unreachable: ${e.message}` };
    throw e;
  }
}

// src/summary.ts
import { readFile as readFile7, writeFile as writeFile4 } from "node:fs/promises";
import { join as join8 } from "node:path";
var WPM = 200;
var PLACEHOLDER = "{{reading_time}}";
function stripFences(md) {
  const out = [];
  let fence = null;
  for (const line of md.split(`
`)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence === null) {
      if (m)
        fence = m[1][0].repeat(m[1].length);
      else
        out.push(line);
    } else if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
      fence = null;
    }
  }
  return out.join(`
`);
}
function readingMinutes(markdown) {
  const text = stripFences(markdown).split(`
`).filter((l) => !/^\s*> 📖/.test(l)).join(`
`);
  const words = text.match(/\S+/g)?.filter((w) => /[\p{L}\p{N}]/u.test(w)).length ?? 0;
  return Math.max(1, Math.ceil(words / WPM));
}
function applyReadingTime(markdown) {
  const n = String(readingMinutes(markdown));
  if (markdown.includes(PLACEHOLDER))
    return markdown.split(PLACEHOLDER).join(n);
  const line = /^(> 📖[^\n]*?~)\d+/m;
  if (line.test(markdown))
    return markdown.replace(line, `$1${n}`);
  const row = `> \uD83D\uDCD6 ~${n} min read`;
  const lines = markdown.split(`
`);
  const q = lines.findIndex((l) => l.startsWith(">"));
  lines.splice(q >= 0 ? q + 1 : 1, 0, row);
  return lines.join(`
`);
}
async function finalizeSummary(dir) {
  const path = join8(dir, "summary.md");
  let text;
  try {
    text = await readFile7(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      throw new UserError(`write summary.md first in ${dir}`);
    throw e;
  }
  const next = applyReadingTime(text);
  if (next !== text)
    await writeFile4(path, next);
  return { reading_minutes: readingMinutes(text) };
}

// src/cli.ts
var USAGE = "usage: video-summary check | config path|get [key]|init [--force]|set <key> <json>|limits | " + "fetch <url|path> [--no-diarize] [--allow-cloud] [--force] | finalize <dir> | readeck <dir>";
var NO_CONFIG = "no config — run setup (see references/setup.md)";
async function requireConfig(path) {
  const cfg = await loadConfig(path);
  if (!cfg)
    throw new UserError(NO_CONFIG);
  return cfg;
}
async function check(d, path) {
  const depsReport = buildReport(await probeDeps(d.run), d.platform, d.runtime, d.now, d.has);
  const config = { path, exists: false, valid: false };
  let cfg = null;
  try {
    cfg = await loadConfig(path);
    config.exists = cfg !== null;
    config.valid = cfg !== null;
  } catch (e) {
    if (!(e instanceof UserError))
      throw e;
    config.exists = await stat3(path).then(() => true, () => false);
    config.error = e.message;
  }
  const providers = cfg ? (await probeProviders(cfg.providers.map(resolveProvider), d.fetch, d.env, d.home)).map((c) => ({
    name: c.provider.name,
    available: c.available,
    keyMissing: c.keyMissing
  })) : [];
  return {
    ok: depsReport.ok && config.exists && config.valid,
    runtime: d.runtime,
    deps: depsReport,
    config,
    providers,
    readeck: cfg?.readeck ? "configured" : "disabled"
  };
}
function parseValue(key, text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    if (/^\s*[[{"]/.test(text))
      throw new UserError(`invalid JSON for ${key}: ${e.message}`);
    return text;
  }
}
async function configCmd(args, d, path) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "path":
      return { path };
    case "get": {
      const cfg = await requireConfig(path);
      if (!rest[0])
        return cfg;
      let v = cfg;
      for (const part of rest[0].split(".")) {
        if (typeof v !== "object" || v === null || !(part in v))
          throw new UserError(`config: ${rest[0]}: unknown key`);
        v = v[part];
      }
      return { value: v };
    }
    case "init": {
      const exists = await stat3(path).then(() => true, () => false);
      if (exists && !rest.includes("--force"))
        throw new UserError(`config exists: ${path} (use --force to overwrite)`);
      await saveConfig(path, DEFAULT_CONFIG);
      return { path, created: true };
    }
    case "set": {
      if (!rest[0] || rest[1] === undefined)
        throw new UserError(USAGE);
      const cfg = await requireConfig(path);
      const next = setValue(cfg, rest[0], parseValue(rest[0], rest[1]));
      await saveConfig(path, next);
      return { path, key: rest[0] };
    }
    case "limits": {
      const cfg = await requireConfig(path);
      return { bitrate: cfg.bitrate, rows: limitsReport(cfg.providers.map(resolveProvider)) };
    }
    default:
      throw new UserError(USAGE);
  }
}
async function main(argv, d) {
  const [cmd, ...rest] = argv;
  const path = configPath(d.env, d.home);
  switch (cmd) {
    case "check":
      return check(d, path);
    case "config":
      return configCmd(rest, d, path);
    case "fetch": {
      const src = rest.find((a) => !a.startsWith("--"));
      if (!src)
        throw new UserError(USAGE);
      const cfg = await requireConfig(path);
      const flags = {
        diarize: !rest.includes("--no-diarize"),
        allowCloud: rest.includes("--allow-cloud"),
        force: rest.includes("--force")
      };
      return fetchCmd(src, flags, { run: d.run, fetch: d.fetch, cfg, env: d.env, now: d.now, cwd: d.cwd, home: d.home });
    }
    case "finalize": {
      if (!rest[0])
        throw new UserError(USAGE);
      return finalizeSummary(resolveInputPath(rest[0], d.cwd, d.home));
    }
    case "readeck": {
      if (!rest[0])
        throw new UserError(USAGE);
      const cfg = await requireConfig(path);
      return sendToReadeck(resolveInputPath(rest[0], d.cwd, d.home), { readeck: cfg.readeck, fetch: d.fetch, env: d.env, home: d.home, run: d.run });
    }
    default:
      throw new UserError(USAGE);
  }
}

// src/exec.ts
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join as join9 } from "node:path";
var run = (cmd, opts) => new Promise((resolve) => {
  const [bin, ...args] = cmd;
  const child = spawn(bin, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => stdout += d);
  child.stderr.setEncoding("utf8").on("data", (d) => stderr += d);
  child.on("error", (e) => resolve({ code: 127, stdout: "", stderr: `${bin}: ${e.message}` }));
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
});
function has(bin) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir)
      continue;
    try {
      accessSync(join9(dir, bin), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

// src/main.ts
try {
  const out = await main(process.argv.slice(2), {
    run,
    fetch: runtimeFetch(process.versions),
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    now: new Date,
    platform: process.platform === "darwin" ? "darwin" : "linux",
    runtime: process.versions.bun ? { name: "bun", version: process.versions.bun } : { name: "node", version: process.versions.node },
    has
  });
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e instanceof UserError ? e.message : `Unexpected error: ${e.message}`);
  process.exit(1);
}
