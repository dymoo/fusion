import { spawnSync } from "node:child_process";

/** Cross-platform liveness check: signal 0 probes without sending a signal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we cannot signal it (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Terminate a process tree cross-platform. SIGTERM first; on Windows (or if the
 * process survives) fall back to taskkill /T /F, on POSIX to SIGKILL.
 */
export async function killProcess(pid: number, graceMs = 5000): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isAlive(pid);
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(150);
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await delay(300);
  return !isAlive(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
