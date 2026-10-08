import { expect, test } from "bun:test";
import { join } from "node:path";
import * as oc from "../../src/asr/openai-compatible";
import { modelsReachable, parseVerbose, transcribeOpenAI } from "../../src/asr/openai-compatible";
import { resolveProvider } from "../../src/asr/presets";
import { type Fetcher, UserError } from "../../src/types";

const fx = (n: string) => Bun.file(join(import.meta.dir, "../fixtures", n)).json();
const verbose = await fx("groq-verbose.json");
const audio = join(import.meta.dir, "../fixtures/sample.ru.srt");
const srv = resolveProvider({ name: "srv", type: "openai-compatible", url: "https://asr.example/v1", model: "whisper-large-v3-turbo", keyEnv: "K" });
const local = resolveProvider({ name: "loc", type: "openai-compatible", url: "http://127.0.0.1:8000/v1", model: "m" });

const rec = (body: unknown, status = 200) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: Fetcher = async (url, init) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }));
  return { calls, f };
};

test("parseVerbose: segments -> cues without speaker, diarized:false", () => {
  const r = parseVerbose(verbose, "srv");
  expect(r.cues.length).toBe(3);
  expect(r.cues[0]).toEqual({ start: 0, end: 8.7, text: "We're no strangers to love, you know the rules and so do I" });
  expect([r.provider, r.diarized, r.speakers]).toEqual(["srv", false, 0]);
});

test("verbose_json: POST {url}/audio/transcriptions, Bearer, model, response_format, timestamp_granularities[]=segment, language", async () => {
  const { calls, f } = rec(verbose);
  const r = await transcribeOpenAI(audio, { language: "en-US", diarize: true }, srv, "tok", f);
  expect(calls[0]!.url).toBe("https://asr.example/v1/audio/transcriptions");
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
  await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "tok", f);
  expect((calls[0]!.init?.body as FormData).has("language")).toBe(false);
});

test("diarize requested -> still verbose_json, no speakers (own servers have no diarized format)", async () => {
  const { calls, f } = rec(verbose);
  const r = await transcribeOpenAI(audio, { language: null, diarize: true }, srv, "tok", f);
  const fd = calls[0]!.init?.body as FormData;
  expect([fd.get("response_format"), fd.get("timestamp_granularities[]")]).toEqual(["verbose_json", "segment"]);
  expect(fd.has("chunking_strategy")).toBe(false);
  expect([r.diarized, r.speakers]).toEqual([false, 0]);
  expect("parseDiarized" in oc).toBe(false);
});

test("no key (local) -> no Authorization header", async () => {
  const { calls, f } = rec(verbose);
  await transcribeOpenAI(audio, { language: null, diarize: false }, local, null, f);
  expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
  expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBeUndefined();
});

test("429 -> UserError '<name>: rate limit — <message>'; 500 -> Error with code", async () => {
  const body = { error: { message: "Rate limit reached for model" } };
  const e1 = await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "t", rec(body, 429).f).catch((e) => e);
  expect(e1).toBeInstanceOf(UserError);
  expect(e1.message).toBe("srv: rate limit — Rate limit reached for model");
  const e2 = await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "t", async () => new Response("boom", { status: 500 })).catch((e) => e);
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
  const err = await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "t", f).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("srv: request failed — ECONNRESET");
});

test("transcribeOpenAI: abort signal and Bun's timeout:false on the request", async () => {
  const { calls, f } = rec(verbose);
  await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "t", f);
  expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  expect((calls[0]!.init as { timeout?: unknown }).timeout).toBe(false);
});

test("transcribeOpenAI: multi-line error bodies collapsed to one line (500 and 429)", async () => {
  const e1 = await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "t",
    async () => new Response("<html>\n<body>\n  Bad gateway\n</body>", { status: 500 })).catch((e) => e);
  expect(e1.message).toBe("srv responded 500: <html> <body> Bad gateway </body>");
  const e2 = await transcribeOpenAI(audio, { language: null, diarize: false }, srv, "t",
    async () => Response.json({ error: { message: "Rate limit\nreached" } }, { status: 429 })).catch((e) => e);
  expect(e2.message).toBe("srv: rate limit — Rate limit reached");
});
