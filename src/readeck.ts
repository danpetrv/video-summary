import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Tokens, marked } from "marked";
import { type ReadeckConfig, keySource, readKey } from "./config";
import { readMeta, writeMeta } from "./meta";
import { netErrorTag, oneLine } from "./net";
import { slugify } from "./paths";
import { type Fetcher, UserError } from "./types";

export type ReadeckResult = {
  status: "sent" | "already-sent" | "skipped" | "disabled"; bookmark_id: string | null; reason?: string;
};
type Deps = {
  readeck: ReadeckConfig | null; fetch: Fetcher; env: Record<string, string | undefined>; home: string;
  sleep?: (ms: number) => Promise<void>;
};

const POLLS = 15;
const TIMEOUT_MS = 15_000;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Mermaid stays a code block: Readeck strips scripts; the full version is summary.md.
 * The header quote (before the first section heading) becomes a plain paragraph with line breaks: Readeck keeps
 * only readability's best block, and when the rest of the summary is lists that block was the header <blockquote>.
 */
export function renderHtml(markdown: string, title: string): string {
  const tokens = marked.lexer(markdown);
  const section = tokens.findIndex((t) => t.type === "heading" && t.depth > 1);
  const i = tokens.findIndex((t, n) => t.type === "blockquote" && (section < 0 || n < section));
  if (i >= 0) tokens.splice(i, 1, ...marked.lexer((tokens[i] as Tokens.Blockquote).text, { gfm: true, breaks: true }));
  const body = marked.parser(tokens, { async: false });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

class NetError extends Error {}

export async function sendToReadeck(dir: string, d: Deps): Promise<ReadeckResult> {
  if (!d.readeck) return { status: "disabled", bookmark_id: null };
  const rd = d.readeck;
  const summaryPath = join(dir, "summary.md");
  const exists = await stat(summaryPath).then(() => true, () => false);
  if (!exists) throw new UserError(`write summary.md first in ${dir}`);
  const meta = await readMeta(dir);
  if (!meta?.title) throw new UserError(`no meta.json in ${dir} — run fetch first`);
  const key = await readKey(rd, d.env, d.home);
  if (!key) return { status: "skipped", bookmark_id: null, reason: `no API key (${keySource(rd) ?? "not configured"})` };

  const base = rd.url.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${key}` };
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const call = async (url: string, init?: RequestInit) => {
    try {
      return await d.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new NetError(netErrorTag(e)); // a code, never the message (it may echo headers)
    }
  };

  const markdown = await readFile(summaryPath, "utf8");
  const sha = createHash("sha256").update(markdown).digest("hex");
  let replaced: string | null = null;

  try {
    const old = meta.readeck_bookmark_id;
    // No sha: meta predates hashes, assume the same summary was sent.
    const same = !meta.readeck_summary_sha || meta.readeck_summary_sha === sha;
    let drop = false;
    if (old && same) {
      const r = await call(`${base}/api/bookmarks/${old}`, { headers: auth });
      if (r.ok) {
        const b = (await r.json().catch(() => ({}))) as { loaded?: boolean; state?: number };
        if (!(b.loaded && b.state === 1)) return { status: "already-sent", bookmark_id: old };
        drop = true; // saved bookmark failed processing: resend
      } else if (r.status !== 404) {
        return { status: "skipped", bookmark_id: null, reason: `Readeck answered ${r.status} while checking the bookmark` };
      }
    } else if (old) {
      drop = true;
    }
    if (drop && old) {
      // Rewritten summary or failed bookmark: replace our own (notes on the old one in Readeck are lost).
      const r = await call(`${base}/api/bookmarks/${old}`, { method: "DELETE", headers: auth });
      if (!r.ok && r.status !== 404) {
        return { status: "skipped", bookmark_id: null, reason: `Readeck refused to delete old bookmark ${old} (${r.status})` };
      }
      replaced = old;
    }

    // Multipart with html as a file part only: Readeck 0.23.3 ignores a JSON html field and fetches url itself.
    const form = new FormData();
    form.append("url", meta.url ?? `https://local.invalid/${slugify(meta.title)}`);
    form.append("title", meta.title);
    form.append("labels", rd.label || "video-summary");
    const html = renderHtml(markdown, meta.title);
    form.append("html", new File([html], "_", { type: "text/html" }));
    const r = await call(`${base}/api/bookmarks`, { method: "POST", headers: auth, body: form });
    if (r.status === 401) return { status: "skipped", bookmark_id: null, reason: "Readeck rejected the token (401)" };
    const id = r.headers.get("Bookmark-Id");
    if (r.status !== 202 || !id) {
      throw new UserError(`Readeck rejected the bookmark (${r.status}): ${oneLine(await r.text()).slice(0, 300)}`);
    }
    await writeMeta(dir, { ...meta, readeck_bookmark_id: id, readeck_summary_sha: sha });
    const note = replaced ? `summary changed — replaced old bookmark ${replaced}` : undefined;
    const done = (extra?: string): ReadeckResult => {
      const reason = [note, extra].filter(Boolean).join("; ");
      return reason ? { status: "sent", bookmark_id: id, reason } : { status: "sent", bookmark_id: id };
    };

    for (let i = 0; i < POLLS; i++) {
      await sleep(1000);
      let g: Response;
      try {
        g = await call(`${base}/api/bookmarks/${id}`, { headers: auth });
      } catch (e) {
        // The bookmark exists already: report it as sent, not as skipped.
        if (e instanceof NetError) return done(`could not check status — Readeck unreachable: ${e.message}`);
        throw e;
      }
      if (!g.ok) return done(`could not check status (${g.status})`);
      const b = (await g.json().catch(() => ({}))) as { loaded?: boolean; state?: number }; // non-JSON: not loaded yet
      if (!b.loaded) continue;
      if (b.state === 1) throw new UserError(`Readeck could not process bookmark ${id}`);
      return done();
    }
    return done("Readeck is still processing — check later");
  } catch (e) {
    if (e instanceof NetError) return { status: "skipped", bookmark_id: null, reason: `Readeck unreachable: ${e.message}` };
    throw e;
  }
}
