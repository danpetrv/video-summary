# video-summary (публичный скилл) — дизайн

Дата: 2026-10-02. Статус: спек одобрен (2026-10-02).

Предшественник: the author's personal skill (private), личный скилл `video-summary`.
Он работает и проверен на реальном стриме; этот проект делает из него публичный скилл.

## Зачем

Выложить скилл в открытый доступ: `npx skills add danpetrv/video-summary`, каталог
skills.sh (попадание туда — автоматически, по статистике установок). Для этого убрать
привязку к личной инфраструктуре (адреса whisperx/Readeck в коде, подсказка `llm off`) и
дать пользователю самому выбрать папку, провайдеров распознавания, Readeck.

Критерий успеха: человек без моей инфраструктуры ставит скилл одной командой, агент
проводит его через настройку, и `/video-summary <url>` даёт конспект — через Groq,
OpenAI или его собственный эндпоинт. Личная установка автора работает как сейчас
(whisperx → Groq → Readeck), но на публичной версии.

## Что входит и что нет

Входит:

- всё, что умеет текущий скилл (ручные субтитры, sidecar-субтитры, ASR, диаризация,
  адаптивный битрейт, повтор без повторного ASR, Readeck), с теми же правилами;
- конфиг пользователя и настройка, которую ведёт агент;
- провайдеры ASR списком с fallback: whisperx-asr, Groq, OpenAI, любой OpenAI-совместимый
  эндпоинт (локальный или личный) с необязательным ключом;
- диаризация: whisperx и OpenAI `gpt-4o-transcribe-diarize`;
- автосубтитры YouTube как опция (по умолчанию выключены);
- язык конспекта настраивается;
- Readeck — опционально;
- рантайм: Bun, если есть, иначе Node ≥ 20;
- macOS и Linux;
- публичный репозиторий: README (en), LICENSE, CI;
- исправление отложенных мелочей из ревью предшественника (список ниже).

Не входит (YAGNI):

- Windows;
- нарезка длинного аудио на куски — длина видео ограничена лимитами провайдера, и это
  честно сообщается при настройке;
- другие «приёмники» кроме Readeck (Notion, Obsidian и т. п.);
- интерактивный мастер в терминале — настройку ведёт агент;
- перевод личной установки автора на публичный скилл — отдельный шаг после публикации, вне этого репозитория.

## Стандарт и раскладка

Формат — спецификация Agent Skills (skills.sh — каталог поверх неё). `npx skills`
(vercel-labs/skills) клонирует репозиторий, находит `SKILL.md` (папка `skills/` —
стандартный контейнер) и копирует пользователю **всю папку скилла**. Требования:
frontmatter `name` (латиница, нижний регистр, дефисы, = имя папки) и `description`;
`SKILL.md` короткий, детали — в `references/`, читаются по необходимости.

```
video-summary/                          → github.com/danpetrv/video-summary
├── skills/video-summary/               только это приезжает пользователю
│   ├── SKILL.md                        en; цикл check → setup → fetch → конспект → readeck
│   ├── scripts/
│   │   ├── video-summary               sh-лаунчер (выбор рантайма)
│   │   └── video-summary.mjs           собранный бандл, коммитится; npm install не нужен
│   └── references/
│       ├── setup.md                    как вести настройку: вопросы, лимиты, ключи
│       ├── summary-template.md         шаблон конспекта и правила
│       └── providers.md                пресеты, лимиты, диаризация, свой эндпоинт
├── src/                                TypeScript только на API Node
│   ├── cli.ts config.ts deps.ts captions.ts paths.ts meta.ts ytdlp.ts audio.ts fetch-cmd.ts readeck.ts
│   └── asr/ types.ts presets.ts select.ts whisperx.ts openai-compatible.ts
├── test/                               *.test.ts + fixtures/ (bun test)
├── package.json                        devDependencies: marked (вшивается в бандл), typescript, @types/node
├── README.md  LICENSE  .github/workflows/ci.yml
└── docs/superpowers/{specs,plans}/
```

## Рантайм

- Код — только API Node (`node:fs`, `node:fs/promises`, `node:child_process`, `node:path`,
  `node:os`, `node:crypto`, глобальные `fetch`/`FormData`/`Blob`). Bun эти API реализует,
  поэтому один код работает на обоих. `Bun.*` в `src/` запрещён (проверка в CI).
- Сборка: `bun build src/cli.ts --target=node --format=esm --outfile skills/video-summary/scripts/video-summary.mjs`
  (`marked` вшивается). Бандл коммитится; CI проверяет, что он совпадает со свежей сборкой.
- Лаунчер `scripts/video-summary` (POSIX sh): `bun` в PATH → `exec bun …mjs "$@"`; иначе
  `node` с мажорной версией ≥ 20 → `exec node …mjs "$@"`; иначе печатает JSON
  `{"ok":false,"runtime":"missing","install":[…]}` (варианты: bun — `curl -fsSL https://bun.sh/install | bash`
  или `brew install oven-sh/bun/bun`; node — `brew install node` / пакетный менеджер / fnm) и выходит с 1.
  Ставить bun при наличии node не предлагаем. Агент запускает `sh <путь>/scripts/video-summary …`,
  не полагаясь на бит исполнения после копирования.

## Конфиг

Файл: `$VIDEO_SUMMARY_CONFIG`, иначе `${XDG_CONFIG_HOME:-~/.config}/video-summary/config.json`.

```jsonc
{
  "outputDir": "~/Documents/video-summaries",
  "summaryLanguage": "auto",              // auto = язык, на котором пользователь говорит с агентом; иначе код (ru, en…)
  "subtitles": "manual",                  // manual | manual+auto
  "bitrate": "adaptive",                  // adaptive | fixed
  "providers": [                          // порядок = приоритет
    { "name": "home-whisperx", "type": "whisperx", "url": "https://asr.example", "keyFile": null },
    { "name": "groq", "type": "openai-compatible", "preset": "groq", "tier": "free",
      "keyFile": "~/.config/video-summary/groq.key" },
    { "name": "openai", "type": "openai-compatible", "preset": "openai", "diarize": true, "keyEnv": "OPENAI_API_KEY" },
    { "name": "local", "type": "openai-compatible", "url": "http://localhost:8000/v1",
      "model": "Systran/faster-whisper-large-v3", "local": true }
  ],
  "readeck": null                         // или { "url": "https://read.example", "keyFile": "…" }
}
```

- `~` раскрывается во всех путях. Ключ: `keyFile` (содержимое с `trim()`) или `keyEnv`;
  в самом конфиге ключей нет. Ключ нигде не печатается: ни в stdout, ни в ошибках.
- Нет конфига → `check` сообщает `config: missing`, `fetch` отказывает с подсказкой.
- Неверный JSON / неизвестный `type`/`preset` → `UserError` с путём к полю.
- Значения по умолчанию при `config init`: `outputDir` `~/Documents/video-summaries`,
  `summaryLanguage` `auto`, `subtitles` `manual`, `bitrate` `adaptive`, `providers` `[]`, `readeck` `null`.

## Провайдеры ASR

Два типа, один интерфейс `transcribe(audio, opts) → {cues, provider, diarized, speakers, language}`.

### whisperx (whisperx-asr-service, `/asr`)

Как у предшественника: `POST {url}/asr?output=json&diarize=<bool>&word_timestamps=false[&language=xx]`,
поле `audio_file`; доступность — `GET {url}/health` (5 с). Если задан ключ — заголовок
`Authorization: Bearer`. `local: true` по умолчанию. Диаризация по умолчанию включена
(`--no-diarize` выключает), метки `SPEAKER_xx` → «Спикер N» / «Speaker N» по языку конспекта.
Лимитов размера и длительности по умолчанию нет.

### openai-compatible (`/v1/audio/transcriptions`)

Пресеты (`asr/presets.ts`); любое поле пресета переопределяется в конфиге:

| preset | url | модель | формат | лимит файла | лимит длительности | local |
|---|---|---|---|---|---|---|
| `groq`, tier `free` | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | `verbose_json` + `timestamp_granularities[]=segment` | 25 МБ | 7000 с (ASH 7200 с/ч) | нет |
| `groq`, tier `dev` | то же | то же | то же | 100 МБ | уточнить при реализации | нет |
| `openai` | `https://api.openai.com/v1` | `whisper-1` | `verbose_json` + segment | 25 МБ | уточнить | нет |
| `openai`, `diarize: true` | то же | `gpt-4o-transcribe-diarize` | `diarized_json`, `chunking_strategy=auto` | 25 МБ | уточнить | нет |
| без пресета | `url` обязателен | `model` обязателен | `verbose_json` + segment | нет | нет | `local` из конфига (по умолчанию `false`) |

- Почему не `gpt-4o-transcribe` у OpenAI без диаризации: по документации он отдаёт только
  `json`/`text` без таймкодов; нам нужны сегменты — поэтому `whisper-1`. Проверить при реализации.
- `diarized_json`: сегменты `{start, end, text, speaker}` (метки `A`, `B`, …) → «Спикер N».
- Лимит файла считается в десятичных байтах (25 МБ = 25 000 000) — консервативно.
- Доступность: для `local: true` — `GET {url}/models` (5 с); облачные пресеты не пингуются,
  проверяется только наличие ключа.
- Ответ 429 → `UserError` с текстом лимита, без повторов; прочие не-2xx → ошибка с кодом и телом.
- Язык: передаётся основной подтег (`en-US` → `en`), если известен.

### Выбор провайдера (`asr/select.ts`)

До скачивания аудио (по длительности из метаданных; для файлов — `ffprobe`): обход списка
по порядку, берётся первый, у которого все условия выполнены —

1. доступен (см. выше) и есть ключ, если он нужен;
2. длительность ≤ лимита длительности;
3. ожидаемый размер при выбранном битрейте ≤ лимита файла (после сжатия — проверка фактического размера);
4. облачный провайдер + локальный файл (или ссылка с `extractor_key == "Generic"`) → только с `--allow-cloud`.

Никто не подошёл → `UserError` с причиной по каждому: `whisperx: не отвечает; groq: 2 ч 30 мин
больше лимита free (≈1 ч 56 мин); openai: нет ключа (OPENAI_API_KEY)`. Ошибка провайдера
посреди распознавания на следующий **не** переключает (как у предшественника).

### Битрейт и предел длины

- `fixed`: opus 32k. `adaptive`: `kbps = clamp(16, 32, floor(target·8 / duration / 1000))`,
  где `target` = 96% наименьшего лимита файла среди облачных провайдеров конфига (нет таких — 32k).
- Предел длины для пары «провайдер + битрейт» = `min(лимит длительности, 96% лимита файла·8 / битрейт)`
  (тот же запас 4% и при выборе провайдера);
  его считает `config limits` и называет агент при настройке. Например, Groq free:
  adaptive ≈ 1 ч 56 мин (упирается в 7000 с), fixed = 1 ч 40 мин (96% от 25 МБ на 32k = 6000 с).
- Сжатие атомарное (`.tmp` → rename), повторное использование `.work/audio.ogg` — только если
  он покрывает длительность и влезает в лимит (как у предшественника).

## Источник текста

- Ссылка: ручные субтитры на языке оригинала → автосубтитры (если `subtitles: manual+auto`) → ASR.
- Файл: sidecar `.srt`/`.vtt` (код языка в имени — только `^[a-z]{2,3}(-[a-z0-9]{2,8})*$`) → ASR.
- **Автосубтитры:** `--write-auto-subs --sub-langs <lang>-orig,<lang>` (дорожка оригинала, не
  автоперевод); у YouTube в автосубтитрах «бегущие» строки — каждая реплика повторяет хвост
  предыдущей. Новая чистка `dedupeRolling(cues)`: убирать из реплики префикс, совпадающий с
  концом предыдущей, и реплики-дубли. Фикстура — реальная дорожка. В `meta.source` —
  `youtube-auto-subs`, в шапке конспекта — «автосубтитры (возможны ошибки)».
- `meta.source` для ручных субтитров не-YouTube сайтов — `manual-subs` (не `youtube-manual-subs`).

## CLI

Все команды печатают JSON в stdout; ошибка — код 1 и одна строка в stderr.

| Команда | Что делает |
|---|---|
| `check` | рантайм, yt-dlp (+ свежесть), ffmpeg/ffprobe, конфиг; по каждому провайдеру — доступен ли / есть ли ключ |
| `config path` / `config get [key]` | путь к конфигу / значение |
| `config init` | создать конфиг со значениями по умолчанию (не перезаписывает существующий без `--force`) |
| `config set <key> <json>` | записать значение (`providers`, `readeck` — целиком JSON) с валидацией |
| `config limits` | предел длины видео для каждого провайдера при текущем битрейте и при другом |
| `fetch <url\|путь> [--no-diarize] [--allow-cloud] [--force]` | как у предшественника |
| `finalize <dir>` | подставляет в `summary.md` примерное время чтения (см. «Время чтения»); идемпотентно |
| `readeck <dir>` | как у предшественника; `readeck: null` в конфиге → `{"status":"disabled"}` |

## SKILL.md и references

- `SKILL.md` (en, < ~150 строк): когда применять; как запускать лаунчер; цикл
  `check` → (нет конфига → `references/setup.md`) → `fetch` (долго: таймаут 10 мин / фон, не
  перезапускать) → конспект по `references/summary-template.md` → `readeck` (если включён) → итог.
  URL всегда в одинарных кавычках. Чтение длинного транскрипта — частями (offset/limit).
- `references/setup.md`: порядок вопросов (папка; провайдеры по порядку и их параметры; битрейт
  с названием предела длины из `config limits`; автосубтитры — предложить, если провайдеров нет;
  язык; Readeck), как пользователь кладёт ключ без чата
  (`! read -rs k && printf %s "$k" > <файл> && chmod 600 <файл>` или переменная окружения),
  финальный `check`.
- `references/summary-template.md`: шаблон предшественника; заголовки секций — на языке
  конспекта; строка «Источник текста» учитывает автосубтитры и провайдера.
- `references/providers.md`: таблица пресетов, лимиты, диаризация, как подключить свой эндпоинт
  (speaches, faster-whisper-server, whisperx-asr-service).

## Время чтения (добавлено 2026-10-02)

В шапке каждого конспекта — примерное время чтения. Считает скрипт, не агент:
шаблон содержит строку `> 📖 ~{{reading_time}} <мин чтения на языке конспекта>`, после записи
конспекта агент вызывает `finalize <dir>`. Минуты = ⌈слова / 200⌉, минимум 1; слова —
`\S+` в тексте без fenced-блоков (код, mermaid). Плейсхолдер заменяется числом; если
плейсхолдера нет, но есть строка, начинающаяся с `> 📖`, в ней обновляется первое число
после `~` (повторный `finalize` после правки конспекта пересчитывает). Нет ни того ни
другого — строка вставляется после первой строки-цитаты шапки. `finalize` идёт до `readeck`.

## Readeck

Как у предшественника: multipart (`url`, `title`, `labels=video-summary`, `html` файлом `_`),
`Bearer`, опрос `state`, sha конспекта для замены переписанного, заглушка `https://local.invalid/<slug>`
для файлов. Плюс: таймаут 15 с на каждый вызов; `state 1` при проверке существующей закладки →
переотправка. Метка настраивается (`readeck.label`, по умолчанию `video-summary`).

## Отложенные мелочи предшественника, которые закрываем

1. `.work`: после сжатия исходник удаляется; доступность провайдеров проверяется до скачивания.
2. Скачанный bestaudio — в `src.%(ext)s`, не пересекается с `audio.ogg`.
3. Разделитель блоков субтитров — строка из пробелов тоже (`/\n[ \t]*\n/`).
4. Readeck: `state 1` у сохранённой закладки → переотправка; таймауты.
5. `check`: версия рантайма; наличие `yt-dlp-ejs` (через `yt-dlp --version`/`-v` вывод или пробный запуск — решить при реализации).
6. URL в одинарных кавычках в `SKILL.md`; чтение транскрипта частями.
7. slug: сохранять `\p{M}`; резать по кодпоинтам.
8. Чистка тегов: только известные VTT/HTML-теги (`c`, `i`, `b`, `u`, `v`, `lang`, `ruby`, `rt`, таймштампы), а не `<[^>]+>`.
9. Подсказки об ошибках берут реальные пути/переменные из конфига.
10. Ссылка без схемы → подсказка «добавь https://».
11. `--flat-playlist` для быстрого отказа на плейлистах/каналах.
12. Лимит в десятичных МБ.
13. Sidecar с несколькими языками: предпочитать язык, совпадающий с `summaryLanguage`/системным, иначе первый.
14. `Generic`-ссылки в облако — только с `--allow-cloud`.

## Ошибки

Как у предшественника, плюс: нет конфига; битый конфиг (путь к полю); нет рантайма (JSON от
лаунчера); ни один провайдер не подходит (причина по каждому); провайдер без ключа. Ключи и
содержимое ключевых файлов не попадают ни в какой вывод.

## Тестирование

- Перенос 95 тестов предшественника (с заменой Bun-API в фикстурах/хелперах на `node:fs`).
- Новые юнит-тесты: конфиг (умолчания, `~`, `XDG_CONFIG_HOME`, `VIDEO_SUMMARY_CONFIG`, ошибки
  валидации, `config set` для вложенных ключей); пресеты и тарифы; `select` (порядок, лимиты,
  `local`/`--allow-cloud`/Generic, сообщения); `config limits`; разбор `verbose_json` и
  `diarized_json`; `dedupeRolling` на реальной автосубтитровой фикстуре; лаунчер (bun / node 20+ /
  node 18 / ничего) — через подставной `PATH` с фейковыми бинарями.
- CI (GitHub Actions, ubuntu + macos): `bun test`; сборка и сравнение бандла с закоммиченным;
  `node scripts/video-summary.mjs check` на Node 20 и 22 (ловит Bun-API); grep на `Bun\.` в `src/`.
- Живая приёмка: Groq (есть ключ); OpenAI — если пользователь даст ключ; whisperx — когда свободен
  GPU; Readeck — пробная закладка с удалением; установка `npx skills add` из локального пути/репо
  в чистый каталог.

## Публикация

- Репозиторий `github.com/danpetrv/video-summary`, публичный; лицензия — MIT (подтверждено 2026-10-02).
- README (en): что делает, установка (`npx skills add danpetrv/video-summary`), требования
  (yt-dlp, ffmpeg, bun или node ≥ 20), провайдеры и лимиты, приватность (что уходит в облако),
  пример конфига.
- Тег `v0.1.0` после приёмки. Публикация (push, создание репозитория) — только с явного «да» пользователя.

## Открытые вопросы на реализацию

1. Лимиты длительности: Groq dev, OpenAI `whisper-1` и `gpt-4o-transcribe-diarize`; обязателен ли
   `chunking_strategy` для diarize-модели на длинном аудио.
2. Подтвердить, что `gpt-4o-transcribe` не отдаёт сегменты с таймкодами (иначе — он вместо `whisper-1`).
3. ~~Как надёжно проверить наличие `yt-dlp-ejs`.~~ Закрыто: по stderr `yt-dlp -v --simulate` (реализовано в `check`).
4. ~~Сохраняет ли `npx skills` бит исполнения у файлов.~~ Закрыто (2026-10-02, skills 1.7.0): установка из локального пути (`skills add <path> -a claude-code --copy -y`, также `-g`) копирует папку скилла целиком, бит исполнения у `scripts/video-summary` сохраняется; лаунчер всё равно вызывается через `sh`.
