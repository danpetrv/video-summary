import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalProvider } from "../asr/providers";
import type { SlowEstimate } from "../asr/select";

/** A local run expected to take longer than this needs `--accept-slow`. */
export const SLOW_MINUTES = 10;

/** Conservative speeds (audio seconds per wall second) until a run on this machine is measured. */
const DEFAULT_SPEED: Record<"gpu" | "cpu", number> = { cpu: 8, gpu: 60 };

/** Same for the diarization pass (`parakeet-cli scene`), which has its own speed. */
const DEFAULT_DIAR_SPEED: Record<"gpu" | "cpu", number> = { cpu: 16, gpu: 100 };

export const speedKey = (p: LocalProvider, device: "gpu" | "cpu"): string => `${p.engine}:${p.model}:${device}`;

export const diarSpeedKey = (device: "gpu" | "cpu"): string => `parakeet:diar:${device}`;

/** Measured speeds by key; a missing or broken file (or a bad entry) counts as nothing measured. */
export async function readSpeeds(file: string): Promise<Record<string, number>> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0),
  );
}

/**
 * Blend a new measurement into the stored speed: new = 0.5·old + 0.5·measured (the first one is stored
 * as is). Written to a temporary file and renamed, so a concurrent reader never sees half a file.
 */
export async function recordSpeed(file: string, key: string, measured: number): Promise<void> {
  const speeds = await readSpeeds(file);
  const old = speeds[key];
  speeds[key] = old === undefined ? measured : 0.5 * old + 0.5 * measured;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(speeds, null, 2) + "\n");
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Expected wall time of a local run on the device it is planned to use. With `diarize` the diarization
 * pass is added and `withoutDiarization` keeps the recognition-only time; `speed` stays the recognition speed.
 */
export function estimateLocal(
  p: LocalProvider, durationSec: number, speeds: Record<string, number>, plannedDevice: "gpu" | "cpu", diarize: boolean,
): SlowEstimate {
  const speed = speeds[speedKey(p, plannedDevice)] ?? DEFAULT_SPEED[plannedDevice];
  const minutes = durationSec / speed / 60;
  if (!diarize) return { minutes, device: plannedDevice, speed };
  const diarSpeed = speeds[diarSpeedKey(plannedDevice)] ?? DEFAULT_DIAR_SPEED[plannedDevice];
  return { minutes: minutes + durationSec / diarSpeed / 60, device: plannedDevice, speed, withoutDiarization: minutes };
}
