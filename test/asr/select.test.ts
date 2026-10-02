import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProvider, type ResolvedProvider } from "../../src/asr/presets";
import { type Candidate, chooseProvider, probeProviders, transcribeWith } from "../../src/asr/select";
import { type Fetcher, UserError } from "../../src/types";

const groq = resolveProvider({ name: "groq", type: "openai-compatible", preset: "groq", tier: "free", keyEnv: "GROQ_API_KEY" });
const wx = resolveProvider({ name: "wx", type: "whisperx", url: "https://wx" });
const ok = (p: ResolvedProvider): Candidate => ({ provider: p, available: true, keyMissing: null });
const base = { durationSec: 5400, kbps: 28, privateSource: false, allowCloud: false };

test("chooseProvider: first fitting in order", () => {
  expect(chooseProvider({ ...base, candidates: [ok(wx), ok(groq)] })).toEqual({ provider: wx });
});

test("chooseProvider: reason per provider", () => {
  const r = chooseProvider({ ...base, candidates: [{ ...ok(wx), available: false }, { ...ok(groq), keyMissing: "env GROQ_API_KEY" }] });
  expect(r).toEqual({ error: "no ASR provider fits: wx: not reachable; groq: no API key (env GROQ_API_KEY)" });
});

test("chooseProvider: duration and size in message — h:mm:ss and MB", () => {
  expect(chooseProvider({ ...base, durationSec: 9000, candidates: [ok(groq)] }))
    .toEqual({ error: "no ASR provider fits: groq: 2:30:00 exceeds duration limit 1:56:40" });
  expect(chooseProvider({ ...base, durationSec: 6500, kbps: 32, candidates: [ok(groq)] }))
    .toEqual({ error: "no ASR provider fits: groq: ~26.0 MB exceeds 96% of file limit 25.0 MB" });
});

test("chooseProvider: cloud + privateSource without allowCloud blocked; local allowed", () => {
  expect(chooseProvider({ ...base, privateSource: true, candidates: [ok(groq)] }))
    .toEqual({ error: "no ASR provider fits: groq: cloud provider, needs --allow-cloud" });
  expect(chooseProvider({ ...base, privateSource: true, candidates: [ok(groq), ok(wx)] })).toEqual({ provider: wx });
  expect(chooseProvider({ ...base, privateSource: true, allowCloud: true, candidates: [ok(groq)] })).toEqual({ provider: groq });
});

test("chooseProvider: empty list", () => {
  expect(chooseProvider({ ...base, candidates: [] }))
    .toEqual({ error: "no ASR providers configured — run setup (see references/setup.md)" });
});

test("probeProviders: whisperx via /health, local openai via /models, cloud not pinged; keyMissing from keySource", async () => {
  const loc = resolveProvider({ name: "loc", type: "openai-compatible", url: "http://l/v1", model: "m", local: true });
  const urls: string[] = [];
  const f: Fetcher = async (u) => (urls.push(u), new Response("{}", { status: u.endsWith("/health") ? 502 : 200 }));
  const r = await probeProviders([wx, loc, groq], f, {}, "/nohome");
  expect(urls.sort()).toEqual(["http://l/v1/models", "https://wx/health"]);
  expect(r.map((c) => [c.provider.name, c.available, c.keyMissing])).toEqual([
    ["wx", false, null], ["loc", true, null], ["groq", true, "env GROQ_API_KEY"],
  ]);
  const r2 = await probeProviders([groq], f, { GROQ_API_KEY: "x" }, "/nohome");
  expect(r2[0]!.keyMissing).toBeNull();
  const nokey = resolveProvider({ name: "n", type: "openai-compatible", preset: "groq" });
  expect((await probeProviders([nokey], f, {}, "/h"))[0]!.keyMissing).toBe("no key configured");
});

test("transcribeWith: reads key file, dispatches by type; missing key -> UserError without leaking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  await writeFile(join(dir, "tok"), "secret-token\n");
  const audio = join(import.meta.dir, "../fixtures/sample.ru.srt");
  const verbose = await Bun.file(join(import.meta.dir, "../fixtures/groq-verbose.json")).text();
  let auth: string | undefined, url = "";
  const f: Fetcher = async (u, init) => (url = u, auth = (init?.headers as Record<string, string>).Authorization, new Response(verbose));
  const p = resolveProvider({ name: "g", type: "openai-compatible", preset: "groq", keyFile: join(dir, "tok") });
  const r = await transcribeWith(p, audio, { language: null, diarize: false }, f, {}, dir);
  expect(auth).toBe("Bearer secret-token");
  expect(url).toContain("/audio/transcriptions");
  expect(r.provider).toBe("g");
  const err = await transcribeWith(groq, audio, { language: null, diarize: false }, f, {}, dir).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("groq: no API key (env GROQ_API_KEY)");
});

test("chooseProvider: limits inclusive, size with 4% headroom (7000 s fits Groq free; exactly 24_000_000 bytes fits, above doesn't)", () => {
  expect(chooseProvider({ ...base, durationSec: 7000, kbps: 16, candidates: [ok(groq)] })).toEqual({ provider: groq });
  // 6000 s at 32 kbps = 24_000_000 bytes = 96% of 25 MB
  expect(chooseProvider({ ...base, durationSec: 6000, kbps: 32, candidates: [ok(groq)] })).toEqual({ provider: groq });
  expect(chooseProvider({ ...base, durationSec: 6001, kbps: 32, candidates: [ok(groq)] }))
    .toEqual({ error: "no ASR provider fits: groq: ~24.0 MB exceeds 96% of file limit 25.0 MB" });
});

test("chooseProvider: order is duration -> size -> privacy", () => {
  expect(chooseProvider({ ...base, durationSec: 9000, privateSource: true, candidates: [ok(groq)] }))
    .toEqual({ error: "no ASR provider fits: groq: 2:30:00 exceeds duration limit 1:56:40" });
  expect(chooseProvider({ ...base, durationSec: 6500, kbps: 32, privateSource: true, candidates: [ok(groq)] }))
    .toEqual({ error: "no ASR provider fits: groq: ~26.0 MB exceeds 96% of file limit 25.0 MB" });
});

test("transcribeWith: whisperx dispatch -> /asr with Speaker labels", async () => {
  const audio = join(import.meta.dir, "../fixtures/sample.ru.srt");
  const body = await Bun.file(join(import.meta.dir, "../fixtures/whisperx-diarized.json")).text();
  let url = "";
  const f: Fetcher = async (u) => (url = u, new Response(body));
  const r = await transcribeWith(wx, audio, { language: null, diarize: true }, f, {}, "/nohome");
  expect(new URL(url).pathname).toBe("/asr");
  expect(r.cues[0]!.speaker).toBe("Speaker 1");
  expect(r.provider).toBe("wx");
});

test("probeProviders: unreadable or malformed key -> keyMissing with the reason, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  await writeFile(join(dir, "bad.key"), "sk-LEAKCANARY\nmore\n");
  const f: Fetcher = async () => new Response("{}");
  const unreadable = resolveProvider({ name: "u", type: "openai-compatible", preset: "groq", keyFile: dir });
  const malformed = resolveProvider({ name: "m", type: "openai-compatible", preset: "groq", keyFile: join(dir, "bad.key") });
  const r = await probeProviders([unreadable, malformed, groq], f, {}, dir);
  expect(r.map((c) => c.keyMissing)).toEqual([
    `cannot read file ${dir} (EISDIR)`,
    `key in file ${join(dir, "bad.key")} contains whitespace or control characters`,
    "env GROQ_API_KEY",
  ]);
});

test("probeProviders: whisperx with an unreadable or malformed key is not probed; the key problem is the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  await writeFile(join(dir, "bad.key"), "sk-LEAKCANARY\nmore\n");
  const urls: string[] = [];
  const f: Fetcher = async (u) => (urls.push(u), new Response("{}", { status: 401 }));
  const bad = resolveProvider({ name: "wx", type: "whisperx", url: "https://wx", keyFile: join(dir, "bad.key") });
  const gone = resolveProvider({ name: "wx2", type: "whisperx", url: "https://wx2", keyFile: dir });
  const cs = await probeProviders([bad, gone], f, {}, dir);
  expect(urls).toEqual([]);
  expect(chooseProvider({ ...base, candidates: cs })).toEqual({
    error: `no ASR provider fits: wx: no API key (key in file ${join(dir, "bad.key")} contains whitespace or control characters); ` +
      `wx2: no API key (cannot read file ${dir} (EISDIR))`,
  });
});
