import type { Modality } from "../neutral/types.js";
import { type Capabilities, CONSERVATIVE_DEFAULT } from "./types.js";

/**
 * Least-capable intersection across a route's models: tools require ALL to
 * support them, modalities are the set intersection, context/output are the
 * minimum. Exposing this floor stops a client asking for something the weakest
 * member cannot do.
 */
export function intersectCapabilities(caps: Capabilities[]): Capabilities {
  if (caps.length === 0) return CONSERVATIVE_DEFAULT;
  const tools = caps.every((c) => c.tools);
  const modalities = caps.reduce<Modality[]>(
    (acc, c) => acc.filter((m) => c.modalities.includes(m)),
    [...(caps[0]?.modalities ?? [])],
  );
  const contextWindow = Math.min(...caps.map((c) => c.contextWindow));
  const maxOutputTokens = Math.min(...caps.map((c) => c.maxOutputTokens));
  return { tools, modalities, contextWindow, maxOutputTokens };
}

/** Clamp a requested max_tokens to the route floor ("smallest max tokens wins"). */
export function clampMaxTokens(requested: number | undefined, floor: Capabilities): number {
  const ceiling = floor.maxOutputTokens;
  if (requested === undefined) return ceiling;
  return Math.min(Math.max(1, requested), ceiling);
}
