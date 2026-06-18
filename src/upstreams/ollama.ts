import { asObject, getArray, getNumber, getString, isObject } from "../adapters/json.js";
import {
  type Capabilities,
  CONSERVATIVE_DEFAULT,
  type ModelDescriptor,
} from "../capabilities/types.js";
import type { UpstreamConfig } from "../config/schema.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { fetchWithTimeout } from "../util/http-fetch.js";
import { OpenAiUpstream } from "./openai.js";
import type { ProviderKind, Upstream, UpstreamCallOptions } from "./types.js";

const DEFAULT_OLLAMA_BASE = "http://localhost:11434/v1";

/**
 * Ollama speaks the OpenAI Chat Completions wire at `/v1`, but exposes richer
 * capability metadata at its native `/api/tags` + `/api/show` endpoints, which
 * we use for discovery (vision/tools/context window).
 */
export class OllamaUpstream implements Upstream {
  readonly id: string;
  readonly kind: ProviderKind = "ollama";
  private readonly chat: OpenAiUpstream;
  private readonly nativeBase: string;
  private readonly configuredModels: string[] | undefined;

  constructor(config: UpstreamConfig) {
    this.id = config.id;
    const v1Base = (config.baseURL ?? DEFAULT_OLLAMA_BASE).replace(/\/$/, "");
    this.nativeBase = v1Base.replace(/\/v1$/, "");
    this.configuredModels = config.models;
    this.chat = new OpenAiUpstream({ ...config, type: "openai-compatible", baseURL: v1Base });
  }

  complete(req: NeutralRequest, opts: UpstreamCallOptions): Promise<NeutralResult> {
    return this.chat.complete(req, opts);
  }

  stream(req: NeutralRequest, opts: UpstreamCallOptions): AsyncIterable<StreamEvent> {
    return this.chat.stream(req, opts);
  }

  async discover(): Promise<ModelDescriptor[]> {
    const names = this.configuredModels ?? (await this.listModels());
    const out: ModelDescriptor[] = [];
    for (const modelId of names) {
      const caps = await this.showCapabilities(modelId);
      out.push({
        upstreamId: this.id,
        modelId,
        capabilities: caps ?? CONSERVATIVE_DEFAULT,
        source: caps ? "provider-native" : "default",
      });
    }
    return out;
  }

  private async listModels(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(`${this.nativeBase}/api/tags`, { timeoutMs: 15_000 });
      if (!res.ok) return [];
      const json: unknown = await res.json();
      return getArray(json, "models")
        .map((m) => getString(m, "name") ?? getString(m, "model"))
        .filter((n): n is string => Boolean(n));
    } catch {
      return [];
    }
  }

  private async showCapabilities(model: string): Promise<Capabilities | null> {
    try {
      const res = await fetchWithTimeout(`${this.nativeBase}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        timeoutMs: 15_000,
      });
      if (!res.ok) return null;
      const json: unknown = await res.json();
      const capsList = getArray(json, "capabilities").filter(
        (c): c is string => typeof c === "string",
      );
      const vision = capsList.includes("vision");
      const tools = capsList.includes("tools");
      const context = extractContextLength(json) ?? CONSERVATIVE_DEFAULT.contextWindow;
      return {
        tools,
        modalities: vision ? ["text", "image"] : ["text"],
        contextWindow: context,
        maxOutputTokens: Math.min(context, 8192),
      };
    } catch {
      return null;
    }
  }
}

function extractContextLength(json: unknown): number | undefined {
  const info = asObject(asObject(json)["model_info"]);
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith("context_length") && typeof value === "number") return value;
  }
  const direct = getNumber(json, "context_length");
  if (direct !== undefined) return direct;
  // some builds nest it under details
  const details = asObject(asObject(json)["details"]);
  const fromDetails = isObject(details) ? getNumber(details, "context_length") : undefined;
  return fromDetails;
}
