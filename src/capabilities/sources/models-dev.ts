import type { Capabilities } from "../types.js";

/**
 * Tiny bundled capability registry for common models, used when an
 * OpenAI-compatible upstream's `/v1/models` reports only ids. Matched by
 * substring against the model id. This is a conservative fallback, not an
 * exhaustive registry; provider-native discovery and config overrides win.
 */
interface Entry {
  match: RegExp;
  caps: Capabilities;
}

const REGISTRY: Entry[] = [
  // Anthropic Claude
  {
    match: /claude.*(opus|sonnet)/i,
    caps: {
      tools: true,
      modalities: ["text", "image"],
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  },
  {
    match: /claude.*haiku/i,
    caps: {
      tools: true,
      modalities: ["text", "image"],
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
    },
  },
  // OpenAI GPT
  {
    match: /gpt-5|gpt-4\.1|gpt-4o|o3|o4/i,
    caps: {
      tools: true,
      modalities: ["text", "image"],
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
    },
  },
  {
    match: /gpt-4|gpt-3\.5/i,
    caps: { tools: true, modalities: ["text"], contextWindow: 128_000, maxOutputTokens: 16_000 },
  },
  // Google Gemini
  {
    match: /gemini.*(pro|flash)/i,
    caps: {
      tools: true,
      modalities: ["text", "image"],
      contextWindow: 1_000_000,
      maxOutputTokens: 65_000,
    },
  },
  // Meta Llama / vision variants
  {
    match: /llama.*(vision|3\.2)/i,
    caps: {
      tools: true,
      modalities: ["text", "image"],
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    },
  },
  {
    match: /llama|mistral|mixtral|qwen|deepseek/i,
    caps: { tools: true, modalities: ["text"], contextWindow: 32_768, maxOutputTokens: 8_192 },
  },
];

export function lookupModelsDev(modelId: string): Capabilities | undefined {
  for (const entry of REGISTRY) {
    if (entry.match.test(modelId)) return entry.caps;
  }
  return undefined;
}
