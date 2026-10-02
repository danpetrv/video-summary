import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const launcher = resolve(import.meta.dir, "../skills/video-summary/scripts/video-summary");
let root: string;
const real: Record<string, string> = {};

function which(bin: string): string {
  const r = Bun.spawnSync(["sh", "-c", `command -v ${bin}`]);
  return r.stdout.toString().trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vs-launcher-"));
  for (const b of ["sh", "sed", "dirname", "cat"]) real[b] = which(b);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** PATH dir with symlinks to a minimal set of tools plus the requested fakes. */
function makePath(name: string, fakes: { bun?: boolean; node?: string }): string {
  const d = join(root, name);
  mkdirSync(d);
  for (const [b, p] of Object.entries(real)) symlinkSync(p, join(d, b));
  if (fakes.bun) {
    writeFileSync(join(d, "bun"), '#!/bin/sh\necho "bun $*"\n');
    chmodSync(join(d, "bun"), 0o755);
  }
  if (fakes.node) {
    writeFileSync(join(d, "node"), `#!/bin/sh\nif [ "$1" = "-v" ]; then echo ${fakes.node}; else echo "node $*"; fi\n`);
    chmodSync(join(d, "node"), 0o755);
  }
  return d;
}

function launch(path: string) {
  const r = Bun.spawnSync([real.sh!, launcher, "check"], { env: { PATH: path } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

const INSTALL = [
  "curl -fsSL https://bun.sh/install | bash",
  "brew install oven-sh/bun/bun",
  "brew install node",
  "fnm install --lts",
];

test("bun in PATH -> exec bun <dir>/video-summary.mjs check", () => {
  const r = launch(makePath("a", { bun: true, node: "v18.0.0" }));
  expect(r.code).toBe(0);
  expect(r.out).toBe(`bun ${resolve(launcher, "..")}/video-summary.mjs check`);
});

test("no bun, node v22.3.0 -> exec node ...mjs", () => {
  const r = launch(makePath("b", { node: "v22.3.0" }));
  expect(r.code).toBe(0);
  expect(r.out).toBe(`node ${resolve(launcher, "..")}/video-summary.mjs check`);
});

test("no bun, node v18.20.0 -> unsupported JSON, code 1", () => {
  const r = launch(makePath("c", { node: "v18.20.0" }));
  expect(r.code).toBe(1);
  expect(JSON.parse(r.out)).toEqual({ ok: false, runtime: "unsupported", found: "node v18.20.0", install: INSTALL });
});

test("neither bun nor node -> missing JSON, code 1", () => {
  const r = launch(makePath("d", {}));
  expect(r.code).toBe(1);
  expect(JSON.parse(r.out)).toEqual({ ok: false, runtime: "missing", install: INSTALL });
});
