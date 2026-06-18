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

/** Ensure every pool/tier references a declared upstream id (or pool/panel). */
function validateReferences(config: FusionConfig): void {
  const ids = new Set(config.upstreams.map((u) => u.id));
  const missing: string[] = [];
  const checkPool = (label: string, members: readonly string[] | undefined): void => {
    for (const id of members ?? []) {
      if (!ids.has(id)) missing.push(`${label} → "${id}"`);
    }
  };
  checkPool("pools.orchestrator", config.pools.orchestrator);
  checkPool("pools.compact", config.pools.compact);
  checkPool("pools.regular", config.pools.regular);
  checkPool("pools.actor", config.pools.actor);
  for (const [name, members] of Object.entries(config.pools.panel)) {
    checkPool(`pools.panel.${name}`, members);
  }

  // Council advisors must resolve to a declared panel when enabled.
  if (config.routing.council.enabled) {
    const panel = config.routing.council.panel;
    if (!(panel in config.pools.panel)) {
      missing.push(`routing.council.panel → "${panel}" (no such panel)`);
    }
  }

  // Smart tier targets must resolve to a configured pool / panel.
  const singlePoolNames = new Set(["orchestrator", "compact", "regular", "actor"]);
  const { tiers } = config.routing.smart;
  const compactPool = tiers.compact.pool;
  const regularPool = tiers.regular.pool;
  const planPanel = tiers.plan.panel;
  if (config.pools.compact === undefined && compactPool === "compact") {
    // ok: falls back to orchestrator[0] at runtime
  } else if (!singlePoolNames.has(compactPool)) {
    missing.push(`routing.smart.tiers.compact.pool → "${compactPool}" (not a single-route pool)`);
  }
  if (config.pools.regular === undefined && regularPool === "regular") {
    // ok: falls back to orchestrator slice at runtime
  } else if (!singlePoolNames.has(regularPool)) {
    missing.push(`routing.smart.tiers.regular.pool → "${regularPool}" (not a single-route pool)`);
  }
  if (Object.keys(config.pools.panel).length > 0 && !(planPanel in config.pools.panel)) {
    missing.push(`routing.smart.tiers.plan.panel → "${planPanel}" (no such panel)`);
  }

  if (missing.length > 0) {
    throw new ConfigError(`Config references unknown ids:\n  ${missing.join("\n  ")}`);
  }
}

export function loadConfig(explicitPath?: string): { config: FusionConfig; path: string } {
  const path = resolveConfigPath(explicitPath);
  const source = readFileSync(path, "utf8");
  return { config: parseConfig(source), path };
}
