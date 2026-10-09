import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProvider, type ResolvedProvider } from "../../src/asr/providers";
import { type AsrDeps, type Candidate, chooseProvider, probeProviders, type SelectInput, transcribeWith } from "../../src/asr/select";
import { localPaths } from "../../src/local/paths";
import { DIAR_MODEL } from "../../src/local/pins";
import type { Fetcher, Runner } from "../../src/types";

const own = resolveProvider({ name: "own", type: "openai-compatible", url: "http://own/v1", model: "m", keyEnv: "OWN_KEY" });
const wx = resolveProvider({ name: "wx", type: "whisperx", url: "https://wx" });
const loc = resolveProvider({ name: "local", type: "local", engine: "parakeet", model: "ultra", device: "auto", diarize: true });
const ok = (p: ResolvedProvider): Candidate => ({ provider: p, available: true, keyMissing: null });
const asrDeps = (fetch: Fetcher, home: string): AsrDeps => ({
  fetch, env: {}, home, platform: "linux", arch: "x64", exists: () => false,
  run: async (cmd) => { throw new Error(`unexpected command ${cmd.join(" ")}`); },
});
const base: Omit<SelectInput, "candidates"> = { durationSec: 5400, language: null, acceptSlow: false, estimate: () => null };

test("chooseProvider: first fitting in order", () => {
  expect(chooseProvider({ ...base, candidates: [ok(wx), ok(own)] })).toEqual({ provider: wx });
  expect(chooseProvider({ ...base, candidates: [ok(own), ok(wx)] })).toEqual({ provider: own });
});

test("chooseProvider: reasons are only availability and key", () => {
  const r = chooseProvider({ ...base, candidates: [{ ...ok(wx), available: false }, { ...ok(own), keyMissing: "cannot read file ~/k (EISDIR)" }] });
  expect(r).toEqual({ error: "no ASR provider fits: wx: not reachable; own: no API key (cannot read file ~/k (EISDIR))" });
  // no duration or size limits any more: a 10-hour recording fits
  expect(chooseProvider({ ...base, durationSec: 36_000, candidates: [ok(own)] })).toEqual({ provider: own });
});

test("chooseProvider: local not installed -> reason names `local install`; installed -> chosen", () => {
  const r = chooseProvider({ ...base, candidates: [{ ...ok(loc), available: false }, { ...ok(wx), available: false }] });
  expect(r).toEqual({ error: "no ASR provider fits: local: local engine not installed — run `local install`; wx: not reachable" });
  expect(chooseProvider({ ...base, candidates: [ok(loc), ok(wx)] })).toEqual({ provider: loc });
});

const slow = (minutes: number, device: "gpu" | "cpu" = "cpu", speed = 8): SelectInput["estimate"] => () => ({ minutes, device, speed });

test("chooseProvider: local over 10 min without acceptSlow -> rejected with the gate reason, next provider chosen", () => {
  expect(chooseProvider({ ...base, estimate: slow(11.25), candidates: [ok(loc), ok(wx)] })).toEqual({ provider: wx });
  expect(chooseProvider({ ...base, estimate: slow(11.25), candidates: [ok(loc)] }))
    .toEqual({ error: "no ASR provider fits: local: ~12 min on CPU (measured speed 8x); add --accept-slow to wait" });
  expect(chooseProvider({ ...base, estimate: slow(20.01, "gpu", 4.6), candidates: [ok(loc)] }))
    .toEqual({ error: "no ASR provider fits: local: ~21 min on GPU (measured speed 5x); add --accept-slow to wait" });
  // exactly 10 min is not over the threshold; no estimate -> not gated
  expect(chooseProvider({ ...base, estimate: slow(10), candidates: [ok(loc), ok(wx)] })).toEqual({ provider: loc });
  expect(chooseProvider({ ...base, candidates: [ok(loc), ok(wx)] })).toEqual({ provider: loc });
  // not installed is the reason that matters, not the time
  expect(chooseProvider({ ...base, estimate: slow(60), candidates: [{ ...ok(loc), available: false }] }))
    .toEqual({ error: "no ASR provider fits: local: local engine not installed — run `local install`" });
});

test("chooseProvider: gate with diarization shows both numbers", () => {
  const withDiar = (minutes: number, withoutDiarization: number): SelectInput["estimate"] =>
    () => ({ minutes, device: "cpu", speed: 8, withoutDiarization });
  // without diarization it fits: offer --no-diarize
  expect(chooseProvider({ ...base, estimate: withDiar(16.9, 9.4), candidates: [ok(loc)] })).toEqual({
    error: "no ASR provider fits: local: ~17 min on CPU with speaker labels (~10 without); add --accept-slow to wait, or --no-diarize to skip speaker labels",
  });
  // slow either way: only --accept-slow
  expect(chooseProvider({ ...base, estimate: withDiar(25, 18), candidates: [ok(loc)] })).toEqual({
    error: "no ASR provider fits: local: ~25 min on CPU with speaker labels (~18 without); add --accept-slow to wait",
  });
  // withoutDiarization of exactly 10 still fits
  expect(chooseProvider({ ...base, estimate: withDiar(15, 10), candidates: [ok(loc)] })).toEqual({
    error: "no ASR provider fits: local: ~15 min on CPU with speaker labels (~10 without); add --accept-slow to wait, or --no-diarize to skip speaker labels",
  });
  // total within the threshold -> not gated
  expect(chooseProvider({ ...base, estimate: withDiar(10, 6), candidates: [ok(loc)] })).toEqual({ provider: loc });
});

test("chooseProvider: local over 10 min with acceptSlow -> chosen", () => {
  expect(chooseProvider({ ...base, acceptSlow: true, estimate: slow(90), candidates: [ok(loc), ok(wx)] })).toEqual({ provider: loc });
});

test("chooseProvider: whisperx and openai-compatible are never gated", () => {
  expect(chooseProvider({ ...base, estimate: slow(600), candidates: [ok(wx)] })).toEqual({ provider: wx });
  expect(chooseProvider({ ...base, estimate: slow(600), candidates: [ok(own)] })).toEqual({ provider: own });
});

test("probeProviders: local availability comes from the install status, no network, no key", async () => {
  const f: Fetcher = async (u) => { throw new Error(`local must not be probed over the network: ${u}`); };
  expect(await probeProviders([loc], f, {}, "/nohome", { installed: true }))
    .toEqual([{ provider: loc, available: true, keyMissing: null }]);
  expect(await probeProviders([loc], f, {}, "/nohome", { installed: false }))
    .toEqual([{ provider: loc, available: false, keyMissing: null }]);
  expect((await probeProviders([loc], f, {}, "/nohome"))[0]!.available).toBe(false);
});

test("chooseProvider: local skipped for a known unsupported language (ja); allowed for ru-RU and for null", () => {
  expect(chooseProvider({ ...base, language: "ja", candidates: [ok(loc)] }))
    .toEqual({ error: "no ASR provider fits: local: language ja not supported" });
  expect(chooseProvider({ ...base, language: "ja", candidates: [ok(loc), ok(wx)] })).toEqual({ provider: wx });
  expect(chooseProvider({ ...base, language: "ru-RU", candidates: [ok(loc), ok(wx)] })).toEqual({ provider: loc });
  expect(chooseProvider({ ...base, language: null, candidates: [ok(loc), ok(wx)] })).toEqual({ provider: loc });
  // remote providers have no language list
  expect(chooseProvider({ ...base, language: "ja", candidates: [ok(wx)] })).toEqual({ provider: wx });
});

test("transcribeWith: local -> parakeet-cli on the installed build; language from the options; speaker labels need --diarize and provider diarize", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  const env = { XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache") };
  const paths = localPaths(env, dir);
  const cli = paths.cli("linux-cpu-x64");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, "");
  await mkdir(dirname(paths.diarModel), { recursive: true });
  await writeFile(paths.diarModel, "");
  await truncate(paths.diarModel, DIAR_MODEL.size);
  const words = await Bun.file(join(import.meta.dir, "../fixtures/parakeet-words.json")).text();
  const scene = await Bun.file(join(import.meta.dir, "../fixtures/parakeet-scene.jsonl")).text();
  let ran: string[] = [];
  const run: Runner = async (cmd) => {
    ran.push(cmd[0] === "ffmpeg" ? "ffmpeg" : `${cmd[0]} ${cmd[1]}`);
    if (cmd[0] === "ffmpeg") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: cmd[1] === "scene" ? scene : words, stderr: "" };
  };
  const f: Fetcher = async (u) => { throw new Error(`local must not use the network: ${u}`); };
  const d = { ...asrDeps(f, dir), env, run, exists: existsSync };
  const audio = join(dir, "audio.ogg");
  const r = await transcribeWith(loc, audio, { language: "ru", diarize: true }, d);
  expect(ran).toEqual(["ffmpeg", `${cli} transcribe`, `${cli} scene`]);
  expect([r.provider, r.language, r.diarized, r.speakers, r.device, r.cues[0]!.text])
    .toEqual(["local", "ru", true, 2, "cpu", "Погнали, привет."]);

  ran = [];
  const r2 = await transcribeWith(loc, audio, { language: null, diarize: false }, d);
  expect(ran).toEqual(["ffmpeg", `${cli} transcribe`]);
  expect([r2.language, r2.diarized, r2.notes]).toEqual([null, false, undefined]);

  // the provider has speaker labels off: no scene run, no note, whatever the flag says
  ran = [];
  const r3 = await transcribeWith({ ...loc, diarize: false }, audio, { language: null, diarize: true }, d);
  expect(ran).toEqual(["ffmpeg", `${cli} transcribe`]);
  expect([r3.diarized, r3.notes]).toEqual([false, undefined]);
});

test("chooseProvider: empty list", () => {
  expect(chooseProvider({ ...base, candidates: [] }))
    .toEqual({ error: "no ASR providers configured — run setup (see references/setup.md)" });
});

test("probeProviders: openai-compatible always probed via /models, whisperx via /health; a key is optional", async () => {
  const urls: string[] = [];
  const f: Fetcher = async (u) => (urls.push(u), new Response("{}", { status: u.endsWith("/health") ? 502 : 200 }));
  const r = await probeProviders([wx, own], f, {}, "/nohome");
  expect(urls.sort()).toEqual(["http://own/v1/models", "https://wx/health"]);
  expect(r.map((c) => [c.provider.name, c.available, c.keyMissing])).toEqual([["wx", false, null], ["own", true, null]]);
  const down: Fetcher = async () => new Response("", { status: 404 });
  expect((await probeProviders([own], down, {}, "/nohome"))[0]!.available).toBe(false);
});

test("probeProviders: the key, when set, goes to the /models probe", async () => {
  let auth: string | undefined;
  const f: Fetcher = async (_u, init) => (auth = (init?.headers as Record<string, string>).Authorization, new Response("{}"));
  await probeProviders([own], f, { OWN_KEY: "k1" }, "/nohome");
  expect(auth).toBe("Bearer k1");
});

test("transcribeWith: reads key file, dispatches by type; no key -> no Authorization header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  await writeFile(join(dir, "tok"), "secret-token\n");
  const audio = join(import.meta.dir, "../fixtures/sample.ru.srt");
  const verbose = await Bun.file(join(import.meta.dir, "../fixtures/openai-verbose.json")).text();
  let auth: string | undefined, url = "";
  const f: Fetcher = async (u, init) => (url = u, auth = (init?.headers as Record<string, string>).Authorization, new Response(verbose));
  const p = resolveProvider({ name: "g", type: "openai-compatible", url: "http://own/v1", model: "m", keyFile: join(dir, "tok") });
  const r = await transcribeWith(p, audio, { language: null, diarize: false }, asrDeps(f, dir));
  expect(auth).toBe("Bearer secret-token");
  expect(url).toBe("http://own/v1/audio/transcriptions");
  expect(r.provider).toBe("g");
  await transcribeWith(own, audio, { language: null, diarize: false }, asrDeps(f, dir));
  expect(auth).toBeUndefined();
});

test("transcribeWith: whisperx dispatch -> /asr with Speaker labels", async () => {
  const audio = join(import.meta.dir, "../fixtures/sample.ru.srt");
  const body = await Bun.file(join(import.meta.dir, "../fixtures/whisperx-diarized.json")).text();
  let url = "";
  const f: Fetcher = async (u) => (url = u, new Response(body));
  const r = await transcribeWith(wx, audio, { language: null, diarize: true }, asrDeps(f, "/nohome"));
  expect(new URL(url).pathname).toBe("/asr");
  expect(r.cues[0]!.speaker).toBe("Speaker 1");
  expect(r.provider).toBe("wx");
});

test("probeProviders: unreadable or malformed key -> keyMissing with the reason, not probed, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  await writeFile(join(dir, "bad.key"), "sk-LEAKCANARY\nmore\n");
  const urls: string[] = [];
  const f: Fetcher = async (u) => (urls.push(u), new Response("{}"));
  const unreadable = resolveProvider({ name: "u", type: "openai-compatible", url: "http://u/v1", model: "m", keyFile: dir });
  const malformed = resolveProvider({ name: "m", type: "openai-compatible", url: "http://m/v1", model: "m", keyFile: join(dir, "bad.key") });
  const r = await probeProviders([unreadable, malformed], f, {}, dir);
  expect(urls).toEqual([]);
  expect(r.map((c) => c.keyMissing)).toEqual([
    `cannot read file ${dir} (EISDIR)`,
    `key in file ${join(dir, "bad.key")} contains whitespace or control characters`,
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
