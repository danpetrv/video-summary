![video-summary](assets/banner.png)

# video-summary

An [Agent Skills](https://agentskills.io) skill that turns a YouTube link, a video URL or a
local audio/video file into a structured markdown summary. The CLI gets the text (manual
subtitles, optionally auto captions, or speech recognition with speaker labels), your
agent writes the summary, and it can optionally be pushed to [Readeck](https://readeck.org).

## Install

```sh
npx skills add danpetrv/video-summary
# or: pnpm dlx skills add danpetrv/video-summary
```

Then ask your agent: `/video-summary https://youtu.be/...`. On the first run the agent
walks you through the setup (output folder, providers, keys, language, Readeck).

## Requirements

- `yt-dlp` (with the `[default]` extra, for `yt-dlp-ejs`) and `ffmpeg`/`ffprobe`;
  for YouTube yt-dlp uses deno, node or bun as its JavaScript runtime (whichever is
  installed)
- `bun` or Node.js >= 20 (the skill ships a prebuilt bundle, no `npm install`)
- macOS or Linux

The agent checks all of this (`check`) and offers to install what is missing.

## Providers and limits

Providers are tried in the order of the config; the first suitable one is used.

| provider | notes |
|---|---|
| whisperx-asr-service | your own server, speaker labels, no limits |
| Groq (`groq`) | `whisper-large-v3-turbo`; free tier: 25 MB and 7000 s per file |
| OpenAI (`openai`) | `whisper-1`; 25 MB. With `diarize: true`: `gpt-4o-transcribe-diarize` (speaker labels), **experimental**: long recordings may be rejected by the API, limits not verified |
| any OpenAI-compatible endpoint | speaches, faster-whisper-server, ... via `url` + `model` |

Audio is compressed to mono opus (16-32 kbps, adaptive to the smallest cloud file
limit), so with Groq free the longest video is about 1 h 56 min (1 h 40 min with
`bitrate: "fixed"`). Longer ones are refused with a clear message (no chunking).
`config limits` prints the numbers for your config.

## Privacy

Subtitles are fetched directly from the site. Recognition sends the extracted audio to
the first suitable provider in your list; a provider marked `local: true` stays on your
network. whisperx defaults to `local: true`: if the whisperx server is not yours, set
`"local": false` on it. A cloud provider receives a **local file** or a link to an unknown
site only when you pass `--allow-cloud` (the agent asks you first). API keys live in key
files or environment variables and are never stored in the config or printed.

## Config

`${XDG_CONFIG_HOME:-~/.config}/video-summary/config.json`; `$VIDEO_SUMMARY_CONFIG`
overrides the whole path:

```json
{
  "outputDir": "~/Documents/video-summaries",
  "summaryLanguage": "auto",
  "subtitles": "manual",
  "bitrate": "adaptive",
  "providers": [
    { "name": "home-whisperx", "type": "whisperx", "url": "https://asr.example" },
    { "name": "groq", "type": "openai-compatible", "preset": "groq", "tier": "free",
      "keyFile": "~/.config/video-summary/groq.key" },
    { "name": "local", "type": "openai-compatible", "url": "http://localhost:8000/v1",
      "model": "Systran/faster-whisper-large-v3", "local": true }
  ],
  "readeck": { "url": "https://read.example", "keyFile": "~/.config/video-summary/readeck.key" }
}
```

`subtitles: "manual+auto"` also uses YouTube auto captions before recognition.
`readeck: null` disables the export (`config set readeck null`).

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

## License

MIT
