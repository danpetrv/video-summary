import { expect, test } from "bun:test";
import { join } from "node:path";
import { modelsReachable, parseDiarized, parseVerbose, transcribeOpenAI } from "../../src/asr/openai-compatible";
import { resolveProvider } from "../../src/asr/presets";
import { type Fetcher, UserError } from "../../src/types";

const fx = (n: string) => Bun.file(join(import.meta.dir, "../fixtures", n)).json();
const verbose = await fx("groq-verbose.json");
const diarized = await fx("openai-diarized.json");
const audio = join(import.meta.dir, "../fixtures/sample.ru.srt");
const groq = resolveProvider({ name: "groq", type: "openai-compatible", preset: "groq", tier: "free", keyEnv: "GROQ_API_KEY" });
const oai = resolveProvider({ name: "oai", type: "openai-compatible", preset: "openai", diarize: true, keyEnv: "K" });
const local = resolveProvider({ name: "loc", type: "openai-compatible", url: "http://127.0.0.1:8000/v1", model: "m", local: true });

const rec = (body: unknown, status = 200) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: Fetcher = async (url, init) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }));
  return { calls, f };
};

test("parseVerbose: segments -> cues without speaker, diarized:false", () => {
  const r = parseVerbose(verbose, "groq");
  expect(r.cues.length).toBe(3);
  expect(r.cues[0]).toEqual({ start: 0, end: 8.7, text: "We're no strangers to love, you know the rules and so do I" });
  expect([r.provider, r.diarized, r.speakers]).toEqual(["groq", false, 0]);
});

test("parseDiarized: A,B,A -> Speaker 1,2,1; diarized true, speakers 2", () => {
  const r = parseDiarized(diarized, "oai");
  expect(r.cues.map((c) => c.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
  expect(r.cues[0]).toEqual({ start: 0.05, end: 5.25, text: "Hello.", speaker: "Speaker 1" });
  expect([r.diarized, r.speakers, r.provider]).toEqual([true, 2, "oai"]);
});

test("verbose_json: POST {url}/audio/transcriptions, Bearer, model, response_format, timestamp_granularities[]=segment, language", async () => {
  const { calls, f } = rec(verbose);
  const r = await transcribeOpenAI(audio, { language: "en-US", diarize: true }, groq, "tok", f);
  expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  expect(calls[0]!.init?.method).toBe("POST");
  expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  const fd = calls[0]!.init?.body as FormData;
  expect([fd.get("model"), fd.get("response_format"), fd.get("timestamp_granularities[]"), fd.get("language")])
    .toEqual(["whisper-large-v3-turbo", "verbose_json", "segment", "en"]);
  expect(fd.has("chunking_strategy")).toBe(false);
  expect(fd.get("file")).toBeInstanceOf(Blob);
  expect(r.language).toBe("en");
});

test("no language -> no language param", async () => {
  const { calls, f } = rec(verbose);
  await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "tok", f);
  expect((calls[0]!.init?.body as FormData).has("language")).toBe(false);
});

test("diarized_json: gpt-4o-transcribe-diarize, response_format diarized_json, chunking_strategy auto, no timestamp_granularities", async () => {
  const { calls, f } = rec(diarized);
  const r = await transcribeOpenAI(audio, { language: null, diarize: true }, oai, "tok", f);
  const fd = calls[0]!.init?.body as FormData;
  expect([fd.get("model"), fd.get("response_format"), fd.get("chunking_strategy")])
    .toEqual(["gpt-4o-transcribe-diarize", "diarized_json", "auto"]);
  expect(fd.has("timestamp_granularities[]")).toBe(false);
  expect([r.diarized, r.speakers]).toEqual([true, 2]);
});

test("no key (local) -> no Authorization header", async () => {
  const { calls, f } = rec(verbose);
  await transcribeOpenAI(audio, { language: null, diarize: false }, local, null, f);
  expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
  expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("429 -> UserError '<name>: rate limit — <message>'; 500 -> Error with code", async () => {
  const body = { error: { message: "Rate limit reached for model" } };
  const e1 = await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "t", rec(body, 429).f).catch((e) => e);
  expect(e1).toBeInstanceOf(UserError);
  expect(e1.message).toBe("groq: rate limit — Rate limit reached for model");
  const e2 = await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "t", async () => new Response("boom", { status: 500 })).catch((e) => e);
  expect(e2.constructor).toBe(Error);
  expect(e2.message).toContain("500");
});

test("modelsReachable: 200 -> true; 404/throw -> false; hits {url}/models", async () => {
  const { calls, f } = rec({});
  expect(await modelsReachable("http://h/v1/", f, "k")).toBe(true);
  expect(calls[0]!.url).toBe("http://h/v1/models");
  expect(await modelsReachable("http://h/v1", async () => new Response("", { status: 404 }), null)).toBe(false);
  expect(await modelsReachable("http://h/v1", async () => { throw new Error("x"); }, null)).toBe(false);
});

test("transcribeOpenAI: network failure -> UserError '<name>: request failed — <code>'", async () => {
  const f: Fetcher = async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); };
  const err = await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "t", f).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("groq: request failed — ECONNRESET");
});

test("transcribeOpenAI: abort signal and Bun's timeout:false on the request", async () => {
  const { calls, f } = rec(verbose);
  await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "t", f);
  expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  expect((calls[0]!.init as { timeout?: unknown }).timeout).toBe(false);
});

test("transcribeOpenAI: multi-line error bodies collapsed to one line (500 and 429)", async () => {
  const e1 = await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "t",
    async () => new Response("<html>\n<body>\n  Bad gateway\n</body>", { status: 500 })).catch((e) => e);
  expect(e1.message).toBe("groq responded 500: <html> <body> Bad gateway </body>");
  const e2 = await transcribeOpenAI(audio, { language: null, diarize: false }, groq, "t",
    async () => Response.json({ error: { message: "Rate limit\nreached" } }, { status: 429 })).catch((e) => e);
  expect(e2.message).toBe("groq: rate limit — Rate limit reached");
});
