import { z } from "zod";

import { capabilityOverridesSchema } from "../capabilities/types.js";

export const PROVIDER_KINDS = [
  "openai",
  "openai-compatible",
  "anthropic",
  "codex",
  "ollama",
] as const;

export const providerKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const upstreamConfigSchema = z.object({
  /** Unique id; referenced by the routing pools. */
  id: z.string().min(1),
  type: providerKindSchema,
  /** Base URL. Optional for codex (fixed backend) and ollama (defaults to localhost). */
  baseURL: z.string().url().optional(),
  /** Inline API key (prefer apiKeyEnv to keep secrets out of the file). */
  apiKey: z.string().optional(),
  /** Name of the env var that holds the API key. */
  apiKeyEnv: z.string().optional(),
  /** Explicit model ids; if omitted, discovered via the capability source. */
  models: z.array(z.string()).optional(),
  /** Per-upstream capability overrides merged on top of discovery. */
  capabilityOverrides: capabilityOverridesSchema.optional(),
  requestTimeoutMs: z.number().int().positive().default(120_000),
});
export type UpstreamConfig = z.infer<typeof upstreamConfigSchema>;

export const poolsConfigSchema = z.object({
  /** Upstream ids forming the orchestrator/judge ring (also the single-route ring). */
  orchestrator: z.array(z.string().min(1)).min(1),
  /** Named panels → ordered upstream ids that "give opinions". */
  panel: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
});
export type PoolsConfig = z.infer<typeof poolsConfigSchema>;

export const routingConfigSchema = z.object({
  defaultMode: z.enum(["single", "panel"]).default("single"),
  /** Panel name used when escalating (defaults to the first defined panel). */
  defaultPanel: z.string().optional(),
  escalation: z
    .object({
      enabled: z.boolean().default(true),
      /** Escalate to panel when the prompt is at least this many estimated tokens. */
      minPromptTokens: z.number().int().positive().default(1500),
      /** Escalate when the latest user message contains any of these substrings. */
      keywords: z
        .array(z.string())
        .default([
          "compare",
          "trade-off",
          "tradeoff",
          "design",
          "architecture",
          "debug",
          "root cause",
          "why is",
          "options",
        ]),
      /** Optional cheap classifier call (upstream id + token budget) or null to skip. */
      routerJudge: z
        .object({ upstreamId: z.string().min(1), maxTokens: z.number().int().positive() })
        .nullable()
        .default(null),
    })
    .default({}),
  /** When true, agentic/tool-bearing requests are forced to single mode. */
  forceSingleWhenTools: z.boolean().default(true),
  /** Behaviour when an image is sent but no vision-capable model is available. */
  imageFallback: z.enum(["error", "strip"]).default("error"),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export const cachingConfigSchema = z.object({
  anthropic: z
    .object({
      enabled: z.boolean().default(true),
      maxBreakpoints: z.number().int().min(1).max(4).default(4),
      /** Use a 1h TTL for the stable (tools+system) breakpoints. */
      oneHour: z.boolean().default(true),
    })
    .default({}),
  promptCacheKey: z.object({ enabled: z.boolean().default(true) }).default({}),
  sessionAffinity: z.object({ enabled: z.boolean().default(false) }).default({}),
});
export type CachingConfig = z.infer<typeof cachingConfigSchema>;

export const serverConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  /** Optional bearer/x-api-key required from clients. Omit to allow local unauthenticated use. */
  authKey: z.string().optional(),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const capabilitiesConfigSchema = z.object({
  refreshIntervalSec: z.number().int().positive().default(900),
});
export type CapabilitiesConfig = z.infer<typeof capabilitiesConfigSchema>;

export const fusionConfigSchema = z.object({
  server: serverConfigSchema.default({}),
  upstreams: z.array(upstreamConfigSchema).min(1),
  pools: poolsConfigSchema,
  routing: routingConfigSchema.default({}),
  caching: cachingConfigSchema.default({}),
  capabilities: capabilitiesConfigSchema.default({}),
});
export type FusionConfig = z.infer<typeof fusionConfigSchema>;
