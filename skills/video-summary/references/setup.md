# First-run setup

Run when `check` reports `config.exists: false` or `valid: false`. You lead the setup;
ask the questions below one at a time, in this order, in the user's language. Use the
user's answers to build the config with the CLI. Do not hand-edit the JSON, except to
repair a JSON syntax error that `check` reports in `config.error` (fix it at the reported
position). Never run `config init --force` on an existing config without the user's
explicit consent: it wipes the providers and Readeck settings.

Launcher: `sh <skill-dir>/scripts/video-summary`. Config file: `config path`.

## Questions

1. **Output folder** for summaries and transcripts. Default `~/Documents/video-summaries`.
2. **Speech recognition**: used when a video has no subtitles. Providers are tried in
   priority order (the first suitable one wins, the next is a fallback). Offer in this
   order:
   1. **Recommended: local recognition** on this machine. Tell the user: no keys and no
      server, the audio never leaves the machine; it needs a one-time download of about
      1 GB (the Parakeet Ultra model ~0.9 GB, the speaker-labeling model ~0.1 GB and small
      parakeet.cpp binaries); it knows 25 European languages (including English, Russian
      and Ukrainian; list in `providers.md`) and labels speakers (up to 8; a video with
      one speaker gets no labels; `fetch --no-diarize` skips the labels); it runs on the
      GPU (Metal on Apple Silicon, Vulkan on Linux) or on the CPU, where a long video
      takes a while and the speaker labels add to it. On "yes"
      run `local install` (in the background: on a slow connection the download can
      outlast the 10-minute Bash limit; a re-run skips what is already in place), then,
      with no other providers, `config set providers '[{"name":"local","type":"local"}]'`.
      With providers already in the config, append to them: read `config get providers`
      and set the same list with `{"name":"local","type":"local"}` added at the end
      (example below); never drop an existing provider.
      On Linux, if `nvidia-smi` exists but `local status` shows `vulkan_lib: false` (it
      then carries a `hint`), the GPU is not used: suggest that the user runs
      `! sudo apt install libvulkan1`, then run `local install` again (it adds the Vulkan
      build). This is optional; if the user declines, recognition stays on the CPU.
   2. **Own server**, only if the user brings it up: a whisperx-asr-service instance
      (`type: whisperx`: `name`, `url`, optional key; also gives speaker labels, for those
      who already have a server) or an
      OpenAI-compatible server such as speaches or faster-whisper-server
      (`type: openai-compatible`: `name`, `url` ending in `/v1`, `model`, optional key).
      It can go before or after the local provider: with the server first, local
      recognition is the fallback when the server is down. See `providers.md`.
   3. **Only on Linux with both `nvidia-smi` and `docker`** (`command -v nvidia-smi && command -v docker`):
      mention [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service)
      as an option with speaker labels. The user installs it themselves; you only give the
      link, and add it as a `whisperx` provider once it runs.

   The user may also choose none: then only subtitles are used.
3. **Keys**, only for an own server that requires one. Never ask for the key in chat and
   never accept it pasted into chat. Use one of:
   - a key file: ask the user to run this (replace `<name>`), type the key, press Enter:
     `! mkdir -p ~/.config/video-summary && read -rs k && [ -n "$k" ] && (umask 077; printf %s "$k" > ~/.config/video-summary/<name>.key) && chmod 600 ~/.config/video-summary/<name>.key && echo "key saved" || echo "key NOT saved (empty input or no terminal)"`
     The file is created with mode 0600 (subshell `umask 077`) and an empty read writes
     nothing. Put `"keyFile": "~/.config/video-summary/<name>.key"` in the provider.
   - an environment variable the user exports themselves: `"keyEnv": "ASR_API_KEY"`.
     The agent runs the CLI from a non-interactive shell, so export the variable where
     such shells see it: `~/.zshenv` (zsh) or `~/.profile` (bash/sh), not only
     `~/.zshrc`. Then restart the agent so it inherits the variable.
   A `!` command may have no interactive terminal (then it prints "key NOT saved"). In
   that case the user runs the same command in their own terminal, or uses `keyEnv`.
   **Verify:** after the user says it is done, run `check` and confirm that provider shows
   `keyMissing: null`. If not, the key was not saved (or the variable is not exported
   to this session): repeat via a fallback. The config itself never contains a key.
4. **Auto captions** (`subtitles`: `manual` default, or `manual+auto`). If there are no
   providers, offer `manual+auto` (YouTube auto captions, may contain errors); otherwise
   keep `manual`.
5. **Summary language** (`summaryLanguage`): `auto` (the language the user writes to you
   in) or a code such as `ru`, `en`.
6. **Summary size** (`summaryLength`): `short` (TL;DR and key ideas), `medium` (default,
   the full template), `long` (in depth) or `<N>m`, a target reading time of 1-60
   minutes. It is the default: a size in the request overrides it.
7. **Readeck** (optional): URL and a key file (same key-file command, file
   `~/.config/video-summary/readeck.key`). Skip if the user does not use it; to turn an
   existing Readeck export off later: `config set readeck null`.

## Writing the config

```sh
sh <skill-dir>/scripts/video-summary config init          # defaults; --force overwrites
sh <skill-dir>/scripts/video-summary config set outputDir '"~/Documents/video-summaries"'
sh <skill-dir>/scripts/video-summary config set summaryLanguage '"auto"'
sh <skill-dir>/scripts/video-summary config set summaryLength '"medium"'
sh <skill-dir>/scripts/video-summary config set subtitles '"manual"'
sh <skill-dir>/scripts/video-summary local install        # ~1 GB, once
sh <skill-dir>/scripts/video-summary config set providers '[{"name":"local","type":"local"}]'   # no other providers
# providers already configured: keep them in order and append local, e.g. after `config get providers`
# returned [{"name":"home-whisperx","type":"whisperx","url":"https://asr.example"}]:
sh <skill-dir>/scripts/video-summary config set providers '[{"name":"home-whisperx","type":"whisperx","url":"https://asr.example"},{"name":"local","type":"local"}]'
sh <skill-dir>/scripts/video-summary config set readeck '{"url":"https://read.example","keyFile":"~/.config/video-summary/readeck.key"}'
```

`config set <key> <json>`: the value is JSON (strings need inner quotes), `providers`
and `readeck` are set whole; the value is validated and a bad one is rejected with the
path of the field (a value starting with `[`, `{` or `"` that is not valid JSON is
rejected too). `config set readeck null` disables the Readeck export. `config get [key]`
reads it back.

## Finish

Run `check`: every provider should show as available (a server reachable, the local
engine installed) with no `keyMissing`, and `ok: true`.
Fix what it reports, then continue with the user's video.
