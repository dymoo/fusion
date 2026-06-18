import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { type FusionConfig, fusionConfigSchema } from "./schema.js";
import { configCandidates } from "./paths.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Find the first existing config candidate, or throw with guidance. */
export function resolveConfigPath(explicitPath?: string): string {
  const candidates = explicitPath ? [explicitPath] : configCandidates();
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // try next
    }
  }
  throw new ConfigError(
    `No config file found. Looked in:\n  ${candidates.join("\n  ")}\n` +
      `Copy config.example.yaml to config.yaml (or set FUSION_CONFIG).`,
  );
}

/** Shallow env-var overrides applied on top of the parsed YAML before validation. */
function applyEnvOverrides(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const server = { ...((obj.server as Record<string, unknown> | undefined) ?? {}) };

  const port = process.env.FUSION_PORT?.trim();
  if (port) server.port = Number(port);

  const host = process.env.FUSION_HOST?.trim();
  if (host) server.host = host;

  const authKey = process.env.FUSION_AUTH_KEY?.trim();
  if (authKey) server.authKey = authKey;

  return { ...obj, server };
}

export function parseConfig(source: string): FusionConfig {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML config: ${(err as Error).message}`);
  }
  const withEnv = applyEnvOverrides(raw);
  const parsed = fusionConfigSchema.safeParse(withEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config:\n${issues}`);
  }
  validateReferences(parsed.data);
  return parsed.data;
}

/** Ensure every pool references a declared upstream id. */
function validateReferences(config: FusionConfig): void {
  const ids = new Set(config.upstreams.map((u) => u.id));
  const missing: string[] = [];
  for (const id of config.pools.orchestrator) {
    if (!ids.has(id)) missing.push(`pools.orchestrator → "${id}"`);
  }
  for (const [name, members] of Object.entries(config.pools.panel)) {
    for (const id of members) {
      if (!ids.has(id)) missing.push(`pools.panel.${name} → "${id}"`);
    }
  }
  const judge = config.routing.escalation.routerJudge?.upstreamId;
  if (judge && !ids.has(judge)) missing.push(`routing.escalation.routerJudge → "${judge}"`);
  if (missing.length > 0) {
    throw new ConfigError(`Config references unknown upstream ids:\n  ${missing.join("\n  ")}`);
  }
}

export function loadConfig(explicitPath?: string): { config: FusionConfig; path: string } {
  const path = resolveConfigPath(explicitPath);
  const source = readFileSync(path, "utf8");
  return { config: parseConfig(source), path };
}
