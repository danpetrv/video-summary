import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type ProviderConfig, DEFAULT_CONFIG } from "../src/config";
import { type FetchDeps, fetchCmd } from "../src/fetch-cmd";
import { readMeta, writeMeta } from "../src/meta";
import { type Fetcher, type Runner, UserError } from "../src/types";

const FX = join(import.meta.dir, "fixtures");
const ytMeta = await Bun.file(join(FX, "ytdlp-meta.json")).json();
const vtt = await Bun.file(join(FX, "manual.en.vtt")).text();
const autoVtt = await Bun.file(join(FX, "auto.en.vtt")).text();
const srt = await Bun.file(join(FX, "sample.ru.srt")).text();
const wxJson = await Bun.file(join(FX, "whisperx-diarized.json")).json();
const groqJson = await Bun.file(join(FX, "groq-verbose.json")).json();
const root = mkdtempSync(join(tmpdir(), "vs-fetch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WX: ProviderConfig = { name: "wx", type: "whisperx", url: "http://wx:9000" };
const GROQ: ProviderConfig = { name: "groq", type: "openai-compatible", preset: "groq", keyEnv: "GROQ_KEY" };
const GROQ_URL = "https://api.groq.com";

type Env = {
  meta?: object; health?: number; asrStatus?: number; oggDuration?: string; oggSize?: number;
  subsExt?: "vtt" | "srt"; cfg?: Partial<Config>; providers?: ProviderConfig[]; groqKey?: boolean; autoFail?: boolean;
};
let calls: { cmds: string[][]; urls: string[] };
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(root, "base-"));
  calls = { cmds: [], urls: [] };
});

const outArg = (cmd: string[]) => cmd[cmd.indexOf("-o") + 1]!;
function deps(env: Env = {}): FetchDeps {
  const run: Runner = async (cmd) => {
    calls.cmds.push(cmd);
    if (cmd[0] === "yt-dlp" && cmd.includes("--dump-single-json"))
      return { code: 0, stdout: JSON.stringify(env.meta ?? ytMeta), stderr: "" };
    if (cmd[0] === "yt-dlp" && cmd.includes("--write-auto-subs") && env.autoFail)
      return { code: 1, stdout: "", stderr: "ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests\n" };
    if (cmd[0] === "yt-dlp" && (cmd.includes("--write-subs") || cmd.includes("--write-auto-subs"))) {
      const lang = cmd[cmd.indexOf("--sub-langs") + 1];
      const ext = env.subsExt ?? "vtt";
      const body = cmd.includes("--write-auto-subs") ? autoVtt : ext === "vtt" ? vtt : srt;
      writeFileSync(outArg(cmd).replace("%(ext)s", `${lang}.${ext}`), body);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "yt-dlp") {
      writeFileSync(outArg(cmd).replace("%(ext)s", "webm"), "audio");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "ffmpeg") {
      writeFileSync(cmd.at(-1)!, Buffer.alloc(env.oggSize ?? 1000));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "ffprobe")
      return { code: 0, stdout: cmd.at(-1)!.endsWith(".ogg") ? (env.oggDuration ?? "213\n") : "120.5\n", stderr: "" };
    throw new Error(`unexpected command ${cmd.join(" ")}`);
  };
  const fetch: Fetcher = async (url) => {
    calls.urls.push(url);
    if (url.endsWith("/health")) return new Response("{}", { status: env.health ?? 200 });
    if (url.includes("/asr?")) return new Response(JSON.stringify(env.asrStatus ? { detail: "boom" } : wxJson), { status: env.asrStatus ?? 200 });
    if (url.startsWith(GROQ_URL)) return new Response(JSON.stringify(groqJson));
    throw new Error(`unexpected URL ${url}`);
  };
  const cfg: Config = { ...DEFAULT_CONFIG, outputDir: base, providers: env.providers ?? [WX, GROQ], ...env.cfg };
  const e = env.groqKey === false ? {} : { GROQ_KEY: "k" };
  return { run, fetch, cfg, env: e, now: new Date(2026, 9, 2, 12), cwd: root, home: root };
}
const flags = { diarize: true, allowCloud: false };
const noMeta = { ...ytMeta, subtitles: { de: [] } };
const URL1 = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const asrCall = () => new URL(calls.urls.find((u) => u.includes("/asr?"))!);
const hasFormatDownload = () => calls.cmds.some((c) => c[0] === "yt-dlp" && c.includes("-f"));

test("URL with manual subs -> youtube-manual-subs, no ASR, url = webpage_url", async () => {
  const r = await fetchCmd("https://youtu.be/dQw4w9WgXcQ?t=42&list=PL1", flags, deps());
  expect(r.source).toBe("youtube-manual-subs");
  expect(r.asr_provider).toBeNull();
  expect(r.url).toBe(ytMeta.webpage_url);
  expect(calls.urls).toEqual([]);
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr.startsWith(`# ${ytMeta.title}\n\n[00:00:`)).toBe(true);
  const m = (await readMeta(r.dir))!;
  expect([m.source_key, m.url, m.language, m.duration, m.diarized]).toEqual(["Youtube:dQw4w9WgXcQ", ytMeta.webpage_url, "en", 213, false]);
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
  expect(r.summary_path).toBe(join(r.dir, "summary.md"));
});

test("URL without manual subs -> audio -> whisperx with diarization", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect([r.source, r.asr_provider, r.diarized, r.speakers]).toEqual(["asr", "wx", true, 2]);
  expect([asrCall().searchParams.get("diarize"), asrCall().searchParams.get("language")]).toEqual(["true", "en"]);
  expect(await Bun.file(r.transcript_path).text()).toContain("**Speaker 2:** Привет! Начнём с вопросов.");
});

test("URL without manual subs, whisperx 502, key present -> groq", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, health: 502 }));
  expect([r.asr_provider, r.diarized]).toEqual(["groq", false]);
  expect((await readMeta(r.dir))!.asr_provider).toBe("groq");
});

test("local file via ~ with sidecar .srt -> sidecar-subs, no ASR", async () => {
  mkdirSync(join(root, "rec"), { recursive: true });
  writeFileSync(join(root, "rec/Встреча 1.mp4"), "");
  writeFileSync(join(root, "rec/Встреча 1.srt"), srt);
  const r = await fetchCmd("~/rec/Встреча 1.mp4", flags, deps());
  expect([r.source, r.url, r.asr_provider]).toEqual(["sidecar-subs", null, null]);
  expect(calls.urls).toEqual([]);
  const m = (await readMeta(r.dir))!;
  expect([m.source_key, m.path, m.title, m.duration]).toEqual([
    `file:${join(root, "rec/Встреча 1.mp4")}`, join(root, "rec/Встреча 1.mp4"), "Встреча 1", 120.5,
  ]);
});

test("local file, no subs, whisperx 502, no --allow-cloud -> UserError with --allow-cloud, groq not called, no ffmpeg", async () => {
  writeFileSync(join(root, "solo.m4a"), "");
  const err = await fetchCmd("solo.m4a", flags, deps({ health: 502 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("--allow-cloud");
  expect(err.message).toContain("wx: not reachable");
  expect(calls.urls.some((u) => u.includes("groq"))).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
});

test("local file, whisperx 502, --allow-cloud -> groq", async () => {
  writeFileSync(join(root, "solo2.m4a"), "");
  const r = await fetchCmd("solo2.m4a", { diarize: true, allowCloud: true }, deps({ health: 502 }));
  expect(r.asr_provider).toBe("groq");
});

test("--no-diarize -> whisperx gets diarize=false", async () => {
  await fetchCmd(URL1, { diarize: false, allowCloud: false }, deps({ meta: noMeta }));
  expect(asrCall().searchParams.get("diarize")).toBe("false");
});

test("rerun: same folder, summary.md untouched, readeck_bookmark_id kept", async () => {
  const first = await fetchCmd(URL1, flags, deps());
  writeFileSync(first.summary_path, "my summary");
  await writeMeta(first.dir, { ...(await readMeta(first.dir))!, readeck_bookmark_id: "bk1" });
  const again = await fetchCmd("https://youtu.be/dQw4w9WgXcQ", flags, deps());
  expect(again.dir).toBe(first.dir);
  expect(again.summary_exists).toBe(true);
  expect(await Bun.file(again.summary_path).text()).toBe("my summary");
  expect((await readMeta(again.dir))!.readeck_bookmark_id).toBe("bk1");
  expect(readdirSync(base).length).toBe(1);
});

test("whisperx up but /asr 500 -> error, no switch to groq, .work/audio.ogg stays; retry reuses it", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500 })).catch((e) => e);
  expect(err.message).toContain("500");
  expect(calls.urls.some((u) => u.includes("groq"))).toBe(false);
  const dir = join(base, readdirSync(base)[0]!);
  expect(existsSync(join(dir, ".work/audio.ogg"))).toBe(true);
  expect(existsSync(join(dir, ".work/src.webm"))).toBe(false);

  calls.cmds = [];
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(calls.cmds.some((c) => c[0] === "ffmpeg" || c.includes("bestaudio/best"))).toBe(false);
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("missing file -> UserError 'file not found: <path>'", async () => {
  const err = await fetchCmd("nope.mp4", flags, deps()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(`file not found: ${join(root, "nope.mp4")}`);
});

test("truncated audio.ogg from an interrupted run is not reused", async () => {
  await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500 })).catch(() => {});
  calls.cmds = [];
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, oggDuration: "60\n" }));
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(true);
  expect(r.asr_provider).toBe("wx");
});

test("regional language en-US goes to ASR as en", async () => {
  await fetchCmd(URL1, flags, deps({ meta: { ...noMeta, language: "en-US" } }));
  expect(asrCall().searchParams.get("language")).toBe("en");
});

test("rerun after successful ASR does not download/transcribe again; --force does", async () => {
  const first = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  writeFileSync(first.summary_path, "summary");
  calls.cmds = [];
  calls.urls = [];
  const again = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(calls.urls).toEqual([]);
  expect(calls.cmds.filter((c) => !c.includes("--dump-single-json"))).toEqual([]);
  expect([again.dir, again.source, again.asr_provider, again.summary_exists, again.diarized]).toEqual([first.dir, "asr", "wx", true, true]);
  await fetchCmd(URL1, { ...flags, force: true }, deps({ meta: noMeta }));
  expect(calls.urls.some((u) => u.includes("/asr?"))).toBe(true);
});

test("subtitles arriving as srt are parsed as srt", async () => {
  const r = await fetchCmd(URL1, flags, deps({ subsExt: "srt" }));
  expect(await Bun.file(r.transcript_path).text()).toContain("Добрый вечер, это стрим про миграцию.");
});

test("long stream (6805 s) is compressed at 28k to fit the Groq limit", async () => {
  await fetchCmd(URL1, flags, deps({ meta: { ...noMeta, duration: 6805 }, oggDuration: "6805\n", providers: [GROQ] }));
  const ff = calls.cmds.find((c) => c[0] === "ffmpeg")!;
  expect(ff[ff.indexOf("-b:a") + 1]).toBe("28k");
});

test("auto captions: manual+auto, no manual -> youtube-auto-subs, no ASR, rolling dupes removed", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, cfg: { subtitles: "manual+auto" } }));
  expect(r.source).toBe("youtube-auto-subs");
  expect(calls.urls).toEqual([]);
  expect(hasFormatDownload()).toBe(false);
  const sub = calls.cmds.find((c) => c.includes("--write-auto-subs"))!;
  expect(sub[sub.indexOf("--sub-langs") + 1]).toBe("en-orig");
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr.match(/this is Bobby Bobby has to do a report/g)?.length).toBe(1);
});

test("auto captions off (manual) -> ASR even if auto exists", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(r.source).toBe("asr");
  expect(calls.cmds.some((c) => c.includes("--write-auto-subs"))).toBe(false);
});

test("provider is chosen BEFORE download: none fits -> UserError, no yt-dlp -f, no ffmpeg", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: { ...noMeta, duration: 9000 }, providers: [GROQ] })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("groq: 2:30:00 exceeds duration limit");
  expect(hasFormatDownload()).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
});

test("after compression src.* is removed; .work removed after success", async () => {
  await fetchCmd(URL1, flags, deps({ meta: noMeta, asrStatus: 500 })).catch(() => {});
  const dir = join(base, readdirSync(base)[0]!);
  expect(readdirSync(join(dir, ".work")).filter((f) => f.startsWith("src."))).toEqual([]);
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta }));
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("Generic link -> privateSource: cloud only with --allow-cloud", async () => {
  const generic = { ...noMeta, extractor_key: "Generic", id: "x1" };
  const d = () => deps({ meta: generic, providers: [GROQ] });
  const err = await fetchCmd(URL1, flags, d()).catch((e) => e);
  expect(err.message).toContain("--allow-cloud");
  expect(hasFormatDownload()).toBe(false);
  const r = await fetchCmd(URL1, { diarize: true, allowCloud: true }, d());
  expect(r.asr_provider).toBe("groq");
});

test("manual subs from a non-YouTube extractor -> manual-subs", async () => {
  const r = await fetchCmd("https://vimeo.com/1", flags, deps({ meta: { ...ytMeta, extractor_key: "Vimeo", id: "1" } }));
  expect(r.source).toBe("manual-subs");
});

test("link without scheme -> 'file not found: ... — if this is a link, add https://'", async () => {
  const err = await fetchCmd("youtube.com/watch?v=x", flags, deps()).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe(`file not found: ${join(root, "youtube.com/watch?v=x")} — if this is a link, add https://`);
});

test("retry after provider change: ogg over the new provider's limit is recompressed with the new kbps", async () => {
  const meta = { ...noMeta, duration: 6805 };
  await fetchCmd(URL1, flags, deps({ meta, oggDuration: "6805\n", asrStatus: 500 })).catch(() => {});
  const dir = join(base, readdirSync(base)[0]!);
  truncateSync(join(dir, ".work/audio.ogg"), 25_000_001);
  calls.cmds = [];
  const r = await fetchCmd(URL1, flags, deps({ meta, oggDuration: "6805\n", health: 502 }));
  const ff = calls.cmds.find((c) => c[0] === "ffmpeg")!;
  expect(ff[ff.indexOf("-b:a") + 1]).toBe("28k");
  expect(r.asr_provider).toBe("groq");
});

test("actual ogg larger than the chosen provider's limit -> UserError", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, providers: [GROQ], oggSize: 25_000_001 })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("over the file limit");
  expect(calls.urls.some((u) => u.startsWith(GROQ_URL))).toBe(false);
});

test("summaryLanguage ru -> sidecar a.ru.srt preferred over a.en.srt", async () => {
  mkdirSync(join(root, "sc"), { recursive: true });
  writeFileSync(join(root, "sc/a.mp4"), "");
  writeFileSync(join(root, "sc/a.en.srt"), "1\n00:00:00,000 --> 00:00:02,000\nEnglish line\n");
  writeFileSync(join(root, "sc/a.ru.srt"), srt);
  const r = await fetchCmd("sc/a.mp4", flags, deps({ cfg: { summaryLanguage: "ru" } }));
  const tr = await Bun.file(r.transcript_path).text();
  expect(tr).toContain("Добрый вечер");
  expect(tr).not.toContain("English line");
});

test("outputDir from config with ~ is expanded", async () => {
  const d = deps({ cfg: { outputDir: "~/out-tilde" } });
  const r = await fetchCmd(URL1, flags, d);
  expect(r.dir.startsWith(join(root, "out-tilde"))).toBe(true);
});

test("unknown duration + Generic without --allow-cloud -> UserError before any download", async () => {
  const meta = { ...noMeta, extractor_key: "Generic", id: "x2", duration: null };
  const err = await fetchCmd(URL1, flags, deps({ meta, providers: [GROQ] })).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("--allow-cloud");
  expect(hasFormatDownload()).toBe(false);
  expect(calls.cmds.some((c) => c[0] === "ffmpeg")).toBe(false);
});

test("unknown duration: probed 6805 s needs 28k -> recompressed from source at 28k, groq used", async () => {
  const meta = { ...noMeta, duration: null };
  const r = await fetchCmd(URL1, flags, deps({ meta, oggDuration: "6805\n", providers: [GROQ] }));
  const ffs = calls.cmds.filter((c) => c[0] === "ffmpeg");
  expect(ffs.map((c) => c[c.indexOf("-b:a") + 1])).toEqual(["32k", "28k"]);
  expect(r.asr_provider).toBe("groq");
  expect(existsSync(join(r.dir, ".work"))).toBe(false);
});

test("#3: auto-caption download fails → falls back to speech recognition", async () => {
  const r = await fetchCmd(URL1, flags, deps({ meta: noMeta, cfg: { subtitles: "manual+auto" }, autoFail: true }));
  expect([r.source, r.asr_provider]).toEqual(["asr", "wx"]);
  expect(hasFormatDownload()).toBe(true);
});

test("#3: auto captions fail and no ASR provider → one error naming both reasons", async () => {
  const err = await fetchCmd(URL1, flags, deps({ meta: noMeta, cfg: { subtitles: "manual+auto" }, providers: [], autoFail: true }))
    .catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("auto captions could not be downloaded");
  expect(err.message).toContain("HTTP Error 429");
  expect(err.message).toContain("no ASR providers configured");
});
