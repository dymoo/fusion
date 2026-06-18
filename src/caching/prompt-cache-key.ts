import type { NeutralRequest } from "../neutral/types.js";

/**
 * Stable prompt-cache key for OpenAI/Codex upstreams. Keyed on the session so
 * repeated turns of one conversation hit the provider's prompt cache.
 */
export function promptCacheKey(req: NeutralRequest): string {
  return `fusion-${req.sessionId}`;
}
