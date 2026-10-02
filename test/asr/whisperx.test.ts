import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveProvider } from "../../src/asr/presets";
import { parseWhisperx, transcribeWhisperx, whisperxHealthy } from "../../src/asr/whisperx";
import { postAsr } from "../../src/asr/types";
import { type Fetcher, UserError } from "../../src/types";

const fixture = await Bun.file(join(import.meta.dir, "../fixtures/whisperx-diarized.json")).json();
const audio = join(import.meta.dir, "../fixtures/sample.ru.srt"); // any existing file as "audio"
const wx = resolveProvider({ name: "wx", type: "whisperx", url: "https://asr.example" });
const wxSlash = resolveProvider({ name: "wx", type: "whisperx", url: "https://asr.example/" });

test("parseWhisperx: SPEAKER_xx -> Speaker N by first appearance; no speaker -> undefined", () => {
  const r = parseWhisperx(fixture, "wx");
  expect(r.cues.map((c) => c.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1", undefined]);
  expect(r.cues[0]).toEqual({ start: 0, end: 4.2, text: "Всем привет, это стрим про миграцию.", speaker: "Speaker 1" });
  expect([r.diarized, r.speakers, r.language, r.provider]).toEqual([true, 2, "ru", "wx"]);
});

test("parseWhisperx: diarization softly failed -> diarized:false, speakers:0", () => {
  const segs = fixture.segments.map(({ speaker, ...s }: { speaker?: string }) => s);
  const r = parseWhisperx({ ...fixture, segments: segs }, "wx");
  expect([r.diarized, r.speakers]).toEqual([false, 0]);
  expect(r.cues.every((c) => c.speaker === undefined)).toBe(true);
});

const catcher = (status = 200, body: unknown = fixture) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: Fetcher = async (url, init) => (calls.push({ url, init }), new Response(JSON.stringify(body), { status }));
  return { calls, f };
};

test("transcribeWhisperx: URL and request shape; language is the primary subtag", async () => {
  const { calls, f } = catcher();
  await transcribeWhisperx(audio, { language: "ru-RU", diarize: true }, wx, null, f);
  const u = new URL(calls[0]!.url);
  expect(u.origin + u.pathname).toBe("https://asr.example/asr");
  expect(Object.fromEntries(u.searchParams)).toEqual({ output: "json", diarize: "true", word_timestamps: "false", language: "ru" });
  expect(calls[0]!.init?.method).toBe("POST");
  expect((calls[0]!.init?.body as FormData).get("audio_file")).toBeInstanceOf(Blob);

  await transcribeWhisperx(audio, { language: null, diarize: false }, wxSlash, null, f);
  const u2 = new URL(calls[1]!.url);
  expect(u2.pathname).toBe("/asr");
  expect(u2.searchParams.get("diarize")).toBe("false");
  expect(u2.searchParams.has("language")).toBe(false);
});

test("whisperx: key set -> Authorization: Bearer; none -> no header", async () => {
  const { calls, f } = catcher();
  await transcribeWhisperx(audio, { language: null, diarize: true }, wx, "k1", f);
  await transcribeWhisperx(audio, { language: null, diarize: true }, wx, null, f);
  expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer k1");
  expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBeUndefined();
  const r = await transcribeWhisperx(audio, { language: null, diarize: true }, wx, "k1", f);
  expect(r.cues[0]!.speaker).toBe("Speaker 1");
});

test("whisperxHealthy: 200 -> true; 502 -> false; throw -> false", async () => {
  expect(await whisperxHealthy("https://a", async () => new Response("{}", { status: 200 }), null)).toBe(true);
  expect(await whisperxHealthy("https://a", async () => new Response("", { status: 502 }), null)).toBe(false);
  expect(await whisperxHealthy("https://a", async () => { throw new Error("ECONNREFUSED"); }, null)).toBe(false);
});

test("whisperxHealthy: hits /health", async () => {
  const { calls, f } = catcher(200, {});
  await whisperxHealthy("https://a/", f, null);
  expect(calls[0]!.url).toBe("https://a/health");
});

test("transcribeWhisperx: 500 -> plain Error with code and body", async () => {
  const { f } = catcher(500, { detail: "CUDA out of memory" });
  const err = await transcribeWhisperx(audio, { language: null, diarize: true }, wx, null, f).catch((e) => e);
  expect(err.constructor).toBe(Error);
  expect(err.message).toContain("500");
  expect(err.message).toContain("CUDA out of memory");
});

test("transcribeWhisperx: provider diarize:false overrides o.diarize:true", async () => {
  const { calls, f } = catcher();
  const p = resolveProvider({ name: "wx", type: "whisperx", url: "https://asr.example", diarize: false });
  await transcribeWhisperx(audio, { language: null, diarize: true }, p, null, f);
  expect(new URL(calls[0]!.url).searchParams.get("diarize")).toBe("false");
});

test("transcribeWhisperx: network failure -> one-line UserError '<name>: request failed — <code>'", async () => {
  const f: Fetcher = async () => { throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }); };
  const err = await transcribeWhisperx(audio, { language: null, diarize: true }, wx, null, f).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("wx: request failed — UND_ERR_HEADERS_TIMEOUT");
});

test("transcribeWhisperx: request has an abort signal and Bun's timeout:false", async () => {
  const { calls, f } = catcher();
  await transcribeWhisperx(audio, { language: null, diarize: true }, wx, null, f);
  expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  expect((calls[0]!.init as { timeout?: unknown }).timeout).toBe(false);
});

test("transcribeWhisperx: multi-line error body collapsed to one line", async () => {
  const f: Fetcher = async () => new Response("Traceback:\n  File x\n\tCUDA out of memory\n", { status: 500 });
  const err = await transcribeWhisperx(audio, { language: null, diarize: true }, wx, null, f).catch((e) => e);
  expect(err.message).toBe("wx: whisperx responded 500: Traceback: File x CUDA out of memory");
});

test("postAsr: injected short timeout against a slow server -> UserError TimeoutError", async () => {
  const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() { await Bun.sleep(1000); return new Response("{}"); } });
  try {
    const err = await postAsr("wx", fetch, `http://127.0.0.1:${slow.port}/asr`, {}, new FormData(), 100).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("wx: request failed — TimeoutError");
  } finally {
    slow.stop(true);
  }
});

test("postAsr: connection refused -> UserError with the error code, not 'fetch failed'", async () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  const err = await postAsr("wx", fetch, `http://127.0.0.1:${port}/asr`, {}, new FormData()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toMatch(/^wx: request failed — \S+$/);
  expect(err.message).not.toContain("fetch failed");
});
