import type { CapabilityResolver } from "../capabilities/resolver.js";
import type { Capabilities } from "../capabilities/types.js";
import { clampMaxTokens } from "../capabilities/intersect.js";
import type { RoutingConfig } from "../config/schema.js";
import { hasImages, type NeutralRequest } from "../neutral/types.js";

export interface Selection {
  /** Members excluded from this request (e.g. non-vision models when images present). */
  excluded: Set<string>;
  floor: Capabilities;
  maxTokens: number;
  /** Set when images must be stripped (imageFallback="strip" and no vision model). */
  stripImages: boolean;
  /** Set when the request cannot be served (imageFallback="error" and no vision model). */
  error?: string;
}

/**
 * Decide which members of a candidate pool can serve this request, the capability
 * floor across them, and the clamped max_tokens. Filters out non-vision models
 * when the request carries images.
 */
export function selectCandidates(
  memberIds: string[],
  req: NeutralRequest,
  resolver: CapabilityResolver,
  routing: RoutingConfig,
): Selection {
  const excluded = new Set<string>();
  const withImages = hasImages(req);

  if (withImages) {
    const visionMembers = memberIds.filter((id) => resolver.imageCapable(id));
    for (const id of memberIds) {
      if (!visionMembers.includes(id)) excluded.add(id);
    }
    if (visionMembers.length === 0) {
      if (routing.imageFallback === "error") {
        return {
          excluded: new Set(),
          floor: resolver.floorFor(memberIds),
          maxTokens: clampMaxTokens(req.maxTokens, resolver.floorFor(memberIds)),
          stripImages: false,
          error: "No vision-capable upstream is available to handle the image(s) in this request.",
        };
      }
      // strip mode: keep all members, drop images downstream
      const floor = resolver.floorFor(memberIds);
      return {
        excluded: new Set(),
        floor,
        maxTokens: clampMaxTokens(req.maxTokens, floor),
        stripImages: true,
      };
    }
  }

  const active = memberIds.filter((id) => !excluded.has(id));
  const floor = resolver.floorFor(active.length > 0 ? active : memberIds);
  return {
    excluded,
    floor,
    maxTokens: clampMaxTokens(req.maxTokens, floor),
    stripImages: false,
  };
}

/** Remove image parts from a request (used by imageFallback="strip"). */
export function stripImagesFromRequest(req: NeutralRequest): NeutralRequest {
  const note = "[image omitted: routed model is not vision-capable]";
  const mapParts = (parts: NeutralRequest["messages"][number]["content"]) =>
    parts.map((p) => (p.kind === "image" ? { kind: "text" as const, text: note } : p));
  return {
    ...req,
    ...(req.system ? { system: mapParts(req.system) } : {}),
    messages: req.messages.map((m) => ({ ...m, content: mapParts(m.content) })),
  };
}
