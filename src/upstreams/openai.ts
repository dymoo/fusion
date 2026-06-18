import {
  neutralToOpenaiBody,
  openaiResponseToNeutral,
  openaiStreamToNeutral,
} from "../adapters/openai.js";
import { asArray, getString } from "../adapters/json.js";
import { CONSERVATIVE_DEFAULT, type ModelDescriptor } from "../capabilities/types.js";
import type { UpstreamConfig } from "../config/schema.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { fetchWithTimeout } from "../util/http-fetch.js";
import { parseSseStream } from "../util/sse.js";
import { resolveApiKey, sendRequest } from "./base.js";
import type { ProviderKind, Upstream, UpstreamCallOptions } from "./types.js";
import { UpstreamError } from "./types.js";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

/** Client for OpenAI and any OpenAI-compatible Chat Completions endpoint. */
export class OpenAiUpstream implements Upstream {
  readonly id: string;
  readonly kind: ProviderKind;
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly configuredModels: string[] | undefined;
  private readonly reasoningEffort: string | undefined;

  constructor(private readonly config: UpstreamConfig) {
    this.id = config.id;
    this.kind = config.type;
    this.baseURL = (config.baseURL ?? DEFAULT_OPENAI_BASE).replace(/\/$/, "");
    this.apiKey = resolveApiKey(config);
    this.timeoutMs = config.requestTimeoutMs;
    this.configuredModels = config.models;
    this.reasoningEffort = config.reasoningEffort;
  }

  private headers(depth?: number): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (depth !== undefined) headers["x-fusion-depth"] = String(depth);
    return headers;
  }

  private modelFor(req: NeutralRequest): string {
    return this.configuredModels?.[0] ?? req.model;
  }

  async complete(req: NeutralRequest, opts: UpstreamCallOptions): Promise<NeutralResult> {
    const model = this.modelFor(req);
    const body = neutralToOpenaiBody({ ...req, stream: false }, model, opts);
    if (this.reasoningEffort) body["reasoning_effort"] = this.reasoningEffort;
    const res = await sendRequest(
      this.id,
      `${this.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(opts.depth),
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs,
      },
      opts.signal,
    );
    const json: unknown = await res.json();
    return openaiResponseToNeutral(json, model);
  }

  async *stream(req: NeutralRequest, opts: UpstreamCallOptions): AsyncIterable<StreamEvent> {
    const model = this.modelFor(req);
    const body = neutralToOpenaiBody({ ...req, stream: true }, model, opts);
    if (this.reasoningEffort) body["reasoning_effort"] = this.reasoningEffort;
    const res = await sendRequest(
      this.id,
      `${this.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(opts.depth),
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs,
      },
      opts.signal,
    );
    if (!res.body) throw new UpstreamError(this.id, null, true, null, "empty stream body");
    yield* openaiStreamToNeutral(parseSseStream(res.body), model);
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
      const res = await fetchWithTimeout(`${this.baseURL}/models`, {
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
