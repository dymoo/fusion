import { shortHash } from "./id.js";

/**
 * Derive a stable session id used for prompt-cache keys and optional upstream
 * affinity. Prefer an explicit client header (Claude Code sends one); otherwise
 * fall back to a hash of the stable conversation prefix (system + first user
 * turn), which stays constant across the turns of a single conversation.
 */
const HEADER_CANDIDATES = ["x-fusion-session", "x-session-id", "x-claude-code-session-id"];

export function deriveSessionId(
  headers: Record<string, string | undefined>,
  stableSeed: string,
): string {
  for (const name of HEADER_CANDIDATES) {
    const value = headers[name]?.trim();
    if (value) return value;
  }
  return `seed-${shortHash(stableSeed)}`;
}
