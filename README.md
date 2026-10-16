![video-summary](assets/banner.png)

# video-summary

**English** · [Русский](README.ru.md)

An [Agent Skills](https://agentskills.io) skill that turns a YouTube link, a video URL or a
local audio/video file into a structured markdown summary. The CLI gets the text (manual
subtitles, optionally auto captions, or speech recognition right on your machine), your
agent writes the summary, and it can optionally be pushed to [Readeck](https://readeck.org).

- [Install](#install)
- [Usage](#usage): [summary size](#summary-size), [recognition provider](#recognition-provider), [what you get](#what-you-get)
- [Requirements](#requirements)
- [Speech recognition](#speech-recognition)
- [Config](#config)
- [CLI reference](#cli-reference)
- [Privacy](#privacy)
- [Development](#development)

## Install

```sh
npx skills add danpetrv/video-summary
# or: pnpm dlx skills add danpetrv/video-summary
```

Then ask your agent: `/video-summary https://youtu.be/...`. On the first run the agent
walks you through the setup (output folder, speech recognition, language, summary size,
Readeck). For speech recognition it recommends the local engine: with your consent it
downloads it once (about 1 GB: the Parakeet Ultra model, the speaker-labeling model and
parakeet.cpp binaries). No account and no API key are needed.

## Usage

```
/video-summary <url|path> [size] [provider]
```

| argument | values | default |
|---|---|---|
| `<url\|path>` | a YouTube link, a link to another site yt-dlp knows, or a path to a local audio/video file | required |
| `size` | `short`, `medium`, `long` or a reading time `1m`…`60m` | `summaryLength` from the config (`medium`) |
| `provider` | the `name` of a recognition provider from the config, e.g. `local` | providers in config order, with fallback |

Both optional arguments can be given in any order, or not at all. You can also just ask
in plain words, in any language: "summarize this briefly", "in detail", "a 5-minute
read", "recognize it locally".

```
/video-summary https://youtu.be/dQw4w9WgXcQ
/video-summary https://youtu.be/dQw4w9WgXcQ short
/video-summary ~/Videos/lecture.mp4 10m local
```

### Summary size

| size | what is in the summary | reading time |
|---|---|---|
| `short` | the header, TL;DR and Key ideas (5-8 points) | about 1-2 min |
| `medium` | the full template: header, TL;DR, Contents with timecodes, By section, Key ideas, plus Quotes, Mentioned and a Diagram when the video has them | depends on the video |
| `long` | the full template in depth: a finer Contents, the arguments, examples, numbers and who said what in every section; Quotes and Mentioned filled generously | longer than `medium` |
| `<N>m` | a target reading time of N minutes (1-60): N ≤ 2 gives the `short` structure, otherwise the `medium` structure scaled to fit N | ≈ N min |

The size is taken from the request argument first, then from the wording of the request
("briefly" → `short`, "in detail" → `long`, "a 5-minute read" → `5m`), then from
`summaryLength` in the config. With `<N>m` the agent checks the real reading time after
writing and shortens or expands the summary once if it is off by more than about 30%.

The TL;DR is always 3-5 points. The summary is written in `summaryLanguage` (`auto`: the
language you talk to the agent in), even when the video is in another language. On YouTube
timecodes are links to that moment of the video.

### Recognition provider

A provider name in the request (`/video-summary <url> local`, "recognize it locally",
"via my server") means: recognize this video only with that provider, with no fallback to
the others. If it is unavailable or fails, you get the reason instead of a transcript from
another provider. Subtitles still come first: recognition only runs when there are none.
See [Speech recognition](#speech-recognition) for the providers.

### What you get

Each video gets a folder `<outputDir>/<date>-<title>/`:

- `transcript.md`: the full text, with timecodes and speaker labels (when there are any);
- `summary.md`: the summary;
- `meta.json`: title, channel, duration, text source and so on.

A repeated request for the same video reuses the folder: the transcript is not fetched
again, and the agent asks whether to rewrite the summary (in the new size, if you gave
one). If Readeck is configured, the summary is also saved there as a bookmark with the
video thumbnail.

The text comes from the first source that has it:

1. manual subtitles from the site;
2. for a local file, a subtitle file next to it: `name.srt`, `name.vtt` or
   `name.<lang>.srt|vtt`;
3. YouTube auto captions, only with `"subtitles": "manual+auto"`;
4. speech recognition.

## Requirements

- `yt-dlp` (with the `[default]` extra, for `yt-dlp-ejs`) and `ffmpeg`/`ffprobe`;
  for YouTube yt-dlp uses deno, node or bun as its JavaScript runtime (whichever is
  installed)
- `bun` or Node.js >= 20 (the skill ships a prebuilt bundle, no `npm install`)
- macOS (Apple Silicon; Intel Macs work on the CPU) or Linux (x64, arm64); on Windows, use
  WSL2, which counts as Linux
- for local recognition on a GPU under Linux: the Vulkan loader (`libvulkan1` on
  Debian/Ubuntu) and a working GPU driver; without it recognition runs on the CPU

The agent checks all of this (`check`) and offers to install what is missing.

## Speech recognition

Recognition is used when a video has no subtitles. Providers are tried in the order of the
config; the first suitable one is used. If it fails during recognition (server error,
network, the local engine crashing), the next suitable one is tried. To pin one provider
for a video, name it in the request (see [Recognition provider](#recognition-provider)).

| provider | notes |
|---|---|
| `local` (recommended) | Parakeet Ultra via [parakeet.cpp](https://github.com/mudler/parakeet.cpp) on this machine: no server, no key; GPU (Metal on Apple Silicon, Vulkan on Linux) or CPU; 25 European languages; speaker labels (up to 8 speakers) |
| `whisperx` | your own [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service) server, speaker labels |
| `openai-compatible` | your own OpenAI-compatible server (speaches, faster-whisper-server, ...) via `url` + `model` |

**Languages.** The local engine knows bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu, it,
lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru and uk; a video in another language goes to the
next provider in the list.

**Speed.** It depends on the hardware: a desktop GPU recognizes an hour of audio in under a
minute, a CPU takes several minutes or more. When a run would take more than 10 minutes,
the agent tells you the estimate (based on the speed measured on your machine) and waits
for your go.

**Speaker labels.** The local engine labels speakers by default with a second pass over
the audio (a small extra model, about 0.1 GB, downloaded by `local install`). A video with
one speaker gets no labels. To skip the labels, say that one person speaks, or set
`"diarize": false` on the provider; it also makes a CPU run faster. If the labeling fails,
you get the transcript without labels and a note why. Upgrading from v0.4 downloads only
the extra model.

## Config

`${XDG_CONFIG_HOME:-~/.config}/video-summary/config.json`; `$VIDEO_SUMMARY_CONFIG`
overrides the whole path. The agent writes it during the first-run setup; to change a
value later, ask the agent or run `config set <key> <json>`.

```json
{
  "outputDir": "~/Documents/video-summaries",
  "summaryLanguage": "auto",
  "summaryLength": "medium",
  "subtitles": "manual",
  "providers": [
    { "name": "home-whisperx", "type": "whisperx", "url": "https://asr.example" },
    { "name": "local", "type": "local" }
  ],
  "readeck": { "url": "https://read.example", "keyFile": "~/.config/video-summary/readeck.key" }
}
```

Here your own whisperx server is tried first and the local engine is the fallback.

| key | values | default |
|---|---|---|
| `outputDir` | folder for summaries and transcripts | `~/Documents/video-summaries` |
| `summaryLanguage` | `auto` (the language you talk to the agent in) or a code: `ru`, `en`, ... | `auto` |
| `summaryLength` | `short`, `medium`, `long` or `<N>m`; a size in the request overrides it | `medium` |
| `subtitles` | `manual`, or `manual+auto` to also use YouTube auto captions (they may contain errors) before recognition | `manual` |
| `providers` | recognition providers, in priority order; empty: subtitles only | `[]` |
| `readeck` | `{url, keyFile \| keyEnv, label?}`, or `null` to turn the export off | `null` |

Provider fields:

| field | providers | meaning |
|---|---|---|
| `name` | all | unique name, used in the request to pin the provider |
| `type` | all | `local`, `whisperx` or `openai-compatible` |
| `url` | servers | server address; for `openai-compatible` it ends in `/v1` |
| `model` | `openai-compatible` | model id the server has loaded, e.g. `Systran/faster-whisper-large-v3` |
| `keyFile` / `keyEnv` | servers, `readeck` | a file with the key or an environment variable; the key itself is never in the config |
| `diarize` | `local`, `whisperx` | `false` turns speaker labels off (default `true`) |
| `device` | `local` | `cpu` never uses the GPU (default `auto`) |

A Readeck bookmark gets the label `video-summary` (or `label` from the config) and the
video thumbnail as its picture; for a local file, the first non-black frame of the first
minute (or the cover art of an audio file) is shown in the text instead.

The local engine keeps its files in `${XDG_DATA_HOME:-~/.local/share}/video-summary/`
(binaries), `${XDG_CACHE_HOME:-~/.cache}/video-summary/models/` (the models) and
`${XDG_STATE_HOME:-~/.local/state}/video-summary/speed.json` (measured speed).

## CLI reference

You normally do not run the CLI yourself: the agent does. It is useful for debugging and
for scripts. Run it through the launcher, which picks bun or node:

```sh
sh <skill-dir>/scripts/video-summary <command>
```

Every command prints JSON to stdout; on error it exits with code 1 and prints one line to
stderr.

| command | what it does |
|---|---|
| `check` | checks dependencies, the config, providers and Readeck |
| `config path` | prints the config path |
| `config get [key]` | prints the config or one key (`readeck.url` style paths work) |
| `config init [--force]` | writes a default config; `--force` overwrites an existing one, providers and Readeck settings included |
| `config set <key> <json>` | sets one key; the value is JSON (`'"short"'`, `'[...]'`, `null`) and is validated |
| `fetch <url\|path> [flags]` | gets the text into `<dir>/transcript.md` |
| `finalize <dir>` | fills in the reading time in `summary.md` |
| `readeck <dir>` | sends the summary to Readeck |
| `local install` | downloads the local engine and models (about 1 GB); safe to re-run |
| `local status` | shows what of the local engine is installed, without network |

`fetch` flags:

| flag | meaning |
|---|---|
| `--provider <name>` | recognize only with this provider, with no fallback |
| `--no-diarize` | skip speaker labels (faster on a CPU) |
| `--accept-slow` | run local recognition even if it is estimated to take over 10 minutes |
| `--force` | download and recognize again instead of returning the existing transcript |

## Privacy

Subtitles are fetched directly from the site. Audio is recognized only on your machines:
by the local engine, or by your own server if you configure one (the skill does not check
where a server's `url` points). Keys for your own servers live in key files or environment
variables and are never stored in the config or printed.

## Development

```sh
bun install
bun test
bun run check:bun-free   # src/ may use only node:* APIs
bun run build            # rebuilds skills/video-summary/scripts/video-summary.mjs
```

The bundle is committed and CI verifies it matches a fresh build, so the bun version is
pinned together with it (`bun-version: 1.4.2` in `.github/workflows/ci.yml`); bump both
at once.

### Releasing

Merge to `main`, then push a tag:

```sh
git tag -a v0.1.3 -m "v0.1.3" && git push origin v0.1.3
```

`.github/workflows/release.yml` runs the CI checks and creates the GitHub release. The notes
are built from the commits since the previous tag (`bun scripts/release-notes.ts <tag>`
previews them): `feat:` → Features, `fix:` → Fixes, the rest → Other, `build:` commits are
skipped, and `Fixes #N` in a commit body becomes a link. A tag with a suffix
(`v0.2.0-rc.1`) becomes a pre-release.

Users of `npx skills add danpetrv/video-summary` get `main`; a release can be pinned with
`npx skills add danpetrv/video-summary#v0.1.2`.

## License

MIT

The local engine is downloaded on first use, not shipped with the skill:

- [parakeet.cpp](https://github.com/mudler/parakeet.cpp): MIT.
- Model [Parakeet Ultra](https://huggingface.co/moondream/parakeet-ultra) (GGUF
  conversion from [mudler/parakeet-cpp-gguf](https://huggingface.co/mudler/parakeet-cpp-gguf)):
  CC-BY-4.0. Attribution: NVIDIA (Parakeet TDT 0.6B v3), fine-tuned by Moondream.
- Model [Nemotron-3-Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization) by
  NVIDIA (GGUF conversion from
  [mudler/parakeet-cpp-gguf](https://huggingface.co/mudler/parakeet-cpp-gguf)):
  [OpenMDW 1.1](https://openmdw.ai/license/1-1/). Downloaded by `local install`, not shipped
  in this repository.
