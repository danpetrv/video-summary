import { rename, rm } from "node:fs/promises";
import type { Runner } from "./types";
import { UserError } from "./types";

/**
 * Mono 16 kHz opus at 32 kbps: 1.5 hours ≈ 21 MB. -nostdin prevents ffmpeg
 * from waiting for input in the background. Write to temp file and rename only on success:
 * ffmpeg writes output as it goes, and interrupted compression would leave a valid but truncated ogg.
 */
export async function compressAudio(input: string, outOgg: string, run: Runner): Promise<void> {
  const tmp = `${outOgg}.tmp`;
  const r = await run([
    "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", input,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", tmp,
  ]);
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    throw new Error(`ffmpeg: ${r.stderr.trim()}`);
  }
  await rename(tmp, outOgg);
}

export async function probeDuration(file: string, run: Runner): Promise<number> {
  const r = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const sec = Number.parseFloat(r.stdout.trim());
  if (r.code !== 0 || !Number.isFinite(sec)) throw new UserError(`could not determine duration: ${file}`);
  return sec;
}
