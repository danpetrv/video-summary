import { join } from "node:path";
import { type BuildId, MODEL, PARAKEET_VERSION } from "./pins";

export type LocalPaths = { binDir(build: BuildId): string; cli(build: BuildId): string; model: string; speedFile: string };

/** XDG locations (same layout on macOS); an empty variable counts as unset. */
export function localPaths(env: Record<string, string | undefined>, home: string): LocalPaths {
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  const cache = env.XDG_CACHE_HOME || join(home, ".cache");
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  const binDir = (build: BuildId) => join(data, "video-summary", "parakeet", PARAKEET_VERSION, build);
  return {
    binDir,
    cli: (build) => join(binDir(build), "parakeet-cli"),
    model: join(cache, "video-summary", "models", MODEL.file),
    speedFile: join(state, "video-summary", "speed.json"),
  };
}
