import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, UserError } from "../src/types";
import { YTDLP_BASE, type VideoMeta, downloadAudio, downloadSubs, fetchMeta, pickAutoTrack, pickManualTrack } from "../src/ytdlp";

const fixture: VideoMeta = await Bun.file(join(import.meta.dir, "fixtures/ytdlp-meta.json")).json();
const m = (o: Partial<VideoMeta>): VideoMeta => ({ ...fixture, ...o });
const tmp = mkdtempSync(join(tmpdir(), "vs-ytdlp-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const URL = "https://youtu.be/dQw4w9WgXcQ?t=42&list=PL1";

test("pickManualTrack", () => {
  expect(pickManualTrack(m({ language: "en" }))).toBe("en");
  expect(pickManualTrack(m({ language: "en", subtitles: { "en-US": [], de: [] } }))).toBe("en-US");
  expect(pickManualTrack(m({ language: "en", subtitles: { "en-US": [], "en-GB": [] } }))).toBe("en-GB");
  expect(pickManualTrack(m({ language: "en-US", subtitles: { en: [], "en-US": [] } }))).toBe("en-US");
  expect(pickManualTrack(m({ language: "ru", subtitles: { en: [], de: [] } }))).toBeNull();
  expect(pickManualTrack(m({ language: null, subtitles: { ru: [], live_chat: [] } }))).toBe("ru");
  expect(pickManualTrack(m({ language: null, subtitles: { ru: [], en: [] } }))).toBeNull();
  expect(pickManualTrack(m({ language: "en", subtitles: { live_chat: [] } }))).toBeNull();
  expect(pickManualTrack(m({ language: "EN", subtitles: { en: [] } }))).toBe("en");
});

const capture = (stdout: string, code = 0, stderr = "") => {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => (calls.push(cmd), { code, stdout, stderr });
  return { calls, run };
};

test("fetchMeta: argv has YTDLP_BASE, --dump-single-json, --flat-playlist, --skip-download", async () => {
  const { calls, run } = capture(JSON.stringify(fixture));
  expect(await fetchMeta(URL, run)).toEqual(fixture);
  expect(calls[0]).toEqual([...YTDLP_BASE, "--dump-single-json", "--flat-playlist", "--skip-download", "--no-warnings", URL]);
  // deno stays enabled (yt-dlp default); node and bun are added so a bun-only machine also works.
  expect(YTDLP_BASE).toEqual(["yt-dlp", "--js-runtimes", "node", "--js-runtimes", "bun", "--no-playlist"]);
});

test("fetchMeta: _type playlist → UserError про плейлисты", async () => {
  const { run } = capture(JSON.stringify({ _type: "playlist", id: "PL1", title: "x" }));
  expect(fetchMeta(URL, run)).rejects.toThrow(new UserError("this is a playlist — give a link to a single video"));
});

test("fetchMeta: is_live → UserError «the stream is still live — wait for the recording»", async () => {
  const { run } = capture(JSON.stringify(m({ is_live: true })));
  expect(fetchMeta(URL, run)).rejects.toThrow("the stream is still live — wait for the recording");
});

test("fetchMeta: ненулевой код → UserError с последней строкой ERROR:", async () => {
  const { run } = capture("", 1, "WARNING: x\nERROR: [youtube] abc: Private video. Sign in\nnoise\n");
  const err = await fetchMeta(URL, run).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("yt-dlp: ERROR: [youtube] abc: Private video. Sign in");
});

test("downloadSubs: аргументы и найденный subs.*.vtt", async () => {
  const work = join(tmp, "subs");
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    writeFileSync(join(work, "subs.en-US.vtt"), "WEBVTT\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  await Bun.write(join(work, ".keep"), "");
  expect(await downloadSubs(URL, "en-US", work, run)).toBe(join(work, "subs.en-US.vtt"));
  expect(calls[0]).toEqual([
    ...YTDLP_BASE, "--skip-download", "--write-subs", "--sub-langs", "en-US", "--sub-format", "vtt/srt/best",
    "-o", join(work, "subs.%(ext)s"), URL,
  ]);
});

test("downloadSubs: нет vtt, есть srt → возвращает .srt; формат вроде .ttml → UserError", async () => {
  const work = join(tmp, "srtsubs");
  await Bun.write(join(work, ".keep"), "");
  const srt: Runner = async () => (writeFileSync(join(work, "subs.en.srt"), "1\n"), { code: 0, stdout: "", stderr: "" });
  expect(await downloadSubs(URL, "en", work, srt)).toBe(join(work, "subs.en.srt"));
  const w2 = join(tmp, "ttml");
  await Bun.write(join(w2, ".keep"), "");
  const ttml: Runner = async () => (writeFileSync(join(w2, "subs.en.ttml"), "<tt/>"), { code: 0, stdout: "", stderr: "" });
  expect(downloadSubs(URL, "en", w2, ttml)).rejects.toThrow(UserError);
});

test("downloadSubs: yt-dlp ничего не скачал → UserError", async () => {
  const work = join(tmp, "nosubs");
  await Bun.write(join(work, ".keep"), "");
  const { run } = capture("");
  expect(downloadSubs(URL, "en", work, run)).rejects.toThrow(UserError);
});

test("downloadAudio: -f bestaudio/best -o <work>/src.%(ext)s, returns src.*", async () => {
  const work = join(tmp, "audio");
  await Bun.write(join(work, ".keep"), "");
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    writeFileSync(join(work, "src.webm"), "x");
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(await downloadAudio(URL, work, run)).toBe(join(work, "src.webm"));
  expect(calls[0]).toEqual([...YTDLP_BASE, "-f", "bestaudio/best", "-o", join(work, "src.%(ext)s"), URL]);
});

test("pickAutoTrack: en-orig beats en; unknown language -> null; no track -> null", () => {
  expect(pickAutoTrack(m({ language: "en", automatic_captions: { en: [], "en-orig": [], de: [] } }))).toBe("en-orig");
  expect(pickAutoTrack(m({ language: "en", automatic_captions: { en: [], de: [] } }))).toBe("en");
  expect(pickAutoTrack(m({ language: null, automatic_captions: { en: [], "en-orig": [] } }))).toBeNull();
  expect(pickAutoTrack(m({ language: "en", automatic_captions: { de: [] } }))).toBeNull();
  expect(pickAutoTrack(m({ language: "en", automatic_captions: {} }))).toBeNull();
  expect(pickAutoTrack(m({ language: "en-US", automatic_captions: { en: [], "en-orig": [] } }))).toBe("en-orig");
});

test("downloadSubs auto: --write-auto-subs instead of --write-subs", async () => {
  const work = join(tmp, "autosubs");
  await Bun.write(join(work, ".keep"), "");
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    writeFileSync(join(work, "subs.en-orig.vtt"), "WEBVTT\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(await downloadSubs(URL, "en-orig", work, run, true)).toBe(join(work, "subs.en-orig.vtt"));
  expect(calls[0]).toEqual([
    ...YTDLP_BASE, "--skip-download", "--write-auto-subs", "--sub-langs", "en-orig", "--sub-format", "vtt/srt/best",
    "-o", join(work, "subs.%(ext)s"), URL,
  ]);
});

describe("retry on transient HTTP 403", () => {
  const forbidden = { code: 1, stdout: "", stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden\n" };

  test("downloadAudio: 403 then success → retried once after 2 s, file returned", async () => {
    const work = join(tmp, "retry-ok");
    await Bun.write(join(work, ".keep"), "");
    const sleeps: number[] = [];
    let n = 0;
    const run: Runner = async () => {
      n++;
      if (n === 1) return forbidden;
      writeFileSync(join(work, "src.webm"), "x");
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await downloadAudio(URL, work, run, async (ms) => void sleeps.push(ms))).toBe(join(work, "src.webm"));
    expect(n).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  test("downloadAudio: 403 on every attempt → 3 attempts (2 s, 5 s pauses), then the yt-dlp error", async () => {
    const work = join(tmp, "retry-fail");
    await Bun.write(join(work, ".keep"), "");
    const sleeps: number[] = [];
    let n = 0;
    const run: Runner = async () => (n++, forbidden);
    const err = await downloadAudio(URL, work, run, async (ms) => void sleeps.push(ms)).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("yt-dlp: ERROR: unable to download video data: HTTP Error 403: Forbidden");
    expect(n).toBe(3);
    expect(sleeps).toEqual([2000, 5000]);
  });

  test("downloadAudio: a non-403 error is not retried", async () => {
    const work = join(tmp, "retry-other");
    await Bun.write(join(work, ".keep"), "");
    let n = 0;
    const run: Runner = async () => (n++, { code: 1, stdout: "", stderr: "ERROR: [youtube] x: Private video\n" });
    const err = await downloadAudio(URL, work, run, async () => {}).catch((e) => e);
    expect(err.message).toBe("yt-dlp: ERROR: [youtube] x: Private video");
    expect(n).toBe(1);
  });

  test("downloadSubs: 403 then success → retried", async () => {
    const work = join(tmp, "retry-subs");
    await Bun.write(join(work, ".keep"), "");
    let n = 0;
    const run: Runner = async () => {
      n++;
      if (n === 1) return forbidden;
      writeFileSync(join(work, "subs.en.vtt"), "WEBVTT\n");
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await downloadSubs(URL, "en", work, run, false, async () => {})).toBe(join(work, "subs.en.vtt"));
    expect(n).toBe(2);
  });
});
