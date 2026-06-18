import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ModelDescriptor } from "../capabilities/types.js";
import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import { Executor, RingExhaustedError } from "../routing/failover.js";
import { RoutingState } from "../routing/state.js";
import type { Upstream, UpstreamCallOptions } from "../upstreams/types.js";
import { UpstreamError } from "../upstreams/types.js";

function mockUpstream(id: string, behavior: () => Promise<NeutralResult>): Upstream {
  return {
    id,
    kind: "openai-compatible",
    complete: behavior,
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "start", model: id };
    },
    async discover(): Promise<ModelDescriptor[]> {
      return [];
    },
  };
}

const okResult = (model: string): NeutralResult => ({
  model,
  content: [{ kind: "text", text: "ok" }],
  stopReason: "stop",
  usage: { inputTokens: 0, outputTokens: 0 },
});

const req: NeutralRequest = { model: "m", messages: [], stream: false, sessionId: "s" };
const opts: UpstreamCallOptions = {
  signal: new AbortController().signal,
  maxTokens: 100,
  depth: 1,
};

describe("Executor.complete failover", () => {
  it("advances to the next upstream on a retryable error", async () => {
    const upstreams = new Map<string, Upstream>([
      [
        "a",
        mockUpstream("a", () => Promise.reject(new UpstreamError("a", 500, true, null, "boom"))),
      ],
      ["b", mockUpstream("b", () => Promise.resolve(okResult("b")))],
    ]);
    const state = new RoutingState({ orchestrator: ["a", "b"], panel: {} });
    const exec = new Executor(upstreams, state, false);
    const { id } = await exec.complete(state.orchestrator, req, opts);
    assert.equal(id, "b");
  });

  it("surfaces a non-retryable error immediately", async () => {
    const upstreams = new Map<string, Upstream>([
      [
        "a",
        mockUpstream("a", () =>
          Promise.reject(new UpstreamError("a", 400, false, null, "bad request")),
        ),
      ],
      ["b", mockUpstream("b", () => Promise.resolve(okResult("b")))],
    ]);
    const state = new RoutingState({ orchestrator: ["a", "b"], panel: {} });
    const exec = new Executor(upstreams, state, false);
    await assert.rejects(() => exec.complete(state.orchestrator, req, opts), UpstreamError);
  });

  it("throws RingExhaustedError when all upstreams fail", async () => {
    const upstreams = new Map<string, Upstream>([
      [
        "a",
        mockUpstream("a", () => Promise.reject(new UpstreamError("a", 503, true, null, "down"))),
      ],
      [
        "b",
        mockUpstream("b", () => Promise.reject(new UpstreamError("b", 503, true, null, "down"))),
      ],
    ]);
    const state = new RoutingState({ orchestrator: ["a", "b"], panel: {} });
    const exec = new Executor(upstreams, state, false);
    await assert.rejects(() => exec.complete(state.orchestrator, req, opts), RingExhaustedError);
  });
});

describe("Executor session affinity", () => {
  function countingUpstreams(): Map<string, Upstream> {
    return new Map<string, Upstream>([
      ["a", mockUpstream("a", () => Promise.resolve(okResult("a")))],
      ["b", mockUpstream("b", () => Promise.resolve(okResult("b")))],
    ]);
  }

  it("pins a session to the first-served model across turns (coherent multi-turn)", async () => {
    const state = new RoutingState({ orchestrator: ["a", "b"], panel: {} });
    const exec = new Executor(countingUpstreams(), state, true);
    const first = await exec.complete(state.orchestrator, req, opts);
    const second = await exec.complete(state.orchestrator, req, opts);
    const third = await exec.complete(state.orchestrator, req, opts);
    // Without affinity the ring would rotate a→b→a; affinity keeps it pinned.
    assert.equal(second.id, first.id);
    assert.equal(third.id, first.id);
    assert.equal(state.affinityFor("s"), first.id);
  });

  it("does not pin when affinity is disabled (round-robins)", async () => {
    const state = new RoutingState({ orchestrator: ["a", "b"], panel: {} });
    const exec = new Executor(countingUpstreams(), state, false);
    const first = await exec.complete(state.orchestrator, req, opts);
    const second = await exec.complete(state.orchestrator, req, opts);
    assert.notEqual(second.id, first.id);
    assert.equal(state.affinityFor("s"), undefined);
  });
});
