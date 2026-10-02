import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findSidecarSubs, resolveInputPath, resolveItemDir, slugify } from "../src/paths";

const tmp = mkdtempSync(join(tmpdir(), "vs-paths-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const today = new Date(2026, 9, 2, 12);

test("slugify", () => {
  expect(slugify("Как мы переезжали на K8s!")).toBe("как-мы-переезжали-на-k8s");
  expect(slugify("a/b\\c: d")).toBe("a-b-c-d");
  expect(slugify("🔥🔥🔥 !!!")).toBe("video");
  expect(slugify("")).toBe("video");
  expect(slugify("x".repeat(100)).length).toBe(60);
  expect(slugify("x".repeat(59) + " y")).toBe("x".repeat(59));
});

test("resolveInputPath: ~, относительный, абсолютный", () => {
  expect(resolveInputPath("~/v/a b.mp4", "/cwd", "/h")).toBe("/h/v/a b.mp4");
  expect(resolveInputPath("запись.m4a", "/cwd", "/h")).toBe("/cwd/запись.m4a");
  expect(resolveInputPath("../x.mp4", "/cwd/sub", "/h")).toBe("/cwd/x.mp4");
  expect(resolveInputPath("/abs/x.mp4", "/cwd", "/h")).toBe("/abs/x.mp4");
});

test("findSidecarSubs: name.srt, name.vtt, name.ru.srt; без сабов → null", async () => {
  const d = join(tmp, "side");
  mkdirSync(d);
  const video = join(d, "Запись встречи.mp4");
  writeFileSync(video, "");
  expect(await findSidecarSubs(video)).toBeNull();
  writeFileSync(join(d, "Запись встречи.ru.srt"), "");
  expect(await findSidecarSubs(video)).toBe(join(d, "Запись встречи.ru.srt"));
  writeFileSync(join(d, "Запись встречи.vtt"), "");
  expect(await findSidecarSubs(video)).toBe(join(d, "Запись встречи.vtt"));
  writeFileSync(join(d, "Запись встречи.srt"), "");
  expect(await findSidecarSubs(video)).toBe(join(d, "Запись встречи.srt"));
  writeFileSync(join(d, "Запись встречи 2.srt"), "");
  writeFileSync(join(d, "Другое.srt"), "");
  const v2 = join(d, "Другое видео.mkv");
  writeFileSync(v2, "");
  expect(await findSidecarSubs(v2)).toBeNull();
});

const writeMetaKey = (dir: string, key: string) => writeFileSync(join(dir, "meta.json"), JSON.stringify({ source_key: key }));

test("findSidecarSubs: lecture.part2.srt — чужой файл, не субтитры lecture.mp4; .SRT в верхнем регистре находится", async () => {
  const d = join(tmp, "side2");
  mkdirSync(d);
  const v = join(d, "lecture.mp4");
  writeFileSync(v, "");
  writeFileSync(join(d, "lecture.part2.mp4"), "");
  writeFileSync(join(d, "lecture.part2.srt"), "");
  expect(await findSidecarSubs(v)).toBeNull();
  writeFileSync(join(d, "lecture.en-US.SRT"), "");
  expect(await findSidecarSubs(v)).toBe(join(d, "lecture.en-US.SRT"));
});

test("resolveItemDir: новая папка <YYYY-MM-DD>-<slug>", async () => {
  const base = join(tmp, "b1");
  const dir = await resolveItemDir(base, "Youtube:abc", "Привет, мир", today);
  expect(dir).toBe(join(base, "2026-10-02-привет-мир"));
  expect(statSync(dir).isDirectory()).toBe(true);
  expect((await Array.fromAsync(new Bun.Glob("*").scan({ cwd: base, onlyFiles: false })))).toEqual([basename(dir)]);
});

test("resolveItemDir: тот же source_key в meta.json → прежняя папка, даже при другой дате", async () => {
  const base = join(tmp, "b2");
  const first = await resolveItemDir(base, "Youtube:abc", "Видео", today);
  writeMetaKey(first, "Youtube:abc");
  const again = await resolveItemDir(base, "Youtube:abc", "Видео (переименовано)", new Date(2026, 10, 5));
  expect(again).toBe(first);
});

test("resolveItemDir: тот же slug и дата, другой source_key → суффикс -2", async () => {
  const base = join(tmp, "b3");
  const a = await resolveItemDir(base, "file:/a.mp4", "Встреча", today);
  writeMetaKey(a, "file:/a.mp4");
  const b = await resolveItemDir(base, "file:/b.mp4", "Встреча", today);
  expect(b).toBe(join(base, "2026-10-02-встреча-2"));
});

test("slugify: комбинирующие знаки сохраняются, длина режется по кодпоинтам", () => {
  expect(slugify("हिन्दी समाचार")).toBe("हिन्दी-समाचार");
  // 𠮷 (CJK Ext B) is an astral letter: survives the regex, so the cut really sees surrogate pairs.
  const long = slugify("𠮷".repeat(100));
  expect(Array.from(long).length).toBe(60);
  expect(long).toBe("𠮷".repeat(60));
  expect(long.isWellFormed()).toBe(true);
});

test("findSidecarSubs: из нескольких языков берётся preferLang", async () => {
  const d = join(tmp, "side3");
  mkdirSync(d);
  const v = join(d, "a.mp4");
  writeFileSync(v, "");
  writeFileSync(join(d, "a.en.srt"), "");
  writeFileSync(join(d, "a.ru.srt"), "");
  expect(await findSidecarSubs(v, "ru")).toBe(join(d, "a.ru.srt"));
  expect(await findSidecarSubs(v, "RU")).toBe(join(d, "a.ru.srt"));
  expect(await findSidecarSubs(v, null)).toBe(join(d, "a.en.srt"));
  expect(await findSidecarSubs(v)).toBe(join(d, "a.en.srt"));
  expect(await findSidecarSubs(v, "de")).toBe(join(d, "a.en.srt"));
});

test("findSidecarSubs: preferLang сопоставляется по основному подтегу (en совпадает с en-US)", async () => {
  const d = join(tmp, "side4");
  mkdirSync(d);
  const v = join(d, "b.mp4");
  writeFileSync(v, "");
  writeFileSync(join(d, "b.de.srt"), "");
  writeFileSync(join(d, "b.en-US.vtt"), "");
  expect(await findSidecarSubs(v, "en")).toBe(join(d, "b.en-US.vtt"));
});
