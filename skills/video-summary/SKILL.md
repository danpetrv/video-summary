---
name: video-summary
description: Use when the user gives a YouTube/video link or a path to a local audio/video file and wants a summary, notes, "what is in this video", "what is this stream about", a transcript or a recognized text, in any language of the request. Gets text from manual subtitles (optionally auto captions) or speech recognition (on-device Parakeet, or the user's own whisperx or OpenAI-compatible server), then you write a structured markdown summary and optionally push it to Readeck.
---

# video-summary

The script does the mechanics (dependencies, subtitles, speech recognition, files,
Readeck). You talk to the user and write the summary.

Run everything through the launcher (it picks bun or node >= 20; do not rely on the
exec bit): `sh <skill-dir>/scripts/video-summary <command>`, where `<skill-dir>` is
the folder this SKILL.md lives in. Every command prints JSON to stdout. On error it exits
with code 1 and one line on stderr: pass it to the user as is (translate it into
their language), it already carries a hint.

Rules that always apply:

- **Always single-quote URLs and paths** in shell commands: `fetch 'https://…'`.
- Never ask the user for API keys in chat (only an own server with auth needs one). Use
  the key-file command from `references/setup.md` (the user runs it with `!`) or an
  environment variable.
- Commands that need `sudo` are never run by you: give them as a line `! <command>`
  and wait.

## 1. Check

`check` returns `{ok, runtime, deps{missing[], stale[]}, config{exists, valid, path, error?, warnings[]}, providers[], readeck}`;
`readeck` is `"configured"` or `"disabled"`.

- Runtime missing or unsupported (the launcher prints `{"ok":false,"runtime":"missing"|"unsupported","install":[...]}`): ask **one
  question** whether to install, show the `install` options, then re-run `check`.
- `deps.missing` not empty: ask **one question** whether to install, show the commands.
  After "yes" run those with `needsSudo: false` yourself; for `needsSudo: true` give
  `! <command>` to the user and wait. Then `check` again.
- `parakeet` in `deps.missing` (a local provider is configured, the engine is not
  installed): its `install` is `local install`, a download of about 0.9 GB (the model plus
  small binaries). Name the size in your question; after "yes" run it yourself
  (`needsSudo: false`) in the background, since on a slow connection it can outlast the
  10-minute Bash limit. It is safe to re-run: what is already in place is not downloaded
  again. Then `check` again.
- An item with `optional: true` (`libvulkan1`: an NVIDIA GPU on Linux without the Vulkan
  loader) does not make `ok` false. Offer it once: with it local recognition runs on the
  GPU instead of the CPU. If the user agrees, give `! sudo apt install libvulkan1`, then
  run `local install` again. If they decline, do not insist and do not offer it again.
- `deps.stale` (old yt-dlp): offer the `upgrade` command (same `needsSudo` rule), do not block.
- An item in `deps.missing` or `deps.stale` may carry a `note` (e.g. `pipx ensurepath`): show it with the command.
- `config.warnings` not empty: the config has settings removed in v0.4.0 (cloud providers
  Groq/OpenAI, `bitrate`, `tier`, ...); they are ignored, the rest works. Show the warnings
  and offer to clean the config: any `config set` saves the cleaned config (e.g. read
  `config get summaryLength` and set the same value back). If no provider is left, or a
  removed cloud provider was a fallback, offer the local provider in its place
  (`references/setup.md`, speech recognition).
- `config.exists: false`: read `references/setup.md` and walk the user through the
  setup, then `check` again.
- `config.exists: true, valid: false`: the config is broken. Show the user
  `config.error` (a field path such as `providers[0].model`, or the file and the
  JSON parse position). Fix that one
  thing: `config set <key> <json>` for a bad value, or, for a JSON syntax error, edit the
  file at the reported position. **Never run `config init --force` without the user's
  explicit consent**: it wipes all providers and Readeck settings. Then `check` again.
- `providers[]` shows per provider whether it is available (a server is reachable, the
  local engine is installed) and has a key (`keyMissing` says what is wrong with the key,
  if anything). A provider that is down is simply skipped by `fetch`.

## 2. Get the text

`fetch '<url|path>' [--no-diarize] [--accept-slow] [--force]`

**This can take minutes** (download, compression, recognition of a long video); tell the
user beforehand. A short video with subtitles: run it with the Bash timeout `600000`
(10 min). A video longer than about 30 minutes, any run with `--accept-slow`, or any
recognition on a local CPU: run `fetch` **in the background** and wait for it to finish,
since it can outlast the 10-minute Bash limit (local recognition on a CPU may take an
hour or more). Never abort it and never start a second `fetch` for the same video while
one is running, also not after a Bash timeout: recognition is already running (on the
server or in the local engine).

- `--no-diarize`: only if the user said one person speaks. Speaker labels come only from
  a whisperx server; the local provider never labels speakers.
- `--accept-slow`: only after the user agreed to wait the time the error named (see below).
- `--force`: download and recognize again. Without it a repeated `fetch` returns the
  existing result at once.

Result: `dir`, `transcript_path`, `summary_path`, `summary_exists`, `source`
(`youtube-manual-subs`, `manual-subs`, `youtube-auto-subs`, `sidecar-subs`, `asr`),
`asr_provider`, `diarized`, `speakers`, `language`, `duration`, `transcript_tokens`, `url`,
and `asr_failed` when a provider failed and the next one recognized the audio: tell the user
which provider failed and why. A note like `local: GPU run failed (...), used CPU` means
the text is there but recognition ran on the CPU: tell the user in one sentence.

If the error says no provider fits, relay each reason as is (translated) and offer what
fits it:

- `~<N> min on CPU|GPU (measured speed <S>x); add --accept-slow to wait`: local recognition
  would take that long. Tell the user the time and ask whether to wait; on "yes" run the
  same `fetch` with `--accept-slow` in the background. The estimate is usually made before
  any download, so little was lost.
- ``local engine not installed — run `local install` ``: offer `local install` (about 0.9 GB),
  as in step 1.
- `language <code> not supported`: the local engine knows 25 European languages (see
  `references/providers.md`). Another provider in the list (an own server) may do it; for
  YouTube, auto captions may exist (`subtitles: manual+auto`, see `references/setup.md`).
- `not reachable`, `no API key (...)`: the user's own server is down or its key is missing.

If `summary_exists: true`, ask whether to rewrite the summary (when the user gave a size,
offer to rewrite it in that size); if "no", go to step 4.

## 3. Summary

Read `<dir>/transcript.md` and `<dir>/meta.json`. If `transcript_tokens` is above about
20,000, read the transcript in chunks (Read with `offset`/`limit`) and merge as you go.
Speaker labels in the transcript are `Speaker N`; render them in the summary language.

Write `<dir>/summary.md` following `references/summary-template.md` (template and rules).
Language: `summaryLanguage` from `config get summaryLanguage`; `auto` means the
language the user talks to you in. Headings are written in that language.

Size: `short`, `medium`, `long` or `<N>m` (target reading time, 1-60 minutes), taken from,
in this order:

1. an argument of the request: `/video-summary '<url>' short`, `... 5m`;
2. the wording of the request: "briefly", "in short" → `short`; "in detail" → `long`;
   "a 5-minute read" → `5m` (in any language);
3. `config get summaryLength` (default `medium`).

What each size includes is in `references/summary-template.md`.

Then run `finalize '<dir>'`: it fills in the reading time. Run it again after any edit.
With an `<N>m` size, compare `reading_minutes` from `finalize` to N: if it is off by
more than about 30%, shorten or expand the summary once and run `finalize` again.

## 4. Readeck

`readeck '<dir>'` returns `{status, bookmark_id, reason?}`.

- `disabled`: Readeck is not configured (`check.readeck: "disabled"`), skip silently,
  do not mention it.
- `sent`: bookmark created. `already-sent`: it was there already.
- `skipped`: not sent, see `reason`; the summary is on disk anyway.

If the summary was rewritten, the old bookmark is replaced (`reason` says so).

## 5. Report to the user

The path to `summary.md`, the Readeck status (with `reason` if any, nothing if
`disabled`) and the TL;DR from the summary, in the summary language.

More: `references/setup.md` (first-run setup), `references/providers.md` (providers,
languages, own server), `references/summary-template.md`.
