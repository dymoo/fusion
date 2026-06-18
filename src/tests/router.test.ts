import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { routingConfigSchema } from "../config/schema.js";
import type { NeutralRequest } from "../neutral/types.js";
import { decideRoute } from "../routing/router.js";

const routing = routingConfigSchema.parse({});
const panels = ["default"];

function userReq(text: string, extra: Partial<NeutralRequest> = {}): NeutralRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text }] }],
    stream: false,
    sessionId: "s",
    ...extra,
  };
}

describe("decideRoute", () => {
  it("defaults to single for a short, plain prompt", () => {
    assert.equal(decideRoute(userReq("hello"), routing, 0, {}, panels).mode, "single");
  });

  it("escalates to panel on a trigger keyword", () => {
    const d = decideRoute(userReq("please compare these two designs"), routing, 0, {}, panels);
    assert.equal(d.mode, "panel");
    assert.equal(d.panelName, "default");
  });

  it("override single beats escalation", () => {
    assert.equal(
      decideRoute(userReq("compare these"), routing, 0, { mode: "single" }, panels).mode,
      "single",
    );
  });

  it("override panel selects a named panel", () => {
    const d = decideRoute(userReq("hi"), routing, 0, { mode: "panel", panel: "default" }, panels);
    assert.equal(d.mode, "panel");
  });

  it("recursion guard forces single at depth>=1 even with a panel override", () => {
    assert.equal(
      decideRoute(userReq("compare"), routing, 1, { mode: "panel" }, panels).mode,
      "single",
    );
  });

  it("tool-bearing requests stay single", () => {
    const req = userReq("compare these", { tools: [{ name: "f", parameters: {} }] });
    assert.equal(decideRoute(req, routing, 0, {}, panels).mode, "single");
  });

  it("falls back to single when no panel is configured", () => {
    assert.equal(decideRoute(userReq("compare"), routing, 0, {}, []).mode, "single");
  });
});
