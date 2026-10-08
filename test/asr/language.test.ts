import { expect, test } from "bun:test";
import { normalizeLanguage } from "../../src/asr/language";
import { parseVerbose } from "../../src/asr/openai-compatible";
import { parseWhisperx } from "../../src/asr/whisperx";

test("#7: normalizeLanguage — Whisper names to ISO 639-1, codes kept, unknown → null", () => {
  expect(normalizeLanguage("English")).toBe("en");
  expect(normalizeLanguage("russian")).toBe("ru");
  expect(normalizeLanguage("Haitian Creole")).toBe("ht");
  expect(normalizeLanguage("cantonese")).toBe("yue");
  expect(normalizeLanguage("en")).toBe("en");
  expect(normalizeLanguage("pt-BR")).toBe("pt");
  expect(normalizeLanguage("klingon")).toBeNull();
  expect(normalizeLanguage("")).toBeNull();
  expect(normalizeLanguage(undefined)).toBeNull();
});

test("#7: parsed ASR results carry ISO codes", () => {
  const seg = [{ start: 0, end: 1, text: " hi" }];
  expect(parseVerbose({ language: "English", segments: seg }, "srv").language).toBe("en");
  expect(parseVerbose({ language: "russian", segments: seg }, "srv").language).toBe("ru");
  expect(parseWhisperx({ language: "ru", segments: seg }, "wx").language).toBe("ru");
});
