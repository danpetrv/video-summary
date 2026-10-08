import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG, configPath, expandHome, keySource, loadConfig, parseConfig, readKey, saveConfig, setValue,
} from "../src/config";
import { UserError } from "../src/types";

const tmp = mkdtempSync(join(tmpdir(), "vs-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("configPath: VIDEO_SUMMARY_CONFIG > XDG_CONFIG_HOME > ~/.config", () => {
  expect(configPath({ VIDEO_SUMMARY_CONFIG: "/c.json" }, "/h")).toBe("/c.json");
  expect(configPath({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/video-summary/config.json");
  expect(configPath({}, "/h")).toBe("/h/.config/video-summary/config.json");
});

test("expandHome", () => {
  expect(expandHome("~/a", "/h")).toBe("/h/a");
  expect(expandHome("~", "/h")).toBe("/h");
  expect(expandHome("/a/~b", "/h")).toBe("/a/~b");
});

test("DEFAULT_CONFIG", () => {
  expect(DEFAULT_CONFIG).toEqual({ outputDir: "~/Documents/video-summaries", summaryLanguage: "auto", summaryLength: "medium",
    subtitles: "manual", providers: [], readeck: null });
});

test("summaryLength: short, medium, long or <N>m with N in 1..60", () => {
  for (const v of ["short", "medium", "long", "1m", "5m", "60m"]) expect(parseConfig({ summaryLength: v }).summaryLength).toBe(v);
  for (const v of ["0m", "61m", "05m", "5", "5 m", "huge", "", 5]) {
    expect(() => parseConfig({ summaryLength: v })).toThrow("config: summaryLength: must be short, medium, long or <N>m (1-60)");
  }
  expect(setValue(DEFAULT_CONFIG, "summaryLength", "short").summaryLength).toBe("short");
  expect(() => setValue(DEFAULT_CONFIG, "summaryLength", "tiny")).toThrow("config: summaryLength:");
});

test("parseConfig: недостающие поля добиваются умолчаниями", () => {
  expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  const c = parseConfig({ providers: [{ name: "w", type: "whisperx", url: "https://a/" }] });
  expect(c.outputDir).toBe(DEFAULT_CONFIG.outputDir);
  expect(c.providers[0]).toMatchObject({ name: "w", url: "https://a" });
  expect(parseConfig({ readeck: { url: "https://r", keyEnv: "K" } }).readeck).toEqual({ url: "https://r", keyEnv: "K" });
  expect(parseConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
});

test("parseConfig: ошибки с путём к полю", () => {
  expect(() => parseConfig({ providers: {} })).toThrow("config: providers: must be an array");
  expect(() => parseConfig({ providers: [{ name: "a", type: "whisperx", url: "u" }, { name: "a", type: "whisperx", url: "v" }] }))
    .toThrow('config: providers[1].name: duplicate "a"');
  expect(() => parseConfig({ nope: 1 })).toThrow('config: nope: unknown key');
  expect(() => parseConfig({ subtitles: "x" })).toThrow('config: subtitles: must be "manual" or "manual+auto"');
  expect(() => parseConfig({ providers: [{ name: "a", type: "grpc" }] })).toThrow("config: providers[0].type: unknown type");
  expect(() => parseConfig({ providers: [{ name: "a", type: "whisperx" }] })).toThrow("config: providers[0].url: required");
  expect(() => parseConfig({ providers: [{ name: "a", type: "openai-compatible" }] })).toThrow("config: providers[0].url: required");
  expect(() => parseConfig({ readeck: {} })).toThrow("config: readeck.url: required");
  expect(() => parseConfig(5)).toThrow(UserError);
});

test("loadConfig: нет файла → null; битый JSON → UserError с путём к файлу", async () => {
  expect(await loadConfig(join(tmp, "none.json"))).toBeNull();
  const bad = join(tmp, "bad.json");
  writeFileSync(bad, "{oops");
  await expect(loadConfig(bad)).rejects.toThrow(`config: ${bad}: invalid JSON`);
  const wrong = join(tmp, "wrong.json");
  writeFileSync(wrong, '{"subtitles":"fast"}');
  await expect(loadConfig(wrong)).rejects.toThrow('subtitles: must be "manual" or "manual+auto"');
  const p = join(tmp, "deep", "dir", "c.json");
  await saveConfig(p, DEFAULT_CONFIG);
  expect(readFileSync(p, "utf8")).toBe(JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  expect(await loadConfig(p)).toEqual(DEFAULT_CONFIG);
});

test("setValue: вложенный ключ readeck.url, providers целиком, неизвестный ключ → UserError", () => {
  const a = setValue(DEFAULT_CONFIG, "readeck.url", "https://r");
  expect(a.readeck).toEqual({ url: "https://r" });
  expect(setValue(a, "readeck.keyFile", "~/k").readeck).toEqual({ url: "https://r", keyFile: "~/k" });
  expect(setValue(a, "readeck", null).readeck).toBeNull();
  const p = [{ name: "w", type: "whisperx", url: "https://a" }];
  expect(setValue(DEFAULT_CONFIG, "providers", p).providers).toEqual(p as any);
  expect(DEFAULT_CONFIG.readeck).toBeNull(); // не мутирует
  expect(() => setValue(DEFAULT_CONFIG, "nope", 1)).toThrow(UserError);
  expect(() => setValue(DEFAULT_CONFIG, "subtitles.x", 1)).toThrow(UserError);
  expect(() => setValue(DEFAULT_CONFIG, "subtitles", "fast")).toThrow("config: subtitles:");
  expect(() => setValue(DEFAULT_CONFIG, "bitrate", "fixed")).toThrow("config: bitrate: unknown key");
});

test("readKey: keyFile с ~ и trim; keyEnv; ни того ни другого → null; keySource для сообщений", async () => {
  writeFileSync(join(tmp, "x.key"), "  secret\n");
  expect(await readKey({ keyFile: "~/x.key" }, {}, tmp)).toBe("secret");
  expect(await readKey({ keyEnv: "K" }, { K: " v " }, tmp)).toBe("v");
  expect(await readKey({ keyFile: join(tmp, "x.key"), keyEnv: "K" }, { K: "e" }, tmp)).toBe("secret");
  expect(await readKey({}, {}, tmp)).toBeNull();
  expect(await readKey({ keyEnv: "K" }, {}, tmp)).toBeNull();
  expect(await readKey({ keyFile: "~/missing.key" }, {}, tmp)).toBeNull();
  writeFileSync(join(tmp, "empty.key"), "\n");
  expect(await readKey({ keyFile: "~/empty.key" }, {}, tmp)).toBeNull();
  expect(keySource({ keyEnv: "OPENAI_API_KEY" })).toBe("env OPENAI_API_KEY");
  expect(keySource({ keyFile: "~/x.key" })).toBe("file ~/x.key");
  expect(keySource({ keyFile: null, keyEnv: null })).toBeNull();
});

test("readKey: unreadable key file -> UserError 'cannot read <keySource> (<code>)'", async () => {
  // keyFile is a directory: reading fails with EISDIR
  await expect(readKey({ keyFile: tmp }, {}, tmp)).rejects.toThrow(new UserError(`cannot read file ${tmp} (EISDIR)`));
});

test("readKey: key with inner whitespace/control/non-ASCII -> UserError naming the source, never the key", async () => {
  const secret = "sk-LEAKCANARY-7f3a";
  const bad = [`${secret}\nsecond-line`, `${secret} tail`, `${secret}\ttail`, `${secret}\u0000`, `${secret}ключ`, `${secret}\u00a0tail`];
  for (const [i, v] of bad.entries()) {
    writeFileSync(join(tmp, `bad${i}.key`), `${v}\n`);
    const e1 = await readKey({ keyFile: `~/bad${i}.key` }, {}, tmp).catch((e) => e);
    expect(e1).toBeInstanceOf(UserError);
    expect(e1.message).toBe(`key in file ~/bad${i}.key contains whitespace or control characters`);
    expect(e1.message).not.toContain("LEAKCANARY");
    const e2 = await readKey({ keyEnv: "K" }, { K: v }, tmp).catch((e) => e);
    expect(e2).toBeInstanceOf(UserError);
    expect(e2.message).toBe("key in env K contains whitespace or control characters");
  }
  // outer whitespace is still trimmed
  expect(await readKey({ keyEnv: "K" }, { K: `\t ${secret} \n` }, tmp)).toBe(secret);
});

test("keySource: both keyFile and keyEnv -> 'file X or env Y'", () => {
  expect(keySource({ keyFile: "~/g.key", keyEnv: "GROQ_API_KEY" })).toBe("file ~/g.key or env GROQ_API_KEY");
});

test("parseConfig: url/model requirements with field paths", () => {
  expect(() => parseConfig({ providers: [{ name: "a", type: "openai-compatible", url: "http://h/v1" }] }))
    .toThrow("config: providers[0].model: required");
  expect(() => parseConfig({ providers: [{ name: "a", type: "openai-compatible", url: "/", model: "m" }] }))
    .toThrow("config: providers[0].url: required");
  expect(() => parseConfig({ providers: [{ name: "a", type: "whisperx", url: "///" }] }))
    .toThrow("config: providers[0].url: required");
  expect(() => parseConfig({ providers: [{ name: "a", type: "openai-compatible", model: "m" }] }))
    .toThrow("config: providers[0].url: required");
  expect(() => parseConfig({ readeck: { url: "/" } })).toThrow("config: readeck.url: required");
});

test("local provider: defaults engine parakeet, model ultra, device auto", () => {
  expect(parseConfig({ providers: [{ name: "local", type: "local" }] }).providers).toEqual([
    { name: "local", type: "local", engine: "parakeet", model: "ultra", device: "auto" },
  ]);
  const full = { name: "l", type: "local", engine: "parakeet", model: "ultra", device: "cpu" } as const;
  expect(parseConfig({ providers: [full] }).providers).toEqual([full]);
  // set via `config set providers`, next to a whisperx fallback
  const c = setValue(DEFAULT_CONFIG, "providers", [{ name: "wx", type: "whisperx", url: "https://a" }, { name: "local", type: "local" }]);
  expect(c.providers.map((p) => p.type)).toEqual(["whisperx", "local"]);
});

test("local provider: url/keyFile/diarize/other model -> error with field path", () => {
  const bad = (extra: object) => () => parseConfig({ providers: [{ name: "l", type: "local", ...extra }] }, []);
  for (const k of ["url", "keyFile", "keyEnv"]) {
    expect(bad({ [k]: "x" })).toThrow(`config: providers[0].${k}: not allowed for type local`);
  }
  expect(bad({ diarize: true })).toThrow("config: providers[0].diarize: not allowed for type local");
  // strict: no soft migration for the new type
  expect(bad({ tier: "free" })).toThrow("config: providers[0].tier: not allowed for type local");
  expect(bad({ preset: "groq" })).toThrow("config: providers[0].preset: not allowed for type local");
  expect(bad({ nope: 1 })).toThrow("config: providers[0].nope: unknown key");
  expect(bad({ model: "large-v3" })).toThrow('config: providers[0].model: must be "ultra"');
  expect(bad({ engine: "whisper" })).toThrow('config: providers[0].engine: must be "parakeet"');
  expect(bad({ device: "gpu" })).toThrow('config: providers[0].device: must be "auto" or "cpu"');
  expect(bad({ device: null })).toThrow('config: providers[0].device: must be "auto" or "cpu"');
  expect(() => parseConfig({ providers: [{ type: "local" }] })).toThrow("config: providers[0].name: must be a non-empty string");
  expect(() => parseConfig({ providers: [{ name: "a", type: "whisperx", url: "u" }, { name: "a", type: "local" }] }))
    .toThrow('config: providers[1].name: duplicate "a"');
  expect(() => parseConfig({ providers: [{ name: "a", type: "grpc" }] }))
    .toThrow('config: providers[0].type: unknown type "grpc" (whisperx, openai-compatible, local)');
});

test("migration: groq/openai presets skipped with a warning, whisperx kept", () => {
  const w: string[] = [];
  const c = parseConfig({ bitrate: "fixed", providers: [
    { name: "wx", type: "whisperx", url: "https://a" },
    { name: "groq", type: "openai-compatible", preset: "groq", tier: "free", keyFile: "~/g.key" },
  ] }, w);
  expect(c.providers).toEqual([{ name: "wx", type: "whisperx", url: "https://a" }]);
  expect(c).not.toHaveProperty("bitrate");
  expect(w).toEqual([
    "bitrate: removed in v0.4.0 — ignored",
    'providers[1] "groq": cloud providers were removed in v0.4.0 — skipped',
  ]);
  // a skipped provider does not hold its name: a later provider may reuse it
  const c2 = parseConfig({ providers: [
    { name: "o", type: "openai-compatible", preset: "openai", diarize: true },
    { name: "o", type: "openai-compatible", url: "http://h/v1", model: "m" },
  ] });
  expect(c2.providers.map((p) => p.name)).toEqual(["o"]);
  // without a warnings array parsing is just as lenient
  expect(parseConfig({ bitrate: "wat" })).toEqual(DEFAULT_CONFIG);
});

test("migration: maxBytes/maxSeconds/local on whisperx and diarize on openai-compatible are ignored with warnings", () => {
  const w: string[] = [];
  const c = parseConfig({ providers: [
    { name: "wx", type: "whisperx", url: "https://a", tier: "free", maxBytes: 25_000_000, maxSeconds: null, local: true, diarize: false },
    { name: "own", type: "openai-compatible", url: "http://h/v1", model: "m", local: true, diarize: true, maxBytes: -1 },
  ] }, w);
  expect(c.providers).toEqual([
    { name: "wx", type: "whisperx", url: "https://a", diarize: false },
    { name: "own", type: "openai-compatible", url: "http://h/v1", model: "m" },
  ]);
  expect(w).toEqual([
    "providers[0].tier: removed in v0.4.0 — ignored",
    "providers[0].maxBytes: removed in v0.4.0 — ignored",
    "providers[0].maxSeconds: removed in v0.4.0 — ignored",
    "providers[0].local: removed in v0.4.0 — ignored",
    "providers[1].maxBytes: removed in v0.4.0 — ignored",
    "providers[1].local: removed in v0.4.0 — ignored",
    "providers[1].diarize: removed in v0.4.0 — ignored",
  ]);
  // still strict about keys that never existed and about the remaining fields
  expect(() => parseConfig({ providers: [{ name: "wx", type: "whisperx", url: "https://a", nope: 1 }] }))
    .toThrow("config: providers[0].nope: unknown key");
  expect(() => parseConfig({ providers: [{ name: "wx", type: "whisperx", url: "https://a", diarize: "yes" }] }))
    .toThrow("config: providers[0].diarize: must be true or false");
});

test("saveConfig after migration writes the cleaned config", async () => {
  const p = join(tmp, "old.json");
  writeFileSync(p, JSON.stringify({ bitrate: "adaptive", providers: [
    { name: "wx", type: "whisperx", url: "https://a", local: true },
    { name: "groq", type: "openai-compatible", preset: "groq", keyEnv: "G" },
  ] }));
  const w: string[] = [];
  const cfg = (await loadConfig(p, w))!;
  expect(w).toHaveLength(3);
  await saveConfig(p, setValue(cfg, "summaryLength", "short"));
  const raw = JSON.parse(readFileSync(p, "utf8"));
  expect(raw).not.toHaveProperty("bitrate");
  expect(raw.providers).toEqual([{ name: "wx", type: "whisperx", url: "https://a" }]);
  expect(raw.summaryLength).toBe("short");
  const again: string[] = [];
  await loadConfig(p, again);
  expect(again).toEqual([]);
});

test("setValue: a value with removed settings is rejected, nothing silently dropped", () => {
  expect(() => setValue(DEFAULT_CONFIG, "providers", [{ name: "groq", type: "openai-compatible", preset: "groq" }]))
    .toThrow(/^config: providers: not saved: providers\[0\] "groq": cloud providers were removed in v0\.4\.0$/);
  expect(() => setValue(DEFAULT_CONFIG, "providers", [{ name: "wx", type: "whisperx", url: "https://a", maxBytes: 5 }]))
    .toThrow(/^config: providers: not saved: providers\[0\]\.maxBytes: removed in v0\.4\.0$/);
});
