import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { neutralToResponsesBody, responsesResponseToNeutral } from "../adapters/responses.js";
import { flattenText, type NeutralRequest } from "../neutral/types.js";
import { isObject } from "../adapters/json.js";

const opts = { signal: new AbortController().signal, maxTokens: 100, depth: 1 };

const req: NeutralRequest = {
  model: "m",
  system: [{ kind: "text", text: "sys" }],
  messages: [
    { role: "user", content: [{ kind: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{ kind: "text", text: "ok" }],
      toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}' }],
    },
    { role: "tool", content: [{ kind: "text", text: "42" }], toolCallId: "c1" },
  ],
  stream: false,
  sessionId: "s",
};

describe("neutralToResponsesBody", () => {
  it("uses instructions for system, sets store=false, and never includes item ids", () => {
    const body = neutralToResponsesBody(req, "m", opts);
    assert.equal(body["instructions"], "sys");
    assert.equal(body["store"], false);
    const input = body["input"] as Record<string, unknown>[];
    const types = input.map((i) => i["type"]);
    assert.deepEqual(types, ["message", "message", "function_call", "function_call_output"]);
    for (const item of input) {
      assert.equal(isObject(item) && "id" in item, false);
    }
    const fnCall = input[2]!;
    assert.equal(fnCall["call_id"], "c1");
    const fnOut = input[3]!;
    assert.equal(fnOut["call_id"], "c1");
    assert.equal(fnOut["output"], "42");
  });
});

describe("responsesResponseToNeutral", () => {
  it("parses output text + function calls + cached usage", () => {
    const n = responsesResponseToNeutral(
      {
        response: {
          model: "m",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hello" }],
            },
            { type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
          ],
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
        },
      },
      "m",
    );
    assert.equal(flattenText(n.content), "hello");
    assert.equal(n.toolCalls?.[0]?.id, "c1");
    assert.equal(n.toolCalls?.[0]?.arguments, '{"a":1}');
    assert.equal(n.stopReason, "tool_calls");
    assert.equal(n.usage.inputTokens, 10);
    assert.equal(n.usage.cacheReadTokens, 4);
  });
});
