# Local speaker diarization (v0.5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `local` provider labels speakers: a second parakeet-cli pass (`scene --diar`) gives "who spoke when", each recognized word gets a speaker by time overlap, the transcript comes out as `**Speaker N:**` paragraphs; plus three v0.4 leftovers (download retry with Range, `device: "cpu"` hint, config warnings in `fetch`).

**Architecture:** Config and install first (`diarize` key, pinned diarization model, status/check), then the download retry. Then pure functions in a new `src/local/diarize.ts` (parse `scene` JSONL, assign speakers to words, label them), the second pass inside `transcribeParakeet`, the slow-run gate that adds both passes, and the small whisperx/fetch changes. Docs and bundle last, then manual acceptance on the real engine.

**Tech Stack:** TypeScript, Bun (tests, build), Node ≥ 20 at runtime (bundle must stay Bun-free), ffmpeg, parakeet.cpp v0.6.1 (already pinned).

**Spec:** `docs/superpowers/specs/2026-10-09-local-diarization-design.md`

## Global Constraints

- Diarization model pin, exactly: file `nemotron-3-diarization-q8_0.gguf`, URL `https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/741158ae71e64ef5c89385862c18f777d07a97a1/nemotron-3-diarization-q8_0.gguf`, size `108674624`, sha256 `76c5bb1fb20d82706142ad32769b7ab496d2458489473a000fd7074c52ceec22`. Path: `${XDG_CACHE_HOME:-~/.cache}/video-summary/models/<file>`.
- Diarization run: `<parakeet-cli> scene --diar <diarModel> --input <wav> --json` — no `--model`, no `--threads`; timeout `LOCAL_TIMEOUT_MS`.
- Speaker assignment: max overlap → else nearest segment within `0.5` s → else previous word's speaker (leading words: first later labeled word). Labels `Speaker 1..N` by first appearance among words.
- One speaker → no labels on cues, `diarized: true`, `speakers: 1` (local and whisperx). Diarization skipped/failed → `diarized: false`, `speakers: 0`.
- Speed keys: `parakeet:diar:<gpu|cpu>`; default diarization speeds CPU `16`, GPU `100`; slow threshold stays `SLOW_MINUTES = 10`.
- Download retry: up to 3 retries per file in one run, `Range: bytes=<received>-`; `206` appends, `200` restarts from zero; non-2xx and size overflow are not retried.
- Note/message texts are fixed by the spec — copy them verbatim from the task that uses them.
- No personal infrastructure (hostnames, machine names, home paths) in code, docs, fixtures or commits — the repo is public.
- Runtime code stays Bun-free (`bun run check:bun-free`); every task ends with `bun test` and `bunx tsc --noEmit` green.

## Review Focus

- **Upgrade from v0.4 without re-running `local install`** (no diarization model): `fetch` via local still works, transcript without labels, note in `asr_failed`, the slow gate does not count diarization, `check` shows the optional item — tests in Tasks 2, 5, 7.
- **Words before the first or after the last diarization segment** (intro music, outro): they inherit a neighbour's speaker, no unlabeled paragraph in a dialogue — test in Task 4.
- **Server ignores Range after a dropped connection** (answers `200`): download restarts cleanly and the final file passes sha256 — test in Task 3.
- **`scene` exits 0 with only empty events** (silence, music): transcript still written, no labels, note `no speech segments found` — test in Task 5.
- **macOS arm64: GPU diarization fails**: CPU retry runs the same Metal binary with `PARAKEET_DEVICE=cpu` — test in Task 5.

---

### Task 1: `diarize` key for the local provider

**Files:**
- Modify: `src/config.ts` (`LocalProviderConfig`, `LOCAL_KEYS`, `parseLocal`), `src/asr/presets.ts` (`LocalProvider`, `resolveProvider`)
- Test: `test/config.test.ts`; fix test helpers that build local configs by hand (`bunx tsc --noEmit` lists them)

**Interfaces:**
- Produces: `LocalProviderConfig.diarize: boolean`; `LocalProvider.diarize: boolean` (was the literal `false`); parsed default `true`.

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`:
  - `local: diarize defaults to true` — `{ name: "local", type: "local" }` parses with `diarize: true`.
  - `local: diarize false is kept` — `"diarize": false` → `diarize: false`; `resolveProvider` gives `diarize: false`.
  - `local: diarize must be boolean` — `"diarize": "no"` → error mentioning `providers[0].diarize` and `must be true or false`.
- [ ] **Step 2: Run** `bun test test/config.test.ts` — FAIL (`diarize` is "not allowed for type local").
- [ ] **Step 3: Implement**: add `"diarize"` to `LOCAL_KEYS`; `diarize: optBool(raw, "diarize", path) ?? true`; update the `parseLocal` doc comment; `resolveProvider` copies `p.diarize`. Update hand-built local configs in tests to include `diarize: true`.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat: diarize key for the local provider`.

### Task 2: Diarization model in pins, install, status and check

**Files:**
- Modify: `src/local/pins.ts`, `src/local/paths.ts`, `src/local/install.ts`, `src/deps.ts` (`localMissing`)
- Create: `src/local/diarize.ts` (only `diarModelReady` in this task)
- Test: `test/local/install.test.ts`, `test/local/paths.test.ts`, `test/deps.test.ts`

**Interfaces:**
- Produces:
  - `pins.ts`: `export const DIAR_MODEL: ModelPin` (values from Global Constraints).
  - `LocalPaths.diarModel: string`.
  - `install.ts`: `Pins = { BUILDS; MODEL; DIAR_MODEL }`; `LocalStatus.diarization: { present: boolean; verified: boolean; path: string }`; `LocalInstallResult.diar_model: { path: string; bytes: number }`.
  - `diarize.ts`: `diarModelReady(paths: LocalPaths, size?: number): boolean` — file exists with exactly `size` bytes (default `DIAR_MODEL.size`); no hashing.
  - `localMissing(s: { installed: boolean; hint?: string; diarization?: { verified: boolean } })`.

- [ ] **Step 1: Write failing tests**:
  - paths: `diarModel` is `<XDG_CACHE_HOME>/video-summary/models/nemotron-3-diarization-q8_0.gguf`.
  - install (extend `fixturePins` with `DIAR_MODEL` of small random bytes, serve it at `DIAR_MODEL.url`): the first test's expected result gains `diar_model: { path: paths().diarModel, bytes }`, `downloaded_bytes` includes it, `modelsDir` lists both files, `fetched` includes `DIAR_MODEL.url`; second run downloads 0.
  - `install: v0.4 machine (builds + ultra present) downloads only the diarization model` — `downloaded_bytes === diarBytes.length`, `fetched` is `[DIAR_MODEL.url]`.
  - `install: diarization model with wrong bytes -> UserError naming nemotron-3-diarization-q8_0.gguf, no final file`.
  - status: `diarization` is `{ present: false, verified: false, path }` before install and `{ true, true, path }` after; `installed` stays `true` with the diarization model missing.
  - deps: `localMissing({ installed: true, diarization: { verified: false } })` → one item `{ name: "diarization-model", install: "sh <skill-dir>/scripts/video-summary local install", needsSudo: false, note: "~0.1 GB download; enables speaker labels", optional: true }`; `installed: false` → only the `parakeet` item; verified → nothing.
- [ ] **Step 2: Run** `bun test test/local test/deps.test.ts` — FAIL.
- [ ] **Step 3: Implement**: pin + path; `localInstall` calls `ensureModel(d, paths.diarModel, pins.DIAR_MODEL)` after the main model; `localStatus` fills `diarization` via `diarModelReady(paths, pins.DIAR_MODEL.size)`; `hint` unchanged; `localMissing` adds the optional item; `cli.ts` `check` already passes the status object through.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat: install the pinned diarization model`.

### Task 3: Download retry with Range

**Files:**
- Modify: `src/local/install.ts` (`download`)
- Test: `test/local/install.test.ts`

**Interfaces:**
- Produces: `export const DOWNLOAD_RETRIES = 3`; `download` keeps its signature and error texts.

- [ ] **Step 1: Write failing tests** (a fetch fake that records request headers, errors the body stream after N bytes on the first response, and honours `Range` on the next):
  - `download: dropped connection resumes with Range, file verifies` — second request carries `Range: bytes=<N>-`, response `206` with the rest; model placed, `downloaded_bytes` equals the full size, no `.part` left.
  - `download: server answers 200 to Range -> restarts from zero, file verifies`.
  - `download: idle stall mid-body is retried` (`downloadIdleMs: 50`).
  - `download: connection error before headers is retried`.
  - `download: 4 failures in a row -> UserError "could not download <file>: <tag>", .part removed, 4 requests made`.
  - `download: HTTP 404 on a retry -> "could not download <file>: HTTP 404", no further requests`.
  - Existing tests (`wrong size`, `wrong bytes`, 404 on the first request) still pass without retries.
- [ ] **Step 2: Run** `bun test test/local/install.test.ts` — FAIL.
- [ ] **Step 3: Implement**: wrap request+read in a loop of at most `1 + DOWNLOAD_RETRIES` attempts; network/idle errors (`net(...)` rejections) retry, `UserError` from HTTP status or `mismatch` does not; on retry send `Range: bytes=${bytes}-` when `bytes > 0`; on `200` truncate the `.part` (`fh.truncate(0)`), reset `bytes` and the hash (new `createHash`), write from offset 0; on `206` keep appending. The idle `AbortController` is per attempt.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `fix: resume an interrupted local install download with Range`.

### Task 4: Pure diarization functions and speaker-aware cues

**Files:**
- Modify: `src/local/diarize.ts`, `src/local/parakeet.ts` (`Word`, `wordsToCues`)
- Create: `test/fixtures/parakeet-scene.jsonl`, `test/local/diarize.test.ts`
- Test: `test/local/parakeet.test.ts`

**Interfaces:**
- Produces (in `diarize.ts`):
  - `type Segment = { speaker: number; start: number; end: number }`
  - `parseScene(stdout: string): Segment[]` — throws `Error` on a non-JSON line or a malformed segment.
  - `assignSpeakers(words: Word[], segs: Segment[]): (number | null)[]`
  - `labelSpeakers(words: Word[], ids: (number | null)[]): { words: Word[]; speakers: number }` — `speakers` = distinct ids among words; with ≥ 2 each word gets `speaker: "Speaker N"` (first appearance order); with 1 or 0 words are returned without `speaker`.
- Produces (in `parakeet.ts`): `type Word = { w: string; start: number; end: number; speaker?: string }`; `wordsToCues` copies `speaker` to the cue and also starts a new cue when the speaker changes.

- [ ] **Step 1: Create the fixture** `test/fixtures/parakeet-scene.jsonl` (format of `scene --json`; segments match the words in `parakeet-words.json`):
  ```
  {"t":0.200,"utterances":[],"words":[],"speakers":[],"sounds":[],"active":{"speakers":[],"sounds":[]}}
  {"t":3.400,"utterances":[],"words":[],"speakers":[{"speaker":0,"start":0.000,"end":3.300}],"sounds":[],"active":{"speakers":[],"sounds":[]}}
  {"t":4.400,"utterances":[],"words":[],"speakers":[],"sounds":[],"active":{"speakers":[{"speaker":1,"start":4.300}],"sounds":[]}}

  {"t":33.200,"utterances":[],"words":[],"speakers":[{"speaker":1,"start":4.300,"end":33.000}],"sounds":[],"active":{"speakers":[],"sounds":[]}}
  {"t":40.312,"utterances":[],"words":[],"speakers":[{"speaker":0,"start":34.300,"end":40.300}],"sounds":[],"active":{"speakers":[],"sounds":[]}}
  ```
- [ ] **Step 2: Write failing tests** in `test/local/diarize.test.ts`:
  - `parseScene: collects closed segments of all events, skips empty lines` → `[{0,0,3.3},{1,4.3,33},{0,34.3,40.3}]`.
  - `parseScene: a non-JSON line or a segment without numeric start/end throws`.
  - `assignSpeakers`: max overlap wins (word 32.4–34.2 overlapping only speaker 1 → 1); tie → earlier segment; word 0.1 s after a segment end → that segment; word 1 s from every segment → previous word's speaker; leading words with no segment → first later labeled word; no segments → all `null`.
  - `labelSpeakers`: ids `[1,1,0]` → `Speaker 1, Speaker 1, Speaker 2`, `speakers: 2`; ids `[0,0]` → no `speaker` fields, `speakers: 1`; all `null` → `speakers: 0`; an id with no words is not counted.
  - fixture end-to-end: words of `parakeet-words.json` + fixture → `wordsToCues` gives 4 cues: `"Погнали, привет."` S1, `"Сегодня говорим про миграцию"` S1, `"и дальше … никак"` S2 (4.4–34.2), `"что думает чат?"` S1.
  - in `parakeet.test.ts`: `wordsToCues: speaker change starts a new cue even without a pause`; words without `speaker` give the same cues as before.
- [ ] **Step 3: Run** `bun test test/local` — FAIL.
- [ ] **Step 4: Implement** the functions above; tolerance constant `NEAREST_SEC = 0.5`, compared with the existing `EPS`. `diarize.ts` takes `Word` via `import type` from `parakeet.ts` (no runtime cycle).
- [ ] **Step 5: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 6: Commit** `feat: assign diarization speakers to recognized words`.

### Task 5: Second pass in `transcribeParakeet`

**Files:**
- Modify: `src/local/parakeet.ts`, `src/asr/types.ts` (`AsrResult`), `src/asr/select.ts` (`transcribeWith`)
- Test: `test/local/parakeet.test.ts` (extend the `machine` helper: the `cli` callback also gets `cmd`, so tests answer `transcribe` and `scene` differently; diarization model placed with `truncateSync(paths.diarModel, DIAR_MODEL.size)`)

**Interfaces:**
- Consumes: Task 2 `diarModelReady`, `LocalPaths.diarModel`; Task 4 `parseScene`, `assignSpeakers`, `labelSpeakers`.
- Produces:
  - `transcribeParakeet(ogg: string, p: LocalProvider, d: ParakeetDeps, o: { diarize: boolean }): Promise<AsrResult>`
  - `AsrResult.diarization?: { device: "gpu" | "cpu"; plannedDevice: "gpu" | "cpu"; elapsedMs: number; pathElapsedMs: number }`
  - `transcribeWith` passes `{ diarize: o.diarize && p.diarize }` for local.

Notes (`<p>` = provider name), verbatim:
- `<p>: speaker labels skipped — diarization model not installed, run \`local install\``
- `<p>: speaker labels skipped — diarization failed (<last stderr line>)`
- `<p>: speaker labels skipped — diarization timed out`
- `<p>: speaker labels skipped — unexpected parakeet-cli scene output`
- `<p>: speaker labels skipped — no speech segments found`
- `<p>: GPU diarization failed (<last stderr line>), used CPU`
- changed: `<p>: no GPU device found, ran on CPU — set "device": "cpu" for <p> to skip the GPU attempt`

- [ ] **Step 1: Write failing tests**:
  - `diarize: scene runs after transcribe on the same wav with --diar <diarModel> --input <wav> --json` (no `--model`, no `--threads`, `timeoutMs: LOCAL_TIMEOUT_MS`); fixture scene → cues with `Speaker 1/2`, `diarized: true`, `speakers: 2`, `diarization.device === "gpu"`.
  - `diarize: one speaker -> no labels, diarized true, speakers 1`.
  - `diarize: transcribe fell back to CPU (GPU failed) -> scene runs only on the CPU build`.
  - `diarize: Vulkan found no device -> scene runs on the CPU build; note has the device hint`.
  - `diarize: GPU scene fails, CPU scene succeeds -> labels, note "GPU diarization failed (…), used CPU", diarization.device cpu, plannedDevice gpu`.
  - `diarize: darwin arm64 GPU scene fails -> retry is the Metal build with PARAKEET_DEVICE=cpu`.
  - `diarize: scene fails on CPU / times out (code 124) / prints garbage / only empty events` → transcript cues without labels, `diarized: false`, `speakers: 0`, the matching note; GPU timeout is not retried on CPU.
  - `diarize: off (o.diarize false) or model missing -> scene never runs`; missing model adds its note, `o.diarize false` adds none.
  - Update the existing "no GPU device found" expectation in `parakeet.test.ts` and `fetch-cmd.test.ts` to the new text.
- [ ] **Step 2: Run** `bun test test/local/parakeet.test.ts` — FAIL.
- [ ] **Step 3: Implement**: extract the existing "run on build, time it" closure so both passes share it; after a successful `transcribe`, if `o.diarize` — model not ready → note; else run `scene` on the build matching the device step 1 actually used (`device === "gpu" ? gpuBuild : cpuBuild` with `PARAKEET_DEVICE=cpu` when the CPU build is a GPU build), GPU failure → one CPU retry, code 124 → timed-out note without retry; parse/assign/label inside a `try` that turns any error into the "unexpected output" note. The wav is removed in the existing `finally` after both passes.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat: label speakers in local recognition`.

### Task 6: whisperx — one speaker without labels

**Files:**
- Modify: `src/asr/whisperx.ts` (`parseWhisperx`)
- Test: `test/asr/whisperx.test.ts`

- [ ] **Step 1: Write failing test** `parseWhisperx: a single speaker -> cues without speaker, diarized true, speakers 1`; the existing two-speaker test is unchanged.
- [ ] **Step 2: Run** `bun test test/asr/whisperx.test.ts` — FAIL.
- [ ] **Step 3: Implement**: after mapping, if `names.size === 1` drop `speaker` from cues.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `fix: no speaker labels on a whisperx transcript with one speaker`.

### Task 7: Slow-run gate and speed store count both passes

**Files:**
- Modify: `src/local/speed.ts`, `src/asr/select.ts` (`SlowEstimate`, `reject`), `src/fetch-cmd.ts` (`recognize`)
- Test: `test/local/speed.test.ts`, `test/asr/select.test.ts`, `test/fetch-cmd.test.ts`

**Interfaces:**
- Consumes: Task 2 `LocalStatus.diarization`; Task 5 `AsrResult.diarization`.
- Produces:
  - `diarSpeedKey(device: "gpu" | "cpu"): string` → `parakeet:diar:<device>`
  - `estimateLocal(p, durationSec, speeds, plannedDevice, diarize: boolean): SlowEstimate`
  - `SlowEstimate = { minutes: number; device: "gpu" | "cpu"; speed: number; withoutDiarization?: number }` — `minutes` includes diarization when `diarize`; `withoutDiarization` set only then; `speed` stays the recognition speed.

Gate texts (`reject`), verbatim, `~N` = `Math.ceil`:
- with diarization, `withoutDiarization ≤ 10`: `~<N> min on <CPU|GPU> with speaker labels (~<M> without); add --accept-slow to wait, or --no-diarize to skip speaker labels`
- with diarization, both over 10: `~<N> min on <CPU|GPU> with speaker labels (~<M> without); add --accept-slow to wait`
- without diarization: unchanged.

- [ ] **Step 1: Write failing tests**:
  - speed: `diarSpeedKey("cpu") === "parakeet:diar:cpu"`; `estimateLocal(..., true)` with nothing measured on CPU for 5400 s → `minutes = 5400/8/60 + 5400/16/60`, `withoutDiarization = 5400/8/60`; GPU defaults 60/100; measured `parakeet:diar:cpu` is used; `diarize: false` → as before, no `withoutDiarization`.
  - select: the two new texts (e.g. `minutes 16.9, withoutDiarization 9.4` → `~17 min on CPU with speaker labels (~10 without); add --accept-slow to wait, or --no-diarize to skip speaker labels`; `25 / 18` → the short form).
  - fetch: `90-min video, local with the diarization model, CPU default speeds -> gate text with both numbers`; `--no-diarize` → the v0.4 text; model missing → the v0.4 text.
  - fetch: `diarization speed recorded under parakeet:diar:<device>`; planned GPU, diarization on CPU → also `parakeet:diar:gpu` from `pathElapsedMs`.
- [ ] **Step 2: Run** `bun test test/local/speed.test.ts test/asr/select.test.ts test/fetch-cmd.test.ts` — FAIL.
- [ ] **Step 3: Implement**: `DEFAULT_DIAR_SPEED = { cpu: 16, gpu: 100 }`; in `recognize` the estimate closure passes `flags.diarize && p.diarize && local.diarization.verified`; after a local success record `asr.diarization` like the recognition speed (`noteSpeed`).
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat: slow-run gate counts the diarization pass`.

### Task 8: Config warnings in `fetch` output

**Files:**
- Modify: `src/cli.ts` (`fetch` case, `requireConfig`), `src/fetch-cmd.ts` (`FetchDeps`, `FetchResult`, `fetchCmd`)
- Test: `test/fetch-cmd.test.ts` (passthrough, both return paths), `test/cli.test.ts` (the `fetch` case collects `loadConfig` warnings)

**Interfaces:**
- Produces: `requireConfig(path: string, warnings?: string[])`; `FetchDeps.warnings?: string[]`; `FetchResult.warnings?: string[]` — present only when non-empty, also on the early "text already exists" return.

- [ ] **Step 1: Write failing tests**: a v0.3-style config (openai-compatible without `local`) → `fetch` result has `warnings: ['providers[0] "<name>": now treated as your own server — local files are sent to it without asking']`; a clean config → no `warnings` key; second `fetch` (early return) still carries them.
- [ ] **Step 2: Run** the test — FAIL.
- [ ] **Step 3: Implement**: collect into an array in the `fetch` case, pass through `FetchDeps`, attach in `fetchCmd` on both return paths.
- [ ] **Step 4: Run** `bun test && bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `fix: show config warnings in fetch output`.

### Task 9: Docs and bundle

**Files:**
- Modify: `README.md`, `skills/video-summary/SKILL.md`, `skills/video-summary/references/providers.md`, `skills/video-summary/references/setup.md`, `skills/video-summary/references/summary-template.md`, `skills/video-summary/scripts/video-summary.mjs` (rebuilt)

- [ ] **Step 1: Edit docs** per the spec's "Документация" section: local labels speakers (up to 8; one speaker → no labels; `diarize` key and `--no-diarize`); whisperx stays an equal second path with speaker labels; install size (~0.9 GB + ~0.1 GB; ~0.1 GB when upgrading); README License: Nemotron-3-Diarization by NVIDIA, [OpenMDW 1.1](https://openmdw.ai/license/1-1/), GGUF conversion mudler/parakeet-cpp-gguf, downloaded by `local install`, not in the repo; SKILL.md: drop "the local provider never labels speakers", `--no-diarize` when one person speaks or to go faster on CPU, relay `warnings`, relay "speaker labels skipped …" notes in one sentence, on a two-number gate refusal ask whether to wait or skip labels, optional `diarization-model` item in `check`; summary template: "Participants" only when `speakers ≥ 2`.
- [ ] **Step 2: Rebuild** `bun run build`, then `bun run check:bun-free` — PASS.
- [ ] **Step 3: Check** `bun test && bunx tsc --noEmit` — PASS; `git grep -nE 'dpet|/home/' -- README.md skills docs/superpowers/plans/2026-10-09-local-diarization.md` — nothing.
- [ ] **Step 4: Commit** `docs: local speaker labels` and `build: rebuild the bundle` (two commits).

### Task 10: Manual acceptance on the real engine (orchestrator, not a subagent)

Throwaway scripts and audio live in the session scratchpad, never in the repo.

- [ ] `local install` from the bundle on this machine (v0.4 layout) → downloads only the diarization model (~108 MB), `local status` shows `diarization.verified: true`.
- [ ] `fetch` the 525 s two-speaker video used in the design probe (whisperx reference exists in the user's output dir) with the bundle → `diarized: true`, `speakers: 2`; word-level agreement with the whisperx transcript computed by a scratch script; report the number.
- [ ] A monologue video → no labels, `speakers: 1`.
- [ ] `--no-diarize` and `"diarize": false` → no `scene` run (no `parakeet:diar:*` key update), `diarized: false`.
- [ ] `"device": "cpu"` → both passes on CPU; `speed.json` gains `parakeet:diar:cpu`.
- [ ] A long video without `--accept-slow` on CPU → refusal text with both numbers.
- [ ] macOS (Metal) — handed to the repository owner.
