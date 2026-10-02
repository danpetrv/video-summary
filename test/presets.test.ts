import { expect, test } from "bun:test";
import { resolveProvider } from "../src/asr/presets";

test("resolveProvider: пресеты", () => {
  expect(resolveProvider({ name: "g", type: "openai-compatible", preset: "groq", tier: "free" })).toMatchObject({
    url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", format: "verbose_json",
    maxBytes: 25_000_000, maxSeconds: 7000, local: false, keyRequired: true, diarize: false });
  expect(resolveProvider({ name: "g", type: "openai-compatible", preset: "groq", tier: "dev" }))
    .toMatchObject({ maxBytes: 100_000_000, maxSeconds: null });
  expect(resolveProvider({ name: "g", type: "openai-compatible", preset: "groq" }))
    .toMatchObject({ maxBytes: 25_000_000, maxSeconds: 7000 });
  expect(resolveProvider({ name: "o", type: "openai-compatible", preset: "openai" }))
    .toMatchObject({ url: "https://api.openai.com/v1", model: "whisper-1", format: "verbose_json", diarize: false,
      maxBytes: 25_000_000, maxSeconds: null });
  expect(resolveProvider({ name: "o", type: "openai-compatible", preset: "openai", diarize: true }))
    .toMatchObject({ model: "gpt-4o-transcribe-diarize", format: "diarized_json", diarize: true });
  expect(resolveProvider({ name: "w", type: "whisperx", url: "https://a/" }))
    .toMatchObject({ url: "https://a", diarize: true, local: true, keyRequired: false, maxBytes: null, format: null });
  expect(resolveProvider({ name: "l", type: "openai-compatible", url: "http://l/v1", model: "m", local: true, maxBytes: 5 }))
    .toMatchObject({ local: true, maxBytes: 5, keyRequired: false, format: "verbose_json" });
  expect(() => resolveProvider({ name: "l", type: "openai-compatible", url: "http://l/v1" }))
    .toThrow("config: provider l: model is required without preset");
});

test("resolveProvider: поля конфига переопределяют пресет; ключи пробрасываются", () => {
  const r = resolveProvider({ name: "g", type: "openai-compatible", preset: "groq", url: "https://p/v1/", model: "m",
    maxSeconds: null, maxBytes: 10, keyEnv: "K", keyFile: "~/k" });
  expect(r).toMatchObject({ url: "https://p/v1", model: "m", maxSeconds: null, maxBytes: 10, keyEnv: "K", keyFile: "~/k" });
  expect(resolveProvider({ name: "w", type: "whisperx", url: "u", diarize: false, local: false }))
    .toMatchObject({ diarize: false, local: false });
  expect(() => resolveProvider({ name: "x", type: "whisperx" })).toThrow("config: provider x: url is required");
});
