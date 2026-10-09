import { stat } from "node:fs/promises";
import { type Config, DEFAULT_CONFIG, configPath, loadConfig, saveConfig, setValue } from "./config";
import { type DepsReport, buildReport, depsOk, localMissing, probeDeps } from "./deps";
import { fetchCmd } from "./fetch-cmd";
import { localInstall, localStatus } from "./local/install";
import { resolveInputPath } from "./paths";
import { resolveProvider } from "./asr/presets";
import { probeProviders } from "./asr/select";
import { sendToReadeck } from "./readeck";
import { finalizeSummary } from "./summary";
import { type Fetcher, type Platform, type Runner, UserError } from "./types";

export type CliDeps = {
  run: Runner; fetch: Fetcher; env: Record<string, string | undefined>; home: string; cwd: string; now: Date;
  platform: Platform; arch: "x64" | "arm64"; runtime: DepsReport["runtime"];
  has: (bin: string) => boolean; exists: (p: string) => boolean;
};

const USAGE =
  "usage: video-summary check | config path|get [key]|init [--force]|set <key> <json> | " +
  "fetch <url|path> [--no-diarize] [--force] [--accept-slow] | finalize <dir> | readeck <dir> | local install|status";
const NO_CONFIG = "no config — run setup (see references/setup.md)";

async function requireConfig(path: string, warnings?: string[]): Promise<Config> {
  const cfg = await loadConfig(path, warnings);
  if (!cfg) throw new UserError(NO_CONFIG);
  return cfg;
}

async function check(d: CliDeps, path: string): Promise<unknown> {
  const depsReport = buildReport(await probeDeps(d.run), d.platform, d.runtime, d.now, d.has);
  const config: { path: string; exists: boolean; valid: boolean; error?: string; warnings: string[] } =
    { path, exists: false, valid: false, warnings: [] };
  let cfg: Config | null = null;
  try {
    cfg = await loadConfig(path, config.warnings);
    config.exists = cfg !== null;
    config.valid = cfg !== null;
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    config.exists = await stat(path).then(() => true, () => false);
    config.error = e.message;
  }
  const resolved = cfg ? cfg.providers.map(resolveProvider) : [];
  // The local engine is checked only when a local provider is configured.
  const local = resolved.some((p) => p.type === "local") ? localStatus(d) : undefined;
  if (local) {
    depsReport.missing.push(...localMissing(local, resolved.some((p) => p.type === "local" && p.diarize)));
    depsReport.ok = depsOk(depsReport.missing);
  }
  const providers = (await probeProviders(resolved, d.fetch, d.env, d.home, local)).map((c) => ({
    name: c.provider.name, available: c.available, keyMissing: c.keyMissing,
  }));
  return {
    ok: depsReport.ok && config.exists && config.valid,
    runtime: d.runtime, deps: depsReport, config, providers,
    readeck: cfg?.readeck ? "configured" : "disabled",
  };
}

/** JSON value; a bare word is taken as a string, but text that looks like JSON must parse. */
function parseValue(key: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    if (/^\s*[[{"]/.test(text)) throw new UserError(`invalid JSON for ${key}: ${(e as Error).message}`);
    return text;
  }
}

async function configCmd(args: string[], d: CliDeps, path: string): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "path":
      return { path };
    case "get": {
      const cfg = await requireConfig(path);
      if (!rest[0]) return cfg;
      let v: unknown = cfg;
      for (const part of rest[0].split(".")) {
        if (typeof v !== "object" || v === null || !(part in v)) throw new UserError(`config: ${rest[0]}: unknown key`);
        v = (v as Record<string, unknown>)[part];
      }
      return { value: v };
    }
    case "init": {
      const exists = await stat(path).then(() => true, () => false);
      if (exists && !rest.includes("--force")) throw new UserError(`config exists: ${path} (use --force to overwrite)`);
      await saveConfig(path, DEFAULT_CONFIG);
      return { path, created: true };
    }
    case "set": {
      if (!rest[0] || rest[1] === undefined) throw new UserError(USAGE);
      const cfg = await requireConfig(path);
      const next = setValue(cfg, rest[0], parseValue(rest[0], rest[1]));
      await saveConfig(path, next);
      return { path, key: rest[0] };
    }
    default:
      throw new UserError(USAGE);
  }
}

export async function main(argv: string[], d: CliDeps): Promise<unknown> {
  const [cmd, ...rest] = argv;
  const path = configPath(d.env, d.home);
  switch (cmd) {
    case "check":
      return check(d, path);
    case "config":
      return configCmd(rest, d, path);
    case "fetch": {
      const src = rest.find((a) => !a.startsWith("--"));
      if (!src) throw new UserError(USAGE);
      const warnings: string[] = [];
      const cfg = await requireConfig(path, warnings);
      // --allow-cloud (v0.3 and older SKILL.md) is accepted and ignored, like any other unknown flag.
      const flags = {
        diarize: !rest.includes("--no-diarize"), force: rest.includes("--force"), acceptSlow: rest.includes("--accept-slow"),
      };
      return fetchCmd(src, flags, {
        run: d.run, fetch: d.fetch, cfg, env: d.env, now: d.now, cwd: d.cwd, home: d.home,
        platform: d.platform, arch: d.arch, exists: d.exists, has: d.has, warnings,
      });
    }
    case "finalize": {
      if (!rest[0]) throw new UserError(USAGE);
      return finalizeSummary(resolveInputPath(rest[0], d.cwd, d.home));
    }
    case "readeck": {
      if (!rest[0]) throw new UserError(USAGE);
      const cfg = await requireConfig(path);
      return sendToReadeck(resolveInputPath(rest[0], d.cwd, d.home), { readeck: cfg.readeck, fetch: d.fetch, env: d.env, home: d.home, run: d.run });
    }
    case "local": {
      // No config needed: install/status depend only on the machine.
      if (rest[0] === "install") return localInstall(d);
      if (rest[0] === "status") return localStatus(d);
      throw new UserError(USAGE);
    }
    default:
      throw new UserError(USAGE);
  }
}
