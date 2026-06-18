import { isObject, type JsonObject } from "../adapters/json.js";

export interface AnthropicCacheOptions {
  enabled: boolean;
  maxBreakpoints: number;
  oneHour: boolean;
}

function addCacheControl(block: unknown, ttl: "5m" | "1h"): boolean {
  if (!isObject(block)) return false;
  block["cache_control"] = ttl === "5m" ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" };
  return true;
}

function lastOf(arr: unknown): JsonObject | undefined {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const last = arr[arr.length - 1] as unknown;
  return isObject(last) ? last : undefined;
}

/**
 * Inject `cache_control` breakpoints into an Anthropic Messages body.
 *
 * Order respects Anthropic's "1h before 5m" rule positionally: the stable
 * prefix (tools + last system block) gets 1h breakpoints; the last up-to-N
 * messages get 5m breakpoints. Caps at `maxBreakpoints` (Anthropic max is 4)
 * and never marks per-request-varying content beyond the chosen blocks.
 */
export function injectAnthropicCache(body: JsonObject, opts: AnthropicCacheOptions): JsonObject {
  if (!opts.enabled) return body;
  let budget = Math.min(4, Math.max(1, opts.maxBreakpoints));
  const stableTtl: "5m" | "1h" = opts.oneHour ? "1h" : "5m";

  const lastTool = lastOf(body["tools"]);
  if (budget > 0 && lastTool && addCacheControl(lastTool, stableTtl)) budget--;

  const lastSystem = lastOf(body["system"]);
  if (budget > 0 && lastSystem && addCacheControl(lastSystem, stableTtl)) budget--;

  const messages = body["messages"];
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
      const block = lastOf((messages[i] as JsonObject | undefined)?.["content"]);
      if (block && addCacheControl(block, "5m")) budget--;
    }
  }
  return body;
}
