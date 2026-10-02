import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Source = "youtube-manual-subs" | "manual-subs" | "youtube-auto-subs" | "sidecar-subs" | "asr";
export type Meta = {
  source_key: string;
  source: Source;
  asr_provider: string | null; // имя провайдера из конфига
  diarized: boolean;
  speakers: number;
  url: string | null;
  path: string | null;
  id: string | null;
  title: string;
  uploader: string | null;
  upload_date: string | null;
  duration: number | null;
  language: string | null;
  created_at: string;
  transcript_tokens: number;
  readeck_bookmark_id: string | null;
  readeck_summary_sha: string | null; // sha256 отправленного summary.md — чтобы заметить переписанный конспект
};

export async function readMeta(dir: string): Promise<Meta | null> {
  const p = join(dir, "meta.json");
  try {
    await access(p);
  } catch {
    return null;
  }
  return JSON.parse(await readFile(p, "utf8")) as Meta;
}

export async function writeMeta(dir: string, m: Meta): Promise<void> {
  await writeFile(join(dir, "meta.json"), JSON.stringify(m, null, 2) + "\n");
}

/** Грубая оценка: ~3 символа на токен (кириллица дороже латиницы). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
