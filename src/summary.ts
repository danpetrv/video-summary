import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./types";

const WPM = 200;
const PLACEHOLDER = "{{reading_time}}";

/** Drops fenced blocks (``` or ~~~, including mermaid); an unclosed fence runs to the end. */
function stripFences(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence === null) {
      if (m) fence = m[1]![0]!.repeat(m[1]!.length);
      else out.push(line);
    } else if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) {
      fence = null;
    }
  }
  return out.join("\n");
}

/** Words only: the reading-time line itself and bare markdown markers (#, >, -, emoji) do not count. */
export function readingMinutes(markdown: string): number {
  const text = stripFences(markdown).split("\n").filter((l) => !/^\s*> 📖/.test(l)).join("\n");
  const words = text.match(/\S+/g)?.filter((w) => /[\p{L}\p{N}]/u.test(w)).length ?? 0;
  return Math.max(1, Math.ceil(words / WPM));
}

export function applyReadingTime(markdown: string): string {
  const n = String(readingMinutes(markdown));
  if (markdown.includes(PLACEHOLDER)) return markdown.split(PLACEHOLDER).join(n);
  const line = /^(> 📖[^\n]*?~)\d+/m;
  if (line.test(markdown)) return markdown.replace(line, `$1${n}`);
  const row = `> 📖 ~${n} min read`;
  const lines = markdown.split("\n");
  const q = lines.findIndex((l) => l.startsWith(">"));
  lines.splice(q >= 0 ? q + 1 : 1, 0, row);
  return lines.join("\n");
}

export async function finalizeSummary(dir: string): Promise<{ reading_minutes: number }> {
  const path = join(dir, "summary.md");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new UserError(`write summary.md first in ${dir}`);
    throw e;
  }
  const next = applyReadingTime(text);
  if (next !== text) await writeFile(path, next);
  return { reading_minutes: readingMinutes(text) };
}
