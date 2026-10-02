---
name: video-summary
description: Use when the user gives a YouTube/video link or a path to a local audio/video file and wants a summary, notes, "what is in this video", "what is this stream about", a transcript or a recognized text, in any language of the request. Gets text from manual subtitles (optionally auto captions) or speech recognition (whisperx, Groq, OpenAI or any OpenAI-compatible endpoint), then you write a structured markdown summary and optionally push it to Readeck.
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
- Never ask the user for API keys in chat. Use the key-file command from
  `references/setup.md` (the user runs it with `!`) or an environment variable.
- Commands that need `sudo` are never run by you: give them as a line `! <command>`
  and wait.

## 1. Check

`check` returns `{ok, runtime, deps{missing[], stale[]}, config{exists, valid, path, error?}, providers[], readeck}`;
`readeck` is `"configured"` or `"disabled"`.

- Runtime missing or unsupported (the launcher prints `{"ok":false,"runtime":"missing"|"unsupported","install":[...]}`): ask **one
  question** whether to install, show the `install` options, then re-run `check`.
- `deps.missing` not empty: ask **one question** whether to install, show the commands.
  After "yes" run those with `needsSudo: false` yourself; for `needsSudo: true` give
  `! <command>` to the user and wait. Then `check` again.
- `deps.stale` (old yt-dlp): offer the `upgrade` command (same `needsSudo` rule), do not block.
- An item in `deps.missing` or `deps.stale` may carry a `note` (e.g. `pipx ensurepath`): show it with the command.
- `config.exists: false`: read `references/setup.md` and walk the user through the
  setup, then `check` again.
- `config.exists: true, valid: false`: the config is broken. Show the user
  `config.error` (a field path such as `providers[0].model`, or the file and the
  JSON parse position). Fix that one
  thing: `config set <key> <json>` for a bad value, or, for a JSON syntax error, edit the
  file at the reported position. **Never run `config init --force` without the user's
  explicit consent**: it wipes all providers and Readeck settings. Then `check` again.
- `providers[]` shows per provider whether it is reachable and has a key (`keyMissing`
  says what is wrong with the key, if anything). A provider that is down is simply
  skipped by `fetch`.

## 2. Get the text

`fetch '<url|path>' [--no-diarize] [--allow-cloud] [--force]`

**This can take minutes** (download, compression, recognition of a long video); tell the
user beforehand. A short video with subtitles: run it with the Bash timeout `600000`
(10 min). A video longer than about 30 minutes, or any recognition on a local CPU
provider: run `fetch` **in the background** and wait for it to finish, since it can
outlast the 10-minute Bash limit (recognition may take up to 30 min). Never abort it and
never start a second `fetch` for the same video while one is running, also not after a
Bash timeout: recognition is already running on the server.

- `--no-diarize`: only if the user said one person speaks.
- `--allow-cloud`: only on the user's explicit permission to send a **local file** (or a
  link from an unknown site) to a cloud provider. Links to known sites go to the
  cloud on their own when no local provider is up.
- `--force`: download and recognize again. Without it a repeated `fetch` returns the
  existing result at once.

Result: `dir`, `transcript_path`, `summary_path`, `summary_exists`, `source`
(`youtube-manual-subs`, `manual-subs`, `youtube-auto-subs`, `sidecar-subs`, `asr`),
`asr_provider`, `diarized`, `speakers`, `language`, `duration`, `transcript_tokens`, `url`.

If the error says no provider fits (too long, no key, down), relay each reason and
offer options: another provider, a lower bitrate (`config limits` shows the maximum
length), or auto captions for YouTube (`subtitles: manual+auto`, see `references/setup.md`).

If `summary_exists: true`, ask whether to rewrite the summary; if "no", go to step 4.

## 3. Summary

Read `<dir>/transcript.md` and `<dir>/meta.json`. If `transcript_tokens` is above about
20,000, read the transcript in chunks (Read with `offset`/`limit`) and merge as you go.
Speaker labels in the transcript are `Speaker N`; render them in the summary language.

Write `<dir>/summary.md` following `references/summary-template.md` (template and rules).
Language: `summaryLanguage` from `config get summaryLanguage`; `auto` means the
language the user talks to you in. Headings are written in that language.

Then run `finalize '<dir>'`: it fills in the reading time. Run it again after any edit.

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
limits, own endpoint), `references/summary-template.md`.
