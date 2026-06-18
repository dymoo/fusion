import type { AnthropicCacheOptions } from "../caching/anthropic-cache.js";
import type { FusionConfig } from "../config/schema.js";
import { AnthropicUpstream } from "./anthropic.js";
import { CodexUpstream } from "./codex.js";
import { OllamaUpstream } from "./ollama.js";
import { OpenAiUpstream } from "./openai.js";
import type { Upstream } from "./types.js";

export function buildUpstreams(config: FusionConfig): Map<string, Upstream> {
  const cacheOpts: AnthropicCacheOptions = {
    enabled: config.caching.anthropic.enabled,
    maxBreakpoints: config.caching.anthropic.maxBreakpoints,
    oneHour: config.caching.anthropic.oneHour,
  };
  const map = new Map<string, Upstream>();
  for (const cfg of config.upstreams) {
    let upstream: Upstream;
    switch (cfg.type) {
      case "codex":
        upstream = new CodexUpstream(cfg);
        break;
      case "anthropic":
        upstream = new AnthropicUpstream(cfg, cacheOpts);
        break;
      case "ollama":
        upstream = new OllamaUpstream(cfg);
        break;
      case "openai":
      case "openai-compatible":
        upstream = new OpenAiUpstream(cfg);
        break;
    }
    map.set(cfg.id, upstream);
  }
  return map;
}
