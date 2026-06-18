import {
  anthropicResponseToNeutral,
  anthropicStreamToNeutral,
  neutralToAnthropicBody,
} from "../adapters/anthropic.js";
import { asArray, getString } from "../adapters/json.js";
import { injectAnthropicCache, type AnthropicCacheOptions } from "../caching/anthropic-cache.js";
import { CONSERVATIVE_DEFAULT, type ModelDescriptor } from "../capabilities/types.js";
import type { UpstreamConfig } from "../config/schema.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { fetchWithTimeout } from "../util/http-fetch.js";
import { parseSseStream } from "../util/sse.js";
import { resolveApiKey, sendRequest } from "./base.js";
import type { ProviderKind, Upstream, UpstreamCallOptions } from "./types.js";
import { UpstreamError } from "./types.js";

const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** Client for the Anthropic Messages API. */
export class AnthropicUpstream implements Upstream {
  readonly id: string;
  readonly kind: ProviderKind = "anthropic";
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly configuredModels: string[] | undefined;

  constructor(
    config: UpstreamConfig,
    private readonly cacheOpts: AnthropicCacheOptions,
  ) {
    this.id = config.id;
    this.baseURL = (config.baseURL ?? DEFAULT_ANTHROPIC_BASE).replace(/\/$/, "");
    this.apiKey = resolveApiKey(config);
    this.timeoutMs = config.requestTimeoutMs;
    this.configuredModels = config.models;
  }

  private headers(depth?: number): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (depth !== undefined) headers["x-fusion-depth"] = String(depth);
    return headers;
  }

  private modelFor(req: NeutralRequest): string {
    return this.configuredModels?.[0] ?? req.model;
  }

  async complete(req: NeutralRequest, opts: UpstreamCallOptions): Promise<NeutralResult> {
    const model = this.modelFor(req);
    const body = injectAnthropicCache(
      neutralToAnthropicBody({ ...req, stream: false }, model, opts),
      this.cacheOpts,
    );
    const res = await sendRequest(
      this.id,
      `${this.baseURL}/v1/messages`,
      {
        method: "POST",
        headers: this.headers(opts.depth),
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs,
      },
      opts.signal,
    );
    const json: unknown = await res.json();
    return anthropicResponseToNeutral(json, model);
  }

  async *stream(req: NeutralRequest, opts: UpstreamCallOptions): AsyncIterable<StreamEvent> {
    const model = this.modelFor(req);
    const body = injectAnthropicCache(
      neutralToAnthropicBody({ ...req, stream: true }, model, opts),
      this.cacheOpts,
    );
    const res = await sendRequest(
      this.id,
      `${this.baseURL}/v1/messages`,
      {
        method: "POST",
        headers: this.headers(opts.depth),
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs,
      },
      opts.signal,
    );
    if (!res.body) throw new UpstreamError(this.id, null, true, null, "empty stream body");
    yield* anthropicStreamToNeutral(parseSseStream(res.body), model);
  }

  async discover(): Promise<ModelDescriptor[]> {
    const ids = this.configuredModels ?? (await this.fetchModelIds());
    return ids.map((modelId) => ({
      upstreamId: this.id,
      modelId,
      capabilities: CONSERVATIVE_DEFAULT,
      source: "default" as const,
    }));
  }

  private async fetchModelIds(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(`${this.baseURL}/v1/models`, {
        headers: this.headers(),
        timeoutMs: 15_000,
      });
      if (!res.ok) return [];
      const json: unknown = await res.json();
      const data = asArray((json as { data?: unknown }).data);
      return data.map((m) => getString(m, "id")).filter((id): id is string => Boolean(id));
    } catch {
      return [];
    }
  }
}
