import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type ResolvedProvider, resolveProvider } from "./asr/presets";
import { type Candidate, chooseProvider, probeProviders, transcribeWith } from "./asr/select";
import { type AsrResult, primaryLang } from "./asr/types";
import { compressAudio, probeDuration } from "./audio";
import { cleanCues, dedupeRolling, parseSrt, parseVtt, renderTranscript, toParagraphs } from "./captions";
import { type Config, expandHome } from "./config";
import { bitrateFor, targetBytes } from "./limits";
import { estimateTokens, type Meta, readMeta, type Source, writeMeta } from "./meta";
import { findSidecarSubs, resolveInputPath, resolveItemDir } from "./paths";
import { type Cue, type Fetcher, type Runner, UserError } from "./types";
import { downloadAudio, downloadSubs, fetchMeta, pickAutoTrack, pickManualTrack } from "./ytdlp";

export type FetchFlags = { diarize: boolean; allowCloud: boolean; force?: boolean };
export type FetchDeps = {
  run: Runner; fetch: Fetcher; cfg: Config; env: Record<string, string | undefined>;
  now: Date; cwd: string; home: string;
};
export type FetchResult = {
  dir: string;
  transcript_path: string;
  summary_path: string;
  summary_exists: boolean;
  source: Source;
  asr_provider: string | null;
  diarized: boolean;
  speakers: number;
  language: string | null;
  duration: number | null;
  transcript_tokens: number;
  url: string | null;
};

type Got = { cues: Cue[]; source: Source; asr: AsrResult | null };
type Item = {
  sourceKey: string; title: string; url: string | null; path: string | null; id: string | null;
  uploader: string | null; upload_date: string | null; duration: number | null; language: string | null;
  privateSource: boolean;
};

async function coversDuration(ogg: string, expected: number, run: Runner): Promise<boolean> {
  try {
    return Math.abs((await probeDuration(ogg, run)) - expected) <= Math.max(5, expected * 0.02);
  } catch {
    return false;
  }
}

async function readSubs(file: string): Promise<Cue[]> {
  const text = await readFile(file, "utf8");
  return file.endsWith(".srt") ? parseSrt(text) : parseVtt(text);
}

/** Choose a provider (before any download), compress audio (or reuse a leftover .ogg), transcribe. */
async function recognize(
  getAudio: () => Promise<string>, work: string, item: Item, flags: FetchFlags, d: FetchDeps,
): Promise<AsrResult> {
  const providers = d.cfg.providers.map(resolveProvider);
  const candidates: Candidate[] = await probeProviders(providers, d.fetch, d.env, d.home);
  const kbps = bitrateFor(item.duration, d.cfg.bitrate, targetBytes(providers));
  const pick = (durationSec: number, rate = kbps): ResolvedProvider => {
    const c = chooseProvider({ candidates, durationSec, kbps: rate, privateSource: item.privateSource, allowCloud: flags.allowCloud });
    if ("error" in c) throw new UserError(c.error);
    return c.provider;
  };
  let provider = item.duration !== null ? pick(item.duration) : null;
  // Unknown duration: fail fast on what is knowable now (availability, keys, privacy).
  if (!provider) pick(0);

  const ogg = join(work, "audio.ogg");
  if (existsSync(ogg)) {
    // A leftover ogg is reused only if it covers the whole video and fits the chosen provider.
    const covers = item.duration === null || (await coversDuration(ogg, item.duration, d.run));
    const fits = !provider || provider.maxBytes === null || statSync(ogg).size <= provider.maxBytes;
    if (!covers || !fits) await rm(ogg, { force: true });
  }
  if (!existsSync(ogg)) {
    const src = await getAudio();
    await compressAudio(src, ogg, d.run, kbps);
    if (!provider) {
      // Duration unknown up front: with the real one, recompress at the adaptive bitrate if lower.
      const real = await probeDuration(ogg, d.run);
      const better = bitrateFor(real, d.cfg.bitrate, targetBytes(providers));
      const rate = Math.min(better, kbps);
      if (better < kbps) await compressAudio(src, ogg, d.run, better);
      provider = pick(real, rate);
    }
    for (const f of await readdir(work)) if (f.startsWith("src.")) await rm(join(work, f), { force: true });
  }
  if (!provider) provider = pick(await probeDuration(ogg, d.run)); // leftover ogg, duration unknown
  if (provider.maxBytes !== null && statSync(ogg).size > provider.maxBytes) {
    throw new UserError(`${provider.name}: compressed audio is ${statSync(ogg).size} bytes, over the file limit ${provider.maxBytes}`);
  }
  return transcribeWith(provider, ogg, { language: primaryLang(item.language), diarize: flags.diarize }, d.fetch, d.env, d.home);
}

const looksLikeLink = (s: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(s);

export async function fetchCmd(input: string, flags: FetchFlags, d: FetchDeps): Promise<FetchResult> {
  const isUrl = /^https?:\/\//i.test(input);
  let item: Item;
  let get: (work: string) => Promise<Got>;

  if (isUrl) {
    const vm = await fetchMeta(input, d.run);
    item = {
      sourceKey: `${vm.extractor_key}:${vm.id}`, title: vm.title, url: vm.webpage_url, path: null, id: vm.id,
      uploader: vm.uploader, upload_date: vm.upload_date, duration: vm.duration, language: vm.language,
      privateSource: vm.extractor_key === "Generic",
    };
    const manual = pickManualTrack(vm);
    const auto = !manual && d.cfg.subtitles === "manual+auto" ? pickAutoTrack(vm) : null;
    get = async (work) => {
      if (manual) {
        const cues = await readSubs(await downloadSubs(vm.webpage_url, manual, work, d.run));
        return { cues, source: vm.extractor_key === "Youtube" ? "youtube-manual-subs" : "manual-subs", asr: null };
      }
      if (auto) {
        const cues = await readSubs(await downloadSubs(vm.webpage_url, auto, work, d.run, true));
        return { cues: dedupeRolling(cues), source: "youtube-auto-subs", asr: null };
      }
      const asr = await recognize(() => downloadAudio(vm.webpage_url, work, d.run), work, item, flags, d);
      return { cues: asr.cues, source: "asr", asr };
    };
  } else {
    const abs = resolveInputPath(input, d.cwd, d.home);
    if (!existsSync(abs)) {
      throw new UserError(`file not found: ${abs}${looksLikeLink(input) ? " — if this is a link, add https://" : ""}`);
    }
    item = {
      sourceKey: `file:${abs}`, title: basename(abs, extname(abs)), url: null, path: abs, id: null,
      uploader: null, upload_date: null, duration: await probeDuration(abs, d.run), language: null, privateSource: true,
    };
    get = async (work) => {
      const lang = d.cfg.summaryLanguage === "auto" ? null : d.cfg.summaryLanguage;
      const side = await findSidecarSubs(abs, lang);
      if (side) return { cues: await readSubs(side), source: "sidecar-subs", asr: null };
      const asr = await recognize(async () => abs, work, item, flags, d);
      return { cues: asr.cues, source: "asr", asr };
    };
  }

  const dir = await resolveItemDir(expandHome(d.cfg.outputDir, d.home), item.sourceKey, item.title, d.now);
  // Stub meta.json right away: if we fail later, a retry finds the same folder by source_key.
  const prev = await readMeta(dir);
  if (!prev) await writeFile(join(dir, "meta.json"), JSON.stringify({ source_key: item.sourceKey }) + "\n");
  const transcriptPath = join(dir, "transcript.md");
  const summaryPath = join(dir, "summary.md");
  // Text already exists: do not download or transcribe again (long ASR = minutes and cloud quota).
  if (prev?.source && existsSync(transcriptPath) && !flags.force) return toResult(prev, dir, transcriptPath, summaryPath);
  const work = join(dir, ".work");
  await mkdir(work, { recursive: true });
  const got = await get(work); // on error .work stays: a retry reuses a finished audio.ogg
  await rm(work, { recursive: true, force: true });

  const transcript = renderTranscript(item.title, toParagraphs(cleanCues(got.cues)));
  await writeFile(transcriptPath, transcript);

  const meta: Meta = {
    source_key: item.sourceKey,
    source: got.source,
    asr_provider: got.asr?.provider ?? null,
    diarized: got.asr?.diarized ?? false,
    speakers: got.asr?.speakers ?? 0,
    url: item.url,
    path: item.path,
    id: item.id,
    title: item.title,
    uploader: item.uploader,
    upload_date: item.upload_date,
    duration: item.duration,
    language: item.language ?? got.asr?.language ?? null,
    created_at: d.now.toISOString(),
    transcript_tokens: estimateTokens(transcript),
    readeck_bookmark_id: prev?.readeck_bookmark_id ?? null,
    readeck_summary_sha: prev?.readeck_summary_sha ?? null,
  };
  await writeMeta(dir, meta);
  return toResult(meta, dir, transcriptPath, summaryPath);
}

function toResult(meta: Meta, dir: string, transcriptPath: string, summaryPath: string): FetchResult {
  return {
    dir,
    transcript_path: transcriptPath,
    summary_path: summaryPath,
    summary_exists: existsSync(summaryPath),
    source: meta.source,
    asr_provider: meta.asr_provider,
    diarized: meta.diarized,
    speakers: meta.speakers,
    language: meta.language,
    duration: meta.duration,
    transcript_tokens: meta.transcript_tokens,
    url: meta.url,
  };
}
