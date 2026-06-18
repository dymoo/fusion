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
  // Zhipu GLM (e.g. glm-5.2) — tool-calling, long context.
  {
    match: /glm|zhipu|chatglm/i,
    caps: { tools: true, modalities: ["text"], contextWindow: 131_072, maxOutputTokens: 32_768 },
  },
  // Moonshot Kimi (e.g. kimi-k2.7-code) — tool-calling, very long context.
  {
    match: /kimi|moonshot/i,
    caps: { tools: true, modalities: ["text"], contextWindow: 262_144, maxOutputTokens: 32_768 },
  },
  // MiniMax (e.g. minimax-m3) — tool-calling, very long context.
  {
    match: /minimax|abab/i,
    caps: { tools: true, modalities: ["text"], contextWindow: 524_288, maxOutputTokens: 32_768 },
  },
];

export function lookupModelsDev(modelId: string): Capabilities | undefined {
  for (const entry of REGISTRY) {
    if (entry.match.test(modelId)) return entry.caps;
  }
  return undefined;
}
