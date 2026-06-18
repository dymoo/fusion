import type { RouteOverride } from "../routing/router.js";

export function parseDepth(headers: Record<string, string | undefined>): number {
  const raw = headers["x-fusion-depth"];
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Route override via request headers:
 *   `x-fusion-route: single|smart|all|compact|regular|plan`
 *   `x-fusion-tier:  compact|regular|plan`
 *   `x-fusion-panel: <name>`
 */
export function parseOverrideHeaders(headers: Record<string, string | undefined>): RouteOverride {
  const out: RouteOverride = {};
  const route = headers["x-fusion-route"]?.trim().toLowerCase();
  if (route === "single" || route === "smart" || route === "all") out.mode = route;
  else if (route === "compact" || route === "regular" || route === "plan") out.tier = route;
  const tier = headers["x-fusion-tier"]?.trim().toLowerCase();
  if (tier === "compact" || tier === "regular" || tier === "plan") out.tier = tier;
  const panel = headers["x-fusion-panel"]?.trim();
  if (panel) out.panel = panel;
  return out;
}
