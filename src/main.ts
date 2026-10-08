import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { main } from "./cli";
import { UserError } from "./types";
import { has, run } from "./exec";
import { runtimeFetch } from "./net";

try {
  const out = await main(process.argv.slice(2), {
    // One client for every command: Bun's fetch, or node:http(s) on Node (no 300 s headers limit).
    run, fetch: runtimeFetch(process.versions), env: process.env, home: homedir(), cwd: process.cwd(), now: new Date(),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    runtime: process.versions.bun
      ? { name: "bun", version: process.versions.bun }
      : { name: "node", version: process.versions.node },
    has, exists: existsSync,
  });
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e instanceof UserError ? e.message : `Unexpected error: ${(e as Error).message}`);
  process.exit(1);
}
