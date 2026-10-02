import type { Cue, Paragraph } from "./types";

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function parseTime(t: string): number {
  const parts = t.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Блоки, разделённые пустой строкой (в т. ч. из пробелов); в каждом ищем строку тайминга, текст — строки после неё. */
function parseBlocks(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i === -1) continue;
    const m = lines[i]!.match(TIMING)!;
    const body = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean).join(" ");
    cues.push({ start: parseTime(m[1]!), end: parseTime(m[2]!), text: body });
  }
  return cues;
}

/** WEBVTT: заголовок, NOTE и STYLE не содержат тайминга и отпадают сами. */
export function parseVtt(text: string): Cue[] {
  return parseBlocks(text);
}

export function parseSrt(text: string): Cue[] {
  return parseBlocks(text);
}

const NOISE = new Set(["music", "музыка", "applause", "аплодисменты", "laughter", "смех", "silence", "тишина"]);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

// Только теги WebVTT/SRT: <c.cls>, <i>, <b>, <u>, <ruby>, <rt>, <v Имя>, <lang xx>, таймкоды <00:00:01.000>.
// Аннотация через пробел допустима лишь у v и lang: иначе «a<b and c>d» принимается за тег.
const TAGS =
  /<\/?(?:(?:c|i|b|u|ruby|rt)(?:\.[^>\s]*)*|(?:v|lang)(?:\.[^>\s]*)*(?:\s[^>]*)?)>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/g;

function cleanText(t: string): string {
  return t
    .replace(TAGS, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]!)
    .replace(/[♪♫]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Реплика целиком — пометка вроде [Music], (аплодисменты), [♪♪♪]. */
function isNoise(t: string): boolean {
  const m = t.match(/^[[(](.*)[\])]$/);
  if (!m) return false;
  const inner = m[1]!.trim().toLowerCase();
  return inner === "" || NOISE.has(inner);
}

export function cleanCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const text = cleanText(c.text);
    if (!text || isNoise(text)) continue;
    const prev = out.at(-1);
    if (prev && prev.text === text && prev.speaker === c.speaker) continue;
    out.push({ ...c, text });
  }
  return out;
}

const SENTENCE_END = /[.!?…]["»”)]?$/;

export function toParagraphs(cues: Cue[]): Paragraph[] {
  const ps: Paragraph[] = [];
  let para: Paragraph | null = null;
  let prev: Cue | null = null;
  for (const c of cues) {
    const span = para ? c.start - para.start : 0;
    const split =
      !para ||
      !prev ||
      c.speaker !== para.speaker ||
      span >= 120 ||
      (span >= 60 && SENTENCE_END.test(prev.text)) ||
      (c.start - prev.end >= 3 && span >= 20);
    if (split) {
      para = c.speaker ? { start: c.start, speaker: c.speaker, text: c.text } : { start: c.start, text: c.text };
      ps.push(para);
    } else {
      para!.text += ` ${c.text}`;
    }
    prev = c;
  }
  return ps;
}

export function formatTs(sec: number): string {
  const s = Math.floor(sec);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function renderTranscript(title: string, ps: Paragraph[]): string {
  const body = ps.map((p) => `[${formatTs(p.start)}] ${p.speaker ? `**${p.speaker}:** ` : ""}${p.text}`);
  return `# ${title}\n\n${body.join("\n\n")}\n`;
}

/**
 * YouTube auto captions "roll": each cue repeats the tail of the previous one.
 * Cut the longest word-level suffix of the previous ORIGINAL cue that prefixes
 * the current cue; drop cues that end up empty.
 */
export function dedupeRolling(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  let prev: string[] = [];
  for (const c of cues) {
    const cur = c.text.split(/\s+/).filter(Boolean);
    let cut = 0;
    for (let n = Math.min(prev.length, cur.length); n > 0; n--) {
      if (prev.slice(-n).every((w, i) => w === cur[i])) {
        cut = n;
        break;
      }
    }
    prev = cur;
    const text = cur.slice(cut).join(" ");
    if (text) out.push({ ...c, text });
  }
  return out;
}
