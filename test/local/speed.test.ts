import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProvider } from "../../src/asr/presets";
import { localPaths } from "../../src/local/paths";
import { estimateLocal, readSpeeds, recordSpeed, speedKey } from "../../src/local/speed";

const root = mkdtempSync(join(tmpdir(), "vs-speed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const speedFile = () => localPaths({ XDG_STATE_HOME: join(root, `s${n++}`) }, root).speedFile;
const loc = resolveProvider({ name: "local", type: "local", engine: "parakeet", model: "ultra", device: "auto", diarize: true });

test("speedKey: parakeet:ultra:<gpu|cpu>", () => {
  expect(speedKey(loc, "cpu")).toBe("parakeet:ultra:cpu");
  expect(speedKey(loc, "gpu")).toBe("parakeet:ultra:gpu");
});

test("estimateLocal: defaults CPU 8x / GPU 60x when nothing is measured", () => {
  expect(estimateLocal(loc, 5400, {}, "cpu")).toEqual({ minutes: 11.25, device: "cpu", speed: 8 });
  expect(estimateLocal(loc, 5400, {}, "gpu")).toEqual({ minutes: 1.5, device: "gpu", speed: 60 });
  // a measured speed for the planned device wins; the other device's does not count
  expect(estimateLocal(loc, 5400, { "parakeet:ultra:cpu": 30 }, "cpu")).toEqual({ minutes: 3, device: "cpu", speed: 30 });
  expect(estimateLocal(loc, 5400, { "parakeet:ultra:cpu": 30 }, "gpu").speed).toBe(60);
});

test("readSpeeds: missing file -> {}", async () => {
  expect(await readSpeeds(speedFile())).toEqual({});
});

test("recordSpeed: first measurement stored as is, then new = 0.5*old + 0.5*measured under the key", async () => {
  const file = speedFile();
  await recordSpeed(file, "parakeet:ultra:cpu", 20);
  expect(await readSpeeds(file)).toEqual({ "parakeet:ultra:cpu": 20 });
  await recordSpeed(file, "parakeet:ultra:cpu", 40);
  expect(await readSpeeds(file)).toEqual({ "parakeet:ultra:cpu": 30 });
  await recordSpeed(file, "parakeet:ultra:gpu", 100);
  expect(await readSpeeds(file)).toEqual({ "parakeet:ultra:cpu": 30, "parakeet:ultra:gpu": 100 });
  // atomic write: no temporary files left next to speed.json
  expect(readdirSync(dirname(file))).toEqual(["speed.json"]);
});

test("broken speed.json is ignored and overwritten", async () => {
  for (const broken of ["{not json", "[1,2]", "null", JSON.stringify({ "parakeet:ultra:cpu": "fast", "parakeet:ultra:gpu": -3 })]) {
    const file = speedFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, broken);
    expect(await readSpeeds(file)).toEqual({});
    await recordSpeed(file, "parakeet:ultra:cpu", 12);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "parakeet:ultra:cpu": 12 });
  }
});
