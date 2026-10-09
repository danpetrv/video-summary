import { expect, test } from "bun:test";
import { join } from "node:path";
import { assignSpeakers, labelSpeakers, parseScene, type Segment } from "../../src/local/diarize";
import { type Word, wordsToCues } from "../../src/local/parakeet";

const FX = join(import.meta.dir, "../fixtures");
const scene = await Bun.file(join(FX, "parakeet-scene.jsonl")).text();
const words: Word[] = JSON.parse(await Bun.file(join(FX, "parakeet-words.json")).text()).words;

const w = (start: number, end: number, text = "x"): Word => ({ w: text, start, end });
const seg = (speaker: number, start: number, end: number): Segment => ({ speaker, start, end });

test("parseScene: collects closed segments of all events, skips empty lines", () => {
  expect(parseScene(scene)).toEqual([seg(0, 0, 3.3), seg(1, 4.3, 33), seg(0, 34.3, 40.3)]);
  expect(parseScene("")).toEqual([]);
});

test("parseScene: a non-JSON line or a segment without numeric start/end throws", () => {
  expect(() => parseScene("not json")).toThrow(Error);
  expect(() => parseScene('{"speakers":[{"speaker":0,"start":1}]}')).toThrow(Error);
  expect(() => parseScene('{"speakers":[{"speaker":0,"start":"1","end":2}]}')).toThrow(Error);
  expect(() => parseScene('{"speakers":[{"speaker":"a","start":1,"end":2}]}')).toThrow(Error);
});

test("assignSpeakers: the segment with the max overlap wins", () => {
  const segs = [seg(0, 0, 10), seg(1, 10, 20)];
  expect(assignSpeakers([w(8, 14)], segs)).toEqual([1]);
  expect(assignSpeakers([w(32.4, 34.2)], parseScene(scene))).toEqual([1]);
});

test("assignSpeakers: equal overlap goes to the earlier segment", () => {
  expect(assignSpeakers([w(9, 11)], [seg(1, 10, 20), seg(0, 0, 10)])).toEqual([0]);
});

test("assignSpeakers: a word just outside every segment takes the nearest one within 0.5 s", () => {
  const segs = [seg(0, 0, 5), seg(1, 10, 15)];
  expect(assignSpeakers([w(5.1, 5.4)], segs)).toEqual([0]);
  expect(assignSpeakers([w(9.7, 9.9)], segs)).toEqual([1]);
});

test("assignSpeakers: a word 1 s from every segment gets the previous word's speaker", () => {
  const segs = [seg(0, 0, 5), seg(1, 10, 15)];
  expect(assignSpeakers([w(1, 2), w(6, 7)], segs)).toEqual([0, 0]);
  expect(assignSpeakers([w(11, 12), w(8.2, 9)], segs)).toEqual([1, 1]);
});

test("assignSpeakers: leading words with no segment get the first later labeled word's speaker", () => {
  const segs = [seg(1, 10, 15)];
  expect(assignSpeakers([w(0, 1), w(2, 3), w(10, 11)], segs)).toEqual([1, 1, 1]);
});

test("assignSpeakers: no segments gives null for every word", () => {
  expect(assignSpeakers([w(0, 1), w(2, 3)], [])).toEqual([null, null]);
  expect(assignSpeakers([], [seg(0, 0, 1)])).toEqual([]);
});

test("labelSpeakers: labels by first appearance when there are 2 or more speakers", () => {
  const r = labelSpeakers([w(0, 1), w(1, 2), w(2, 3)], [1, 1, 0]);
  expect(r.speakers).toBe(2);
  expect(r.words.map((x) => x.speaker)).toEqual(["Speaker 1", "Speaker 1", "Speaker 2"]);
});

test("labelSpeakers: one speaker gives no labels", () => {
  const r = labelSpeakers([w(0, 1), w(1, 2)], [0, 0]);
  expect(r.speakers).toBe(1);
  expect(r.words.every((x) => !("speaker" in x))).toBe(true);
});

test("labelSpeakers: no labeled word gives speakers 0; an id without words is not counted", () => {
  expect(labelSpeakers([w(0, 1)], [null]).speakers).toBe(0);
  expect(labelSpeakers([], []).speakers).toBe(0);
  expect(labelSpeakers([w(0, 1), w(1, 2)], [3, 3]).speakers).toBe(1);
});

test("fixture: words + scene segments give speaker-tagged cues", () => {
  const ids = assignSpeakers(words, parseScene(scene));
  const labeled = labelSpeakers(words, ids);
  expect(labeled.speakers).toBe(2);
  expect(wordsToCues(labeled.words)).toEqual([
    { start: 0, end: 1.04, text: "Погнали, привет.", speaker: "Speaker 1" },
    { start: 1.2, end: 3.2, text: "Сегодня говорим про миграцию", speaker: "Speaker 1" },
    { start: 4.4, end: 34.2, text: "и дальше мы смотрим как это всё работает на практике потому что без этого никак", speaker: "Speaker 2" },
    { start: 34.4, end: 40.2, text: "что думает чат?", speaker: "Speaker 1" },
  ]);
});
