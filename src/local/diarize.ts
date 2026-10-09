import { statSync } from "node:fs";
import type { LocalPaths } from "./paths";
import { DIAR_MODEL } from "./pins";

/** The diarization model is in place with exactly the pinned size. No hashing: `local install` verified it. */
export function diarModelReady(paths: LocalPaths, size: number = DIAR_MODEL.size): boolean {
  try {
    return statSync(paths.diarModel).size === size;
  } catch {
    return false;
  }
}
