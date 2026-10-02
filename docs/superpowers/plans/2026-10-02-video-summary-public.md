# video-summary (public skill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Публичный скилл `video-summary` (Agent Skills / `npx skills add danpetrv/video-summary`): конфиг пользователя, провайдеры ASR списком (whisperx, Groq, OpenAI, свой OpenAI-совместимый), опциональные автосубтитры и Readeck, рантайм Bun или Node ≥ 20.

**Architecture:** Перенос проверенного предшественника (the author's personal skill (private), 95 тестов) в этот репозиторий: `src/` на API Node, тесты на `bun test`, собранный одним файлом бандл `skills/video-summary/scripts/video-summary.mjs` + sh-лаунчер выбирают рантайм. Зашитые адреса уходят в `~/.config/video-summary/config.json`, который агент заполняет при первом запуске.

**Tech Stack:** TypeScript (API Node 20+), Bun 1.4 (тесты, сборка `bun build --target=node`), `marked` (вшивается в бандл), yt-dlp, ffmpeg/ffprobe, whisperx-asr-service, OpenAI-совместимый `/v1/audio/transcriptions`, Readeck 0.23 API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-video-summary-public-design.md` (в этом репозитории).

**Предшественник (источник переноса):** the author's personal skill (private), его каталог `scripts/` — ниже `P/`. «Перенести из P/x.ts» = скопировать файл и тесты, затем внести перечисленные правки. Тесты предшественника переезжают в `test/`, фикстуры — в `test/fixtures/`, импорты — `../src/…`.

## Global Constraints

- В `src/` запрещён `Bun.*` (проверяется скриптом `check:bun-free` и в CI); только `node:*` и глобальные `fetch`/`FormData`/`Blob`. В `test/` Bun-API допустимы (тесты гоняет `bun test`).
- Файл для FormData — `openAsBlob(path)` из `node:fs` (проверено: работает в Bun 1.4 и Node 24).
- Все строки, которые печатает CLI (ошибки, подсказки, `reason`), — **на английском**; пользователю их переводит агент. Транскрипт размечает говорящих как `Speaker N` независимо от языка; в конспекте агент пишет на языке конспекта.
- Ошибка CLI: код 1, одна строка в stderr (`UserError.message`). Успех: JSON в stdout, код 0. Ключи и содержимое key-файлов не попадают ни в какой вывод.
- Конфиг: `$VIDEO_SUMMARY_CONFIG`, иначе `${XDG_CONFIG_HOME:-~/.config}/video-summary/config.json`; JSON с отступом 2 и `\n` в конце.
- yt-dlp всегда с `--js-runtimes node --js-runtimes bun --no-playlist` (deno остаётся включённым по умолчанию); сжатие `ffmpeg -nostdin -loglevel error -y -i <src> -vn -ac 1 -ar 16000 -c:a libopus -b:a <kbps>k -f ogg <out>.tmp` → rename.
- Лимиты файлов — десятичные байты (25 МБ = `25_000_000`). Адаптивная цель — 96% наименьшего `maxBytes` среди облачных провайдеров.
- Таймауты: `/health` и `/models` — 5 с; ASR — 30 мин; каждый вызов Readeck — 15 с.
- Пресеты (точные значения):
  - `groq` free: `https://api.groq.com/openai/v1`, `whisper-large-v3-turbo`, `verbose_json`, `maxBytes 25_000_000`, `maxSeconds 7000`;
  - `groq` dev: то же, `maxBytes 100_000_000`, `maxSeconds null`;
  - `openai`: `https://api.openai.com/v1`, `whisper-1`, `verbose_json`, `maxBytes 25_000_000`, `maxSeconds null`;
  - `openai` + `diarize: true`: `gpt-4o-transcribe-diarize`, `diarized_json`, `chunking_strategy=auto`.

## Review Focus

1. Конфиг, которого нет или который сломан руками (лишняя запятая, неизвестный `preset`, `providers` не массив) → понятная ошибка с путём к полю, а не стектрейс; `check` при этом всё равно отвечает JSON. → тесты в Task 2 и Task 9.
2. Ни одного провайдера в конфиге и выключенные автосубтитры, видео без ручных субтитров → ошибка, которая говорит «нет провайдеров — настрой» , а не «нет подходящего». → Task 6.
3. Пользователь с одним Node 18 (или без node и bun) → лаунчер отвечает JSON с вариантами установки, а не падает синтаксической ошибкой бандла. → Task 3.
4. Ключ задан переменной окружения, которой нет в окружении агента (export в `.zshrc`, агент в неинтерактивной оболочке) → в ошибке видно имя переменной, а не «no API key». → Task 2 и Task 6.
5. Повторный запуск после смены конфига (было `fixed`, стало `adaptive`; другой провайдер) с готовым `.work/audio.ogg` → ogg больше лимита нового провайдера пережимается. → Task 7.

---

### Task 1: Каркас репозитория и перенос чистых модулей

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `scripts/check-bun-free.sh`
- Create (перенос): `src/types.ts`, `src/captions.ts`, `src/paths.ts`, `src/meta.ts` из `P/`
- Test (перенос + новые): `test/captions.test.ts`, `test/paths.test.ts`, `test/meta.test.ts`; `test/fixtures/{manual.en.vtt,sample.ru.srt}`

**Interfaces:**
- Produces: `Cue`, `Paragraph`, `Runner`, `RunResult`, `Fetcher`, `Platform`, `UserError` (`src/types.ts`, как в `P/types.ts`); `parseVtt`, `parseSrt`, `cleanCues`, `toParagraphs`, `formatTs`, `renderTranscript` (как в `P/captions.ts`); `slugify`, `resolveInputPath`, `resolveItemDir` (как в `P/paths.ts`); `findSidecarSubs(absFile: string, preferLang?: string | null): Promise<string | null>`; `Meta`, `Source`, `readMeta`, `writeMeta`, `estimateTokens`.
- `Source = "youtube-manual-subs" | "manual-subs" | "youtube-auto-subs" | "sidecar-subs" | "asr"`; в `Meta` поле `asr_backend` заменяется на `asr_provider: string | null` (имя провайдера из конфига).

- [ ] **Step 1: Каркас.** `package.json`: `{"name":"video-summary","private":true,"type":"module","scripts":{"test":"bun test","build":"bun build src/cli.ts --target=node --format=esm --outfile skills/video-summary/scripts/video-summary.mjs","check:bun-free":"sh scripts/check-bun-free.sh"}}`; `bun add -d marked typescript @types/node @types/bun`. `tsconfig.json`: strict, `noEmit`, `module`/`moduleResolution` `bundler`, `types: ["node","bun"]`. `.gitignore`: `node_modules/`. `LICENSE`: MIT, `Copyright (c) 2026 danpetrv`. `scripts/check-bun-free.sh`: `grep -rnE '\bBun\.' src && { echo "Bun API in src/"; exit 1; } || exit 0`.
- [ ] **Step 2: Перенести модули и тесты** `types`, `captions`, `paths`, `meta` с фикстурами; в `src/` заменить `Bun.file/Bun.write` на `node:fs/promises` (`readFile`, `writeFile`, `access`). `bun test` → все перенесённые тесты зелёные; `bun run check:bun-free` → 0.
- [ ] **Step 3: Новые падающие тесты (правки из спека, «отложенные мелочи» 3, 7, 8, 13)**

```ts
test("parseSrt: строка из пробелов тоже разделяет блоки", () => {
  expect(parseSrt("1\n00:00:01,000 --> 00:00:02,000\nhello\n \n2\n00:00:03,000 --> 00:00:04,000\nworld\n").map((c) => c.text))
    .toEqual(["hello", "world"]);
});
test("cleanCues: удаляет только известные теги, a<b and c>d не трогает", () => {
  expect(cleanCues([{ start: 0, end: 1, text: "<v Bob><i>if</i> a<b and c>d <00:00:01.000>then</v>" }])[0]!.text)
    .toBe("if a<b and c>d then");
});
test("slugify: комбинирующие знаки сохраняются, длина режется по кодпоинтам", () => {
  expect(slugify("हिन्दी समाचार")).toBe("हिन्दी-समाचार");
  expect([...slugify("😀a".repeat(40))].length).toBeLessThanOrEqual(60);
});
test("findSidecarSubs: из нескольких языков берётся preferLang", async () => {
  // a.mp4 + a.en.srt + a.ru.srt: preferLang "ru" → a.ru.srt; null → a.en.srt (первый по алфавиту)
});
test("Meta: asr_provider вместо asr_backend (round-trip)", async () => {});
```

- [ ] **Step 4: Запустить — падают** на новых тестах.
- [ ] **Step 5: Реализовать.** Разделитель блоков `/\n[ \t]*\n/`; теги — `/<\/?(?:c|i|b|u|v|lang|ruby|rt)(?:[.\s][^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/g`; slug — `[^\p{L}\p{M}\p{N}]+` → `-`, обрезка `Array.from(s).slice(0, 60).join("")`; sidecar — среди языковых кандидатов сначала тот, чей код (основной подтег) равен `preferLang`.
- [ ] **Step 6: `bun test` зелёный, `check:bun-free` → 0.**
- [ ] **Step 7: Commit** — `feat: scaffold and port captions/paths/meta from personal skill`.

---

### Task 2: Конфиг, пресеты, лимиты

**Files:**
- Create: `src/config.ts`, `src/asr/presets.ts`, `src/limits.ts`
- Test: `test/config.test.ts`, `test/presets.test.ts`, `test/limits.test.ts`

**Interfaces:**
- Produces (`config.ts`):
  ```ts
  export type KeyRef = { keyFile?: string | null; keyEnv?: string | null };
  export type ProviderConfig = KeyRef & { name: string; type: "whisperx" | "openai-compatible"; preset?: "groq" | "openai";
    tier?: "free" | "dev"; url?: string; model?: string; diarize?: boolean; local?: boolean;
    maxBytes?: number | null; maxSeconds?: number | null };
  export type ReadeckConfig = KeyRef & { url: string; label?: string };
  export type Config = { outputDir: string; summaryLanguage: string; subtitles: "manual" | "manual+auto";
    bitrate: "adaptive" | "fixed"; providers: ProviderConfig[]; readeck: ReadeckConfig | null };
  export const DEFAULT_CONFIG: Config;
  export function configPath(env: Record<string, string | undefined>, home: string): string;
  export function expandHome(p: string, home: string): string;
  export function parseConfig(raw: unknown): Config;                       // UserError "config: <path>: <problem>"
  export function loadConfig(path: string): Promise<Config | null>;        // null — файла нет
  export function saveConfig(path: string, cfg: Config): Promise<void>;    // mkdir -p
  export function setValue(cfg: Config, key: string, value: unknown): Config; // dotted key, результат проходит parseConfig
  export function keySource(ref: KeyRef): string | null;                   // "env OPENAI_API_KEY" | "file ~/x.key" | null
  export function readKey(ref: KeyRef, env: Record<string, string | undefined>, home: string): Promise<string | null>;
  ```
- Produces (`asr/presets.ts`):
  ```ts
  export type ResolvedProvider = { name: string; type: "whisperx" | "openai-compatible"; url: string; model: string | null;
    format: "verbose_json" | "diarized_json" | null; diarize: boolean; local: boolean;
    maxBytes: number | null; maxSeconds: number | null; keyRequired: boolean; keyFile: string | null; keyEnv: string | null };
  export function resolveProvider(p: ProviderConfig): ResolvedProvider;    // UserError при нехватке url/model
  ```
- Produces (`limits.ts`):
  ```ts
  export function targetBytes(ps: ResolvedProvider[]): number | null;      // 0.96 × min(maxBytes) среди !local; нет — null
  export function bitrateFor(durationSec: number | null, mode: "adaptive" | "fixed", target: number | null): number;
  export function maxDurationFor(p: ResolvedProvider, kbps: number): number | null; // min(maxSeconds, maxBytes·8/(kbps·1000))
  export type LimitRow = { provider: string; adaptiveSec: number | null; fixedSec: number | null };
  export function limitsReport(ps: ResolvedProvider[]): LimitRow[];        // adaptive = при 16 kbps, fixed = при 32
  ```

- [ ] **Step 1: Тесты**

```ts
test("configPath: VIDEO_SUMMARY_CONFIG > XDG_CONFIG_HOME > ~/.config", () => {
  expect(configPath({ VIDEO_SUMMARY_CONFIG: "/c.json" }, "/h")).toBe("/c.json");
  expect(configPath({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/video-summary/config.json");
  expect(configPath({}, "/h")).toBe("/h/.config/video-summary/config.json");
});
test("DEFAULT_CONFIG", () => {
  expect(DEFAULT_CONFIG).toEqual({ outputDir: "~/Documents/video-summaries", summaryLanguage: "auto", subtitles: "manual",
    bitrate: "adaptive", providers: [], readeck: null });
});
test("parseConfig: недостающие поля добиваются умолчаниями", () => {});
test("parseConfig: ошибки с путём к полю", () => {
  expect(() => parseConfig({ providers: {} })).toThrow("config: providers: must be an array");
  expect(() => parseConfig({ providers: [{ name: "x", type: "openai-compatible", preset: "foo" }] }))
    .toThrow('config: providers[0].preset: unknown preset "foo" (groq, openai)');
  expect(() => parseConfig({ bitrate: "fast" })).toThrow('config: bitrate: must be "adaptive" or "fixed"');
  expect(() => parseConfig({ providers: [{ name: "a", type: "whisperx", url: "u" }, { name: "a", type: "whisperx", url: "v" }] }))
    .toThrow('config: providers[1].name: duplicate "a"');
});
test("loadConfig: нет файла → null; битый JSON → UserError с путём к файлу", async () => {});
test("setValue: вложенный ключ readeck.url, providers целиком, неизвестный ключ → UserError", () => {});
test("readKey: keyFile с ~ и trim; keyEnv; ни того ни другого → null; keySource для сообщений", async () => {});

test("resolveProvider: пресеты", () => {
  expect(resolveProvider({ name: "g", type: "openai-compatible", preset: "groq", tier: "free" })).toMatchObject({
    url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", format: "verbose_json",
    maxBytes: 25_000_000, maxSeconds: 7000, local: false, keyRequired: true, diarize: false });
  expect(resolveProvider({ name: "g", type: "openai-compatible", preset: "groq", tier: "dev" }))
    .toMatchObject({ maxBytes: 100_000_000, maxSeconds: null });
  expect(resolveProvider({ name: "o", type: "openai-compatible", preset: "openai" }))
    .toMatchObject({ url: "https://api.openai.com/v1", model: "whisper-1", format: "verbose_json", diarize: false });
  expect(resolveProvider({ name: "o", type: "openai-compatible", preset: "openai", diarize: true }))
    .toMatchObject({ model: "gpt-4o-transcribe-diarize", format: "diarized_json", diarize: true });
  expect(resolveProvider({ name: "w", type: "whisperx", url: "https://a/" }))
    .toMatchObject({ url: "https://a", diarize: true, local: true, keyRequired: false, maxBytes: null, format: null });
  expect(resolveProvider({ name: "l", type: "openai-compatible", url: "http://l/v1", model: "m", local: true, maxBytes: 5 }))
    .toMatchObject({ local: true, maxBytes: 5, keyRequired: false, format: "verbose_json" });
  expect(() => resolveProvider({ name: "l", type: "openai-compatible", url: "http://l/v1" }))
    .toThrow("config: provider l: model is required without preset");
});

test("bitrateFor", () => {
  expect(bitrateFor(6805, "adaptive", 24_000_000)).toBe(28);
  expect(bitrateFor(600, "adaptive", 24_000_000)).toBe(32);
  expect(bitrateFor(50_000, "adaptive", 24_000_000)).toBe(16);
  expect(bitrateFor(6805, "adaptive", null)).toBe(32);
  expect(bitrateFor(null, "adaptive", 24_000_000)).toBe(32);
  expect(bitrateFor(6805, "fixed", 24_000_000)).toBe(32);
});
test("targetBytes: 96% от наименьшего облачного лимита; локальные не считаются", () => {});
test("limitsReport: Groq free → adaptive 7000, fixed 6250; whisperx → null/null", () => {});
```

- [ ] **Step 2: Запустить — падают.**
- [ ] **Step 3: Реализовать.** `parseConfig` проверяет каждое поле вручную (без библиотек), неизвестные ключи верхнего уровня → ошибка. `whisperx` и `openai-compatible` без пресета требуют `url`; `url` без завершающего `/`.
- [ ] **Step 4: Тесты зелёные, `check:bun-free` → 0.**
- [ ] **Step 5: Commit** — `feat: config file, provider presets and size/duration limits`.

---

### Task 3: exec, зависимости, лаунчер

**Files:**
- Create: `src/exec.ts`, `src/deps.ts`, `skills/video-summary/scripts/video-summary` (sh)
- Test: `test/deps.test.ts`, `test/launcher.test.ts`

**Interfaces:**
- Produces (`exec.ts`): `export const run: Runner` — `node:child_process` `spawn`, stdin `ignore`; ENOENT → `{ code: 127, stdout: "", stderr }`.
- Produces (`deps.ts`):
  ```ts
  export type DepName = "yt-dlp" | "yt-dlp-ejs" | "ffmpeg" | "ffprobe";
  export type DepStatus = { name: DepName; found: boolean; version: string | null };
  export type DepsReport = { ok: boolean; platform: Platform; runtime: { name: "bun" | "node"; version: string };
    missing: { name: DepName; install: string; needsSudo: boolean }[];
    stale: { name: "yt-dlp"; version: string; ageDays: number; upgrade: string }[] };
  export function probeDeps(run: Runner): Promise<DepStatus[]>;
  export function buildReport(s: DepStatus[], platform: Platform, runtime: DepsReport["runtime"], today: Date,
    has: (bin: string) => boolean): DepsReport;
  ```

- [ ] **Step 1: Тесты `deps.test.ts`** — перенести из `P/deps.test.ts` (yt-dlp/ffmpeg/ffprobe/stale/патч-суффикс) и добавить:

```ts
test("yt-dlp-ejs: из строки «Optional libraries» вывода `yt-dlp -v --simulate`", async () => {
  // фейковый Runner: stderr "[debug] Optional libraries: certifi-1, yt_dlp_ejs-0.8.0, urllib3-2" → found, "0.8.0"
  // без yt_dlp_ejs → found:false
});
test("установка yt-dlp: uv, иначе pipx, иначе brew (darwin)", () => {
  // has("uv") → 'uv tool install "yt-dlp[default]"'; только pipx → 'pipx install "yt-dlp[default]"';
  // darwin без uv/pipx → "brew install yt-dlp"; linux без uv/pipx → 'sudo apt install pipx && pipx install "yt-dlp[default]"' (needsSudo; pip --user упирается в PEP 668)
});
test("yt-dlp-ejs отсутствует при наличии yt-dlp → install «<менеджер> … yt-dlp[default]» (переустановка с extra)", () => {});
test("ffmpeg: darwin brew, linux sudo apt (needsSudo), ffprobe не дублирует", () => {});
test("stale: upgrade под менеджер, которым ставили (uv tool upgrade yt-dlp / pipx upgrade yt-dlp / brew upgrade yt-dlp)", () => {});
test("runtime попадает в отчёт как есть", () => {});
```

- [ ] **Step 2: Тесты `launcher.test.ts`** — через подставной `PATH` с фейковыми бинарями (sh-скрипты в tmp-каталоге), запуск `sh skills/video-summary/scripts/video-summary check` с `env: { PATH: fakeDir }` (+ `/usr/bin:/bin` для `sh`, `sed`, `head`):

```ts
test("bun в PATH → exec bun <dir>/video-summary.mjs check", () => {});          // фейковый bun печатает свои argv
test("нет bun, node v22.3.0 → exec node …mjs", () => {});
test("нет bun, node v18.20.0 → JSON {ok:false, runtime:'unsupported', found:'node v18.20.0', install:[…]}, код 1", () => {});
test("ни bun, ни node → JSON {ok:false, runtime:'missing', install:[…]}, код 1", () => {});
```

- [ ] **Step 3: Запустить — падают.**
- [ ] **Step 4: Реализовать** `exec.ts`, `deps.ts` (`probeDeps`: `yt-dlp --version`, `yt-dlp -v --simulate` для ejs, `ffmpeg -version`, `ffprobe -version`), лаунчер:

```sh
#!/bin/sh
# Pick a runtime: bun if present, else node >= 20.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v bun >/dev/null 2>&1; then exec bun "$dir/video-summary.mjs" "$@"; fi
if command -v node >/dev/null 2>&1; then
  v=$(node -v); major=$(printf %s "$v" | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$major" -ge 20 ] 2>/dev/null; then exec node "$dir/video-summary.mjs" "$@"; fi
  printf '{"ok":false,"runtime":"unsupported","found":"node %s","install":%s}\n' "$v" "$INSTALL"; exit 1
fi
printf '{"ok":false,"runtime":"missing","install":%s}\n' "$INSTALL"; exit 1
```
  где `INSTALL` — JSON-массив, заданный в скрипте выше проверок: `["curl -fsSL https://bun.sh/install | bash","brew install oven-sh/bun/bun","brew install node","fnm install --lts"]`.
- [ ] **Step 5: Тесты зелёные; живьём:** `bun -e` с настоящим `run` → `probeDeps` на этой машине: все `found`, `yt-dlp-ejs` `0.8.0`.
- [ ] **Step 6: Commit** — `feat: runtime launcher, dependency check incl. yt-dlp-ejs`.

---

### Task 4: yt-dlp и автосубтитры

**Files:**
- Create (перенос): `src/ytdlp.ts` из `P/ytdlp.ts`; Modify: `src/captions.ts` (+`dedupeRolling`)
- Test: `test/ytdlp.test.ts` (перенос + новые), `test/captions.test.ts`; `test/fixtures/ytdlp-meta.json` (перенос), `test/fixtures/auto.en.vtt` (новая)

**Interfaces:**
- Consumes: `Runner`, `UserError`, `Cue`.
- Produces:
  ```ts
  export const YTDLP_BASE: string[];                  // как в P
  export type VideoMeta = /* как в P */ & { automatic_captions: Record<string, unknown[]> };
  export function fetchMeta(url: string, run: Runner): Promise<VideoMeta>;   // + "--flat-playlist"
  export function pickManualTrack(m: VideoMeta): string | null;              // как в P
  export function pickAutoTrack(m: VideoMeta): string | null;               // "<lang>-orig" если есть, иначе "<lang>"; language null → null
  export function downloadSubs(url: string, lang: string, workDir: string, run: Runner, auto?: boolean): Promise<string>;
  export function downloadAudio(url: string, workDir: string, run: Runner): Promise<string>; // -o <work>/src.%(ext)s
  export function dedupeRolling(cues: Cue[]): Cue[];  // в captions.ts
  ```

- [ ] **Step 1: Фикстура `auto.en.vtt`** — реальные автосубтитры: `yt-dlp --js-runtimes node --js-runtimes bun --no-playlist --skip-download --write-auto-subs --sub-langs 'en-orig,en' --sub-format vtt -o '/tmp/auto.%(ext)s' 'https://www.youtube.com/watch?v=jNQXAC9IVRw'`; если дорожки нет — взять любое англоязычное видео без ручных субтитров (проверить `automatic_captions` в `--dump-single-json`). Оставить первые ~30 реплик.
- [ ] **Step 2: Тесты**

```ts
test("pickAutoTrack: en-orig предпочтительнее en; язык неизвестен → null; дорожки нет → null", () => {});
test("downloadSubs auto: --write-auto-subs вместо --write-subs", async () => {});
test("downloadAudio: -f bestaudio/best -o <work>/src.%(ext)s, возвращает src.*", async () => {});
test("fetchMeta: argv содержит --flat-playlist", async () => {});
test("dedupeRolling: «бегущие» строки склеиваются без повторов", () => {
  expect(dedupeRolling([
    { start: 0, end: 2, text: "hello there" },
    { start: 2, end: 4, text: "hello there my friend" },
    { start: 4, end: 6, text: "my friend how are you" },
  ]).map((c) => c.text)).toEqual(["hello there", "my friend", "how are you"]);
});
test("dedupeRolling на реальной auto.en.vtt: ни одна реплика не начинается с хвоста предыдущей, текст не теряется", () => {
  // склеенный текст после dedupe содержит каждое слово исходника в том же порядке (подпоследовательность)
});
```

- [ ] **Step 3: Запустить — падают.**
- [ ] **Step 4: Реализовать.** `dedupeRolling`: для каждой реплики найти самый длинный суффикс предыдущей **исходной** реплики, который является префиксом текущей (по словам), и отрезать его; пустые после этого — выбросить.
- [ ] **Step 5: Тесты зелёные; живьём** `fetchMeta` + `downloadSubs(…, auto=true)` на видео из Step 1.
- [ ] **Step 6: Commit** — `feat: yt-dlp port with optional auto-captions and rolling-line dedupe`.

---

### Task 5: Аудио

**Files:**
- Create (перенос): `src/audio.ts` из `P/audio.ts`
- Test: `test/audio.test.ts` (перенос)

**Interfaces:**
- Produces: `compressAudio(input: string, outOgg: string, run: Runner, kbps?: number): Promise<void>` (атомарно, как в P); `probeDuration(file: string, run: Runner): Promise<number>`. `bitrateFor` теперь в `limits.ts` (Task 2) — из `audio.ts` убрать.

- [ ] **Step 1: Перенести тесты** (argv с `-f ogg <out>.tmp`, обрыв → нет ни `.tmp`, ни итога, `probeDuration`); тесты на `bitrateFor` из P не переносить (их заменил Task 2).
- [ ] **Step 2: Запустить — падают** (модуля нет).
- [ ] **Step 3: Перенести реализацию** на `node:fs/promises` (`rename`, `rm`).
- [ ] **Step 4: Тесты зелёные; живьём** `compressAudio` на скачанном в Task 4 аудио с `kbps=28` → `.ogg` есть, `.tmp` нет.
- [ ] **Step 5: Commit** — `feat: atomic audio compression`.

---

### Task 6: Провайдеры ASR и выбор

**Files:**
- Create: `src/asr/types.ts`, `src/asr/whisperx.ts` (перенос P), `src/asr/openai-compatible.ts`, `src/asr/select.ts`
- Test: `test/asr/whisperx.test.ts` (перенос), `test/asr/openai-compatible.test.ts`, `test/asr/select.test.ts`; `test/fixtures/{whisperx-diarized.json,groq-verbose.json}` (перенос), `test/fixtures/openai-diarized.json` (новая)

**Interfaces:**
- Consumes: `ResolvedProvider`, `readKey`, `keySource` (Task 2), `Cue`, `Fetcher`, `UserError`.
- Produces:
  ```ts
  // asr/types.ts
  export type AsrOptions = { language: string | null; diarize: boolean };
  export type AsrResult = { cues: Cue[]; provider: string; diarized: boolean; speakers: number; language: string | null };
  // asr/whisperx.ts
  export function whisperxHealthy(url: string, f: Fetcher, key: string | null): Promise<boolean>;
  export function transcribeWhisperx(file: string, o: AsrOptions, p: ResolvedProvider, key: string | null, f: Fetcher): Promise<AsrResult>;
  export function parseWhisperx(json: unknown, provider: string): AsrResult;   // SPEAKER_xx → "Speaker N"
  // asr/openai-compatible.ts
  export function modelsReachable(url: string, f: Fetcher, key: string | null): Promise<boolean>;  // GET {url}/models, 5 с
  export function transcribeOpenAI(file: string, o: AsrOptions, p: ResolvedProvider, key: string | null, f: Fetcher): Promise<AsrResult>;
  export function parseVerbose(json: unknown, provider: string): AsrResult;
  export function parseDiarized(json: unknown, provider: string): AsrResult;   // speaker "A","B" → "Speaker 1","Speaker 2"
  // asr/select.ts
  export type Candidate = { provider: ResolvedProvider; available: boolean; keyMissing: string | null }; // keyMissing = keySource или "no key configured"
  export function probeProviders(ps: ResolvedProvider[], f: Fetcher, env: Record<string, string | undefined>, home: string): Promise<Candidate[]>;
  export type SelectInput = { candidates: Candidate[]; durationSec: number; kbps: number; privateSource: boolean; allowCloud: boolean };
  export function chooseProvider(i: SelectInput): { provider: ResolvedProvider } | { error: string };
  export function transcribeWith(p: ResolvedProvider, file: string, o: AsrOptions, f: Fetcher, env: Record<string, string | undefined>, home: string): Promise<AsrResult>;
  ```

- [ ] **Step 1: Фикстура `openai-diarized.json`** по форме из документации OpenAI: `{"text": …, "segments": [{"type":"transcript.text.segment","id":"seg_0","start":0.05,"end":5.25,"text":" Hello.","speaker":"A"}, …B…, …A…]}`. Заменить живым ответом, если пользователь даст ключ OpenAI (Task 10).
- [ ] **Step 2: Тесты**

```ts
// whisperx — перенести тесты P, плюс:
test("whisperx: ключ задан → Authorization: Bearer; метки → Speaker N", async () => {});
// openai-compatible:
test("verbose_json: POST {url}/audio/transcriptions, Bearer, model, response_format, timestamp_granularities[]=segment, language", async () => {});
test("diarized_json: model gpt-4o-transcribe-diarize, response_format diarized_json, chunking_strategy auto, нет timestamp_granularities", async () => {});
test("parseDiarized: A,B,A → Speaker 1,2,1; diarized true, speakers 2", () => {});
test("без ключа (local) — заголовка Authorization нет", async () => {});
test("429 → UserError «<name>: rate limit — <message>»; 500 → Error с кодом", async () => {});
test("modelsReachable: 200 → true; 404/исключение → false", async () => {});
// select:
const groq = resolveProvider({ name: "groq", type: "openai-compatible", preset: "groq", tier: "free", keyEnv: "GROQ_API_KEY" });
const wx = resolveProvider({ name: "wx", type: "whisperx", url: "https://wx" });
const ok = (p: ResolvedProvider): Candidate => ({ provider: p, available: true, keyMissing: null });
test("chooseProvider: первый подходящий по порядку", () => {
  expect(chooseProvider({ candidates: [ok(wx), ok(groq)], durationSec: 5400, kbps: 28, privateSource: false, allowCloud: false }))
    .toEqual({ provider: wx });
});
test("chooseProvider: причины по каждому", () => {
  const r = chooseProvider({ candidates: [{ ...ok(wx), available: false }, { ...ok(groq), keyMissing: "env GROQ_API_KEY" }],
    durationSec: 5400, kbps: 28, privateSource: false, allowCloud: false });
  expect(r).toEqual({ error: "no ASR provider fits: wx: not reachable; groq: no API key (env GROQ_API_KEY)" });
});
test("chooseProvider: длительность и размер в сообщении — h:mm и MB", () => {
  // groq, 9000 с → "groq: 2:30:00 exceeds duration limit 1:56:40"; fixed 32k на 6500 с → "groq: ~26.0 MB exceeds file limit 25.0 MB"
});
test("chooseProvider: облако + privateSource без allowCloud → «cloud provider, needs --allow-cloud»; local-провайдер — можно", () => {});
test("chooseProvider: пустой список → «no ASR providers configured — run setup (see references/setup.md)»", () => {});
test("probeProviders: whisperx по /health, local openai-compatible по /models, облачный не пингуется; keyMissing из keySource", async () => {});
```

- [ ] **Step 3: Запустить — падают.**
- [ ] **Step 4: Реализовать.** Ожидаемый размер `durationSec · kbps · 1000 / 8`. Формат длительности `h:mm:ss` (из `formatTs`). Язык в запросах — основной подтег в нижнем регистре.
- [ ] **Step 5: Тесты зелёные; живьём** `transcribeWith` на Groq (ключ — `keyFile: ~/.config/groq/token`) с 30-секундным клипом из Task 5 → `cues.length > 0`.
- [ ] **Step 6: Commit** — `feat: ASR providers (whisperx, OpenAI-compatible incl. diarized) and provider selection`.

---

### Task 7: Команда fetch

**Files:**
- Create (перенос): `src/fetch-cmd.ts` из `P/fetch-cmd.ts`
- Test: `test/fetch-cmd.test.ts` (перенос, адаптация фейков под провайдеров)

**Interfaces:**
- Consumes: всё из Tasks 1–6.
- Produces:
  ```ts
  export type FetchFlags = { diarize: boolean; allowCloud: boolean; force?: boolean };
  export type FetchDeps = { run: Runner; fetch: Fetcher; cfg: Config; env: Record<string, string | undefined>;
    now: Date; cwd: string; home: string };
  export type FetchResult = /* как в P */ & { asr_provider: string | null };   // asr_backend убран
  export function fetchCmd(input: string, flags: FetchFlags, d: FetchDeps): Promise<FetchResult>;
  ```

- [ ] **Step 1: Перенести тесты P** (ручные сабы, sidecar, повтор, `--force`, обрезанный ogg, `en-US` → `en`, srt-сабы, `--no-diarize`, ошибка посреди ASR без переключения), заменив `health`/`groqToken` в фейках на конфиг с провайдерами `wx` (whisperx) и `groq`.
- [ ] **Step 2: Новые тесты**

```ts
test("автосубтитры: subtitles manual+auto, ручных нет → youtube-auto-subs, ASR не вызывается, dedupe применён", async () => {});
test("автосубтитры выключены (manual) → ASR, даже если auto есть", async () => {});
test("провайдер выбирается ДО скачивания: никто не подходит → UserError, yt-dlp -f не вызывался", async () => {});
test("после сжатия src.* удалён; .work удалён после успеха", async () => {});
test("Generic-ссылка → privateSource: облако только с --allow-cloud", async () => {});
test("ручные сабы не с YouTube → source manual-subs", async () => {});
test("ссылка без схемы youtube.com/watch?v=x → «file not found: … — if this is a link, add https://»", async () => {});
test("повтор после смены провайдера: ogg больше лимита нового → пережимается с новым kbps", async () => {});
test("summaryLanguage ru → sidecar a.ru.srt предпочитается a.en.srt", async () => {});
test("outputDir из конфига с ~ раскрывается", async () => {});
```

- [ ] **Step 3: Запустить — падают.**
- [ ] **Step 4: Реализовать** по спеку («Источник текста», «Выбор провайдера», «Битрейт»): `providers = cfg.providers.map(resolveProvider)`; `kbps = bitrateFor(duration, cfg.bitrate, targetBytes(providers))`; выбор до `downloadAudio`; после сжатия — фактический размер ≤ `maxBytes` выбранного, иначе `UserError`.
- [ ] **Step 5: Тесты зелёные.**
- [ ] **Step 6: Commit** — `feat: fetch command with provider list, auto-captions and privacy rules`.

---

### Task 8: Readeck

**Files:**
- Create (перенос): `src/readeck.ts` из `P/readeck.ts`
- Test: `test/readeck.test.ts` (перенос)

**Interfaces:**
- Consumes: `ReadeckConfig`, `readKey`, `keySource`, `Meta`, `slugify`, `Fetcher`.
- Produces:
  ```ts
  export function renderHtml(markdown: string, title: string): string;      // marked
  export type ReadeckResult = { status: "sent" | "already-sent" | "skipped" | "disabled"; bookmark_id: string | null; reason?: string };
  export function sendToReadeck(dir: string, d: { readeck: ReadeckConfig | null; fetch: Fetcher;
    env: Record<string, string | undefined>; home: string; sleep?: (ms: number) => Promise<void> }): Promise<ReadeckResult>;
  ```

- [ ] **Step 1: Перенести тесты P** (multipart, sha и замена, `already-sent`, 401/сеть → skipped, 422 → UserError, local.invalid).
- [ ] **Step 2: Новые тесты**

```ts
test("readeck null → {status:'disabled', bookmark_id:null}, fetch не вызывается", async () => {});
test("label из конфига попадает в labels", async () => {});
test("сохранённая закладка в state 1 → переотправка, а не already-sent", async () => {});
test("каждый вызов получает signal (таймаут 15 с)", async () => {});
test("renderHtml через marked: таблица, mermaid как <pre><code class=\"language-mermaid\">", () => {});
```

- [ ] **Step 3: Запустить — падают.**
- [ ] **Step 4: Реализовать:** `marked.parse` (синхронно), `createHash("sha256")` из `node:crypto`, `setTimeout`-промис вместо `Bun.sleep`, `AbortSignal.timeout(15_000)` на каждый `fetch`.
- [ ] **Step 5: Тесты зелёные.**
- [ ] **Step 6: Commit** — `feat: optional Readeck export`.

---

### Task 9: CLI, время чтения, бандл, CI

**Files:**
- Create: `src/cli.ts`, `src/summary.ts`, `.github/workflows/ci.yml`, `skills/video-summary/scripts/video-summary.mjs` (сборка)
- Test: `test/cli.test.ts`, `test/summary.test.ts`

**Interfaces:**
- Consumes: всё выше.
- Produces (`summary.ts`):
  ```ts
  export function readingMinutes(markdown: string): number;     // ⌈words/200⌉, min 1; без fenced-блоков
  export function applyReadingTime(markdown: string): string;   // плейсхолдер → «> 📖» строка → вставка (спек «Время чтения»)
  export function finalizeSummary(dir: string): Promise<{ reading_minutes: number }>; // UserError, если нет summary.md
  ```
- Produces: команды из спека («CLI»), включая `finalize <dir>`. `check` → `{ ok, runtime, deps: DepsReport, config: { path, exists, valid, error? }, providers: { name, available, keyMissing }[], readeck: "disabled" | "configured" }`; `ok` = `deps.ok && config.exists && config.valid`. `config limits` → `{ bitrate, rows: LimitRow[] }`.

- [ ] **Step 0: Тесты `summary.test.ts`**

```ts
test("readingMinutes: 400 слов → 2; 1 слово → 1; mermaid и код не считаются", () => {});
test("applyReadingTime: {{reading_time}} → число", () => {
  expect(applyReadingTime("# T\n\n> 📺 a\n> 📖 ~{{reading_time}} min read\n\n" + "w ".repeat(450)))
    .toContain("> 📖 ~3 min read");
});
test("applyReadingTime: повторный вызов после правки пересчитывает число в строке «> 📖 ~N»", () => {});
test("applyReadingTime: ни плейсхолдера, ни строки → вставка после первой строки-цитаты шапки", () => {});
test("finalizeSummary: нет summary.md → UserError; есть → файл переписан, вернул минуты", async () => {});
```

- [ ] **Step 1: Тесты `cli.test.ts`** — CLI вызывается как `main(argv, deps)` с подменёнными `run`/`fetch`/`env`, без процесса:

```ts
test("check без конфига → config.exists false, ok false, но JSON и код 0", async () => {});
test("check с битым конфигом → config.valid false, error с путём к полю", async () => {});
test("config init создаёт DEFAULT_CONFIG; повтор без --force → UserError «config exists»", async () => {});
test("config set providers '<json>' валидирует; config get readeck.url", async () => {});
test("config limits: строки по провайдерам", async () => {});
test("fetch без конфига → UserError «no config — run setup»", async () => {});
test("finalize <dir> → {reading_minutes}", async () => {});
test("неизвестная команда → usage", async () => {});
```

- [ ] **Step 2: Запустить — падают.**
- [ ] **Step 3: Реализовать `cli.ts`** (`main` экспортируется; точка входа вызывает его с `process.argv.slice(2)`, ловит `UserError` → stderr + exit 1, прочее → `Unexpected error: <message>`).
- [ ] **Step 4: Тесты зелёные; `bun run build`; смоук на Node:** `node skills/video-summary/scripts/video-summary.mjs check` и `sh skills/video-summary/scripts/video-summary check` → валидный JSON; `bun run check:bun-free` → 0.
- [ ] **Step 5: CI `ci.yml`:** матрица `ubuntu-latest`, `macos-latest`; шаги: `oven-sh/setup-bun`, `bun install --frozen-lockfile`, `bun test`, `bun run check:bun-free`, `bun run build && git diff --exit-code skills/`, `actions/setup-node` 20 и 22 → `node skills/video-summary/scripts/video-summary.mjs config path`.
- [ ] **Step 6: Commit** (вместе с собранным бандлом) — `feat: CLI entry, bundled script and CI`.

---

### Task 10: SKILL.md, references, README, приёмка, публикация

**Files:**
- Create: `skills/video-summary/SKILL.md`, `skills/video-summary/references/{setup.md,summary-template.md,providers.md}`, `README.md`
- Modify: спек — закрыть открытые вопросы по итогам приёмки

- [ ] **Step 1: `SKILL.md` (en, < 150 строк).** Frontmatter: `name: video-summary`; `description` — когда применять (YouTube/video link or local audio/video file; summary, «what's in this video», transcript; любой язык запроса). Тело — цикл из спека («SKILL.md и references»): лаунчер `sh <skill-dir>/scripts/video-summary <cmd>`; `check` → нет рантайма/зависимостей → один вопрос и установка (sudo — строкой `! …`) → нет конфига → `references/setup.md`; `fetch` (URL в одинарных кавычках; долго: таймаут 10 мин / фон; не перезапускать; `--allow-cloud` только по явному разрешению); `summary_exists` → спросить; транскрипт читать частями при > ~20k токенов; конспект по `references/summary-template.md` на языке `summaryLanguage` (auto = язык пользователя); `finalize <dir>` (время чтения); `readeck` (`disabled` — молча пропустить); итог.
- [ ] **Step 2: `references/setup.md`** — вопросы по порядку из спека; для каждого провайдера — какие поля спросить; как назвать предел длины (`config limits`); ключи без чата: `! read -rs k && printf %s "$k" > ~/.config/video-summary/<name>.key && chmod 600 ~/.config/video-summary/<name>.key` или `keyEnv`; запись через `config init` + `config set`; финальный `check`. `references/summary-template.md` — шаблон и правила из `P/../SKILL.md` (раздел «3. Конспект»), заголовки — на языке конспекта, строка времени чтения `> 📖 ~{{reading_time}} <min read на языке конспекта>` в шапке (число подставит `finalize`), «Источник текста» с вариантом автосубтитров и именем провайдера, `Speaker N` → в языке конспекта. `references/providers.md` — таблица пресетов из Global Constraints, лимиты (`config limits`), диаризация, свой эндпоинт (speaches / faster-whisper-server / whisperx-asr-service: что указать в `url`/`model`).
- [ ] **Step 3: `README.md` (en)** — что делает; `npx skills add danpetrv/video-summary`; требования; провайдеры и лимиты; приватность (что и когда уходит в облако, `--allow-cloud`); пример конфига; лицензия MIT.
- [ ] **Step 4: Проверка установки** — `pnpm dlx skills add --help`, установить из локального пути в одноразовый каталог (временный `HOME`), убедиться, что приехали ровно `SKILL.md`, `scripts/`, `references/`, и что `sh …/scripts/video-summary check` отвечает JSON.
- [ ] **Step 5: Живая приёмка** с временным конфигом (`VIDEO_SUMMARY_CONFIG=/tmp/vs-pub/config.json`, `outputDir /tmp/vs-pub/out`, провайдеры: `wx` = `https://asr.example`, `groq` free с `keyFile: ~/.config/groq/token`; Readeck `https://read.example` с `keyFile: ~/.config/readeck/token`):
  - видео с ручными субтитрами (`dQw4w9WgXcQ`) → `youtube-manual-subs`;
  - видео без ручных (`jNQXAC9IVRw`) при погашенном whisperx → `groq`;
  - то же с `subtitles: manual+auto` и пустым `providers` → `youtube-auto-subs`;
  - `readeck` → `sent`, проверка `has_article`, затем `DELETE` пробной закладки;
  - OpenAI — только если пользователь даст ключ (тогда снять живой `diarized_json` в фикстуру).
- [ ] **Step 6: Спек** — отметить закрытые открытые вопросы (3 — yt-dlp-ejs через `-v --simulate`; 4 — по итогам Step 4); commit `docs: skill instructions, references, README`.
- [ ] **Step 7: Публикация** (пользователь одобрил публичный репозиторий 2026-10-02): `gh repo create danpetrv/video-summary --public --source . --remote origin --push`; дождаться зелёного CI (`gh run watch`); `git tag v0.1.0 && git push origin v0.1.0`; `pnpm dlx skills add danpetrv/video-summary` в одноразовый `HOME` — установка из GitHub работает.
