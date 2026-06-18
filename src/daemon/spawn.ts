import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDataDir, errLogFile, logFile } from "../config/paths.js";
import { writePidFiles } from "./pidfile.js";

/** Path to the compiled CLI entry (dist/cli.js), resolved from dist/daemon/. */
function cliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "cli.js");
}

/**
 * Spawn the server as a detached background process with stdout/stderr
 * redirected to log files, then record its pid + port. Works on all platforms
 * (no native daemonizer).
 */
export function spawnDaemon(port: number, configPath?: string): number {
  ensureDataDir();
  const out = openSync(logFile(), "a");
  const err = openSync(errLogFile(), "a");
  const args = ["run", "--port", String(port)];
  if (configPath) args.push("--config", configPath);
  const child = spawn(process.execPath, [cliEntry(), ...args], {
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error("Failed to spawn fusion daemon");
  writePidFiles(child.pid, port);
  return child.pid;
}
