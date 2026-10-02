import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Fetcher } from "./types";

/** Collapse whitespace runs (newlines included) so error text stays on one stderr line. */
export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const GENERIC = new Set(["Error", "TypeError"]);

/**
 * Short tag for a network error: `cause.code`, own `code`, or a specific error name
 * (TimeoutError, AbortError). Never the message: it may echo request headers.
 */
export function netErrorTag(e: unknown): string {
  if (typeof e !== "object" || e === null) return "unknown error";
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown; name?: unknown } };
  for (const c of [err.cause?.code, err.code]) if (typeof c === "string" && c) return c;
  for (const n of [err.cause?.name, err.name]) if (typeof n === "string" && n && !GENERIC.has(n)) return n;
  return typeof err.name === "string" && err.name ? err.name : "unknown error";
}

/** Pick the HTTP client once per process: Bun's fetch, or httpFetch on Node. */
export const runtimeFetch = (versions: { bun?: string }): Fetcher => (versions.bun ? globalThis.fetch : httpFetch);

const NULL_BODY = new Set([204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Minimal fetch on node:http / node:https for Node. Node's global fetch gives up after
 * 300 s without response headers, regardless of the request's AbortSignal, and a long recognition
 * answers only at the end. node:http has no such limit, so the request's signal is the only timeout.
 *
 * Supports method, headers (object or Headers), a string or FormData body (streamed, not buffered)
 * and signal; returns a standard Response. Follows redirects for GET/HEAD only, dropping
 * Authorization on a cross-origin hop. Errors keep their `code` (ECONNREFUSED, ...); an abort
 * rejects with the signal's reason (TimeoutError, AbortError).
 * Unknown init keys (Bun's `timeout`) are ignored.
 */
export const httpFetch: Fetcher = (input, init = {}) => send(new URL(input), init, MAX_REDIRECTS);

async function send(url: URL, init: RequestInit, redirects: number): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const signal = init.signal ?? undefined;
  let body: Readable | string | undefined;
  if (typeof init.body === "string") {
    body = init.body;
  } else if (init.body instanceof FormData) {
    // The runtime's own multipart encoder: boundary in content-type, parts as a stream.
    const encoded = new Response(init.body);
    headers.set("content-type", encoded.headers.get("content-type")!);
    body = Readable.fromWeb(encoded.body as unknown as WebReadableStream);
  } else if (init.body != null) {
    throw new TypeError("httpFetch: unsupported body type");
  }

  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url, { method, headers: Object.fromEntries(headers), signal }, resolve,
    );
    req.on("error", (e) => {
      if (body instanceof Readable) body.destroy();
      reject(signal?.aborted ? signal.reason : e);
    });
    if (body instanceof Readable) {
      body.on("error", (e) => req.destroy(e));
      body.pipe(req);
    } else {
      req.end(body);
    }
  });

  const status = res.statusCode ?? 0;
  const location = res.headers.location;
  if (REDIRECT.has(status) && location && (method === "GET" || method === "HEAD") && redirects > 0) {
    res.resume();
    const next = new URL(location, url);
    if (next.origin === url.origin) return send(next, init, redirects - 1);
    // Like fetch: never forward credentials to another origin (also on any later hop).
    const stripped = new Headers(init.headers);
    stripped.delete("authorization");
    return send(next, { ...init, headers: stripped }, redirects - 1);
  }
  const out = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
  if (NULL_BODY.has(status) || method === "HEAD") {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers: out });
  }
  // An abort while the body streams fails the body read with the signal's reason, as fetch does.
  const onAbort = () => res.destroy(signal!.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  res.on("close", () => signal?.removeEventListener("abort", onAbort));
  return new Response(Readable.toWeb(res) as unknown as ReadableStream, { status, statusText: res.statusMessage, headers: out });
}
