import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Runner } from "./types";

/**
 * Run an external command. A missing binary yields code 127, not an exception.
 * `env` is merged over process.env. On `timeoutMs` the child gets SIGTERM
 * (SIGKILL 5 s later) and the result has code 124.
 */
export const run: Runner = (cmd, opts) =>
  new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin!, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs !== undefined) {
      termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, opts.timeoutMs);
    }
    const clearTimers = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    };
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimers();
      resolve({ code: 127, stdout: "", stderr: `${bin}: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimers();
      if (timedOut) {
        const secs = (opts?.timeoutMs ?? 0) / 1000;
        resolve({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${secs} s` });
      } else {
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });

/** True if an executable named `bin` exists in a PATH directory (no shell spawn). */
export function has(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}
