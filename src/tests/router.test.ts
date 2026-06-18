import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { routingConfigSchema } from "../config/schema.js";
import type { NeutralRequest } from "../neutral/types.js";
import { decideStatic, disablePanelWhenTools, fromTier } from "../routing/router.js";

function userReq(text: string, extra: Partial<NeutralRequest> = {}): NeutralRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text }] }],
    stream: false,
    sessionId: "s",
    ...extra,
  };
}

describe("decideStatic", () => {
  it("returns null for smart mode (caller must classify)", () => {
    const routing = routingConfigSchema.parse({ mode: "smart" });
    assert.equal(decideStatic(userReq("hi"), routing, 0, {}, "default"), null);
  });

  it("mode=single routes single over orchestrator", () => {
    const routing = routingConfigSchema.parse({ mode: "single" });
    const d = decideStatic(userReq("hi"), routing, 0, {}, "default");
    assert.equal(d?.mode, "single");
    assert.equal(d?.poolName, "orchestrator");
  });

  it("mode=all routes panel", () => {
    const routing = routingConfigSchema.parse({ mode: "all" });
    const d = decideStatic(userReq("hi"), routing, 0, {}, "default");
    assert.equal(d?.mode, "panel");
    assert.equal(d?.panelName, "default");
  });

  it("recursion guard forces single regardless of mode", () => {
    const routing = routingConfigSchema.parse({ mode: "all" });
    const d = decideStatic(userReq("hi"), routing, 1, {}, "default");
    assert.equal(d?.mode, "single");
  });

  it("tools force single over the actor pool in smart mode", () => {
    const routing = routingConfigSchema.parse({ mode: "smart" });
    const req = userReq("design a system", { tools: [{ name: "f", parameters: {} }] });
    const d = decideStatic(req, routing, 0, {}, "default");
    assert.equal(d?.mode, "single");
    assert.equal(d?.poolName, "actor");
  });

  it("override tier=plan → panel; tier=compact → single compact pool", () => {
    const routing = routingConfigSchema.parse({ mode: "single" });
    const plan = decideStatic(userReq("hi"), routing, 0, { tier: "plan" }, "default");
    assert.equal(plan?.mode, "panel");
    const compact = decideStatic(userReq("hi"), routing, 0, { tier: "compact" }, "default");
    assert.equal(compact?.mode, "single");
    assert.equal(compact?.poolName, "compact");
  });

  it("override mode=all forces panel even when config is single", () => {
    const routing = routingConfigSchema.parse({ mode: "single" });
    const d = decideStatic(userReq("hi"), routing, 0, { mode: "all" }, "default");
    assert.equal(d?.mode, "panel");
  });
});

describe("fromTier", () => {
  const routing = routingConfigSchema.parse({});
  it("maps tiers to strategy + pool/panel", () => {
    assert.equal(fromTier("compact", routing, "default", "r").poolName, "compact");
    assert.equal(fromTier("regular", routing, "default", "r").poolName, "regular");
    const plan = fromTier("plan", routing, "default", "r");
    assert.equal(plan.mode, "panel");
    assert.equal(plan.panelName, "default");
  });

  it("plan falls back to single when no panel name resolves", () => {
    const noPanel = routingConfigSchema.parse({ smart: { tiers: { plan: { panel: "" } } } });
    assert.equal(fromTier("plan", noPanel, undefined, "r").mode, "single");
  });
});

describe("disablePanelWhenTools (tools ⇒ never panel)", () => {
  const routing = routingConfigSchema.parse({});

  it("downgrades a panel decision to single(orchestrator) when tools are present", () => {
    const panel = fromTier("plan", routing, "default", "classified plan", {
      compact: 0.2,
      regular: 0.3,
      plan: 0.6,
    });
    assert.equal(panel.mode, "panel");
    const safe = disablePanelWhenTools(panel, true);
    assert.equal(safe.mode, "single");
    assert.equal(safe.poolName, "actor");
    assert.equal(safe.tier, "plan"); // tier preserved for the x-fusion-route header
    assert.deepEqual(safe.scores, { compact: 0.2, regular: 0.3, plan: 0.6 }); // scores preserved
    assert.match(safe.reason, /tools->single/);
  });

  it("leaves a panel decision unchanged when there are no tools", () => {
    const panel = fromTier("plan", routing, "default", "r");
    assert.equal(disablePanelWhenTools(panel, false), panel);
  });

  it("leaves a single decision unchanged even with tools", () => {
    const single = fromTier("regular", routing, "default", "r");
    assert.equal(disablePanelWhenTools(single, true), single);
  });
});
