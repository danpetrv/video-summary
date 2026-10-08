# Providers

Speech recognition runs on the user's own machines: on this one (`local`) or on the
user's own server (`whisperx`, `openai-compatible`). Providers are tried in config order;
the first that is available, has a key if it needs one, and accepts the video is used. If
a provider fails in the middle of recognition (HTTP error, network error, timeout, the
local engine crashing), the next one that fits is tried. `fetch` lists the failed ones in
`asr_failed`.

| type | where | speaker labels | key |
|---|---|---|---|
| `local` | this machine, Parakeet Ultra via parakeet.cpp | no | none |
| `whisperx` | own whisperx-asr-service | yes | optional |
| `openai-compatible` | own OpenAI-compatible server | no | optional |

Cloud providers (the `groq` and `openai` presets) were removed in v0.4.0. An old config
still loads: such providers are skipped and removed settings (`bitrate`, `tier`,
`maxBytes`, `maxSeconds`, `local`) are ignored, each with a line in `check`'s
`config.warnings`. Any `config set` saves the cleaned config.

## local

```json
{ "name": "local", "type": "local" }
```

Optional fields: `"device": "cpu"` forces the CPU even when a GPU build is installed
(default `"auto"`); `engine` (`"parakeet"`) and `model` (`"ultra"`) have one value each.

- **Install:** `local install` downloads pinned parakeet.cpp binaries and the Parakeet
  Ultra model (~0.9 GB), checks their sha256 and is safe to re-run. `local status` reports
  what is installed (no network). `check` lists `parakeet` in `deps.missing` until it is
  installed.
- **Device:** Apple Silicon uses Metal; Linux uses Vulkan when `libvulkan.so.1` is present
  (`libvulkan1` package; `check` suggests it when `nvidia-smi` exists), otherwise the
  CPU; Intel Macs use the CPU. If the GPU run fails (other than by timing out), the same audio is recognized on the
  CPU and `asr_failed` carries a note such as `local: GPU run failed (...), used CPU`.
- **Languages:** 25 European languages: bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu,
  it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru, uk. If the video's language is known
  and not in this list, the local provider is skipped with `language <code> not
  supported`. A local file has no known language and is tried.
- **Slow runs:** before downloading (when the length is known), the run time is estimated from the video length and
  the speed measured on this machine (stored in
  `${XDG_STATE_HOME:-~/.local/state}/video-summary/speed.json`; until the first run:
  8x real time on CPU, 60x on GPU). Over 10 minutes the provider is skipped with
  `~<N> min on CPU|GPU (measured speed <S>x); add --accept-slow to wait`; `fetch
  --accept-slow` runs it anyway. One run is stopped after 2 hours.
- No speaker labels: `diarized` is `false`.

Files: binaries in `${XDG_DATA_HOME:-~/.local/share}/video-summary/parakeet/`, the
model in `${XDG_CACHE_HOME:-~/.cache}/video-summary/models/`.

## whisperx

```json
{ "name": "home-whisperx", "type": "whisperx", "url": "https://asr.example" }
```

`url` of a [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service)
instance. The CLI calls `POST {url}/asr` and checks `GET {url}/health`. Speaker labels
are on by default (`"diarize": false` in the config or `fetch --no-diarize` turns them
off) and come out as `Speaker N`. Optional key (`keyFile`/`keyEnv`) sent as
`Authorization: Bearer`.

## Your own OpenAI-compatible server

```json
{ "name": "speaches", "type": "openai-compatible", "url": "http://localhost:8000/v1",
  "model": "Systran/faster-whisper-large-v3" }
```

- **speaches** and **faster-whisper-server**: `url` is `http://<host>:<port>/v1`
  (the CLI appends `/audio/transcriptions` and asks for `verbose_json`), `model` is the
  Hugging Face id the server has loaded, e.g. `Systran/faster-whisper-large-v3`. The
  server is checked with `GET {url}/models` before use.
- Optional key (`keyFile`/`keyEnv`) sent as `Authorization: Bearer`.
- No speaker labels.
- whisperx-asr-service: use `type: whisperx`, not this type.

The skill does not check where `url` points: it is meant for a server you run. Audio is
uploaded as mono 16 kHz opus at 32 kbps (about 14 MB per hour).
