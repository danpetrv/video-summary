import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpFetch, netErrorTag, oneLine, runtimeFetch } from "../src/net";

const root = mkdtempSync(join(tmpdir(), "vs-net-"));
let server: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let base = "";
let otherBase = "";
beforeAll(() => {
  // A second origin (other port): echoes whether Authorization arrived.
  other = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (req) => Response.json({
      origin: "other", auth: req.headers.get("authorization"),
      proxyAuth: req.headers.get("proxy-authorization"), cookie: req.headers.get("cookie"),
    }),
  });
  otherBase = `http://127.0.0.1:${other.port}`;
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      switch (u.pathname) {
        case "/json":
          return Response.json({ a: 1, auth: req.headers.get("authorization") }, { headers: { "x-test": "yes" } });
        case "/echo":
          return Response.json({ method: req.method, body: await req.text(), type: req.headers.get("content-type") });
        case "/form": {
          const type = req.headers.get("content-type") ?? "";
          const form = await req.formData();
          const file = form.get("audio_file") as File;
          return Response.json({
            type, keys: [...form.keys()], text: form.get("note"), fileName: file.name, fileSize: file.size,
            fileHead: Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString(),
          });
        }
        case "/gzip":
          return new Response(Bun.gzipSync(JSON.stringify({ zipped: true })), {
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          });
        case "/empty":
          return new Response(null, { status: 204 });
        case "/missing":
          return new Response("nope", { status: 404, statusText: "Not Found" });
        case "/moved":
          return new Response(null, { status: 302, headers: { location: "/json" } });
        case "/cross":
          return new Response(null, { status: 302, headers: { location: `${otherBase}/auth` } });
        case "/slow":
          await Bun.sleep(1500);
          return new Response("late");
      }
      return new Response("?", { status: 400 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  other.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("netErrorTag: cause.code, own code, specific name; never the message", () => {
  expect(netErrorTag(new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe("UND_ERR_HEADERS_TIMEOUT");
  expect(netErrorTag(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }))).toBe("ConnectionRefused");
  expect(netErrorTag(new DOMException("The operation timed out.", "TimeoutError"))).toBe("TimeoutError");
  const leaky = new TypeError('Headers.append: "Bearer sk-SECRET\nX" is an invalid header value.');
  expect(netErrorTag(leaky)).toBe("TypeError");
  expect(netErrorTag("boom")).toBe("unknown error");
});

test("oneLine collapses whitespace runs", () => {
  expect(oneLine("  a\n\tb  \r\n c ")).toBe("a b c");
});

test("runtimeFetch: global fetch on Bun, httpFetch on Node", () => {
  expect(runtimeFetch({ bun: "1.4.2" })).toBe(globalThis.fetch);
  expect(runtimeFetch({})).toBe(httpFetch);
});

test("httpFetch: GET JSON -> standard Response with status, headers, body; object headers sent", async () => {
  const r = await httpFetch(`${base}/json`, { headers: { Authorization: "Bearer t" } });
  expect(r).toBeInstanceOf(Response);
  expect(r.ok).toBe(true);
  expect(r.status).toBe(200);
  expect(r.headers.get("x-test")).toBe("yes");
  expect(await r.json()).toEqual({ a: 1, auth: "Bearer t" });
});

test("httpFetch: non-2xx keeps status and statusText; 204 has an empty body", async () => {
  const r = await httpFetch(`${base}/missing`);
  expect([r.ok, r.status, r.statusText, await r.text()]).toEqual([false, 404, "Not Found", "nope"]);
  const e = await httpFetch(`${base}/empty`, { method: "DELETE" });
  expect([e.status, await e.text()]).toEqual([204, ""]);
});

test("httpFetch: GET follows a redirect like fetch", async () => {
  const r = await httpFetch(`${base}/moved`);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { a: number }).a).toBe(1);
});

test("httpFetch: redirect keeps Authorization on the same origin, drops it across origins", async () => {
  const same = await httpFetch(`${base}/moved`, { headers: { Authorization: "Bearer t" } });
  expect(await same.json()).toEqual({ a: 1, auth: "Bearer t" });
  const cross = await httpFetch(`${base}/cross`, { headers: new Headers({ authorization: "Bearer t" }) });
  expect(await cross.json()).toEqual({ origin: "other", auth: null, proxyAuth: null, cookie: null });
});

test("httpFetch: POST string body with Headers object", async () => {
  const r = await httpFetch(`${base}/echo`, {
    method: "POST", body: '{"x":1}', headers: new Headers({ "Content-Type": "application/json" }),
  });
  expect(await r.json()).toEqual({ method: "POST", body: '{"x":1}', type: "application/json" });
});

test("httpFetch: POST FormData with a file part -> server parses the multipart body", async () => {
  const bytes = new Uint8Array(200_000).fill(65);
  bytes.set(new TextEncoder().encode("OggS"));
  const form = new FormData();
  form.append("note", "hi");
  form.append("audio_file", new Blob([bytes], { type: "audio/ogg" }), "audio.ogg");
  const r = await httpFetch(`${base}/form`, { method: "POST", body: form, headers: { Authorization: "Bearer t" } });
  const j = (await r.json()) as Record<string, unknown>;
  expect(String(j.type)).toMatch(/^multipart\/form-data; boundary=\S+$/);
  expect(j).toMatchObject({ keys: ["note", "audio_file"], text: "hi", fileName: "audio.ogg", fileSize: 200_000, fileHead: "OggS" });
});

test("httpFetch: AbortSignal.timeout fires before a slow answer -> TimeoutError", async () => {
  const t = Date.now();
  const e = await httpFetch(`${base}/slow`, { signal: AbortSignal.timeout(200) }).catch((x) => x);
  expect(Date.now() - t).toBeLessThan(1200);
  expect(netErrorTag(e)).toBe("TimeoutError");
  const late = await httpFetch(`${base}/slow`, { signal: AbortSignal.timeout(5000) });
  expect(await late.text()).toBe("late");
});

test("httpFetch: connection refused -> error with code ECONNREFUSED", async () => {
  const tmp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = tmp.port;
  tmp.stop(true);
  const e = await httpFetch(`http://127.0.0.1:${port}/`).catch((x) => x);
  expect(e).toBeInstanceOf(Error);
  expect(netErrorTag(e)).toBe("ECONNREFUSED");
});

// Node's global fetch gives up after 300 s without response headers; httpFetch is the
// client the CLI uses on Node. Prove on real Node that it works and honours the injected signal.
const nodeBin = Bun.which("node");
test.skipIf(!nodeBin)("httpFetch on real Node: GET, FormData POST, AbortSignal.timeout, redirect Authorization", async () => {
  const entry = join(root, "probe.ts");
  writeFileSync(entry, `
import { httpFetch, netErrorTag } from ${JSON.stringify(join(import.meta.dir, "../src/net.ts"))};
const [mode, url, ms] = process.argv.slice(2);
try {
  let init = { signal: AbortSignal.timeout(Number(ms)) };
  if (mode === "auth") init = { ...init, headers: { Authorization: "Bearer t" } };
  if (mode === "form") {
    const form = new FormData();
    form.append("note", "hi");
    form.append("audio_file", new Blob(["OggS" + "A".repeat(99_996)], { type: "audio/ogg" }), "audio.ogg");
    init = { ...init, method: "POST", body: form };
  }
  const r = await httpFetch(url, init);
  console.log("ok " + r.status + " " + (await r.text()));
} catch (e) {
  console.log("err " + netErrorTag(e));
}
`);
  const built = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", outdir: join(root, "out") });
  expect(built.success).toBe(true);
  const out = built.outputs[0]!.path;
  const run = async (mode: string, path: string, ms: number) => {
    const p = Bun.spawn([nodeBin!, out, mode, `${base}${path}`, String(ms)], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return (await new Response(p.stdout).text()).trim();
  };
  // /slow answers after 1.5 s: a 500 ms signal must fire, a 5 s one must not.
  const [short, long, form, same, cross] = await Promise.all([
    run("get", "/slow", 500), run("get", "/slow", 5000), run("form", "/form", 5000),
    run("auth", "/moved", 5000), run("auth", "/cross", 5000),
  ]);
  expect(short).toBe("err TimeoutError");
  expect(long).toBe("ok 200 late");
  expect(form).toStartWith("ok 200 ");
  expect(JSON.parse(form.slice(7))).toMatchObject({ keys: ["note", "audio_file"], fileSize: 100_000, fileHead: "OggS" });
  expect(same).toBe('ok 200 {"a":1,"auth":"Bearer t"}');
  expect(cross).toBe('ok 200 {"origin":"other","auth":null,"proxyAuth":null,"cookie":null}');
}, 20_000);

test("#6: cross-origin redirect also drops Proxy-Authorization and Cookie", async () => {
  const headers = { Authorization: "Bearer t", "Proxy-Authorization": "Basic p", Cookie: "s=1" };
  const r = await (await httpFetch(`${base}/cross`, { headers })).json();
  expect(r).toEqual({ origin: "other", auth: null, proxyAuth: null, cookie: null });
});

test("#6: a gzip-encoded response body is decoded", async () => {
  const r = await httpFetch(`${base}/gzip`);
  expect(r.headers.get("content-encoding")).toBeNull();
  expect(await r.json()).toEqual({ zipped: true });
});
