import { statSync } from "node:fs";
import type { LocalPaths } from "./paths";
import type { Word } from "./parakeet";
import { DIAR_MODEL } from "./pins";

/** The diarization model is in place with exactly the pinned size. No hashing: `local install` verified it. */
export function diarModelReady(paths: LocalPaths, size: number = DIAR_MODEL.size): boolean {
  try {
    return statSync(paths.diarModel).size === size;
  } catch {
    return false;
  }
}

/** A stretch of speech by one diarized speaker, in seconds. */
export type Segment = { speaker: number; start: number; end: number };

// A word this close to a segment (and in no other) still belongs to it: word and speaker timings are not aligned.
const NEAREST_SEC = 0.5;
// Timestamps are floats: 0.1 s from a segment must not be lost to rounding.
const EPS = 1e-6;

/**
 * `parakeet-cli scene --json` prints one JSON event per line; closed speaker segments sit in each event's
 * `speakers` (the open ones in `active` have no end yet and come closed in a later event).
 */
export function parseScene(stdout: string): Segment[] {
  const segs: Segment[] = [];
  for (const [i, line] of stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new Error(`scene output line ${i + 1} is not JSON`);
    }
    const list = (ev as { speakers?: unknown } | null)?.speakers;
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`scene output line ${i + 1}: speakers is not an array`);
    for (const s of list) {
      if (!Number.isFinite(s?.speaker) || !Number.isFinite(s?.start) || !Number.isFinite(s?.end)) {
        throw new Error(`scene output line ${i + 1}: malformed speaker segment`);
      }
      segs.push({ speaker: s.speaker, start: s.start, end: s.end });
    }
  }
  return segs;
}

/**
 * Speaker id per word: the segment with the largest overlap (a tie goes to the earlier one), else the nearest
 * segment within NEAREST_SEC, else the previous word's speaker; leading words take the first labeled word's.
 * All `null` when there is no segment at all.
 */
export function assignSpeakers(words: Word[], segs: Segment[]): (number | null)[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const ids: (number | null)[] = [];
  let prev: number | null = null;
  for (const word of words) {
    let id: number | null = null;
    let best = 0;
    for (const s of sorted) {
      const overlap = Math.min(word.end, s.end) - Math.max(word.start, s.start);
      if (overlap > best + EPS) {
        best = overlap;
        id = s.speaker;
      }
    }
    if (id === null) {
      let nearest = Infinity;
      for (const s of sorted) {
        const gap = Math.max(0, s.start - word.end, word.start - s.end);
        if (gap < nearest - EPS) {
          nearest = gap;
          if (gap <= NEAREST_SEC + EPS) id = s.speaker;
        }
      }
    }
    id ??= prev;
    ids.push(id);
    prev = id;
  }
  const first = ids.find((x) => x !== null);
  if (first !== undefined) {
    for (let i = 0; ids[i] === null; i++) ids[i] = first;
  }
  return ids;
}

/**
 * Names speakers `Speaker N` by first appearance among the words. With a single speaker there is nothing
 * to tell apart: the words come back without labels.
 */
export function labelSpeakers(words: Word[], ids: (number | null)[]): { words: Word[]; speakers: number } {
  const order = new Map<number, number>();
  for (const id of ids) if (id !== null && !order.has(id)) order.set(id, order.size + 1);
  if (order.size < 2) return { words, speakers: order.size };
  return {
    words: words.map((word, i) => {
      const id = ids[i];
      return id === null || id === undefined ? word : { ...word, speaker: `Speaker ${order.get(id)}` };
    }),
    speakers: order.size,
  };
}
