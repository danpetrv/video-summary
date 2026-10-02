import { expect, test } from "bun:test";
import { join } from "node:path";
import { cleanCues, dedupeRolling, formatTs, parseSrt, parseVtt, renderTranscript, toParagraphs } from "../src/captions";
import type { Cue } from "../src/types";

const fx = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();

test("parseVtt: заголовок/NOTE/STYLE пропущены, время с часами и без", () => {
  const c = parseVtt(
    "WEBVTT\nKind: captions\nLanguage: en\n\nNOTE x\ny\n\nSTYLE\n::cue {}\n\n00:01.500 --> 00:03.000\nhi\n\n01:00:00.000 --> 01:00:02.000 align:start\na\nb\n",
  );
  expect(c).toEqual([
    { start: 1.5, end: 3, text: "hi" },
    { start: 3600, end: 3602, text: "a b" },
  ]);
});

test("parseVtt: идентификатор реплики перед таймингом и CRLF", () => {
  expect(parseVtt("WEBVTT\r\n\r\nid-1\r\n00:00:01.000 --> 00:00:02.000\r\nx\r\n")).toEqual([{ start: 1, end: 2, text: "x" }]);
});

test("parseSrt: индекс, запятая в миллисекундах, многострочность", async () => {
  const c = parseSrt(await fx("sample.ru.srt"));
  expect(c.length).toBe(5);
  expect(c[0]).toEqual({ start: 1, end: 4.5, text: "Добрый вечер, это стрим про миграцию." });
  expect(c[1]!.text).toBe("Сегодня поговорим про Kubernetes и деплой.");
  expect(c[4]).toEqual({ start: 3600, end: 3602.25, text: "Спасибо всем, до встречи." });
});

test("cleanCues: теги, сущности, [Music]/[Аплодисменты], пустые, повтор соседа", () => {
  expect(
    cleanCues([
      { start: 0, end: 1, text: "<c.colorE5E5E5>Hello</c> &amp; <00:00:00.500>bye" },
      { start: 1, end: 2, text: "[Music]" },
      { start: 2, end: 3, text: "(аплодисменты)" },
      { start: 3, end: 4, text: "Hello & bye" },
      { start: 4, end: 5, text: "   " },
      { start: 5, end: 6, text: ">> Ведущий: вопрос" },
    ]),
  ).toEqual([
    { start: 0, end: 1, text: "Hello & bye" },
    { start: 5, end: 6, text: ">> Ведущий: вопрос" },
  ]);
});

test("cleanCues: ноты ♪ убираются, [♪♪♪] целиком удаляется", () => {
  expect(
    cleanCues([
      { start: 0, end: 1, text: "[♪♪♪]" },
      { start: 1, end: 2, text: "♪ We're no strangers to love ♪" },
    ]),
  ).toEqual([{ start: 1, end: 2, text: "We're no strangers to love" }]);
});

test("cleanCues: speaker сохраняется; повтор с другим спикером — не повтор", () => {
  const out = cleanCues([
    { start: 0, end: 1, text: "да", speaker: "Спикер 1" },
    { start: 1, end: 2, text: "да", speaker: "Спикер 2" },
  ]);
  expect(out.map((c) => c.speaker)).toEqual(["Спикер 1", "Спикер 2"]);
});

const every10 = (texts: string[], gap = 0): Cue[] =>
  texts.map((t, i) => ({ start: i * 10, end: i * 10 + 10 - gap, text: t }));

test("toParagraphs: рвёт по 60 с на конце предложения", () => {
  const ps = toParagraphs(every10(["a", "b", "c", "d", "e", "f.", "g", "h"]));
  expect(ps.map((p) => p.start)).toEqual([0, 60]);
  expect(ps[0]!.text).toBe("a b c d e f.");
});

test("toParagraphs: до 60 с точка абзац не рвёт", () => {
  expect(toParagraphs(every10(["a.", "b.", "c."])).length).toBe(1);
});

test("toParagraphs: рвёт на паузе ≥ 3 с, если абзацу ≥ 20 с", () => {
  const cues: Cue[] = [
    { start: 0, end: 10, text: "a" },
    { start: 10, end: 20, text: "b" },
    { start: 25, end: 30, text: "c" },
  ];
  expect(toParagraphs(cues).map((p) => p.start)).toEqual([0, 25]);
  const short: Cue[] = [
    { start: 0, end: 5, text: "a" },
    { start: 10, end: 12, text: "b" },
  ];
  expect(toParagraphs(short).length).toBe(1);
});

test("toParagraphs: жёсткий предел 120 с без точек", () => {
  const ps = toParagraphs(every10(Array.from({ length: 15 }, (_, i) => `w${i}`)));
  expect(ps.map((p) => p.start)).toEqual([0, 120]);
});

test("toParagraphs: смена speaker всегда рвёт абзац, speaker переносится в Paragraph", () => {
  const ps = toParagraphs([
    { start: 0, end: 1, text: "a", speaker: "Спикер 1" },
    { start: 1, end: 2, text: "b", speaker: "Спикер 1" },
    { start: 2, end: 3, text: "c", speaker: "Спикер 2" },
  ]);
  expect(ps).toEqual([
    { start: 0, speaker: "Спикер 1", text: "a b" },
    { start: 2, speaker: "Спикер 2", text: "c" },
  ]);
});

test("formatTs", () => {
  expect(formatTs(3725.4)).toBe("01:02:05");
  expect(formatTs(0)).toBe("00:00:00");
});

test("renderTranscript", () => {
  expect(renderTranscript("T", [{ start: 0, text: "a" }, { start: 62, speaker: "Спикер 2", text: "b" }])).toBe(
    "# T\n\n[00:00:00] a\n\n[00:01:02] **Спикер 2:** b\n",
  );
});

test("реальная фикстура manual.en.vtt: парсится, после чистки нет тегов, нот и [Music]", async () => {
  const raw = parseVtt(await fx("manual.en.vtt"));
  expect(raw.length).toBe(64);
  const clean = cleanCues(raw);
  const all = clean.map((c) => c.text).join("\n");
  expect(all).not.toMatch(/[<>♪]|\[Music\]/);
  expect(clean.filter((c) => c.text === "Tagged line & more").length).toBe(1);
  expect(clean[0]!.text).toBe("We're no strangers to love");
});

test("parseSrt: строка из пробелов тоже разделяет блоки", () => {
  expect(parseSrt("1\n00:00:01,000 --> 00:00:02,000\nhello\n \n2\n00:00:03,000 --> 00:00:04,000\nworld\n").map((c) => c.text))
    .toEqual(["hello", "world"]);
});

test("cleanCues: удаляет только известные теги, a<b and c>d не трогает", () => {
  expect(cleanCues([{ start: 0, end: 1, text: "<v Bob><i>if</i> a<b and c>d <00:00:01.000>then</v>" }])[0]!.text)
    .toBe("if a<b and c>d then");
});

test("dedupeRolling: rolling lines are joined without repeats", () => {
  expect(
    dedupeRolling([
      { start: 0, end: 2, text: "hello there" },
      { start: 2, end: 4, text: "hello there my friend" },
      { start: 4, end: 6, text: "my friend how are you" },
    ]).map((c) => c.text),
  ).toEqual(["hello there", "my friend", "how are you"]);
});

test("dedupeRolling: cues that become empty are dropped, timing kept, input untouched", () => {
  const input: Cue[] = [
    { start: 0, end: 1, text: "a b c" },
    { start: 1, end: 2, text: "b c" },
    { start: 2, end: 3, text: "b c d", speaker: "S" },
  ];
  expect(dedupeRolling(input)).toEqual([
    { start: 0, end: 1, text: "a b c" },
    { start: 2, end: 3, text: "d", speaker: "S" },
  ]);
  expect(input[2]!.text).toBe("b c d");
});

test("dedupeRolling on real auto.en.vtt: no cue starts with the tail of the previous, no words lost", async () => {
  const raw = parseVtt(await fx("auto.en.vtt"));
  const out = dedupeRolling(raw);
  expect(raw.length).toBeGreaterThan(20);
  expect(out.length).toBeLessThan(raw.length);
  const words = (cs: Cue[]) => cs.flatMap((c) => c.text.split(/\s+/).filter(Boolean));
  const orig = words(raw);
  let i = 0;
  for (const w of words(out)) {
    while (i < orig.length && orig[i] !== w) i++;
    expect(i).toBeLessThan(orig.length);
    i++;
  }
  // every original word is still covered: deduped text is the original with only repeats removed
  expect(words(out).length).toBeLessThanOrEqual(orig.length);
  expect(new Set(words(out))).toEqual(new Set(orig));
  for (let k = 1; k < raw.length; k++) {
    const prev = raw[k - 1]!.text.split(/\s+/);
    const cur = out.find((c) => c.start === raw[k]!.start)?.text.split(/\s+/);
    if (!cur) continue;
    for (let n = 1; n <= Math.min(prev.length, cur.length); n++) {
      expect(prev.slice(-n).join(" ") === cur.slice(0, n).join(" ")).toBe(false);
    }
  }
});
