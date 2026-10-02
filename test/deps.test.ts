import { expect, test } from "bun:test";
import { buildReport, probeDeps, type DepName } from "../src/deps";
import type { Runner } from "../src/types";

const all = (o: Partial<Record<DepName, string | null>>) =>
  (["yt-dlp", "yt-dlp-ejs", "ffmpeg", "ffprobe"] as DepName[]).map((n) => ({
    name: n,
    found: o[n] !== null,
    version: o[n] === null ? null : (o[n] ?? "1"),
  }));
const today = new Date("2026-10-02");
const rt = { name: "bun" as const, version: "1.4.2" };
const hasOnly = (...bins: string[]) => (b: string) => bins.includes(b);
const UV = hasOnly("uv");
const PIPX_NOTE = "pipx installs into ~/.local/bin: if yt-dlp is not found afterwards, run `pipx ensurepath` and open a new shell (or re-login)";

test("all present and fresh -> ok", () => {
  const r = buildReport(all({ "yt-dlp": "2026.08.19" }), "linux", rt, today, UV);
  expect(r).toEqual({ ok: true, platform: "linux", runtime: rt, missing: [], stale: [] });
});

test("runtime is passed through as is", () => {
  const node = { name: "node" as const, version: "v22.3.0" };
  expect(buildReport(all({ "yt-dlp": "2026.08.19" }), "darwin", node, today, UV).runtime).toEqual(node);
});

test("linux: ffmpeg via sudo apt, yt-dlp via uv; yt-dlp-ejs not duplicated", () => {
  const r = buildReport(
    all({ "yt-dlp": null, "yt-dlp-ejs": null, ffmpeg: null, ffprobe: null }),
    "linux",
    rt,
    today,
    UV,
  );
  expect(r.ok).toBe(false);
  expect(r.missing).toContainEqual({ name: "yt-dlp", install: 'uv tool install "yt-dlp[default]"', needsSudo: false });
  expect(r.missing).toContainEqual({ name: "ffmpeg", install: "sudo apt install ffmpeg", needsSudo: true });
  expect(r.missing.length).toBe(2);
});

test("only ffprobe missing -> ffmpeg once", () => {
  const r = buildReport(all({ "yt-dlp": "2026.08.19", ffprobe: null }), "linux", rt, today, UV);
  expect(r.missing).toEqual([{ name: "ffmpeg", install: "sudo apt install ffmpeg", needsSudo: true }]);
});

test("darwin: ffmpeg via brew", () => {
  const r = buildReport(all({ "yt-dlp": "2026.08.19", ffmpeg: null }), "darwin", rt, today, UV);
  expect(r.missing).toContainEqual({ name: "ffmpeg", install: "brew install ffmpeg", needsSudo: false });
});

test("yt-dlp install: uv, else pipx, else brew (darwin), else apt pipx with sudo (linux, PEP 668)", () => {
  const miss = (platform: "linux" | "darwin", has: (b: string) => boolean) =>
    buildReport(all({ "yt-dlp": null, "yt-dlp-ejs": null }), platform, rt, today, has).missing[0]!.install;
  expect(miss("linux", hasOnly("uv", "pipx"))).toBe('uv tool install "yt-dlp[default]"');
  expect(miss("linux", hasOnly("pipx"))).toBe('pipx install "yt-dlp[default]"');
  expect(miss("darwin", hasOnly())).toBe("brew install yt-dlp");
  expect(miss("linux", hasOnly())).toBe('sudo apt install pipx && pipx install "yt-dlp[default]"');
  const linux = buildReport(all({ "yt-dlp": null, "yt-dlp-ejs": null }), "linux", rt, today, hasOnly()).missing[0]!;
  expect(linux.needsSudo).toBe(true);
  expect(linux.note).toBe(PIPX_NOTE);
  expect(buildReport(all({ "yt-dlp": null, "yt-dlp-ejs": null }), "linux", rt, today, UV).missing[0]).not.toHaveProperty("note");
  expect(buildReport(all({ "yt-dlp": null, "yt-dlp-ejs": null }), "linux", rt, today, hasOnly("pipx")).missing[0]!.needsSudo).toBe(false);
});

test("yt-dlp-ejs missing while yt-dlp present -> reinstall with extra via same manager", () => {
  const r = (has: (b: string) => boolean, p: "linux" | "darwin" = "linux") =>
    buildReport(all({ "yt-dlp": "2026.08.19", "yt-dlp-ejs": null }), p, rt, today, has);
  expect(r(UV).ok).toBe(false);
  expect(r(UV).missing).toEqual([
    { name: "yt-dlp-ejs", install: 'uv tool install --force "yt-dlp[default]"', needsSudo: false },
  ]);
  expect(r(hasOnly("pipx")).missing[0]!.install).toBe('pipx install --force "yt-dlp[default]"');
  expect(r(hasOnly(), "linux").missing[0]).toEqual({
    name: "yt-dlp-ejs", install: 'sudo apt install pipx && pipx install --force "yt-dlp[default]"', needsSudo: true, note: PIPX_NOTE,
  });
  expect(r(hasOnly(), "darwin").missing[0]!.install).toBe("brew upgrade yt-dlp");
});

test("stale: upgrade command matches the manager", () => {
  const up = (has: (b: string) => boolean, p: "linux" | "darwin" = "linux") =>
    buildReport(all({ "yt-dlp": "2026.07.01" }), p, rt, today, has).stale;
  expect(up(UV)).toEqual([{ name: "yt-dlp", version: "2026.07.01", ageDays: 93, upgrade: "uv tool upgrade yt-dlp", needsSudo: false }]);
  expect(up(hasOnly("pipx"))[0]!.upgrade).toBe("pipx upgrade yt-dlp");
  expect(up(hasOnly(), "darwin")[0]!.upgrade).toBe("brew upgrade yt-dlp");
});

test("stale on Linux without uv/pipx: install pipx first (sudo), note about ~/.local/bin", () => {
  const s = buildReport(all({ "yt-dlp": "2026.07.01" }), "linux", rt, today, hasOnly()).stale;
  expect(s).toEqual([{
    name: "yt-dlp", version: "2026.07.01", ageDays: 93,
    upgrade: 'sudo apt install pipx && pipx install --force "yt-dlp[default]"', needsSudo: true, note: PIPX_NOTE,
  }]);
  expect(buildReport(all({ "yt-dlp": "2026.07.01" }), "linux", rt, today, UV).ok).toBe(true);
});

test("patch-suffix version 2026.08.19.1 parses", () => {
  expect(buildReport(all({ "yt-dlp": "2026.08.19.1" }), "linux", rt, today, UV).stale).toEqual([]);
  expect(buildReport(all({ "yt-dlp": "2026.01.01.1" }), "linux", rt, today, UV).stale.length).toBe(1);
});

test("probeDeps: missing command -> found:false, versions parsed", async () => {
  const run: Runner = async (cmd) => {
    if (cmd[0] === "ffmpeg") return { code: 127, stdout: "", stderr: "not found" };
    if (cmd[0] === "yt-dlp" && cmd[1] === "-v")
      return { code: 2, stdout: "", stderr: "[debug] Optional libraries: certifi-1, yt_dlp_ejs-0.8.0, urllib3-2\nUsage: ..." };
    const out: Record<string, string> = {
      "yt-dlp": "2026.08.19\n",
      ffprobe: "ffprobe version 8.0.1-3ubuntu2 Copyright\n",
    };
    return { code: 0, stdout: out[cmd[0]!] ?? "", stderr: "" };
  };
  expect(await probeDeps(run)).toEqual([
    { name: "yt-dlp", found: true, version: "2026.08.19" },
    { name: "yt-dlp-ejs", found: true, version: "0.8.0" },
    { name: "ffmpeg", found: false, version: null },
    { name: "ffprobe", found: true, version: "8.0.1-3ubuntu2" },
  ]);
});

test("yt-dlp-ejs: found:false when absent from Optional libraries or yt-dlp missing", async () => {
  const noEjs: Runner = async (cmd) =>
    cmd[1] === "-v"
      ? { code: 2, stdout: "", stderr: "[debug] Optional libraries: certifi-1, urllib3-2" }
      : { code: 0, stdout: "2026.08.19\n", stderr: "" };
  expect((await probeDeps(noEjs))[1]).toEqual({ name: "yt-dlp-ejs", found: false, version: null });
  const none: Runner = async () => ({ code: 127, stdout: "", stderr: "nf" });
  expect((await probeDeps(none)).every((s) => !s.found)).toBe(true);
});
