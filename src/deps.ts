import type { Platform, Runner } from "./types";

export type DepName = "yt-dlp" | "yt-dlp-ejs" | "ffmpeg" | "ffprobe" | "parakeet" | "libvulkan1";
export type DepStatus = { name: DepName; found: boolean; version: string | null };
export type DepsReport = {
  ok: boolean;
  platform: Platform;
  runtime: { name: "bun" | "node"; version: string };
  missing: { name: DepName; install: string; needsSudo: boolean; note?: string }[];
  stale: { name: "yt-dlp"; version: string; ageDays: number; upgrade: string; needsSudo: boolean; note?: string }[];
};

const STALE_DAYS = 60;
const YTDLP = '"yt-dlp[default]"';
/** A fresh pipx puts its apps in ~/.local/bin, which may not be on PATH yet. */
const PIPX_NOTE = "pipx installs into ~/.local/bin: if yt-dlp is not found afterwards, run `pipx ensurepath` and open a new shell (or re-login)";

type Probe = { name: DepName; cmd: string[]; parse: (r: { stdout: string; stderr: string }) => string | null; anyExit?: boolean };

const PROBES: Probe[] = [
  { name: "yt-dlp", cmd: ["yt-dlp", "--version"], parse: (r) => r.stdout.trim() || null },
  {
    // `yt-dlp -v --simulate` without a URL exits non-zero but still prints the debug line to stderr.
    name: "yt-dlp-ejs",
    cmd: ["yt-dlp", "-v", "--simulate"],
    parse: (r) => r.stderr.match(/Optional libraries:.*?\byt_dlp_ejs-([^\s,]+)/)?.[1] ?? null,
    anyExit: true,
  },
  { name: "ffmpeg", cmd: ["ffmpeg", "-version"], parse: (r) => r.stdout.match(/^ffmpeg version (\S+)/)?.[1] ?? null },
  { name: "ffprobe", cmd: ["ffprobe", "-version"], parse: (r) => r.stdout.match(/^ffprobe version (\S+)/)?.[1] ?? null },
];

export async function probeDeps(run: Runner): Promise<DepStatus[]> {
  return Promise.all(
    PROBES.map(async (p) => {
      const r = await run(p.cmd);
      if (r.code === 127 || (r.code !== 0 && !p.anyExit)) return { name: p.name, found: false, version: null };
      const version = p.parse(r);
      return p.anyExit
        ? { name: p.name, found: version !== null, version }
        : { name: p.name, found: true, version };
    }),
  );
}

/** "apt-pipx": Linux without uv/pipx. pip --user is blocked by PEP 668 on Ubuntu 24.04+/Debian 12. */
type Manager = "uv" | "pipx" | "brew" | "apt-pipx";

function pickManager(platform: Platform, has: (bin: string) => boolean): Manager {
  if (has("uv")) return "uv";
  if (has("pipx")) return "pipx";
  return platform === "darwin" ? "brew" : "apt-pipx";
}

function ytdlpInstall(m: Manager): string {
  return {
    uv: `uv tool install ${YTDLP}`,
    pipx: `pipx install ${YTDLP}`,
    brew: "brew install yt-dlp",
    "apt-pipx": `sudo apt install pipx && pipx install ${YTDLP}`,
  }[m];
}

/** yt-dlp is present but yt-dlp-ejs is not: reinstall with the [default] extra. */
function ytdlpReinstall(m: Manager): string {
  return {
    uv: `uv tool install --force ${YTDLP}`,
    pipx: `pipx install --force ${YTDLP}`,
    brew: "brew upgrade yt-dlp",
    "apt-pipx": `sudo apt install pipx && pipx install --force ${YTDLP}`,
  }[m];
}

function ytdlpUpgrade(m: Manager): string {
  return {
    uv: "uv tool upgrade yt-dlp",
    pipx: "pipx upgrade yt-dlp",
    brew: "brew upgrade yt-dlp",
    // No pipx yet: install it, then (re)install yt-dlp through it.
    "apt-pipx": `sudo apt install pipx && pipx install --force ${YTDLP}`,
  }[m];
}

/** yt-dlp version is a date YYYY.MM.DD (optional .N suffix). */
function ytdlpAgeDays(version: string, today: Date): number | null {
  const m = version.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const released = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((now - released) / 86_400_000);
}

export function buildReport(
  statuses: DepStatus[],
  platform: Platform,
  runtime: DepsReport["runtime"],
  today: Date,
  has: (bin: string) => boolean,
): DepsReport {
  const mgr = pickManager(platform, has);
  const found = (n: DepName) => statuses.find((s) => s.name === n)?.found ?? false;
  const missing: DepsReport["missing"] = [];
  const add = (item: DepsReport["missing"][number]) => {
    if (!missing.some((m) => m.install === item.install)) missing.push(item);
  };
  const sudo = mgr === "apt-pipx";
  const pipxHint = sudo ? { needsSudo: true, note: PIPX_NOTE } : { needsSudo: false };
  if (!found("yt-dlp")) add({ name: "yt-dlp", install: ytdlpInstall(mgr), ...pipxHint });
  else if (!found("yt-dlp-ejs")) add({ name: "yt-dlp-ejs", install: ytdlpReinstall(mgr), ...pipxHint });
  if (!found("ffmpeg") || !found("ffprobe")) {
    add({
      name: "ffmpeg",
      install: platform === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg",
      needsSudo: platform !== "darwin",
    });
  }
  const stale: DepsReport["stale"] = [];
  const yt = statuses.find((s) => s.name === "yt-dlp");
  if (yt?.found && yt.version) {
    const age = ytdlpAgeDays(yt.version, today);
    if (age !== null && age > STALE_DAYS) {
      stale.push({ name: "yt-dlp", version: yt.version, ageDays: age, upgrade: ytdlpUpgrade(mgr), ...pipxHint });
    }
  }
  return { ok: missing.length === 0, platform, runtime, missing, stale };
}

/** Missing pieces of a configured local provider, from `localStatus`. */
export function localMissing(s: { installed: boolean; hint?: string }): DepsReport["missing"] {
  const out: DepsReport["missing"] = [];
  if (!s.installed) {
    out.push({ name: "parakeet", install: "sh <skill-dir>/scripts/video-summary local install", needsSudo: false, note: "~0.9 GB download" });
  }
  if (s.hint) {
    out.push({ name: "libvulkan1", install: "sudo apt install libvulkan1", needsSudo: true, note: "enables GPU recognition; run local install again afterwards" });
  }
  return out;
}
