import { createHash } from "node:crypto";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Meta, readMeta, writeMeta } from "../src/meta";
import { renderHtml, sendToReadeck } from "../src/readeck";
import { type Fetcher, UserError } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "vs-readeck-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tokenFile = join(root, "token");
writeFileSync(tokenFile, "tok\n");
const readeckCfg = { url: "https://rd.example", keyFile: tokenFile };
const env = {};
const home = "/h";
const base = { readeck: readeckCfg, env, home };
const meta: Meta = {
  source_key: "Youtube:x", source: "youtube-manual-subs", asr_provider: null, diarized: false, speakers: 0,
  url: "https://www.youtube.com/watch?v=x", path: null, id: "x", title: "Video <about> K8s", uploader: null,
  upload_date: null, duration: 60, language: "ru", created_at: "2026-10-02T00:00:00Z", transcript_tokens: 1,
  readeck_bookmark_id: null, readeck_summary_sha: null,
};
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(root, "item-"));
  await writeMeta(dir, meta);
  writeFileSync(join(dir, "summary.md"), "# 🎬 Video\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n");
});
const sleep = async () => {};

type Call = { url: string; init?: RequestInit };
function readeck(opts: { postStatus?: number; states?: { loaded: boolean; state: number }[]; getStatus?: number } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "POST")
      return new Response(opts.postStatus === 401 ? "unauthorized" : "{}", {
        status: opts.postStatus ?? 202, headers: { "Bookmark-Id": "bk42" },
      });
    if (opts.getStatus) return new Response("{}", { status: opts.getStatus });
    const st = opts.states ?? [{ loaded: false, state: 2 }, { loaded: true, state: 0 }];
    return Response.json(st[Math.min(polls++, st.length - 1)]);
  };
  return { calls, f };
}

test("renderHtml: headings, table, mermaid as code, title escaped", () => {
  const h = renderHtml("# Heading\n\n| a |\n|---|\n| 1 |\n\n```mermaid\ngraph TD\n```\n", "A <b> & c");
  expect(h.startsWith('<!doctype html><html><head><meta charset="utf-8"><title>A &lt;b&gt; &amp; c</title></head><body>')).toBe(true);
  expect(h).toContain("<h1>Heading</h1>");
  expect(h).toContain("<table>");
  expect(h).toContain('<pre><code class="language-mermaid">');
  expect(h.endsWith("</body></html>")).toBe(true);
});

test("no summary.md -> UserError", async () => {
  rmSync(join(dir, "summary.md"));
  const { f } = readeck();
  await expect(sendToReadeck(dir, { ...base, fetch: f, sleep })).rejects.toThrow(new UserError(`write summary.md first in ${dir}`));
});

test("no key -> skipped, fetch not called", async () => {
  const { calls, f } = readeck();
  const r = await sendToReadeck(dir, { ...base, readeck: { url: "https://rd.example", keyFile: join(root, "none") }, fetch: f, sleep });
  expect(r.status).toBe("skipped");
  expect(r.reason).toBe(`no API key (file ${join(root, "none")})`);
  expect(calls).toEqual([]);
});

test("POST multipart: Bearer, url/title/labels + html as file part _; 202 -> poll -> sent, id in meta", async () => {
  // Readeck 0.23.3 ignores the JSON html field and fetches url itself (verified live) — multipart file only.
  const { calls, f } = readeck();
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r).toEqual({ status: "sent", bookmark_id: "bk42" });
  const post = calls[0]!;
  expect(post.url).toBe("https://rd.example/api/bookmarks");
  expect((post.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  const fd = post.init!.body as FormData;
  expect([fd.get("url"), fd.get("title"), fd.getAll("labels")]).toEqual([meta.url, meta.title, ["video-summary"]]);
  const html = fd.get("html") as File;
  expect(html).toBeInstanceOf(File);
  expect(html.name).toBe("_");
  expect(html.type.startsWith("text/html")).toBe(true);
  expect(await html.text()).toContain("<table>");
  expect(calls.slice(1).map((c) => c.url)).toEqual(["https://rd.example/api/bookmarks/bk42", "https://rd.example/api/bookmarks/bk42"]);
  expect((await readMeta(dir))!.readeck_bookmark_id).toBe("bk42");
});

test("local file: url = https://local.invalid/<slug>", async () => {
  await writeMeta(dir, { ...meta, url: null, path: "/x/Meeting 1.mp4", title: "Meeting 1" });
  const { calls, f } = readeck();
  await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect((calls[0]!.init!.body as FormData).get("url")).toBe("https://local.invalid/meeting-1");
});

test("state 1 after loaded -> UserError", async () => {
  const { f } = readeck({ states: [{ loaded: true, state: 1 }] });
  await expect(sendToReadeck(dir, { ...base, fetch: f, sleep })).rejects.toThrow("Readeck could not process bookmark bk42");
});

test("never loaded in 15 polls -> sent with reason", async () => {
  const { calls, f } = readeck({ states: [{ loaded: false, state: 2 }] });
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r.status).toBe("sent");
  expect(r.reason).toContain("still processing");
  expect(calls.length).toBe(1 + 15);
});

test("sent stores sha256 of summary.md in meta", async () => {
  const { f } = readeck();
  await sendToReadeck(dir, { ...base, fetch: f, sleep });
  const sha = createHash("sha256").update(readFileSync(join(dir, "summary.md"), "utf8")).digest("hex");
  expect((await readMeta(dir))!.readeck_summary_sha).toBe(sha);
});

test("summary rewritten (sha differs) -> old bookmark deleted, new created", async () => {
  await writeMeta(dir, { ...meta, readeck_bookmark_id: "old", readeck_summary_sha: "stale" });
  const calls: Call[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "POST") return new Response("{}", { status: 202, headers: { "Bookmark-Id": "new2" } });
    return Response.json({ loaded: true, state: 0 });
  };
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r).toEqual({ status: "sent", bookmark_id: "new2", reason: "summary changed — replaced old bookmark old" });
  expect(calls.find((c) => c.init?.method === "DELETE")!.url).toBe("https://rd.example/api/bookmarks/old");
  expect((await readMeta(dir))!.readeck_bookmark_id).toBe("new2");
});

test("bookmark id, same sha and GET 200 -> already-sent without POST", async () => {
  const sha = createHash("sha256").update(readFileSync(join(dir, "summary.md"), "utf8")).digest("hex");
  await writeMeta(dir, { ...meta, readeck_bookmark_id: "old", readeck_summary_sha: sha });
  const { calls, f } = readeck({ states: [{ loaded: true, state: 0 }] });
  expect(await sendToReadeck(dir, { ...base, fetch: f, sleep })).toEqual({ status: "already-sent", bookmark_id: "old" });
  expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
});

test("bookmark id, GET 404 -> resends", async () => {
  await writeMeta(dir, { ...meta, readeck_bookmark_id: "gone" });
  const calls: Call[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/gone")) return new Response("", { status: 404 });
    if (init?.method === "POST") return new Response("{}", { status: 202, headers: { "Bookmark-Id": "new1" } });
    return Response.json({ loaded: true, state: 0 });
  };
  expect(await sendToReadeck(dir, { ...base, fetch: f, sleep })).toEqual({ status: "sent", bookmark_id: "new1" });
  expect((await readMeta(dir))!.readeck_bookmark_id).toBe("new1");
});

test("401 -> skipped", async () => {
  const { f } = readeck({ postStatus: 401 });
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r).toEqual({ status: "skipped", bookmark_id: null, reason: "Readeck rejected the token (401)" });
});

test("network down -> skipped", async () => {
  // Node shape: TypeError("fetch failed") with the system error as cause.
  const f: Fetcher = async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND rd.example"), { code: "ENOTFOUND" }) });
  };
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r.status).toBe("skipped");
  expect(r.reason).toContain("Readeck unreachable:");
  expect(r.reason).toContain("ENOTFOUND");
});

test("422 -> UserError with response body", async () => {
  const f: Fetcher = async () => new Response('{"fields":{"url":{"errors":["invalid"]}}}', { status: 422 });
  const err = await sendToReadeck(dir, { ...base, fetch: f, sleep }).catch((e) => e);
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toContain("422");
  expect(err.message).toContain("invalid");
});

test("readeck null -> disabled, fetch not called", async () => {
  const { calls, f } = readeck();
  expect(await sendToReadeck(dir, { ...base, readeck: null, fetch: f, sleep })).toEqual({ status: "disabled", bookmark_id: null });
  expect(calls).toEqual([]);
});

test("label from config goes into labels", async () => {
  const { calls, f } = readeck();
  await sendToReadeck(dir, { ...base, readeck: { ...readeckCfg, label: "talks" }, fetch: f, sleep });
  expect((calls[0]!.init!.body as FormData).getAll("labels")).toEqual(["talks"]);
});

test("saved bookmark in state 1 -> resend, not already-sent", async () => {
  const sha = createHash("sha256").update(readFileSync(join(dir, "summary.md"), "utf8")).digest("hex");
  await writeMeta(dir, { ...meta, readeck_bookmark_id: "bad", readeck_summary_sha: sha });
  const calls: Call[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "POST") return new Response("{}", { status: 202, headers: { "Bookmark-Id": "fresh" } });
    if (url.endsWith("/bad")) return Response.json({ loaded: true, state: 1 });
    return Response.json({ loaded: true, state: 0 });
  };
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r.status).toBe("sent");
  expect(r.bookmark_id).toBe("fresh");
  expect(calls.some((c) => c.init?.method === "POST")).toBe(true);
});

test("every call gets a signal (15 s timeout)", async () => {
  await writeMeta(dir, { ...meta, readeck_bookmark_id: "old", readeck_summary_sha: "stale" });
  const calls: Call[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "POST") return new Response("{}", { status: 202, headers: { "Bookmark-Id": "n" } });
    return Response.json({ loaded: true, state: 0 });
  };
  await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(calls.length).toBe(3);
  for (const c of calls) expect(c.init?.signal).toBeInstanceOf(AbortSignal);
});

test("renderHtml via marked: table, mermaid as <pre><code class=language-mermaid>", () => {
  const h = renderHtml("| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD\n```\n", "t");
  expect(h).toContain("<table>");
  expect(h).toContain('<pre><code class="language-mermaid">');
});

test("poll answers non-JSON -> treated as not loaded, ends as sent 'still processing'", async () => {
  const f: Fetcher = async (_url, init) =>
    init?.method === "POST"
      ? new Response("{}", { status: 202, headers: { "Bookmark-Id": "bk42" } })
      : new Response("<html>maintenance</html>", { status: 200 });
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r.status).toBe("sent");
  expect(r.bookmark_id).toBe("bk42");
  expect(r.reason).toContain("still processing");
});

test("network error while polling -> sent with the known bookmark_id and a reason", async () => {
  const f: Fetcher = async (_url, init) => {
    if (init?.method === "POST") return new Response("{}", { status: 202, headers: { "Bookmark-Id": "bk42" } });
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  };
  const r = await sendToReadeck(dir, { ...base, fetch: f, sleep });
  expect(r).toEqual({ status: "sent", bookmark_id: "bk42", reason: "could not check status — Readeck unreachable: ECONNRESET" });
  expect((await readMeta(dir))!.readeck_bookmark_id).toBe("bk42");
});

test("rejected bookmark: multi-line body collapsed to one line", async () => {
  const f: Fetcher = async () => new Response("bad\n  request\n", { status: 400 });
  const err = await sendToReadeck(dir, { ...base, fetch: f, sleep }).catch((e) => e);
  expect(err.message).toBe("Readeck rejected the bookmark (400): bad request");
});
