import type { RoutingConfig } from "../config/schema.js";
import { flattenText, type NeutralRequest } from "../neutral/types.js";

/** Max recursion depth: a fusion upstream pointed at fusion cannot re-trigger a panel. */
export const MAX_DEPTH = 1;

export interface RouteDecision {
  mode: "single" | "panel";
  panelName?: string;
  reason: string;
}

export interface RouteOverride {
  mode?: "single" | "panel";
  panel?: string;
}

function estimateTokens(req: NeutralRequest): number {
  let chars = 0;
  for (const p of req.system ?? []) chars += p.kind === "text" ? p.text.length : 0;
  for (const m of req.messages)
    for (const p of m.content) chars += p.kind === "text" ? p.text.length : 0;
  return Math.ceil(chars / 4);
}

function lastUserText(req: NeutralRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === "user") return flattenText(m.content).toLowerCase();
  }
  return "";
}

/**
 * Decide single vs panel. Defaults to single; escalates only with a reason.
 * Honors explicit overrides and the recursion-guard depth. Tool-bearing
 * requests stay single by default (panel tool-call aggregation is out of scope).
 */
export function decideRoute(
  req: NeutralRequest,
  routing: RoutingConfig,
  depth: number,
  override: RouteOverride,
  availablePanels: string[],
): RouteDecision {
  const resolvePanel = (): string | undefined =>
    override.panel ?? routing.defaultPanel ?? availablePanels[0];

  if (depth >= MAX_DEPTH) {
    return { mode: "single", reason: "recursion-guard: depth limit reached" };
  }

  if (override.mode === "single") return { mode: "single", reason: "override: single" };
  if (override.mode === "panel") {
    const panelName = resolvePanel();
    if (panelName) return { mode: "panel", panelName, reason: "override: panel" };
    return { mode: "single", reason: "override: panel requested but no panel configured" };
  }

  if (routing.forceSingleWhenTools && req.tools && req.tools.length > 0) {
    return { mode: "single", reason: "tools present → single (no panel tool aggregation in v0)" };
  }

  const panelName = resolvePanel();
  if (!panelName) return { mode: "single", reason: "no panel configured" };

  if (routing.defaultMode === "panel") {
    return { mode: "panel", panelName, reason: "config: defaultMode=panel" };
  }

  if (routing.escalation.enabled) {
    const tokens = estimateTokens(req);
    if (tokens >= routing.escalation.minPromptTokens) {
      return {
        mode: "panel",
        panelName,
        reason: `escalated: ~${tokens} tokens ≥ ${routing.escalation.minPromptTokens}`,
      };
    }
    const text = lastUserText(req);
    const hit = routing.escalation.keywords.find((kw) => text.includes(kw.toLowerCase()));
    if (hit) {
      return { mode: "panel", panelName, reason: `escalated: keyword "${hit}"` };
    }
  }

  return { mode: "single", reason: "default: single" };
}
