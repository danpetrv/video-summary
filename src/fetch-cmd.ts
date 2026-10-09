import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type ResolvedProvider, resolveProvider } from "./asr/providers";
import { type Candidate, chooseProvider, probeProviders, transcribeWith } from "./asr/select";
import { type AsrResult, primaryLang } from "./asr/types";
import { compressAudio, probeDuration } from "./audio";
import { cleanCues, dedupeRolling, parseSrt, parseVtt, renderTranscript, toParagraphs } from "./captions";
import { type Config, expandHome } from "./config";
import { localStatus } from "./local/install";
import { plannedDevice } from "./local/parakeet";
import { localPaths } from "./local/paths";
import { diarSpeedKey, estimateLocal, readSpeeds, recordSpeed, speedKey } from "./local/speed";
import { estimateTokens, type Meta, readMeta, type Source, writeMeta } from "./meta";
import { findSidecarSubs, resolveInputPath, resolveItemDir } from "./paths";
import { type Cue, type Fetcher, type Platform, type Runner, UserError } from "./types";
import { downloadAudio, downloadSubs, fetchMeta, pickAutoTrack, pickManualTrack } from "./ytdlp";

/** `provider`: recognize only with this configured provider (no fallback to the others). */
export type FetchFlags = { diarize: boolean; force?: boolean; acceptSlow?: boolean; provider?: string };
export type FetchDeps = {
  run: Runner; fetch: Fetcher; cfg: Config; env: Record<string, string | undefined>;
  now: Date; cwd: string; home: string;
  // for the local engine's install status
  platform: Platform; arch: "x64" | "arm64"; exists: (p: string) => boolean; has: (bin: string) => boolean;
  clock?: () => number; // ms; times local runs for the speed store (default Date.now)
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
  asr_failed?: string[]; // providers that failed before the one that recognized the audio
};

type Got = { cues: Cue[]; source: Source; asr: AsrResult | null; asrFailed?: string[] };
type Item = {
  sourceKey: string; title: string; url: string | null; path: string | null; id: string | null;
  uploader: string | null; upload_date: string | null; duration: number | null; language: string | null;
  thumbnail: string | null;
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

/**
 * Choose a provider (before any download), compress audio (or reuse a leftover .ogg), transcribe.
 * A provider that fails mid-recognition (HTTP error, rate limit, network, timeout) hands over to the next
 * one that fits by the same rules; `failed` lists those that gave up.
 */
async function recognize(
  getAudio: () => Promise<string>, work: string, item: Item, flags: FetchFlags, d: FetchDeps,
): Promise<{ asr: AsrResult; failed: string[] }> {
  const providers = d.cfg.providers.filter((p) => !flags.provider || p.name === flags.provider).map(resolveProvider);
  const local = providers.some((p) => p.type === "local") ? localStatus(d) : undefined;
  const candidates: Candidate[] = await probeProviders(providers, d.fetch, d.env, d.home, local);
  const language = primaryLang(item.language);
  const speedFile = localPaths(d.env, d.home).speedFile;
  const speeds = local ? await readSpeeds(speedFile) : {};
  const estimate = (p: ResolvedProvider, durationSec: number) =>
    p.type === "local"
      // the diarization pass counts only if it will run: labels asked for, enabled for the provider, model in place
      ? estimateLocal(p, durationSec, speeds, plannedDevice(p, d), flags.diarize && p.diarize && !!local?.diarization.verified)
      : null;
  const select = (cs: Candidate[], durationSec: number) =>
    chooseProvider({ candidates: cs, durationSec, language, acceptSlow: flags.acceptSlow ?? false, estimate });
  const pick = (durationSec: number): ResolvedProvider => {
    const c = select(candidates, durationSec);
    if ("error" in c) throw new UserError(c.error);
    return c.provider;
  };
  let provider = item.duration !== null ? pick(item.duration) : null;
  // Unknown duration: fail fast on what is knowable now (availability, keys).
  if (!provider) pick(0);

  const ogg = join(work, "audio.ogg");
  // A leftover ogg is reused only if it covers the whole video.
  if (existsSync(ogg) && item.duration !== null && !(await coversDuration(ogg, item.duration, d.run))) {
    await rm(ogg, { force: true });
  }
  if (!existsSync(ogg)) {
    await compressAudio(await getAudio(), ogg, d.run);
    for (const f of await readdir(work)) if (f.startsWith("src.")) await rm(join(work, f), { force: true });
  }
  const durationSec = item.duration ?? (await probeDuration(ogg, d.run));
  provider ??= pick(durationSec);

  const failed: string[] = [];
  const tried = new Set<string>();
  for (;;) {
    tried.add(provider.name);
    try {
      const asr = await transcribeWith(provider, ogg, { language, diarize: flags.diarize }, d);
      if (provider.type === "local" && asr.device && asr.elapsedMs !== undefined) {
        await noteSpeed(speedFile, speedKey(provider, asr.device), durationSec, asr.elapsedMs);
        // Planned on the GPU, ended on CPU: the estimate reads the planned key, so it learns the whole path.
        if (asr.plannedDevice && asr.plannedDevice !== asr.device && asr.pathElapsedMs !== undefined) {
          await noteSpeed(speedFile, speedKey(provider, asr.plannedDevice), durationSec, asr.pathElapsedMs);
        }
      }
      if (provider.type === "local" && asr.diarization) {
        const dz = asr.diarization;
        await noteSpeed(speedFile, diarSpeedKey(dz.device), durationSec, dz.elapsedMs);
        // Same as recognition: the estimate reads the planned device's key, so it learns the whole path.
        if (dz.plannedDevice !== dz.device) await noteSpeed(speedFile, diarSpeedKey(dz.plannedDevice), durationSec, dz.pathElapsedMs);
      }
      // Non-fatal problems of the provider that succeeded (GPU failed, CPU used) are reported alongside.
      return { asr, failed: [...failed, ...(asr.notes ?? [])] };
    } catch (e) {
      failed.push((e as Error).message);
    }
    const rest = candidates.filter((c) => !tried.has(c.provider.name));
    const next = select(rest, durationSec);
    if ("error" in next) {
      const why = rest.length ? `; no other provider fits: ${next.error.replace(/^no ASR provider fits: /, "")}` : "";
      throw new UserError(`speech recognition failed: ${failed.join("; ")}${why}`);
    }
    provider = next.provider;
  }
}

/** Feed a finished local run into the speed store; losing a measurement must not lose the transcript. */
async function noteSpeed(file: string, key: string, durationSec: number, elapsedMs: number): Promise<void> {
  if (!(elapsedMs > 0) || !(durationSec > 0)) return;
  try {
    await recordSpeed(file, key, durationSec / (elapsedMs / 1000));
  } catch {
    // e.g. a read-only state dir: the next estimate falls back to the previous or default speed
  }
}

const looksLikeLink = (s: string): boolean => /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(s);

export async function fetchCmd(input: string, flags: FetchFlags, d: FetchDeps): Promise<FetchResult> {
  if (flags.provider && !d.cfg.providers.some((p) => p.name === flags.provider)) {
    const names = d.cfg.providers.map((p) => p.name).join(", ") || "none";
    throw new UserError(`unknown provider ${JSON.stringify(flags.provider)} (configured: ${names})`);
  }
  const isUrl = /^https?:\/\//i.test(input);
  let item: Item;
  let get: (work: string) => Promise<Got>;

  if (isUrl) {
    const vm = await fetchMeta(input, d.run);
    item = {
      sourceKey: `${vm.extractor_key}:${vm.id}`, title: vm.title, url: vm.webpage_url, path: null, id: vm.id,
      uploader: vm.uploader, upload_date: vm.upload_date, duration: vm.duration, language: vm.language,
      thumbnail: vm.thumbnail ?? null,
    };
    const manual = pickManualTrack(vm);
    const auto = !manual && d.cfg.subtitles === "manual+auto" ? pickAutoTrack(vm) : null;
    get = async (work) => {
      if (manual) {
        const cues = await readSubs(await downloadSubs(vm.webpage_url, manual, work, d.run));
        return { cues, source: vm.extractor_key === "Youtube" ? "youtube-manual-subs" : "manual-subs", asr: null };
      }
      const viaAsr = async (): Promise<Got> => {
        const { asr, failed } = await recognize(() => downloadAudio(vm.webpage_url, work, d.run), work, item, flags, d);
        return { cues: asr.cues, source: "asr", asr, asrFailed: failed };
      };
      if (!auto) return viaAsr();
      let autoError: UserError;
      try {
        const cues = await readSubs(await downloadSubs(vm.webpage_url, auto, work, d.run, true));
        return { cues: dedupeRolling(cues), source: "youtube-auto-subs", asr: null };
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        autoError = e; // e.g. YouTube 429 on timedtext: try speech recognition instead
      }
      try {
        return await viaAsr();
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        throw new UserError(`auto captions could not be downloaded (${autoError.message}); ${e.message}`);
      }
    };
  } else {
    const abs = resolveInputPath(input, d.cwd, d.home);
    if (!existsSync(abs)) {
      throw new UserError(`file not found: ${abs}${looksLikeLink(input) ? " — if this is a link, add https://" : ""}`);
    }
    item = {
      sourceKey: `file:${abs}`, title: basename(abs, extname(abs)), url: null, path: abs, id: null,
      uploader: null, upload_date: null, duration: await probeDuration(abs, d.run), language: null,
      thumbnail: null,
    };
    get = async (work) => {
      const lang = d.cfg.summaryLanguage === "auto" ? null : d.cfg.summaryLanguage;
      const side = await findSidecarSubs(abs, lang);
      if (side) return { cues: await readSubs(side), source: "sidecar-subs", asr: null };
      const { asr, failed } = await recognize(async () => abs, work, item, flags, d);
      return { cues: asr.cues, source: "asr", asr, asrFailed: failed };
    };
  }

  const dir = await resolveItemDir(expandHome(d.cfg.outputDir, d.home), item.sourceKey, item.title, d.now);
  // Stub meta.json right away: if we fail later, a retry finds the same folder by source_key.
  const prev = await readMeta(dir);
  if (!prev) await writeFile(join(dir, "meta.json"), JSON.stringify({ source_key: item.sourceKey }) + "\n");
  const transcriptPath = join(dir, "transcript.md");
  const summaryPath = join(dir, "summary.md");
  // Text already exists: do not download or transcribe again (long ASR takes minutes).
  // A transcript recognized by another provider is redone when a provider is named.
  const otherProvider = !!flags.provider && prev?.source === "asr" && prev.asr_provider !== flags.provider;
  if (prev?.source && existsSync(transcriptPath) && !flags.force && !otherProvider) {
    return toResult(prev, dir, transcriptPath, summaryPath);
  }
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
    thumbnail: item.thumbnail,
  };
  await writeMeta(dir, meta);
  const result = toResult(meta, dir, transcriptPath, summaryPath);
  return got.asrFailed?.length ? { ...result, asr_failed: got.asrFailed } : result;
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
