import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Runner, UserError } from "./types";

/**
 * YouTube needs a JS runtime. deno is enabled by yt-dlp by default; node and bun are added so
 * whichever runtime runs this CLI also works for yt-dlp (yt-dlp picks the best available one).
 */
export const YTDLP_BASE = ["yt-dlp", "--js-runtimes", "node", "--js-runtimes", "bun", "--no-playlist"];

export type VideoMeta = {
  _type?: string;
  id: string;
  extractor_key: string;
  title: string;
  uploader: string | null;
  upload_date: string | null;
  duration: number | null;
  language: string | null;
  is_live: boolean | null;
  webpage_url: string;
  subtitles: Record<string, unknown[]>;
  automatic_captions: Record<string, unknown[]>;
};

function ytdlpError(stderr: string): UserError {
  const lines = stderr.split("\n").filter((l) => l.startsWith("ERROR:"));
  return new UserError(`yt-dlp: ${lines.at(-1) ?? stderr.trim().split("\n").at(-1) ?? "unknown error"}`);
}

export async function fetchMeta(url: string, run: Runner): Promise<VideoMeta> {
  const r = await run([...YTDLP_BASE, "--dump-single-json", "--flat-playlist", "--skip-download", "--no-warnings", url]);
  if (r.code !== 0) throw ytdlpError(r.stderr);
  const m = JSON.parse(r.stdout) as VideoMeta;
  if (m._type === "playlist") throw new UserError("this is a playlist — give a link to a single video");
  if (m.is_live) throw new UserError("the stream is still live — wait for the recording");
  return m;
}

/** Manual track in the original language; auto captions are not considered here. */
export function pickManualTrack(m: VideoMeta): string | null {
  const tracks = Object.keys(m.subtitles ?? {}).filter((k) => k !== "live_chat");
  if (!m.language) return tracks.length === 1 ? tracks[0]! : null;
  const lang = m.language.toLowerCase();
  const exact = tracks.find((t) => t.toLowerCase() === lang);
  if (exact) return exact;
  const primary = lang.split("-")[0];
  const same = tracks.filter((t) => t.toLowerCase().split("-")[0] === primary).sort();
  return same[0] ?? null;
}

/** Auto captions: "<lang>-orig" (original speech) if present, else "<lang>"; unknown language -> null. */
export function pickAutoTrack(m: VideoMeta): string | null {
  if (!m.language) return null;
  const lang = m.language.toLowerCase();
  const keys = Object.keys(m.automatic_captions ?? {});
  const primary = lang.split("-")[0]!;
  for (const want of [`${lang}-orig`, `${primary}-orig`, lang, primary]) {
    const hit = keys.find((k) => k.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

async function findOne(dir: string, prefix: string, exts?: string[]): Promise<string | null> {
  const hit = (await readdir(dir))
    .filter((f) => f.startsWith(prefix) && !f.endsWith(".part") && !f.endsWith(".ytdl") && (!exts || exts.some((x) => f.endsWith(x))))
    .sort();
  return hit.length ? join(dir, hit[0]!) : null;
}

/** Path to a .vtt or .srt file: not every site has vtt. */
export async function downloadSubs(url: string, lang: string, workDir: string, run: Runner, auto = false): Promise<string> {
  const r = await run([
    ...YTDLP_BASE, "--skip-download", auto ? "--write-auto-subs" : "--write-subs", "--sub-langs", lang, "--sub-format", "vtt/srt/best",
    "-o", join(workDir, "subs.%(ext)s"), url,
  ]);
  if (r.code !== 0) throw ytdlpError(r.stderr);
  const f = await findOne(workDir, "subs.", [".vtt", ".srt"]);
  if (!f) throw new UserError(`yt-dlp did not download ${lang} subtitles in vtt or srt format`);
  return f;
}

export async function downloadAudio(url: string, workDir: string, run: Runner): Promise<string> {
  const r = await run([...YTDLP_BASE, "-f", "bestaudio/best", "-o", join(workDir, "src.%(ext)s"), url]);
  if (r.code !== 0) throw ytdlpError(r.stderr);
  const f = await findOne(workDir, "src.");
  if (!f) throw new UserError("yt-dlp did not download the audio");
  return f;
}
