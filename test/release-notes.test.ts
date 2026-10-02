import { expect, test } from "bun:test";
import { renderNotes } from "../scripts/release-notes";

const REPO = "danpetrv/video-summary";

test("groups conventional commits, strips the type, links issues, skips build commits", () => {
  const notes = renderNotes([
    { subject: "feat(cli): add --dry-run", body: "" },
    { subject: "fix: retry yt-dlp downloads on transient HTTP 403", body: "YouTube...\n\nFixes #1" },
    { subject: "fix: two issues at once", body: "Fixes #2\nCloses #3" },
    { subject: "docs: add banner", body: "" },
    { subject: "build: rebuild bundle", body: "" },
    { subject: "Merge branch 'x'", body: "" },
    { subject: "plain subject without type", body: "" },
  ], "v0.1.0", "v0.1.1", REPO);
  expect(notes).toBe(
    "## Features\n\n- Add --dry-run\n\n" +
    "## Fixes\n\n- Retry yt-dlp downloads on transient HTTP 403 (#1)\n- Two issues at once (#2, #3)\n\n" +
    "## Other\n\n- Add banner\n- Plain subject without type\n\n" +
    "**Full Changelog**: https://github.com/danpetrv/video-summary/compare/v0.1.0...v0.1.1\n",
  );
});

test("first release (no previous tag) has no commit list", () => {
  expect(renderNotes([{ subject: "video-summary v0.1.0", body: "" }], null, "v0.1.0", REPO)).toBe(
    "Initial release.\n\n**Full Changelog**: https://github.com/danpetrv/video-summary/commits/v0.1.0\n",
  );
});

test("empty sections are omitted; nothing but build commits still gives the changelog link", () => {
  expect(renderNotes([{ subject: "build: rebuild bundle", body: "" }], "v1", "v2", REPO)).toBe(
    "**Full Changelog**: https://github.com/danpetrv/video-summary/compare/v1...v2\n",
  );
});
