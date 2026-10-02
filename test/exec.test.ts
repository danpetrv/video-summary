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

test("has: finds executables in PATH, not missing ones", () => {
  expect(has("sh")).toBe(true);
  expect(has("definitely-not-a-binary-xyz")).toBe(false);
});
