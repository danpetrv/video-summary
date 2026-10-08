# Local ASR (Parakeet) + removal of cloud providers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, zero-config speech recognition provider (parakeet.cpp + Parakeet Ultra) as the default, and remove cloud providers (Groq/OpenAI presets, cloud limits, privacy gate) while keeping `whisperx` and `openai-compatible` for users' own servers.

**Architecture:** Removal first (config with soft migration, selection, fetch), then a new `src/local/` module: pins, paths, build selection, installer (`local install|status`), the parakeet runner (WAV → `parakeet-cli --vad --json` → cues, GPU→CPU fallback) and a speed store that drives the slow-run gate. Docs and bundle last, then manual acceptance on real binaries.

**Tech Stack:** TypeScript, Bun (tests, build), Node ≥ 20 at runtime (bundle must stay Bun-free), ffmpeg, system `tar`.

**Spec:** `docs/superpowers/specs/2026-10-08-local-asr-parakeet-design.md`

## Global Constraints

- parakeet.cpp `v0.6.1`; release asset URL `https://github.com/mudler/parakeet.cpp/releases/download/v0.6.1/<asset>`.
- Assets (name → size, sha256), exactly:
  - `parakeet-v0.6.1-bin-macos-metal-arm64.tar.gz` 2587801 `bc97b5e6253e928d1127f48f08242324317495ef8708e31db1e09b9537d1bb74`
  - `parakeet-v0.6.1-bin-macos-cpu-x64.tar.gz` 2753061 `82392069ea091c896dcf86fb5d86f20d107c71f6bad4b9e79a114523d98fb643`
  - `parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz` 2727511 `cce60d122ab72e1068cd0d164e54a21655a0b83f1b9c21befc20124f5a972c10`
  - `parakeet-v0.6.1-bin-linux-cpu-arm64.tar.gz` 2448702 `85b6dafce8a984d0971d94865da5e2e50e111604fb6e7030f5b599dc2616c8db`
  - `parakeet-v0.6.1-bin-linux-vulkan-x64.tar.gz` 37493205 `881fd99d531a4dcfc26119a4969aec61b8390ba84e9d641716411d4c1db2de3a`
  - `parakeet-v0.6.1-bin-linux-vulkan-arm64.tar.gz` 29743428 `96bc0a9ac524ea875f7260fbaed65632d55cd249e251d0f8a69d9df13dc30c9c`
- Model: `https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/741158ae71e64ef5c89385862c18f777d07a97a1/ultra-q8_0.gguf`, 941517728 bytes, sha256 `c2fb452a9df468a141012b01c8c168a25ce93f710897c7de6e353c6cc250986a`.
- Paths: binaries `${XDG_DATA_HOME:-~/.local/share}/video-summary/parakeet/v0.6.1/<build>/`, models `${XDG_CACHE_HOME:-~/.cache}/video-summary/models/`, speed `${XDG_STATE_HOME:-~/.local/state}/video-summary/speed.json`; same on macOS.
- Supported languages (Parakeet v3/Ultra): `bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro sk sl es sv ru uk`.
- Local process timeout 2 h; HTTP providers keep 30 min.
- Slow gate: threshold 10 min; default speeds CPU 8×, GPU 60×; update `new = 0.5·old + 0.5·measured`; key `parakeet:ultra:<gpu|cpu>`.
- Cue grouping: break after a word ending in `.` `?` `!` `…`, or on a gap ≥ 1.0 s, or when the cue would exceed 30 s.
- Audio for all providers: opus 32k (no adaptive bitrate).
- Migration warning texts: `providers[<i>] "<name>": cloud providers were removed in v0.4.0 — skipped`; `<path>: removed in v0.4.0 — ignored`.
- No personal infrastructure (hostnames, machine names, home paths) in code, docs or commits — the repo is public.
- Runtime code must stay Bun-free (`bun run check:bun-free`); every task ends with `bun test` and `bunx tsc --noEmit` green.

## Review Focus

- **Upgrade with an old config (whisperx + groq + `bitrate`)**: `check` and `fetch` keep working on whisperx, groq is skipped with a warning — test in Task 2.
- **Vulkan library present but GPU/driver broken** (or no GPU device): GPU build fails, CPU build recognizes, note lands in `asr_failed` — test in Task 5.
- **Interrupted or corrupted model download** (partial `.part`, wrong bytes): next `local install` re-downloads and never leaves a bad `ultra-q8_0.gguf` in place — test in Task 3.
- **Video without speech (music) or empty JSON words**: local provider fails with "no speech recognized" and the next provider is tried — test in Task 5.
- **Two `local install` runs at once** (agent retries): unique temp names + atomic rename, no half-extracted build directory — test in Task 3.

---

### Task 1: Runner gets `env` and `timeoutMs`

**Files:**
- Modify: `src/types.ts` (Runner), `src/exec.ts`
- Test: `test/exec.test.ts`

**Interfaces:**
- Produces: `type Runner = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<RunResult>`; on timeout `run` resolves `{ code: 124, stdout, stderr: stderr + "\ntimed out after <N> s" }` after SIGTERM (SIGKILL 5 s later). `env` is merged over `process.env`.

- [ ] **Step 1: Write failing tests** in `test/exec.test.ts`:
  - `run: env is passed to the child` — `run(["sh","-c","printf %s \"$VS_X\""], { env: { VS_X: "42" } })` → `stdout === "42"`.
  - `run: timeoutMs kills the child and returns code 124` — `run(["sleep","5"], { timeoutMs: 200 })` → `code === 124`, `stderr` contains `timed out after 0.2 s`, finishes in < 2 s.
- [ ] **Step 2: Run** `bun test test/exec.test.ts` — expected FAIL (env ignored, no timeout).
- [ ] **Step 3: Implement** in `src/exec.ts` (spawn `env: { ...process.env, ...opts.env }`; timer → `kill("SIGTERM")`, second timer → `kill("SIGKILL")`, clear timers on close).
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat: runner supports env and timeout`.

### Task 2: Remove cloud providers (config migration, resolution, selection, fetch)

One task: removing `bitrate`/presets from the config breaks `fetch-cmd.ts` and `presets.ts` at compile time, so they change together.

**Files:**
- Modify: `src/config.ts`, `src/asr/presets.ts`, `src/asr/select.ts`, `src/asr/openai-compatible.ts`, `src/fetch-cmd.ts`, `src/cli.ts` (check `config.warnings`, remove `config limits`, USAGE, fetch flags)
- Delete: `src/limits.ts`, `test/limits.test.ts`, `test/presets.test.ts` (replaced by `test/resolve.test.ts`)
- Test: `test/config.test.ts`, `test/cli.test.ts`, `test/resolve.test.ts`, `test/asr/select.test.ts`, `test/asr/openai-compatible.test.ts`, `test/fetch-cmd.test.ts`

**Interfaces:**
- Produces:
  - `ProviderConfig = KeyRef & { name: string; type: "whisperx" | "openai-compatible"; url: string; model?: string; diarize?: boolean }` (`diarize` only for whisperx; Task 4 adds the `local` variant).
  - `Config` loses `bitrate`; `DEFAULT_CONFIG` = `{ outputDir: "~/Documents/video-summaries", summaryLanguage: "auto", summaryLength: "medium", subtitles: "manual", providers: [], readeck: null }`.
  - `parseConfig(raw: unknown, warnings?: string[]): Config`, `loadConfig(path: string, warnings?: string[]): Promise<Config | null>` — warnings pushed into the array when given.
  - `check` → `config: { path, exists, valid, error?, warnings: string[] }`.
  - `ResolvedProvider = { name: string; type: "whisperx" | "openai-compatible"; url: string; model: string | null; diarize: boolean; keyFile: string | null; keyEnv: string | null }` (no `format`, `local`, `maxBytes`, `maxSeconds`, `keyRequired`).
  - `type SlowEstimate = { minutes: number; device: "gpu" | "cpu"; speed: number }` exported from `src/asr/select.ts`; `SelectInput = { candidates: Candidate[]; durationSec: number; language: string | null; acceptSlow: boolean; estimate: (p: ResolvedProvider, durationSec: number) => SlowEstimate | null }` (callers pass `() => null` until Task 6).
  - `FetchFlags = { diarize: boolean; force?: boolean; acceptSlow?: boolean }`; `--allow-cloud` is parsed and ignored.
  - `transcribeOpenAI` always sends `verbose_json`; `parseDiarized` removed.

- [ ] **Step 1: Write failing tests** (`test/config.test.ts`):
  - `migration: groq/openai presets skipped with a warning, whisperx kept` — `parseConfig({ bitrate: "fixed", providers: [{name:"wx",type:"whisperx",url:"https://a"},{name:"groq",type:"openai-compatible",preset:"groq",tier:"free",keyFile:"~/g.key"}] }, w)` → `providers` = `[{name:"wx",type:"whisperx",url:"https://a"}]`; `w` = `['bitrate: removed in v0.4.0 — ignored', 'providers[1] "groq": cloud providers were removed in v0.4.0 — skipped']`.
  - `migration: maxBytes/maxSeconds/local on whisperx and diarize on openai-compatible are ignored with warnings` (e.g. `providers[0].maxBytes: removed in v0.4.0 — ignored`); the result has none of these keys.
  - `saveConfig after migration writes the cleaned config` — load a file with groq + bitrate, `setValue(cfg, "summaryLength", "short")`, save, raw JSON has no `bitrate` and no groq provider.
  - Update the `DEFAULT_CONFIG` test; drop assertions about preset/tier/limit messages.
- [ ] **Step 2: Write failing tests** (`test/cli.test.ts`): `check reports migration warnings and stays valid` (groq config → `valid: true`, one warning); `config limits` → usage error (delete the old limits test).
- [ ] **Step 3: Write failing tests**: `test/resolve.test.ts` (whisperx `diarize` default true, url trimmed; openai-compatible url/model/keys, `diarize: false`); `test/asr/select.test.ts` (`probeProviders: openai-compatible always probed via /models`; `chooseProvider` reasons are only availability/key; delete limit, size and privacy tests); `test/fetch-cmd.test.ts` (`compression is always 32k` for a 6805 s video; `--allow-cloud is accepted and ignored`; delete Groq-limit, adaptive-bitrate, privateSource/Generic, ogg-over-limit tests; rewrite the v0.3.1 fallback tests with whisperx + an `openai-compatible` own server stubbed in `deps()` instead of groq).
- [ ] **Step 4: Run** `bun test` — FAIL.
- [ ] **Step 5: Implement**: `parseProvider` skips providers with `preset`, warns and drops `tier`/`maxBytes`/`maxSeconds`/`local` (and `diarize` on openai-compatible) before `checkKeys`; `bitrate` accepted at top level only to warn and drop; `openai-compatible` requires `url` and `model`; `resolveProvider` without presets; `reject` keeps availability and key checks; `recognize` drops `kbps`/`targetBytes`/`bitrateFor`/size check/`privateSource`; delete `src/limits.ts`; remove the `limits` subcommand.
- [ ] **Step 6: Run** `bun test && bunx tsc --noEmit && bun run check:bun-free` — PASS.
- [ ] **Step 7: Commit** `feat!: remove cloud providers; soft migration of old configs`.

### Task 3: `src/local/` — pins, paths, builds, installer, CLI `local install|status`

**Files:**
- Create: `src/local/pins.ts`, `src/local/paths.ts`, `src/local/builds.ts`, `src/local/install.ts`
- Modify: `src/cli.ts` (subcommands, `CliDeps.arch`), `src/main.ts` (`arch: process.arch === "arm64" ? "arm64" : "x64"`)
- Test: `test/local/builds.test.ts`, `test/local/install.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces:
  - `pins.ts`: `PARAKEET_VERSION = "v0.6.1"`; `type BuildId = "macos-metal-arm64" | "macos-cpu-x64" | "linux-cpu-x64" | "linux-cpu-arm64" | "linux-vulkan-x64" | "linux-vulkan-arm64"`; `BUILDS: Record<BuildId, { asset: string; size: number; sha256: string; gpu: boolean }>`; `MODEL = { file: "ultra-q8_0.gguf", url, size: 941517728, sha256 }`; `LANGUAGES: readonly string[]` (Global Constraints).
  - `paths.ts`: `localPaths(env, home): { binDir(build: BuildId): string; cli(build: BuildId): string; model: string; speedFile: string }`.
  - `builds.ts`: `findVulkanLib(exists: (p: string) => boolean): boolean` (checks `libvulkan.so.1` in `/usr/lib/x86_64-linux-gnu`, `/usr/lib/aarch64-linux-gnu`, `/usr/lib64`, `/usr/lib`); `planBuilds(o: { platform: Platform; arch: "x64" | "arm64"; vulkanLib: boolean; device: "auto" | "cpu" }): { gpu: BuildId | null; cpu: BuildId | null }` per the spec table (darwin arm64 → `{ gpu: "macos-metal-arm64", cpu: null }` — CPU fallback is the same binary with `PARAKEET_DEVICE=cpu`; darwin x64 → `{ gpu: null, cpu: "macos-cpu-x64" }`; linux with lib → `{ gpu: vulkan-<arch>, cpu: cpu-<arch> }`; linux without → `{ gpu: null, cpu: cpu-<arch> }`; `device: "cpu"` → `gpu: null` except darwin arm64 where `cpu` becomes `"macos-metal-arm64"`).
  - `install.ts`: `type LocalDeps = { run: Runner; fetch: Fetcher; env; home; platform; arch; exists: (p: string) => boolean; has: (bin: string) => boolean }`; `localStatus(d): { installed: boolean; version: string; builds: BuildId[]; model: { present: boolean; verified: boolean; path: string }; vulkan_lib: boolean; hint?: string }` (no network, no hashing: `present` = file exists, `verified` = exact pinned size; `installed` = planned builds' `parakeet-cli` exist and `verified`; `hint` = `sudo apt install libvulkan1` when linux, no lib, `has("nvidia-smi")`); `localInstall(d): Promise<{ version: string; builds: BuildId[]; model: { path: string; bytes: number }; downloaded_bytes: number }>`.
  - CLI: `local install`, `local status` (JSON); `CliDeps` gains `arch`.

- [ ] **Step 1: Write failing tests** `test/local/builds.test.ts`: the full matrix (darwin arm64/x64 × device; linux x64/arm64 × lib yes/no × device) with exact `BuildId`s; `findVulkanLib` true for each listed dir, false otherwise.
- [ ] **Step 2: Write failing tests** `test/local/install.test.ts` (tmp `XDG_DATA_HOME`/`XDG_CACHE_HOME`, stub `fetch` serving fixture bytes and a stub `run` for `tar` that creates `<dest>/parakeet-v0.6.1-bin-<build>/parakeet-cli`; the test patches `BUILDS`/`MODEL` size+sha to the fixture via an injectable `pins` param — `localInstall(d, pins = { BUILDS, MODEL })`):
  - `install: downloads planned builds and the model, verifies, places them; second run downloads 0 bytes`.
  - `install: archive with wrong sha256 -> UserError "downloaded <asset> does not match the pinned checksum — retry \`local install\`", no build dir`.
  - `install: model with wrong bytes -> UserError naming ultra-q8_0.gguf; no final model file; .part removed`.
  - `install: leftover .part from an interrupted run is replaced`.
  - `install: concurrent installs end with a complete build dir` (`Promise.all([localInstall(d), localInstall(d)])` → both resolve, `cli(build)` exists).
  - `status: not installed / installed / linux without libvulkan with nvidia-smi -> hint`.
- [ ] **Step 3: Run** `bun test test/local` — FAIL.
- [ ] **Step 4: Implement**: download = stream `Response.body` to `<target>.<random>.part` while hashing (`node:crypto` sha256), check size + hash, `rename`; archive → `mkdtemp` next to the bin dir, `run(["tar","-xzf",archive,"-C",tmp])`, rename `<tmp>/parakeet-v0.6.1-bin-<build>` → `binDir(build)` (if target exists and is complete, keep it and remove tmp). Network errors → `UserError` with `netErrorTag`.
- [ ] **Step 5: Write failing CLI tests** (`test/cli.test.ts`): `local status` JSON shape; `local install` dispatches; unknown `local foo` → usage.
- [ ] **Step 6: Implement CLI wiring; run** `bun test && bunx tsc --noEmit && bun run check:bun-free` — PASS.
- [ ] **Step 7: Commit** `feat: local engine installer (parakeet.cpp v0.6.1, Parakeet Ultra)`.

### Task 4: `type: "local"` in config, resolution, availability and `check`

**Files:**
- Modify: `src/config.ts`, `src/asr/presets.ts`, `src/asr/select.ts`, `src/cli.ts`
- Test: `test/config.test.ts`, `test/resolve.test.ts`, `test/asr/select.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `localStatus`, `localPaths` (Task 3).
- Produces: `probeProviders(ps, f, env, home, local?: { installed: boolean })` — local candidate `available = local.installed`, `keyMissing: null`; `reject` for an unavailable local provider returns `local engine not installed — run \`local install\``. When a local provider is configured, `check` adds to `deps.missing`: `{ name: "parakeet", install: "sh <skill-dir>/scripts/video-summary local install", needsSudo: false, note: "~0.9 GB download" }` if not installed, and `{ name: "libvulkan1", install: "sudo apt install libvulkan1", needsSudo: true, note: "enables GPU recognition; run local install again afterwards" }` if `localStatus().hint` is set (`DepName` gains `"parakeet" | "libvulkan1"`).

- [ ] **Step 1: Write failing tests**: `local provider: defaults engine parakeet, model ultra, device auto`; `local provider: url/keyFile/diarize/other model -> error with field path` (e.g. `config: providers[0].url: not allowed for type local`); `resolveProvider(local)` → `{ type: "local", url: null, engine: "parakeet", model: "ultra", device: "auto", diarize: false }`; `chooseProvider: local not installed -> reason "local engine not installed — run \`local install\`"`; `check: local configured, not installed -> deps.missing has parakeet with the install command; installed -> provider available`; `check: linux, no libvulkan, nvidia-smi present -> deps.missing has libvulkan1 with needsSudo true`; `check: no local provider -> no parakeet/libvulkan1 items`.
- [ ] **Step 2: Run** `bun test` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat: local provider type in config, selection and check`.

### Task 5: Parakeet recognition

**Files:**
- Create: `src/local/parakeet.ts`
- Modify: `src/asr/select.ts` (`transcribeWith` dispatch + language rejection), `src/asr/types.ts` (`AsrResult.device?: "gpu" | "cpu"`, `AsrResult.notes?: string[]`), `src/fetch-cmd.ts` (append `notes` to `failed`; pass `language`)
- Test: `test/local/parakeet.test.ts`, `test/asr/select.test.ts`, `test/fetch-cmd.test.ts`
- Fixture: `test/fixtures/parakeet-words.json` (short real-shaped output: `{ text, frame_sec, words: [{ w, start, end, conf }], tokens: [] }` with a sentence end, a 1.2 s gap and a > 30 s run)

**Interfaces:**
- Consumes: `planBuilds`, `localPaths`, `MODEL`, `LANGUAGES` (Task 3); Runner `env`/`timeoutMs` (Task 1).
- Produces: `wordsToCues(words: { w: string; start: number; end: number }[]): Cue[]`; `transcribeParakeet(ogg: string, p: ResolvedProvider, d: { run: Runner; env; home; platform; arch; exists }): Promise<AsrResult>`; `LOCAL_TIMEOUT_MS = 2 * 60 * 60_000`.

- [ ] **Step 1: Write failing tests** (`test/local/parakeet.test.ts`, stub `run`):
  - `wordsToCues: breaks after . ? ! …, on gaps >= 1.0 s, and before a cue would exceed 30 s` (exact cue texts/starts from the fixture).
  - `transcribe: converts to 16 kHz mono wav, runs parakeet-cli transcribe --model <model> --input <wav> --vad --json --threads <min(cpus,8)> with timeoutMs 7200000` (assert argv and opts).
  - `transcribe: GPU build fails -> CPU build (linux) / PARAKEET_DEVICE=cpu (darwin arm64); result.device "cpu"; notes ["local: GPU run failed (<last stderr line>), used CPU"]`.
  - `transcribe: device "cpu" in config -> only the CPU run, no note`.
  - `transcribe: empty words -> UserError "no speech recognized"`; `timeout (code 124) -> error naming the timeout`.
- [ ] **Step 2: Write failing tests** (`test/asr/select.test.ts`): `chooseProvider: local skipped for a known unsupported language ("ja") with reason "language ja not supported"; allowed for "ru-RU" and for null`.
- [ ] **Step 3: Write failing tests** (`test/fetch-cmd.test.ts`): `local provider end to end: fetch with [local] -> source asr, asr_provider "local", transcript from fixture words`; `local GPU fallback note appears in asr_failed`; `local no speech -> next provider (whisperx) is used, asr_failed names local`.
- [ ] **Step 4: Run** `bun test` — FAIL.
- [ ] **Step 5: Implement** (`result.language` = item language passed in `AsrOptions`, else `null`).
- [ ] **Step 6: Run** `bun test && bunx tsc --noEmit && bun run check:bun-free` — PASS.
- [ ] **Step 7: Commit** `feat: recognize speech locally with parakeet.cpp`.

### Task 6: Speed store and the slow-run gate (`--accept-slow`)

**Files:**
- Create: `src/local/speed.ts`
- Modify: `src/asr/select.ts` (`reject` uses `estimate`), `src/fetch-cmd.ts` (estimate before download, record after success, `clock`), `src/cli.ts` (`--accept-slow`)
- Test: `test/local/speed.test.ts`, `test/asr/select.test.ts`, `test/fetch-cmd.test.ts`

**Interfaces:**
- Produces: `readSpeeds(file): Promise<Record<string, number>>` (missing or broken file → `{}`); `recordSpeed(file, key, measured): Promise<void>` (EMA 0.5, atomic tmp+rename); `estimateLocal(p, durationSec, speeds, plannedDevice: "gpu" | "cpu"): SlowEstimate`; `FetchDeps.clock?: () => number` (default `Date.now`). Gate reason text: `~<N> min on <CPU|GPU> (measured speed <S>x); add --accept-slow to wait` (`N` = ceil minutes, `S` = speed rounded to an integer).

- [ ] **Step 1: Write failing tests** (`test/local/speed.test.ts`): defaults CPU 8 / GPU 60; EMA update; broken JSON ignored and overwritten; key `parakeet:ultra:cpu`.
- [ ] **Step 2: Write failing tests** (`test/asr/select.test.ts`): `local over 10 min without acceptSlow -> rejected with the gate reason, next provider chosen`; `with acceptSlow -> chosen`; `whisperx never gated`.
- [ ] **Step 3: Write failing tests** (`test/fetch-cmd.test.ts`): `90-min video, only local, CPU default speed -> UserError with "add --accept-slow" before any audio download (no yt-dlp -f call)`; `--accept-slow -> proceeds`; `after a local run speed.json is updated under the device that actually ran` (GPU fallback → `cpu` key).
- [ ] **Step 4: Run** `bun test` — FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run** `bun test && bunx tsc --noEmit && bun run check:bun-free` — PASS.
- [ ] **Step 7: Commit** `feat: warn before slow local recognition (--accept-slow)`.

### Task 7: Docs and bundle

**Files:**
- Modify: `skills/video-summary/SKILL.md`, `skills/video-summary/references/setup.md`, `skills/video-summary/references/providers.md`, `README.md`, `skills/video-summary/scripts/video-summary.mjs` (rebuild)

- [ ] **Step 1:** `SKILL.md` — Check: `config.warnings` shown with an offer to clean; `parakeet` in `deps.missing` installed after the user agrees to ~0.9 GB. Get the text: `--accept-slow` only after the user agrees to the stated time; drop `--allow-cloud`, cloud limits, bitrate; GPU→CPU note in `asr_failed` reported in one sentence; local CPU long runs in background stays.
- [ ] **Step 2:** `setup.md` — providers step per spec «Настройка» (local recommended → `local install` → `config set providers '[{"name":"local","type":"local"}]'`; libvulkan hint; own server only if the user brings it up; whisperx-asr-service link only with `nvidia-smi` + `docker`); remove Groq/OpenAI key steps, `tier`, bitrate, `config limits`; keep the key-file instructions for own servers.
- [ ] **Step 3:** `providers.md` — three types (local, whisperx, openai-compatible), no cloud, no limits; language list for local.
- [ ] **Step 4:** `README.md` — per spec «README» (local-first install, providers, privacy, licenses MIT + CC-BY-4.0 attribution NVIDIA/Moondream, `libvulkan1`, config example without cloud, note that cloud providers were removed in v0.4.0 and old configs are migrated softly).
- [ ] **Step 5:** `bun run build`; `bun test && bunx tsc --noEmit && bun run check:bun-free`; review the diff for personal hostnames, machine names and home-directory paths → none (the patterns live in the maintainer's private notes, not in this repo).
- [ ] **Step 6: Commit** `docs: local-first setup; cloud providers removed`.

### Task 8: Manual acceptance on real binaries

Run with the repo bundle and a temporary `VIDEO_SUMMARY_CONFIG` / `XDG_*` dirs in the session scratchpad (never touch the user's real config or caches without asking).

- [ ] **Step 1:** Linux x64 with libvulkan: `local install` (expect vulkan + cpu builds, ~0.9 GB model, sha OK), `local status`, `check` → available.
- [ ] **Step 2:** `fetch` a 30+ min Russian YouTube video without manual subs using `[{"name":"local","type":"local"}]` → transcript complete (last cue near the end), `asr_provider: "local"`; time noted; `speed.json` written.
- [ ] **Step 3:** GPU→CPU fallback: run with an env that breaks Vulkan (`VK_ICD_FILENAMES=/nonexistent`) → CPU build used, note in `asr_failed`. Record whether the Vulkan build without a device behaves like CPU or fails (open question in the spec).
- [ ] **Step 4:** Slow gate: set `speed.json` CPU speed to 2 and force `device: "cpu"` → 30-min video asks for `--accept-slow`; with the flag proceeds.
- [ ] **Step 5:** Old-config migration: copy of a config with whisperx + groq + bitrate → `check` warnings, `fetch` uses whisperx; `config set` writes it cleaned.
- [ ] **Step 6:** Unsupported language (a Japanese video with `language: ja` metadata) → local skipped with the reason.
- [ ] **Step 7:** Hand the macOS checklist to the repo owner (install on Apple Silicon, Metal used, a 30-min video, `codesign`/quarantine behaviour). Clean all downloads from the scratchpad.
- [ ] **Step 8:** Fix anything found (TDD), re-run Steps 1–6 as needed, commit fixes.
