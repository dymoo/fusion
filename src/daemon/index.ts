import type { FusionConfig } from "../config/schema.js";
import { fetchWithTimeout } from "../util/http-fetch.js";
import { clearPidFiles, readPid, readPort, writePidFiles } from "./pidfile.js";
import { isAlive, killProcess } from "./process.js";
import { spawnDaemon } from "./spawn.js";

export interface DaemonResult {
  ok: boolean;
  message: string;
}

async function probeHealth(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`http://${host}:${port}/health`, { timeoutMs });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startDaemon(
  config: FusionConfig,
  port: number,
  configPath?: string,
): Promise<DaemonResult> {
  const existing = readPid();
  if (existing && isAlive(existing)) {
    return { ok: true, message: `fusion already running (pid ${existing})` };
  }
  clearPidFiles();
  const pid = spawnDaemon(port, configPath);
  // poll health for up to ~6s
  for (let i = 0; i < 40; i++) {
    if (await probeHealth(config.server.host, port)) {
      return {
        ok: true,
        message: `fusion started (pid ${pid}, http://${config.server.host}:${port})`,
      };
    }
    if (!isAlive(pid)) {
      return {
        ok: false,
        message: `fusion process exited during startup; check logs (\`fusion logs\`)`,
      };
    }
    await delay(150);
  }
  return { ok: false, message: "fusion did not become healthy in time; check `fusion logs`" };
}

export async function stopDaemon(): Promise<DaemonResult> {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    clearPidFiles();
    return { ok: true, message: "fusion is not running" };
  }
  const killed = await killProcess(pid);
  clearPidFiles();
  return killed
    ? { ok: true, message: `fusion stopped (pid ${pid})` }
    : { ok: false, message: `failed to stop fusion (pid ${pid})` };
}

export async function statusDaemon(config: FusionConfig): Promise<DaemonResult> {
  const pid = readPid();
  const port = readPort() ?? config.server.port;
  if (!pid) return { ok: false, message: "fusion is not running (no pidfile)" };
  if (!isAlive(pid))
    return { ok: false, message: `stale pidfile (pid ${pid} not alive); run \`fusion stop\`` };
  const healthy = await probeHealth(config.server.host, port);
  return {
    ok: healthy,
    message: `fusion running (pid ${pid}, port ${port}, health ${healthy ? "ok" : "unreachable"})`,
  };
}

export async function restartDaemon(
  config: FusionConfig,
  port: number,
  configPath?: string,
): Promise<DaemonResult> {
  await stopDaemon();
  await delay(300);
  return startDaemon(config, port, configPath);
}

/** Mark this process as the running daemon (used by `fusion run`). */
export function registerForeground(port: number): void {
  writePidFiles(process.pid, port);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
