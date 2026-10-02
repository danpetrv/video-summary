# Providers

Providers are tried in config order; the first that is available, has a key, fits the
video length and file size, and is allowed by the privacy rule is used. If a provider
fails in the middle of recognition (HTTP error, rate limit, network error, timeout), the
next one that fits by the same rules is tried; a cloud provider still needs
`--allow-cloud` for a local file. `fetch` lists the failed ones in `asr_failed`.

## Presets (`type: openai-compatible`)

Any field of a preset can be overridden in the config.

| preset | url | model | format | file limit | duration limit |
|---|---|---|---|---|---|
| `groq`, tier `free` | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | `verbose_json` | 25 MB | 7000 s |
| `groq`, tier `dev` | same | same | `verbose_json` | 100 MB | none |
| `openai` | `https://api.openai.com/v1` | `whisper-1` | `verbose_json` | 25 MB | none |
| `openai`, `diarize: true` (experimental) | same | `gpt-4o-transcribe-diarize` | `diarized_json`, `chunking_strategy=auto` | 25 MB | not verified |
| no preset | `url` required | `model` required | `verbose_json` | none | none |

MB is decimal (25 MB = 25,000,000 bytes). Presets are cloud (`local: false`); a custom
endpoint is cloud unless it has `local: true`. HTTP 429 is reported with the limit text
and is not retried.

The OpenAI diarized preset is **experimental**: its duration limit has not been verified
and there was no live test against the OpenAI API, so long recordings may be rejected
by the API. Keep a fallback provider after it.

## Maximum video length

`min(duration limit, 96% of file limit * 8 / bitrate)`. Audio is compressed to mono
16 kHz opus: `fixed` is 32 kbps; `adaptive` picks 16-32 kbps so the file fits 96% of the
smallest file limit among cloud providers in the config. The 4% headroom is also kept
when a provider is chosen, because the real opus size drifts a little from the bitrate.
Groq free: about 1 h 56 min adaptive (the 7000 s limit), 1 h 40 min fixed (6000 s).
`config limits` prints the numbers for the current config. Longer videos are refused;
there is no chunking.

## Diarization (speaker labels)

- whisperx: on by default, `--no-diarize` turns it off.
- OpenAI: only with `diarize: true` (model `gpt-4o-transcribe-diarize`, experimental).
  `--no-diarize` does not change this preset: it still uses the diarized model.
- Groq and generic endpoints: no speaker labels.

Labels come out as `Speaker N`.

## whisperx

`type: whisperx`, `url` of a whisperx-asr-service instance.
The CLI calls `POST {url}/asr` and checks `GET {url}/health`. Local by default
(`local: true`), so it is allowed for any file; if the server is not yours (someone
else's or a cloud host), set `"local": false` so private files need `--allow-cloud`.
Optional key sent as `Authorization: Bearer`.

## Your own OpenAI-compatible endpoint

```json
{ "name": "local", "type": "openai-compatible", "url": "http://localhost:8000/v1",
  "model": "Systran/faster-whisper-large-v3", "local": true }
```

- **speaches** and **faster-whisper-server**: `url` is `http://<host>:<port>/v1`
  (the CLI appends `/audio/transcriptions`), `model` is the Hugging Face id the server
  has loaded, e.g. `Systran/faster-whisper-large-v3`. A `local: true` endpoint is
  checked with `GET {url}/models` before use.
- whisperx-asr-service: use `type: whisperx`, not this type.

## Privacy rule

A cloud provider receives the extracted audio. A local file, or a link whose site is
unknown to yt-dlp (generic extractor), goes to a cloud provider only with
`--allow-cloud`, which you add only on the user's explicit permission. Local providers
(`local: true`, whisperx) never need it.
