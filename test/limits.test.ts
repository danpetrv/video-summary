import { expect, test } from "bun:test";
import { resolveProvider } from "../src/asr/presets";
import { bitrateFor, limitsReport, maxDurationFor, targetBytes } from "../src/limits";

const groq = resolveProvider({ name: "groq", type: "openai-compatible", preset: "groq", tier: "free" });
const openai = resolveProvider({ name: "openai", type: "openai-compatible", preset: "openai" });
const wx = resolveProvider({ name: "wx", type: "whisperx", url: "https://a" });
const loc = resolveProvider({ name: "l", type: "openai-compatible", url: "http://l/v1", model: "m", local: true, maxBytes: 1_000 });

test("bitrateFor", () => {
  expect(bitrateFor(6805, "adaptive", 24_000_000)).toBe(28);
  expect(bitrateFor(600, "adaptive", 24_000_000)).toBe(32);
  expect(bitrateFor(50_000, "adaptive", 24_000_000)).toBe(16);
  expect(bitrateFor(6805, "adaptive", null)).toBe(32);
  expect(bitrateFor(null, "adaptive", 24_000_000)).toBe(32);
  expect(bitrateFor(6805, "fixed", 24_000_000)).toBe(32);
});

test("targetBytes: 96% от наименьшего облачного лимита; локальные не считаются", () => {
  expect(targetBytes([groq, openai])).toBe(24_000_000);
  expect(targetBytes([groq, resolveProvider({ name: "d", type: "openai-compatible", preset: "groq", tier: "dev" })])).toBe(24_000_000);
  expect(targetBytes([loc, groq])).toBe(24_000_000);
  expect(targetBytes([wx, loc])).toBeNull();
  expect(targetBytes([])).toBeNull();
});

test("maxDurationFor", () => {
  expect(maxDurationFor(groq, 16)).toBe(7000);
  expect(maxDurationFor(groq, 32)).toBe(6000); // 96% of 25 MB at 32 kbps
  expect(maxDurationFor(openai, 32)).toBe(6000);
  expect(maxDurationFor(openai, 16)).toBe(12000);
  expect(maxDurationFor(wx, 32)).toBeNull();
});

test("limitsReport: Groq free → adaptive 7000, fixed 6000; whisperx → null/null", () => {
  expect(limitsReport([groq, wx])).toEqual([
    { provider: "groq", adaptiveSec: 7000, fixedSec: 6000 },
    { provider: "wx", adaptiveSec: null, fixedSec: null },
  ]);
});
