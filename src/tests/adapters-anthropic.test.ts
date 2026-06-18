import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  anthropicRequestToNeutral,
  neutralResultToAnthropic,
  neutralStreamToAnthropic,
} from "../adapters/anthropic.js";
import { flattenText, type NeutralResult, type StreamEvent } from "../neutral/types.js";

async function* gen(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}
async function join(it: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const c of it) s += c;
  return s;
}

describe("anthropicRequestToNeutral", () => {
  it("splits tool_result blocks into neutral tool messages", () => {
    const n = anthropicRequestToNeutral(
      {
        model: "m",
        max_tokens: 100,
        system: [{ type: "text", text: "sys" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "tu1", name: "f", input: { a: 1 } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu1", content: "42" },
              { type: "text", text: "thanks" },
            ],
          },
        ],
        tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
        tool_choice: { type: "auto" },
      },
      "s",
    );
    assert.equal(flattenText(n.system ?? []), "sys");
    assert.equal(n.maxTokens, 100);
    assert.equal(n.messages[0]!.role, "user");
    assert.equal(n.messages[1]!.role, "assistant");
    assert.equal(n.messages[1]!.toolCalls?.[0]?.name, "f");
    assert.equal(n.messages[1]!.toolCalls?.[0]?.arguments, JSON.stringify({ a: 1 }));
    assert.equal(n.messages[2]!.role, "tool");
    assert.equal(n.messages[2]!.toolCallId, "tu1");
    assert.equal(flattenText(n.messages[2]!.content), "42");
    assert.equal(flattenText(n.messages[3]!.content), "thanks");
    assert.equal(n.tools?.[0]?.name, "f");
    assert.equal(n.toolChoice, "auto");
  });
});

describe("neutralResultToAnthropic", () => {
  it("renders text + tool_use blocks with parsed input", () => {
    const result: NeutralResult = {
      model: "m",
      content: [{ kind: "text", text: "ok" }],
      toolCalls: [{ id: "tu1", name: "f", arguments: '{"a":1}' }],
      stopReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const out = neutralResultToAnthropic(result, "claude-fusion") as {
      type: string;
      content: { type: string; input?: unknown }[];
      stop_reason: string;
    };
    assert.equal(out.type, "message");
    assert.equal(out.content[0]!.type, "text");
    assert.equal(out.content[1]!.type, "tool_use");
    assert.deepEqual(out.content[1]!.input, { a: 1 });
    assert.equal(out.stop_reason, "tool_use");
  });
});

describe("neutralStreamToAnthropic", () => {
  it("emits the full event sequence in order", async () => {
    const s = await join(
      neutralStreamToAnthropic(
        gen([
          { type: "start", model: "m" },
          { type: "text-delta", text: "hi" },
          { type: "tool-call-start", index: 0, id: "tu1", name: "f" },
          { type: "tool-call-delta", index: 0, argsDelta: '{"a":1}' },
          { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
          { type: "stop", reason: "tool_calls" },
        ]),
        "claude-fusion",
      ),
    );
    const order = [
      "event: message_start",
      "event: content_block_start",
      '"type":"text_delta"',
      "event: content_block_stop",
      '"type":"tool_use"',
      '"type":"input_json_delta"',
      "event: message_delta",
      '"stop_reason":"tool_use"',
      "event: message_stop",
    ];
    let prev = -1;
    for (const marker of order) {
      const idx = s.indexOf(marker);
      assert.ok(idx > prev, `expected "${marker}" after position ${prev}, got ${idx}`);
      prev = idx;
    }
  });
});
