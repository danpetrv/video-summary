import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const cut = Array.from(s).slice(0, 60).join("").replace(/-+$/g, "");
  return cut || "video";
}

export function resolveInputPath(p: string, cwd: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) return join(home, p.slice(1));
  return resolve(cwd, p);
}

/** Субтитры рядом с файлом: name.srt, name.vtt, затем name.<код языка>.srt|vtt (регистр расширения любой);
 * из нескольких языков берётся preferLang, иначе первый по алфавиту. */
export async function findSidecarSubs(absFile: string, preferLang?: string | null): Promise<string | null> {
  const dir = dirname(absFile);
  const stem = basename(absFile, extname(absFile));
  const rests = (await readdir(dir))
    .filter((e) => e.startsWith(`${stem}.`))
    .map((e) => ({ e, rest: e.slice(stem.length + 1) }));
  for (const ext of ["srt", "vtt"]) {
    const hit = rests.find((r) => r.rest.toLowerCase() === ext);
    if (hit) return join(dir, hit.e);
  }
  // Только код языка (ru, en-US, pt-BR), иначе lecture.part2.srt сойдёт за субтитры lecture.mp4.
  const lang = rests
    .filter((r) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*\.(srt|vtt)$/i.test(r.rest))
    .map((r) => r.e)
    .sort();
  if (!lang.length) return null;
  // Предпочтительный язык сравниваем с основным подтегом (en совпадает с en-US).
  const want = preferLang?.toLowerCase().split("-")[0];
  const hit = want ? lang.find((e) => e.slice(stem.length + 1).split(".")[0]!.toLowerCase().split("-")[0] === want) : undefined;
  return join(dir, hit ?? lang[0]!);
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function sourceKeyOf(dir: string): Promise<string | null> {
  try {
    return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")).source_key ?? null;
  } catch {
    return null;
  }
}

/** Папка под видео: прежняя с тем же source_key, иначе новая <дата>-<slug>[-N]. */
export async function resolveItemDir(baseDir: string, sourceKey: string, title: string, today: Date): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && (await sourceKeyOf(join(baseDir, e.name))) === sourceKey) return join(baseDir, e.name);
  }
  const names = new Set(entries.map((e) => e.name));
  const stem = `${localDate(today)}-${slugify(title)}`;
  let name = stem;
  for (let i = 2; names.has(name); i++) name = `${stem}-${i}`;
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  return dir;
}
