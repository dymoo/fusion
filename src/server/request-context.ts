import type { RouteOverride } from "../routing/router.js";

export function parseDepth(headers: Record<string, string | undefined>): number {
  const raw = headers["x-fusion-depth"];
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Route override via request headers: `x-fusion-route: single|panel`, `x-fusion-panel: <name>`. */
export function parseOverrideHeaders(headers: Record<string, string | undefined>): RouteOverride {
  const out: RouteOverride = {};
  const mode = headers["x-fusion-route"]?.trim().toLowerCase();
  if (mode === "single" || mode === "panel") out.mode = mode;
  const panel = headers["x-fusion-panel"]?.trim();
  if (panel) out.panel = panel;
  return out;
}
