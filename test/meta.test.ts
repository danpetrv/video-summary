import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, type Meta, readMeta, writeMeta } from "../src/meta";

const tmp = mkdtempSync(join(tmpdir(), "vs-meta-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const meta: Meta = {
  source_key: "Youtube:x", source: "asr", asr_provider: "groq", diarized: false, speakers: 0,
  url: "https://www.youtube.com/watch?v=x", path: null, id: "x", title: "T", uploader: "U",
  upload_date: "20260101", duration: 5400, language: "ru", created_at: "2026-10-02T12:00:00.000Z",
  transcript_tokens: 100, readeck_bookmark_id: null, readeck_summary_sha: null,
};

test("readMeta/writeMeta round-trip; JSON с отступом 2 и \\n в конце", async () => {
  await writeMeta(tmp, meta);
  expect(await readMeta(tmp)).toEqual(meta);
  const raw = await Bun.file(join(tmp, "meta.json")).text();
  expect(raw).toBe(JSON.stringify(meta, null, 2) + "\n");
});

test("readMeta: нет файла → null", async () => {
  expect(await readMeta(join(tmp, "nope"))).toBeNull();
});

test("estimateTokens", () => {
  expect(estimateTokens("abcdefg")).toBe(3);
  expect(estimateTokens("")).toBe(0);
});

test("Meta: asr_provider вместо asr_backend (round-trip)", async () => {
  const d = join(tmp, "prov");
  mkdirSync(d);
  const m: Meta = { ...meta, source: "youtube-auto-subs", asr_provider: "my-local" };
  await writeMeta(d, m);
  const back = await readMeta(d);
  expect(back).toEqual(m);
  expect(back).not.toHaveProperty("asr_backend");
  await writeMeta(d, { ...meta, source: "manual-subs", asr_provider: null });
  expect((await readMeta(d))!.asr_provider).toBeNull();
});
