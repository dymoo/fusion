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
  /**
   * Reasoning effort. For codex (Responses API) this is the graded
   * `reasoning.effort` (gpt-5.5 supports up to `xhigh`). For OpenAI-compatible
   * upstreams it is sent as `reasoning_effort`. Omit to use the model default
   * (Ollama Cloud thinking models reason by default).
   */
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  requestTimeoutMs: z.number().int().positive().default(120_000),
});
export type UpstreamConfig = z.infer<typeof upstreamConfigSchema>;

export const poolsConfigSchema = z.object({
  /** Upstream ids forming the orchestrator/judge ring (also the default single-route ring). */
  orchestrator: z.array(z.string().min(1)).min(1),
  /** Named panels → ordered upstream ids that "give opinions". */
  panel: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
  /** Single-route ring for the smart "compact" tier (defaults to [orchestrator[0]]). */
  compact: z.array(z.string().min(1)).min(1).optional(),
  /** Single-route ring for the smart "regular" tier (defaults to first 2 orchestrator members). */
  regular: z.array(z.string().min(1)).min(1).optional(),
  /** Single-route ring driving agentic/tool turns (the strong "actor"; defaults to orchestrator). */
  actor: z.array(z.string().min(1)).min(1).optional(),
});
export type PoolsConfig = z.infer<typeof poolsConfigSchema>;

/** In-process ONNX embedding model for the smart complexity classifier. */
export const embeddingsConfigSchema = z.object({
  /** Code-specific by default; small + fast. Override for a lighter model. */
  model: z.string().default("jinaai/jina-embeddings-v2-base-code"),
  dtype: z.enum(["fp32", "fp16", "q8", "int8", "uint8", "q4", "q4f16", "bnb4"]).default("q8"),
});
export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;

export const smartRoutingSchema = z
  .object({
    embeddings: embeddingsConfigSchema.default({}),
    tiers: z
      .object({
        compact: z.object({ pool: z.string().default("compact") }).default({}),
        regular: z.object({ pool: z.string().default("regular") }).default({}),
        plan: z.object({ panel: z.string().default("default") }).default({}),
      })
      .default({}),
    thresholds: z
      .object({
        /** Min cosine to a harness-mode anchor (plan mode / compaction) to force that tier. */
        harnessConfidence: z.number().default(0.5),
      })
      .default({}),
    /** Tier used only for a genuinely empty request (nothing to embed). */
    fallbackTier: z.enum(["compact", "regular", "plan"]).default("regular"),
    /** Override the built-in anchor phrases per tier. */
    anchors: z
      .object({
        compact: z.array(z.string()).optional(),
        regular: z.array(z.string()).optional(),
        plan: z.array(z.string()).optional(),
      })
      .optional(),
    /** Truncate the classified text to this many chars before embedding. */
    maxTextChars: z.number().int().positive().default(4000),
  })
  .default({});
export type SmartRoutingConfig = z.infer<typeof smartRoutingSchema>;

/**
 * Council-then-act: on hard agentic (tool-bearing) turns, a panel of advisor
 * models deliberates as text (no tool execution), an optional judge condenses it
 * into a briefing, and the pinned actor model runs WITH the real tools plus that
 * briefing injected — mixture-of-agents made tool-compatible.
 */
export const councilConfigSchema = z
  .object({
    /** Convene the council on hard agentic turns. */
    enabled: z.boolean().default(false),
    /** Panel name whose members deliberate (advise) on the next step. */
    panel: z.string().default("default"),
    /** Minimum classified complexity to convene ("always" = every agentic turn). */
    trigger: z.enum(["compact", "regular", "plan", "always"]).default("plan"),
    /** Run a judge to condense advisor opinions into one briefing (else inject raw). */
    synthesize: z.boolean().default(true),
    /** Drop the session's actor model from the advisor set (diversity; it integrates anyway). */
    excludeActor: z.boolean().default(true),
  })
  .default({});
export type CouncilConfig = z.infer<typeof councilConfigSchema>;

export const routingConfigSchema = z.object({
  /** single = one model + failover; smart = embedding tier classifier; all = panel (fuse everything). */
  mode: z.enum(["single", "smart", "all"]).default("smart"),
  /** Panel name used by "all" mode and the smart "plan" tier. */
  defaultPanel: z.string().optional(),
  /** When true, agentic/tool-bearing requests are forced to single mode. */
  forceSingleWhenTools: z.boolean().default(true),
  /** Behaviour when an image is sent but no vision-capable model is available. */
  imageFallback: z.enum(["error", "strip"]).default("error"),
  smart: smartRoutingSchema,
  council: councilConfigSchema,
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
