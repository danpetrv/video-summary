import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, main } from "../src/cli";
import { DEFAULT_CONFIG } from "../src/config";
import { UserError } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "vs-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let cfgFile: string;
let n = 0;
beforeEach(() => { cfgFile = join(root, `cfg-${n++}.json`); });

const okRun = async (cmd: string[]) => {
  if (cmd[0] === "yt-dlp" && cmd[1] === "--version") return { code: 0, stdout: "2026.09.30\n", stderr: "" };
  if (cmd[0] === "yt-dlp") return { code: 2, stdout: "", stderr: "[debug] Optional libraries: yt_dlp_ejs-0.3.0, requests-2" };
  if (cmd[0] === "ffmpeg") return { code: 0, stdout: "ffmpeg version 7.1 x\n", stderr: "" };
  if (cmd[0] === "ffprobe") return { code: 0, stdout: "ffprobe version 7.1 x\n", stderr: "" };
  return { code: 127, stdout: "", stderr: "" };
};
const deps = (over: Partial<CliDeps> = {}): CliDeps => ({
  run: okRun, fetch: async () => { throw new Error("offline"); },
  env: { VIDEO_SUMMARY_CONFIG: cfgFile }, home: root, cwd: root, now: new Date("2026-10-02T00:00:00Z"),
  platform: "linux", arch: "x64", runtime: { name: "node", version: "24.0.0" }, has: () => false, exists: () => false,
  ...over,
});
const call = (argv: string[], over: Partial<CliDeps> = {}) => main(argv, deps(over));

test("check without config -> config.exists false, ok false, still JSON", async () => {
  const r = (await call(["check"])) as any;
  expect(r.config).toEqual({ path: cfgFile, exists: false, valid: false, warnings: [] });
  expect(r.ok).toBe(false);
  expect(r.deps.ok).toBe(true);
  expect(r.readeck).toBe("disabled");
  expect(r.providers).toEqual([]);
});

test("check with broken config -> config.valid false, error with field path", async () => {
  writeFileSync(cfgFile, JSON.stringify({ subtitles: "wat" }));
  const r = (await call(["check"])) as any;
  expect(r.config.exists).toBe(true);
  expect(r.config.valid).toBe(false);
  expect(r.config.error).toContain("subtitles");
  expect(r.ok).toBe(false);
});

test("check reports migration warnings and stays valid", async () => {
  writeFileSync(cfgFile, JSON.stringify({
    providers: [{ name: "groq", type: "openai-compatible", preset: "groq", tier: "free", keyEnv: "GROQ_API_KEY" }],
  }));
  const r = (await call(["check"])) as any;
  expect(r.config).toEqual({
    path: cfgFile, exists: true, valid: true,
    warnings: ['providers[0] "groq": cloud providers were removed in v0.4.0 — skipped'],
  });
  expect(r.ok).toBe(true);
  expect(r.providers).toEqual([]);
});

test("check with valid config -> ok true, providers probed, readeck configured", async () => {
  writeFileSync(cfgFile, JSON.stringify({
    providers: [{ name: "w", type: "whisperx", url: "http://x:1" }],
    readeck: { url: "https://rd", keyEnv: "K" },
  }));
  const r = (await call(["check"])) as any;
  expect(r.ok).toBe(true);
  expect(r.runtime).toEqual({ name: "node", version: "24.0.0" });
  expect(r.providers).toEqual([{ name: "w", available: false, keyMissing: null }]);
  expect(r.readeck).toBe("configured");
  expect(r.config.warnings).toEqual([]);
});

test("config init creates DEFAULT_CONFIG; repeat without --force -> UserError 'config exists'", async () => {
  await call(["config", "init"]);
  expect(JSON.parse(readFileSync(cfgFile, "utf8"))).toEqual(DEFAULT_CONFIG);
  await expect(call(["config", "init"])).rejects.toThrow(/config exists/);
  await call(["config", "init", "--force"]);
  expect(existsSync(cfgFile)).toBe(true);
});

test("config path / get / set", async () => {
  expect(await call(["config", "path"])).toEqual({ path: cfgFile });
  await call(["config", "init"]);
  await call(["config", "set", "providers", '[{"name":"o","type":"openai-compatible","url":"http://h/v1","model":"m","keyEnv":"G"}]']);
  await call(["config", "set", "readeck", '{"url":"https://rd.example"}']);
  expect(await call(["config", "get", "readeck.url"])).toEqual({ value: "https://rd.example" });
  await call(["config", "set", "outputDir", "~/notes"]);
  expect(((await call(["config", "get"])) as any).outputDir).toBe("~/notes");
  await expect(call(["config", "set", "providers", '[{"name":"g"}]'])).rejects.toBeInstanceOf(UserError);
  await expect(call(["config", "get", "nope"])).rejects.toBeInstanceOf(UserError);
});

test("config limits is gone -> usage error; usage mentions neither limits nor --allow-cloud", async () => {
  await call(["config", "init"]);
  const err = (await call(["config", "limits"]).catch((e) => e)) as Error;
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toMatch(/^usage:/);
  expect(err.message).not.toMatch(/limits|allow-cloud/);
});

test("fetch: --allow-cloud from an old SKILL.md is accepted and ignored", async () => {
  await call(["config", "init"]);
  // gets past argument parsing to yt-dlp (which fails in this stub), not a usage error
  const err = (await call(["fetch", "--allow-cloud", "https://x.example/v"]).catch((e) => e)) as Error;
  expect(err.message).toStartWith("yt-dlp");
});

test("fetch and readeck without config -> UserError 'no config — run setup'", async () => {
  await expect(call(["fetch", "https://x.example/v"])).rejects.toThrow(/no config — run setup/);
  await expect(call(["readeck", root])).rejects.toThrow(/no config — run setup/);
});

test("finalize <dir> -> {reading_minutes}", async () => {
  const dir = mkdtempSync(join(root, "item-"));
  writeFileSync(join(dir, "summary.md"), "# T\n\n> 📖 ~{{reading_time}} min\n\n" + "w ".repeat(250));
  expect(await call(["finalize", dir])).toEqual({ reading_minutes: 2 });
  await expect(call(["finalize"])).rejects.toBeInstanceOf(UserError);
});

test("local status -> JSON status of the engine and model, no network", async () => {
  const env = { VIDEO_SUMMARY_CONFIG: cfgFile, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") };
  const r = await call(["local", "status"], {
    env, has: (b) => b === "nvidia-smi",
    fetch: async () => { throw new Error("status must not touch the network"); },
  });
  expect(r).toEqual({
    installed: false, version: "v0.6.1", builds: [],
    model: { present: false, verified: false, path: join(root, "cache", "video-summary", "models", "ultra-q8_0.gguf") },
    vulkan_lib: false, hint: "sudo apt install libvulkan1",
  });
});

test("local install dispatches to the installer (network error surfaces as UserError)", async () => {
  const env = { VIDEO_SUMMARY_CONFIG: cfgFile, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") };
  const urls: string[] = [];
  const err = (await call(["local", "install"], {
    env, arch: "arm64",
    fetch: async (url) => { urls.push(url); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); },
  }).catch((e: Error) => e)) as Error;
  expect(err).toBeInstanceOf(UserError);
  expect(err.message).toBe("could not download parakeet-v0.6.1-bin-linux-cpu-arm64.tar.gz: ECONNREFUSED");
  expect(urls).toEqual(["https://github.com/mudler/parakeet.cpp/releases/download/v0.6.1/parakeet-v0.6.1-bin-linux-cpu-arm64.tar.gz"]);
});

test("local without a known subcommand -> usage mentioning local install|status", async () => {
  for (const argv of [["local"], ["local", "foo"]]) {
    const err = (await call(argv).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/^usage:.*local install\|status/);
  }
});

test("unknown command -> usage", async () => {
  await expect(call(["bogus"])).rejects.toThrow(/usage:/);
  await expect(call([])).rejects.toThrow(/usage:/);
  await expect(call(["config", "bogus"])).rejects.toThrow(/usage:/);
});

test("check still answers JSON for configs that used to crash it", async () => {
  const keyDir = mkdtempSync(join(root, "keydir-"));
  const cases: [string, (r: any) => void][] = [
    [JSON.stringify({ providers: [{ name: "c", type: "openai-compatible", url: "http://h/v1" }] }), (r) => {
      expect(r.config.valid).toBe(false);
      expect(r.config.error).toBe("config: providers[0].model: required");
    }],
    [JSON.stringify({ providers: [{ name: "c", type: "openai-compatible", url: "/", model: "m" }] }), (r) => {
      expect(r.config.valid).toBe(false);
      expect(r.config.error).toBe("config: providers[0].url: required");
    }],
    [JSON.stringify({ providers: [{ name: "g", type: "openai-compatible", url: "http://h/v1", model: "m", keyFile: keyDir }] }), (r) => {
      expect(r.config.valid).toBe(true);
      expect(r.providers).toEqual([{ name: "g", available: true, keyMissing: `cannot read file ${keyDir} (EISDIR)` }]);
    }],
    ['{"providers": [{"name": "g", "type": "openai-compatible", "url": "http://h/v1",}]}', (r) => {
      expect(r.config.valid).toBe(false);
      expect(r.config.error).toContain("invalid JSON");
    }],
  ];
  for (const [text, verify] of cases) {
    writeFileSync(cfgFile, text);
    const r = await call(["check"]);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // plain JSON-serializable object
    verify(r);
  }
});

test("config set: a value that looks like JSON but does not parse -> UserError, not a string", async () => {
  await call(["config", "init"]);
  await expect(call(["config", "set", "providers", '[{"name":"g","type":"whisperx","url":"http://h",}]']))
    .rejects.toThrow(/^invalid JSON for providers: /);
  await expect(call(["config", "set", "readeck", '{"url":"https://r"']))
    .rejects.toThrow(/^invalid JSON for readeck: /);
  await expect(call(["config", "set", "outputDir", '"~/notes']))
    .rejects.toThrow(/^invalid JSON for outputDir: /);
  await call(["config", "set", "outputDir", "~/plain"]); // bare word is still accepted as a string
  expect(((await call(["config", "get"])) as any).outputDir).toBe("~/plain");
});

test("malformed key never reaches stdout/stderr of the real CLI (check, readeck)", async () => {
  const secret = "sk-LEAKCANARY-91c2";
  const keyFile = join(root, "leak.key");
  writeFileSync(keyFile, `${secret}\n${secret}-second-line\n`);
  writeFileSync(cfgFile, JSON.stringify({
    providers: [{ name: "g", type: "openai-compatible", url: "http://127.0.0.1:9/v1", model: "m", keyFile }],
    readeck: { url: "http://127.0.0.1:9", keyFile },
  }));
  const item = mkdtempSync(join(root, "item-"));
  writeFileSync(join(item, "summary.md"), "# T\n");
  writeFileSync(join(item, "meta.json"), JSON.stringify({ source_key: "x", title: "T", url: "https://example.com/v" }));
  const entry = join(import.meta.dir, "../src/main.ts");
  for (const args of [["check"], ["readeck", item]]) {
    const p = Bun.spawnSync(["bun", entry, ...args], { env: { ...process.env, VIDEO_SUMMARY_CONFIG: cfgFile } });
    const out = p.stdout.toString() + p.stderr.toString();
    expect(out).not.toContain("LEAKCANARY");
    expect(out).toContain(`key in file ${keyFile} contains whitespace or control characters`);
  }
}, 20_000);
