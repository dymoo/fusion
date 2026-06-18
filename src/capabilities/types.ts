import { z } from "zod";

import type { Modality } from "../neutral/types.js";

export const modalitySchema = z.enum(["text", "image"]);

/**
 * The negotiated capabilities of a model (or of an intersected route).
 *
 * Fusion exposes only the *least-capable intersection* across a route's models
 * so a client never asks for something the weakest member cannot do.
 */
export const capabilitiesSchema = z.object({
  /** Whether function/tool calling is supported. */
  tools: z.boolean(),
  /** Supported input modalities. */
  modalities: z.array(modalitySchema),
  /** Context window in tokens. */
  contextWindow: z.number().int().positive(),
  /** Maximum output tokens. */
  maxOutputTokens: z.number().int().positive(),
});

export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** A partial override supplied via config (merged on top of discovered values). */
export const capabilityOverridesSchema = capabilitiesSchema.partial();
export type CapabilityOverrides = z.infer<typeof capabilityOverridesSchema>;

export type CapabilitySource = "provider-native" | "models-dev" | "config-override" | "default";

export interface ModelDescriptor {
  upstreamId: string;
  /** The upstream's native model id / slug. */
  modelId: string;
  capabilities: Capabilities;
  /** Provenance, for debugging /v1/models and logs. */
  source: CapabilitySource;
}

export const CONSERVATIVE_DEFAULT: Capabilities = {
  tools: false,
  modalities: ["text"],
  contextWindow: 8192,
  maxOutputTokens: 4096,
};

export function hasModality(caps: Capabilities, modality: Modality): boolean {
  return caps.modalities.includes(modality);
}

/** Merge a partial override on top of base caps, keeping every field defined. */
export function applyOverride(base: Capabilities, override?: CapabilityOverrides): Capabilities {
  if (!override) return base;
  return {
    tools: override.tools ?? base.tools,
    modalities: override.modalities ?? base.modalities,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
  };
}
