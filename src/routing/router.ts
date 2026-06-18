import type { RoutingConfig } from "../config/schema.js";
import { flattenText, type NeutralRequest } from "../neutral/types.js";
import type { Tier } from "./anchors.js";

/** Max recursion depth: a fusion upstream pointed at fusion cannot re-trigger a panel. */
export const MAX_DEPTH = 1;

export type Strategy = "single" | "panel";

export interface RouteDecision {
  mode: Strategy;
  /** Complexity tier (smart mode only). */
  tier?: Tier;
  /** Single-route ring name (single mode): orchestrator | compact | regular. */
  poolName?: string;
  /** Panel name (panel mode). */
  panelName?: string;
  reason: string;
  /** Per-tier cosine scores (smart embedding classification only). */
  scores?: Record<Tier, number>;
}

export interface RouteOverride {
  /** Force a routing mode for this request. */
  mode?: "single" | "smart" | "all";
  /** Force a complexity tier for this request. */
  tier?: Tier;
  /** Panel name override (for all/plan). */
  panel?: string;
}

/** Estimate prompt size in tokens (~chars/4) across system + messages. */
export function estimateTokens(req: NeutralRequest): number {
  let chars = 0;
  for (const p of req.system ?? []) chars += p.kind === "text" ? p.text.length : 0;
  for (const m of req.messages)
    for (const p of m.content) chars += p.kind === "text" ? p.text.length : 0;
  return Math.ceil(chars / 4);
}

/** Lowercased text of the last user message. */
export function lastUserText(req: NeutralRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === "user") return flattenText(m.content).toLowerCase();
  }
  return "";
}

/** Map a complexity tier to a concrete routing decision. */
export function fromTier(
  tier: Tier,
  routing: RoutingConfig,
  resolvedPanel: string | undefined,
  reason: string,
  scores?: Record<Tier, number>,
): RouteDecision {
  const withScores = scores ? { scores } : {};
  if (tier === "plan") {
    const panelName = routing.smart.tiers.plan.panel || resolvedPanel;
    if (panelName) return { mode: "panel", tier, panelName, reason, ...withScores };
    return {
      mode: "single",
      tier,
      poolName: "orchestrator",
      reason: `${reason}; no panel → single`,
      ...withScores,
    };
  }
  const poolName =
    tier === "compact" ? routing.smart.tiers.compact.pool : routing.smart.tiers.regular.pool;
  return { mode: "single", tier, poolName, reason, ...withScores };
}

/**
 * Resolve the routing decision for non-smart cases (recursion guard, overrides,
 * tools-force-single, mode=single, mode=all). Returns null when embedding-based
 * smart classification is required (the caller then classifies + calls fromTier).
 */
export function decideStatic(
  req: NeutralRequest,
  routing: RoutingConfig,
  depth: number,
  override: RouteOverride,
  firstPanel: string | undefined,
): RouteDecision | null {
  const resolvedPanel = override.panel ?? routing.defaultPanel ?? firstPanel;

  if (depth >= MAX_DEPTH) {
    return {
      mode: "single",
      poolName: "orchestrator",
      reason: "recursion-guard: depth limit reached",
    };
  }
  if (override.tier) {
    return fromTier(override.tier, routing, resolvedPanel, `override: tier=${override.tier}`);
  }
  if (override.mode === "single") {
    return { mode: "single", poolName: "orchestrator", reason: "override: single" };
  }
  if (override.mode === "all") {
    return resolvedPanel
      ? { mode: "panel", panelName: resolvedPanel, reason: "override: all" }
      : { mode: "single", poolName: "orchestrator", reason: "override: all but no panel → single" };
  }

  if (routing.forceSingleWhenTools && (req.tools?.length ?? 0) > 0) {
    return {
      mode: "single",
      poolName: "actor",
      reason: "tools present → single actor (no panel tool aggregation in v0)",
    };
  }

  const mode = override.mode === "smart" ? "smart" : routing.mode;
  if (mode === "single") return { mode: "single", poolName: "orchestrator", reason: "mode=single" };
  if (mode === "all") {
    return resolvedPanel
      ? { mode: "panel", panelName: resolvedPanel, reason: "mode=all (fuse every request)" }
      : { mode: "single", poolName: "orchestrator", reason: "mode=all but no panel → single" };
  }
  return null; // smart → caller classifies
}

/**
 * Enforce the v0 invariant: a request carrying tools must never route to the
 * panel. The panel fans out non-streaming and synthesizes ONE text answer via a
 * judge — it cannot merge heterogeneous tool calls, so a tool-bearing request
 * routed there comes back as prose with no `tool_use` block, which stalls an
 * agent's loop (it has nothing to execute). When that would happen we degrade to
 * single over the actor ring (round-robin + failover; with session affinity the
 * conversation stays pinned to one model). Tier/scores are kept so the
 * `x-fusion-route` header still reports what the classifier decided.
 *
 * This runs AFTER the decision is finalized, so it also closes the ordering hole
 * where `x-fusion-route: all`, `x-fusion-tier: plan`, or `mode: all` reach the
 * panel ahead of the `forceSingleWhenTools` guard in `decideStatic`.
 */
export function disablePanelWhenTools(decision: RouteDecision, hasTools: boolean): RouteDecision {
  if (decision.mode !== "panel" || !hasTools) return decision;
  return {
    mode: "single",
    poolName: "actor",
    ...(decision.tier ? { tier: decision.tier } : {}),
    ...(decision.scores ? { scores: decision.scores } : {}),
    reason: `${decision.reason}; tools->single actor (panel can't aggregate tool calls in v0)`,
  };
}

/** Resolve the panel name a smart "plan" decision should use. */
export function resolvePanel(
  routing: RoutingConfig,
  override: RouteOverride,
  firstPanel: string | undefined,
): string | undefined {
  return override.panel ?? routing.defaultPanel ?? firstPanel;
}
