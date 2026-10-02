import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meta } from "./meta";
import type { Runner } from "./types";

/** Picture for the Readeck bookmark. Readeck takes og:image only from a URL; a data URI shows in the text only. */
export type Cover = { src: string; remote: boolean };

/** Frames scanned for a non-black one; a long dark intro does not make us decode the whole file. */
const SCAN_SECONDS = "60";
/** Mean luma (0-255) above which a frame is not black: skips fade-ins and dark title cards. */
const MIN_LUMA = "24";
const SCALE = "scale='min(1280,iw)':-2";

/** yt-dlp thumbnail; for a meta.json from before it was stored, the YouTube one by id; for a local file, a frame. */
export async function coverFor(meta: Meta, run?: Runner): Promise<Cover | null> {
  if (meta.thumbnail) return { src: meta.thumbnail, remote: true };
  if (meta.source_key.startsWith("Youtube:") && meta.id) {
    return { src: `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg`, remote: true };
  }
  if (!meta.path || !run) return null;
  const exists = await access(meta.path).then(() => true, () => false);
  if (!exists) return null; // the source file was moved or deleted since fetch
  const work = await mkdtemp(join(tmpdir(), "vs-cover-"));
  try {
    const out = join(work, "cover.jpg");
    const nonBlack = `signalstats,metadata=select:key=lavfi.signalstats.YAVG:value=${MIN_LUMA}:function=greater,${SCALE}`;
    // Only dark frames in the first minute -> the very first frame; an audio file with cover art has a single frame.
    for (const vf of [nonBlack, SCALE]) {
      await run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-t", SCAN_SECONDS, "-i", meta.path, "-vf", vf,
        "-frames:v", "1", "-q:v", "3", out]);
      const size = await stat(out).then((s) => s.size, () => 0);
      if (size > 0) return { src: `data:image/jpeg;base64,${(await readFile(out)).toString("base64")}`, remote: false };
    }
    return null;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
