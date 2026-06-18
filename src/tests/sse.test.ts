import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { encodeSse, encodeSseJson, parseSseStream, type SseFrame } from "../util/sse.js";

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const parts = [text.slice(0, 5), text.slice(5)];
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]!));
      else controller.close();
    },
  });
}

describe("sse encode", () => {
  it("encodes data and named events", () => {
    assert.equal(encodeSse("hello"), "data: hello\n\n");
    assert.equal(encodeSse("x", "ping"), "event: ping\ndata: x\n\n");
    assert.equal(encodeSseJson({ a: 1 }), 'data: {"a":1}\n\n');
  });
});

describe("parseSseStream", () => {
  it("parses multi-frame streams split across chunks", async () => {
    const raw = 'event: message_start\ndata: {"a":1}\n\ndata: [DONE]\n\n';
    const frames: SseFrame[] = [];
    for await (const f of parseSseStream(streamFrom(raw))) frames.push(f);
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[0], { event: "message_start", data: '{"a":1}' });
    assert.deepEqual(frames[1], { data: "[DONE]" });
  });
});
