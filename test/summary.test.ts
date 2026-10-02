import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReadingTime, finalizeSummary, readingMinutes } from "../src/summary";
import { UserError } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "vs-summary-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("readingMinutes: 400 words -> 2; 1 word -> 1; mermaid and code are not counted", () => {
  expect(readingMinutes("w ".repeat(400))).toBe(2);
  expect(readingMinutes("w ".repeat(401))).toBe(3);
  expect(readingMinutes("one")).toBe(1);
  expect(readingMinutes("")).toBe(1);
  expect(readingMinutes("a b\n```mermaid\n" + "x ".repeat(1000) + "\n```\nc\n~~~\n" + "y ".repeat(1000) + "\n~~~\n")).toBe(1);
});

test("applyReadingTime: {{reading_time}} -> number", () => {
  expect(applyReadingTime("# T\n\n> 📺 a\n> 📖 ~{{reading_time}} min read\n\n" + "w ".repeat(450)))
    .toContain("> 📖 ~3 min read");
});

test("applyReadingTime: second call after an edit recomputes the number in the '> 📖 ~N' line", () => {
  const first = applyReadingTime("# T\n\n> 📖 ~{{reading_time}} min read\n\n" + "w ".repeat(150));
  expect(first).toContain("> 📖 ~1 min read");
  const edited = first + "w ".repeat(450);
  const second = applyReadingTime(edited);
  expect(second).toContain("> 📖 ~4 min read");
  expect(applyReadingTime(second)).toBe(second);
});

test("applyReadingTime: no placeholder and no line -> inserted after the first header quote line", () => {
  const out = applyReadingTime("# T\n\n> 📺 a\n> b\n\nbody " + "w ".repeat(10));
  expect(out).toContain("> 📺 a\n> 📖 ~1 min read\n> b");
});

test("applyReadingTime: no quote line at all -> inserted after the title", () => {
  expect(applyReadingTime("# T\n\nbody")).toContain("# T\n> 📖 ~1 min read\n");
});

test("finalizeSummary: no summary.md -> UserError; present -> file rewritten, minutes returned", async () => {
  const dir = mkdtempSync(join(root, "item-"));
  await expect(finalizeSummary(dir)).rejects.toBeInstanceOf(UserError);
  writeFileSync(join(dir, "summary.md"), "# T\n\n> 📖 ~{{reading_time}} min\n\n" + "w ".repeat(450));
  expect(await finalizeSummary(dir)).toEqual({ reading_minutes: 3 });
  expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("> 📖 ~3 min");
});

test("#5: repeated finalize on an unchanged summary keeps the same number", () => {
  // header tokens (#, T, >, 📺, a, ·, b, >, 📝, c) = 10 + 390 words = exactly 400 by the old count;
  // the inserted "> 📖 ~2 min read" would push the old count to 405 → 3 on the second pass
  const md = "# T\n\n> 📺 a · b\n> 📝 c\n\n" + "w ".repeat(390).trim() + "\n";
  const once = applyReadingTime(md);
  const twice = applyReadingTime(once);
  expect(twice).toBe(once);
  expect(readingMinutes(once)).toBe(readingMinutes(md));
});

test("#5: markdown markers and the reading-time line are not words", () => {
  const body = "w ".repeat(190).trim(); // 190 words + markers would be 201 → 2 min by the old count
  expect(readingMinutes(`# Title\n\n> 📖 ~3 min read\n> 📺 x\n\n- ${body}\n`)).toBe(readingMinutes(`Title\n\nx\n\n${body}\n`));
});
