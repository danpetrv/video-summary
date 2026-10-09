# Providers

Speech recognition runs on the user's own machines: on this one (`local`) or on the
user's own server (`whisperx`, `openai-compatible`). Providers are tried in config order;
the first that is available, has a key if it needs one, and accepts the video is used. If
a provider fails in the middle of recognition (HTTP error, network error, timeout, the
local engine crashing), the next one that fits is tried. `fetch` lists the failed ones in
`asr_failed`. `fetch --provider <name>` uses only the named provider for that video, with
no fallback.

| type | where | speaker labels | key |
|---|---|---|---|
| `local` | this machine, Parakeet Ultra via parakeet.cpp | yes (up to 8) | none |
| `whisperx` | own whisperx-asr-service | yes | optional |
| `openai-compatible` | own OpenAI-compatible server | no | optional |

## local

```json
{ "name": "local", "type": "local" }
```

Optional fields: `"device": "cpu"` forces the CPU even when a GPU build is installed
(default `"auto"`); `"diarize": false` turns speaker labels off (default `true`); `engine`
(`"parakeet"`) and `model` (`"ultra"`) have one value each.

- **Install:** `local install` downloads pinned parakeet.cpp binaries, the Parakeet
  Ultra model (~0.9 GB) and the speaker-labeling model Nemotron-3-Diarization (~0.1 GB),
  checks their sha256 and is safe to re-run; a dropped connection is resumed up to 3
  times. Its result has `model` and `diar_model` (`{path, bytes}`). `local status` reports
  what is installed (no network), with `diarization: {present, verified, path}` for the
  speaker-labeling model. `check` lists `parakeet` in `deps.missing` until the engine is
  installed. The speaker-labeling model is optional: when the engine is installed without
  it, `check` lists an optional `diarization-model` item (`local install`, ~0.1 GB) and
  local works, just without speaker labels (upgrading from v0.4 downloads only this
  model).
- **Device:** Apple Silicon uses Metal; Linux uses Vulkan when `libvulkan.so.1` is present
  (`libvulkan1` package; `check` suggests it when `nvidia-smi` exists) and a GPU device is
  available, otherwise the CPU; Intel Macs use the CPU. With the library but no usable GPU
  device the Vulkan build runs on the CPU by itself and `asr_failed` carries
  `local: no GPU device found, ran on CPU — set "device": "cpu" for local to skip the GPU attempt`. If the GPU run fails (other than by timing out),
  the same audio is recognized on the CPU and `asr_failed` carries a note such as
  `local: GPU run failed (...), used CPU`.
- **Languages:** 25 European languages: bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu,
  it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru, uk. If the video's language is known
  and not in this list, the local provider is skipped with `language <code> not
  supported`. A local file has no known language and is tried.
- **Slow runs:** before downloading (when the length is known), the run time is estimated from the video length and
  the speed measured on this machine (stored in
  `${XDG_STATE_HOME:-~/.local/state}/video-summary/speed.json`; until the first run:
  8x real time on CPU, 60x on GPU for recognition, 16x and 100x for speaker labels). The
  estimate includes the speaker-label pass when it will run. Over 10 minutes the provider
  is skipped with `~<N> min on CPU|GPU (measured speed <S>x); add --accept-slow to wait`;
  `fetch --accept-slow` runs it anyway. When the speaker labels are what tips it over, the
  text is `~<N> min on <CPU|GPU> with speaker labels (~<M> without); add --accept-slow to
  wait, or --no-diarize to skip speaker labels` (no `--no-diarize` part when it is over
  10 minutes without labels too). One run is stopped after 2 hours.
- **Speaker labels:** a second pass over the audio (`scene --diar`), on by default, up to
  8 speakers, named `Speaker N` in order of appearance. `fetch --no-diarize` or
  `"diarize": false` skips it. One speaker found: no labels in the transcript, `diarized`
  is `true`, `speakers` is `1` (the same for whisperx). The pass runs on the same device
  as recognition. If it fails, the transcript is kept without labels (`diarized: false`)
  and `asr_failed` carries `local: speaker labels skipped — <reason>` (model not
  installed, diarization failed, timed out, unexpected output, no speech segments found).
  If only the GPU pass failed, the CPU repeats it and the note is
  `local: GPU diarization failed (...), used CPU`.

Files: binaries in `${XDG_DATA_HOME:-~/.local/share}/video-summary/parakeet/`, the
models in `${XDG_CACHE_HOME:-~/.cache}/video-summary/models/`.

## whisperx

```json
{ "name": "home-whisperx", "type": "whisperx", "url": "https://asr.example" }
```

`url` of a [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service)
instance. The CLI calls `POST {url}/asr` and checks `GET {url}/health`. Speaker labels
are on by default (`"diarize": false` in the config or `fetch --no-diarize` turns them
off) and come out as `Speaker N`; a single speaker gets no labels. Optional key (`keyFile`/`keyEnv`) sent as
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
