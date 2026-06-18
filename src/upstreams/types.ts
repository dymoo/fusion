import type { ModelDescriptor } from "../capabilities/types.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import type { ProviderKind } from "../config/schema.js";

export type { ProviderKind };

export interface UpstreamCallOptions {
  signal: AbortSignal;
  /** Already clamped to the route floor by the capability resolver. */
  maxTokens: number;
  /** Recursion-guard depth (fusion-in-fusion protection). */
  depth: number;
  /** Stable per-session key to maximize provider prompt-cache hits. */
  promptCacheKey?: string;
}

export interface Upstream {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Non-streaming completion in neutral terms. */
  complete(req: NeutralRequest, opts: UpstreamCallOptions): Promise<NeutralResult>;
  /** Streaming completion: yields neutral StreamEvents. */
  stream(req: NeutralRequest, opts: UpstreamCallOptions): AsyncIterable<StreamEvent>;
  /** Discover this upstream's models + capabilities. */
  discover(): Promise<ModelDescriptor[]>;
}

/** Error raised by an upstream client; carries enough info for failover decisions. */
export class UpstreamError extends Error {
  constructor(
    readonly upstreamId: string,
    /** HTTP status, or null for network/timeout errors. */
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}
