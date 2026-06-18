import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Cross-platform path resolution for runtime/daemon state.
 *
 * Data dir precedence: `FUSION_HOME` env → `~/.fusion` (works on macOS, Linux,
 * and Windows where homedir() resolves to %USERPROFILE%). Everything is built
 * with path.join so there is no hard-coded separator.
 */
export function dataDir(): string {
  const override = process.env.FUSION_HOME?.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(homedir(), ".fusion");
}

export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const pidFile = (): string => join(dataDir(), "fusion.pid");
export const portFile = (): string => join(dataDir(), "fusion.port");
export const logFile = (): string => join(dataDir(), "fusion.log");
export const errLogFile = (): string => join(dataDir(), "fusion.err.log");

/** Candidate locations for the config file, in priority order. */
export function configCandidates(): string[] {
  const explicit = process.env.FUSION_CONFIG?.trim();
  const candidates: string[] = [];
  if (explicit) candidates.push(isAbsolute(explicit) ? explicit : resolve(explicit));
  candidates.push(resolve(process.cwd(), "config.yaml"));
  candidates.push(resolve(process.cwd(), "config.local.yaml"));
  candidates.push(join(dataDir(), "config.yaml"));
  return candidates;
}

/** Codex auth/cache directory (`CODEX_HOME` → `~/.codex`). */
export function codexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(homedir(), ".codex");
}

export const codexAuthFile = (): string => join(codexHome(), "auth.json");
export const codexModelsCacheFile = (): string => join(codexHome(), "models_cache.json");
