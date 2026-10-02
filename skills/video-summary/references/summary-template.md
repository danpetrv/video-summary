# Summary template and rules

Write `<dir>/summary.md` in the summary language (`summaryLanguage`; `auto` = the
language the user talks to you in), even when the video is in another language.
Section headings are translated into that language too; keep the emoji.

```markdown
# 🎬 <title>

> 📺 <channel> · 📅 <publication date> · ⏱️ <duration> · 🔗 [watch](<url>)
> 📖 ~{{reading_time}} <"min read" in the summary language>
> 📝 Text source: <see rules below>
> 🗣️ Participants: <names or "Speaker 1", "Speaker 2">   (only if diarized)

## ⚡ TL;DR
3-5 points: the main thing, why it is (or is not) worth watching.

## 🧭 Contents
- [00:00](<url>&t=0s) Intro
- [12:30](<url>&t=750s) ...

## 📚 By section
### [12:30](<url>&t=750s) <Section>
The gist of the section, key points as a list, numbers and facts.

## 💡 Key ideas
## 💬 Quotes            (only if there are striking ones)
## 🔗 Mentioned         (people, tools, links, only if any)
## 🗺️ Diagram           (mermaid, only if the video has a process/structure/comparison)
```

Rules:

- Leave `{{reading_time}}` literally in the file: `finalize <dir>` replaces it with the
  number of minutes after you write the summary. Do not compute it yourself.
- "Text source" line, from `meta.json`:
  - `source` is `youtube-manual-subs`, `manual-subs` or `sidecar-subs`: manual subtitles;
  - `youtube-auto-subs`: auto captions (may contain errors);
  - `asr`: recognition, naming the provider from `asr_provider`, plus whether
    speakers are labeled (`diarized`), e.g. "recognition (groq, no speaker labels)".
  Write the line in the summary language.
- "Participants" line only when `diarized: true`.
- Timecode links only for YouTube: `<meta.url>&t=<seconds>s` (`meta.url` is always
  `watch?v=...`). For other sites and local files timecodes are plain text, no links.
  Publication date from `upload_date` (`YYYYMMDD`), duration from `duration`.
- If the source is ASR or auto captions, names and terms may be misrecognized: do not
  invent a spelling where unsure.
- Transcript labels are `Speaker N`; write them in the summary language ("Спикер N",
  "Speaker N", ...). Replace a label with a name only if the text supports it
  (introductions, being addressed by name); otherwise keep the label. With diarization
  say who claimed what ("Ivan thinks..., Speaker 2 objects..."). Without diarization
  (subtitles, non-diarized ASR) attribute only where the text makes it explicit.
- Quotes, Mentioned and Diagram sections only when there is something to put in them.
  Mermaid only for a process, structure or comparison.
- Do not retell linearly: group by topic, drop filler and repetition.
