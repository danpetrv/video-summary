![video-summary](assets/banner.png)

# video-summary

An [Agent Skills](https://agentskills.io) skill that turns a YouTube link, a video URL or a
local audio/video file into a structured markdown summary. The CLI gets the text (manual
subtitles, optionally auto captions, or speech recognition right on your machine), your
agent writes the summary, and it can optionally be pushed to [Readeck](https://readeck.org).

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

The summary size is an optional argument: `short` (TL;DR and key ideas), `medium` (the
full template, default), `long` (in depth) or a target reading time such as `5m`
(1-60 minutes): `/video-summary https://youtu.be/... short`. Plain words work too
("briefly", "in detail"). Without one, `summaryLength` from the config is used.

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
network, the local engine crashing), the next suitable one is tried. To use one provider
for a video, name it: `/video-summary <url> local` (or ask to recognize it locally); then
only that provider is used, with no fallback.

| provider | notes |
|---|---|
| `local` (recommended) | Parakeet Ultra via [parakeet.cpp](https://github.com/mudler/parakeet.cpp) on this machine: no server, no key; GPU (Metal on Apple Silicon, Vulkan on Linux) or CPU; 25 European languages; speaker labels (up to 8 speakers) |
| `whisperx` | your own [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service) server, speaker labels |
| `openai-compatible` | your own OpenAI-compatible server (speaches, faster-whisper-server, ...) via `url` + `model` |

The local engine knows bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu, it, lv, lt, mt,
pl, pt, ro, sk, sl, es, sv, ru and uk; a video in another language goes to the next
provider in the list. Speed depends on the hardware: a desktop GPU recognizes an hour of
audio in under a minute, a CPU takes several minutes or more. When a run would take more
than 10 minutes, the agent tells you the estimate (based on the speed measured on your
machine) and waits for your go.

The local engine labels speakers by default with a second pass over the audio (a small
extra model, about 0.1 GB, downloaded by `local install`). A video with one speaker gets no
labels. To skip the labels, use `fetch --no-diarize` or `"diarize": false` on the local
provider; it also makes a CPU run faster. If the labeling fails, you get the transcript
without labels and a note why. Upgrading from v0.4 downloads only the extra model.

## Privacy

Subtitles are fetched directly from the site. Audio is recognized only on your machines:
by the local engine, or by your own server if you configure one (the skill does not check
where a server's `url` points). Keys for your own servers live in key files or environment
variables and are never stored in the config or printed.

## Config

`${XDG_CONFIG_HOME:-~/.config}/video-summary/config.json`; `$VIDEO_SUMMARY_CONFIG`
overrides the whole path:

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

Here your own whisperx server is tried first and the local engine is the fallback. With
`"device": "cpu"` the local provider never uses the GPU.

`subtitles: "manual+auto"` also uses YouTube auto captions before recognition.
`readeck: null` disables the export (`config set readeck null`). A Readeck bookmark gets the
video thumbnail as its picture; for a local file, the first non-black frame of the first
minute (or the cover art of an audio file) is shown in the text instead.

The local engine keeps its files in `${XDG_DATA_HOME:-~/.local/share}/video-summary/`
(binaries), `${XDG_CACHE_HOME:-~/.cache}/video-summary/models/` (the models) and
`${XDG_STATE_HOME:-~/.local/state}/video-summary/speed.json` (measured speed).

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
