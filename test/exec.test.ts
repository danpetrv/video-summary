import { expect, test } from "bun:test";
import { has, run } from "../src/exec";

test("run: captures stdout and code", async () => {
  const r = await run(["sh", "-c", "echo hi; echo err >&2; exit 3"]);
  expect(r).toEqual({ code: 3, stdout: "hi\n", stderr: "err\n" });
});

test("run: missing binary -> code 127", async () => {
  const r = await run(["definitely-not-a-binary-xyz"]);
  expect(r.code).toBe(127);
  expect(r.stdout).toBe("");
});

test("run: env is passed to the child", async () => {
  const r = await run(["sh", "-c", 'printf %s "$VS_X"'], { env: { VS_X: "42" } });
  expect(r.stdout).toBe("42");
});

test("run: timeoutMs kills the child and returns code 124", async () => {
  const t0 = Date.now();
  const r = await run(["sleep", "5"], { timeoutMs: 200 });
  expect(r.code).toBe(124);
  expect(r.stderr).toContain("timed out after 0.2 s");
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("has: finds executables in PATH, not missing ones", () => {
  expect(has("sh")).toBe(true);
  expect(has("definitely-not-a-binary-xyz")).toBe(false);
});
