import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { pidFile, portFile } from "../config/paths.js";

export function writePidFiles(pid: number, port: number): void {
  writeFileSync(pidFile(), String(pid), "utf8");
  writeFileSync(portFile(), String(port), "utf8");
}

export function readPid(): number | null {
  try {
    const n = Number(readFileSync(pidFile(), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function readPort(): number | null {
  try {
    const n = Number(readFileSync(portFile(), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function clearPidFiles(): void {
  for (const f of [pidFile(), portFile()]) {
    try {
      rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
}
