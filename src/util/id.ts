import { createHash, randomUUID } from "node:crypto";

function rand(): string {
  return randomUUID().replace(/-/g, "");
}

/** OpenAI-style chat completion id. */
export const chatCompletionId = (): string => `chatcmpl-${rand()}`;

/** Anthropic-style message id. */
export const messageId = (): string => `msg_${rand()}`;

/** Generic tool call id (used when an upstream omits one). */
export const toolCallId = (): string => `call_${rand().slice(0, 24)}`;

/** Short correlation id for a single request, used in logs. */
export const requestId = (): string => `req_${rand().slice(0, 12)}`;

/** Stable short hash of an arbitrary string (for cache keys / session derivation). */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
