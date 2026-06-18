import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { injectAnthropicCache } from "../caching/anthropic-cache.js";
import { isObject, type JsonObject } from "../adapters/json.js";

function body(): JsonObject {
  return {
    model: "x",
    tools: [{ name: "t1" }, { name: "t2" }],
    system: [
      { type: "text", text: "sys-a" },
      { type: "text", text: "sys-b" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "m1" }] },
      { role: "assistant", content: [{ type: "text", text: "m2" }] },
      { role: "user", content: [{ type: "text", text: "m3" }] },
    ],
  };
}

function cc(block: unknown): unknown {
  return isObject(block) ? block["cache_control"] : undefined;
}

describe("injectAnthropicCache", () => {
  it("marks tools + last system block with 1h and last messages with 5m", () => {
    const b = injectAnthropicCache(body(), { enabled: true, maxBreakpoints: 4, oneHour: true });
    const tools = b["tools"] as unknown[];
    const system = b["system"] as unknown[];
    const messages = b["messages"] as JsonObject[];

    assert.deepEqual(cc(tools[1]), { type: "ephemeral", ttl: "1h" });
    assert.equal(cc(tools[0]), undefined);
    assert.deepEqual(cc(system[1]), { type: "ephemeral", ttl: "1h" });

    const lastContent = messages[2]?.["content"] as unknown[];
    const midContent = messages[1]?.["content"] as unknown[];
    assert.deepEqual(cc(lastContent[0]), { type: "ephemeral" });
    assert.deepEqual(cc(midContent[0]), { type: "ephemeral" });
  });

  it("respects the breakpoint budget", () => {
    const b = injectAnthropicCache(body(), { enabled: true, maxBreakpoints: 2, oneHour: true });
    const messages = b["messages"] as JsonObject[];
    // budget of 2 is consumed by tools + system; no message gets a breakpoint
    for (const m of messages) {
      const content = m["content"] as unknown[];
      assert.equal(cc(content[0]), undefined);
    }
  });

  it("is a no-op when disabled", () => {
    const b = injectAnthropicCache(body(), { enabled: false, maxBreakpoints: 4, oneHour: true });
    const tools = b["tools"] as unknown[];
    assert.equal(cc(tools[1]), undefined);
  });
});
