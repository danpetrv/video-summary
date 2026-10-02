import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverFor } from "../src/cover";
import type { Meta } from "../src/meta";
import type { Runner } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "vs-cover-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const video = join(root, "talk.mp4");
writeFileSync(video, "video");

const base: Meta = {
  source_key: "Youtube:abc", source: "asr", asr_provider: "wx", diarized: false, speakers: 0,
  url: "https://www.youtube.com/watch?v=abc", path: null, id: "abc", title: "T", uploader: null, upload_date: null,
  duration: 60, language: "ru", created_at: "2026-10-03T00:00:00Z", transcript_tokens: 1,
  readeck_bookmark_id: null, readeck_summary_sha: null,
};
const local: Meta = { ...base, source_key: `file:${video}`, url: null, path: video, id: null, thumbnail: null };
const noRun: Runner = async (cmd) => {
  throw new Error(`unexpected command ${cmd.join(" ")}`);
};

/** ffmpeg stub: writes the output (last argument) on the attempts listed in `writeOn` (1-based). */
function ffmpeg(writeOn: number[]) {
  const cmds: string[][] = [];
  const run: Runner = async (cmd) => {
    cmds.push(cmd);
    if (writeOn.includes(cmds.length)) writeFileSync(cmd.at(-1)!, Buffer.from([0xff, 0xd8, 0xff]));
    return { code: writeOn.includes(cmds.length) ? 0 : 1, stdout: "", stderr: "" };
  };
  return { cmds, run };
}

test("yt-dlp thumbnail -> remote cover", async () => {
  expect(await coverFor({ ...base, thumbnail: "https://i.ytimg.com/vi/abc/maxresdefault.jpg" }, noRun))
    .toEqual({ src: "https://i.ytimg.com/vi/abc/maxresdefault.jpg", remote: true });
});

test("no thumbnail in an old meta.json: YouTube id -> hqdefault; another site -> no cover", async () => {
  expect(await coverFor(base, noRun)).toEqual({ src: "https://i.ytimg.com/vi/abc/hqdefault.jpg", remote: true });
  expect(await coverFor({ ...base, source_key: "Vimeo:1", id: "1", thumbnail: null }, noRun)).toBeNull();
});

test("local file: first non-black frame within 60 s as a data URI", async () => {
  const { cmds, run } = ffmpeg([1]);
  expect(await coverFor(local, run)).toEqual({ src: "data:image/jpeg;base64,/9j/", remote: false });
  expect(cmds).toHaveLength(1);
  const cmd = cmds[0]!;
  expect(cmd.slice(0, 2)).toEqual(["ffmpeg", "-nostdin"]);
  expect(cmd[cmd.indexOf("-t") + 1]).toBe("60");
  expect(cmd[cmd.indexOf("-i") + 1]).toBe(video);
  expect(cmd[cmd.indexOf("-vf") + 1]).toContain("signalstats,metadata=select:key=lavfi.signalstats.YAVG");
  expect(cmd[cmd.indexOf("-frames:v") + 1]).toBe("1");
});

test("local file, only dark frames -> the first frame; nothing at all (audio without cover) -> no cover", async () => {
  const dark = ffmpeg([2]);
  expect((await coverFor(local, dark.run))?.src).toBe("data:image/jpeg;base64,/9j/");
  expect(dark.cmds[1]![dark.cmds[1]!.indexOf("-vf") + 1]).not.toContain("signalstats");
  const none = ffmpeg([]);
  expect(await coverFor(local, none.run)).toBeNull();
  expect(none.cmds).toHaveLength(2);
});

test("local file that is gone -> no cover, ffmpeg not called", async () => {
  expect(await coverFor({ ...local, path: join(root, "moved.mp4") }, noRun)).toBeNull();
});
