import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  neutralResultToOpenai,
  neutralStreamToOpenai,
  openaiRequestToNeutral,
  parseOpenaiRouteOverride,
} from "../adapters/openai.js";
import { flattenText, type NeutralResult, type StreamEvent } from "../neutral/types.js";

async function* gen(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("openaiRequestToNeutral", () => {
  it("separates system, maps user/tool, parses tools and stream", () => {
    const n = openaiRequestToNeutral(
      {
        model: "fusion/coder",
        stream: true,
        max_tokens: 50,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        tool_choice: "auto",
      },
      "sess",
    );
    assert.equal(flattenText(n.system ?? []), "be terse");
    assert.equal(n.messages.length, 1);
    assert.equal(flattenText(n.messages[0]!.content), "hi");
    assert.equal(n.stream, true);
    assert.equal(n.maxTokens, 50);
    assert.equal(n.tools?.[0]?.name, "f");
    assert.equal(n.toolChoice, "auto");
    assert.equal(n.sessionId, "sess");
  });

  it("parses a data-URI image into a base64 part", () => {
    const n = openaiRequestToNeutral(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      },
      "s",
    );
    const img = n.messages[0]!.content[1]!;
    assert.equal(img.kind, "image");
    if (img.kind === "image") {
      assert.equal(img.mediaType, "image/png");
      assert.deepEqual(img.source, { type: "base64", data: "AAAA" });
    }
  });

  it("parses route overrides", () => {
    assert.deepEqual(parseOpenaiRouteOverride({ fusion_route: "panel", panel: "debug" }), {
      mode: "panel",
      panel: "debug",
    });
  });
});

describe("neutralResultToOpenai", () => {
  it("builds a chat.completion with usage", () => {
    const result: NeutralResult = {
      model: "m",
      content: [{ kind: "text", text: "hello" }],
      stopReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 },
    };
    const out = neutralResultToOpenai(result, "fusion/coder") as {
      object: string;
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    assert.equal(out.object, "chat.completion");
    assert.equal(out.model, "fusion/coder");
    assert.equal(out.choices[0]!.message.content, "hello");
    assert.equal(out.choices[0]!.finish_reason, "stop");
    assert.equal(out.usage.total_tokens, 5);
  });
});

describe("neutralStreamToOpenai", () => {
  it("emits content chunks then a finish chunk and [DONE]", async () => {
    const chunks = await collect(
      neutralStreamToOpenai(
        gen([
          { type: "start", model: "m" },
          { type: "text-delta", text: "ab" },
          { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
          { type: "stop", reason: "stop" },
        ]),
        "fusion/coder",
      ),
    );
    assert.equal(chunks[chunks.length - 1], "data: [DONE]\n\n");
    assert.ok(chunks.some((c) => c.includes('"content":"ab"')));
    assert.ok(chunks.some((c) => c.includes('"finish_reason":"stop"')));
  });
});
