import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressAudio, probeDuration } from "../src/audio";
import type { Runner } from "../src/types";

test("compressAudio: exact ffmpeg argv; non-zero code → Error with stderr", async () => {
  const calls: string[][] = [];
  const w = mkdtempSync(join(tmpdir(), "vs-audio-"));
  const out = join(w, "audio.ogg");
  const ok: Runner = async (cmd) => (calls.push(cmd), writeFileSync(cmd.at(-1)!, "ogg"), { code: 0, stdout: "", stderr: "" });
  await compressAudio("/in/a b.webm", out, ok);
  expect(calls[0]).toEqual([
    "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", "/in/a b.webm",
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", `${out}.tmp`,
  ]);
  expect([existsSync(out), existsSync(`${out}.tmp`)]).toEqual([true, false]);
  const bad: Runner = async () => ({ code: 1, stdout: "", stderr: "Invalid data found when processing input" });
  expect(compressAudio("/x", "/y.ogg", bad)).rejects.toThrow("Invalid data found");
});

test("compressAudio: ffmpeg failed midway → no output file, partial file deleted", async () => {
  const w = mkdtempSync(join(tmpdir(), "vs-audio-"));
  const out = join(w, "audio.ogg");
  const half: Runner = async (cmd) => (writeFileSync(cmd.at(-1)!, "half"), { code: 1, stdout: "", stderr: "No space left on device" });
  await compressAudio("/in.webm", out, half).catch(() => {});
  expect([existsSync(out), existsSync(`${out}.tmp`)]).toEqual([false, false]);
});

test("probeDuration: '5400.123\\n' → 5400.123", async () => {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => (calls.push(cmd), { code: 0, stdout: "5400.123\n", stderr: "" });
  expect(await probeDuration("/f.mp4", run)).toBe(5400.123);
  expect(calls[0]).toEqual(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "/f.mp4"]);
});

test("probeDuration: garbage in output → UserError 'could not determine duration'", async () => {
  const run: Runner = async () => ({ code: 0, stdout: "N/A\n", stderr: "" });
  expect(probeDuration("/f", run)).rejects.toThrow("could not determine duration");
});
