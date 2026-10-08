import { expect, test } from "bun:test";
import { resolveProvider } from "../src/asr/presets";

test("resolveProvider: whisperx — diarize defaults to true, url trimmed, keys passed through", () => {
  expect(resolveProvider({ name: "w", type: "whisperx", url: "https://a/" })).toEqual({
    name: "w", type: "whisperx", url: "https://a", model: null, diarize: true, keyFile: null, keyEnv: null, engine: null, device: null,
  });
  expect(resolveProvider({ name: "w", type: "whisperx", url: "u", diarize: false, keyFile: "~/k", keyEnv: "K" }))
    .toMatchObject({ diarize: false, keyFile: "~/k", keyEnv: "K" });
});

test("resolveProvider: openai-compatible — url/model/keys from config, never diarized", () => {
  expect(resolveProvider({ name: "o", type: "openai-compatible", url: "http://h/v1//", model: "m", keyEnv: "K" })).toEqual({
    name: "o", type: "openai-compatible", url: "http://h/v1", model: "m", diarize: false, keyFile: null, keyEnv: "K", engine: null, device: null,
  });
  expect(() => resolveProvider({ name: "o", type: "openai-compatible", url: "http://h/v1" }))
    .toThrow("config: provider o: model is required");
});

test("resolveProvider: local — no url or keys, never diarized; engine/model/device from config", () => {
  expect(resolveProvider({ name: "local", type: "local", engine: "parakeet", model: "ultra", device: "auto" })).toEqual({
    name: "local", type: "local", url: null, model: "ultra", diarize: false, keyFile: null, keyEnv: null,
    engine: "parakeet", device: "auto",
  });
  expect(resolveProvider({ name: "l", type: "local", engine: "parakeet", model: "ultra", device: "cpu" }).device).toBe("cpu");
});
