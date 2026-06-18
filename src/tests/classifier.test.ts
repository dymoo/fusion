import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { smartRoutingSchema } from "../config/schema.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { NeutralMessage, NeutralRequest } from "../neutral/types.js";
import { ClassifierUnavailableError, ComplexityClassifier } from "../routing/classifier.js";

// 5 dims: [compactTier, regularTier, planTier, harnessPlan, harnessCompact].
// Maps both anchor phrases and queries so each concept is separable.
// Harness markers are checked first (most specific); filler → low/neutral.
function vec(text: string): number[] {
  const t = text.toLowerCase();
  if (
    [
      "plan mode",
      "must not make",
      "exitplanmode",
      "planning phase",
      "read-only",
      "architect engineer",
      "act mode",
    ].some((k) => t.includes(k))
  )
    return [0, 0, 0, 1, 0];
  if (
    [
      "summary of the conversation",
      "primary request",
      "pending tasks",
      "continuation summary",
      "wrap your analysis",
    ].some((k) => t.includes(k))
  )
    return [0, 0, 0, 0, 1];
  if (
    [
      "design",
      "architecture",
      "refactor",
      "migrat",
      "compare",
      "trade",
      "root cause",
      "debug",
      "milestone",
      "evaluate",
      "data model",
      "implementation plan",
    ].some((k) => t.includes(k))
  )
    return [0, 0, 1, 0, 0];
  if (
    [
      "typo",
      "rename",
      "format",
      "import",
      "version",
      "log line",
      "type of",
      "change this string",
      "bump",
    ].some((k) => t.includes(k))
  )
    return [1, 0, 0, 0, 0];
  if (
    [
      "implement",
      "parser",
      "handler",
      "unit test",
      "error handling",
      "endpoint",
      "component",
      "loop",
      "field",
      "bug",
      "function",
    ].some((k) => t.includes(k))
  )
    return [0, 1, 0, 0, 0];
  return [0.1, 0.1, 0.1, 0.1, 0.1];
}

const stubEmbedder: Embedder = {
  id: "stub",
  warmup: () => Promise.resolve(),
  embed: (texts) => Promise.resolve(texts.map(vec)),
};

const throwingEmbedder: Embedder = {
  id: "throwing",
  warmup: () => Promise.resolve(),
  embed: () => Promise.reject(new Error("no onnx")),
};

const cfg = smartRoutingSchema.parse({});

function userReq(text: string): NeutralRequest {
  return {
    model: "fusion",
    messages: [{ role: "user", content: [{ kind: "text", text }] }],
    stream: false,
    sessionId: "s",
  };
}

function convo(turns: { role: NeutralMessage["role"]; text: string }[]): NeutralRequest {
  return {
    model: "fusion",
    messages: turns.map((t) => ({ role: t.role, content: [{ kind: "text", text: t.text }] })),
    stream: false,
    sessionId: "s",
  };
}

describe("ComplexityClassifier", () => {
  it("classifies short prompts by meaning, not size (no token guards)", async () => {
    const c = new ComplexityClassifier(stubEmbedder, cfg);
    assert.equal(
      (await c.classify(userReq("please rename this variable cleanly"))).tier,
      "compact",
    );
    assert.equal((await c.classify(userReq("implement the parser handler here"))).tier, "regular");
    const plan = await c.classify(userReq("design the architecture for the service"));
    assert.equal(plan.tier, "plan"); // short but complex → still plan
    assert.equal(plan.source, "embedding");
  });

  it("detects harness plan mode and routes to plan (semantically, not by substring)", async () => {
    const c = new ComplexityClassifier(stubEmbedder, cfg);
    const r = await c.classify(
      userReq(
        "Plan mode is active. You must not make any edits. Use ExitPlanMode to present your plan.",
      ),
    );
    assert.equal(r.tier, "plan");
    assert.equal(r.source, "harness");
  });

  it("detects a compaction request and routes to compact", async () => {
    const c = new ComplexityClassifier(stubEmbedder, cfg);
    const r = await c.classify(
      userReq(
        "Your task is to create a detailed summary of the conversation so far. Primary Request and Intent: ...",
      ),
    );
    assert.equal(r.tier, "compact");
    assert.equal(r.source, "harness");
  });

  it("max-pool: a terse latest turn after a complex earlier turn is NOT down-tiered to compact", async () => {
    const c = new ComplexityClassifier(stubEmbedder, cfg);
    const r = await c.classify(
      convo([
        { role: "user", text: "design the architecture and data model for a new payments service" },
        { role: "assistant", text: "Here is a proposed approach..." },
        { role: "user", text: "yes, do that" },
      ]),
    );
    assert.equal(r.tier, "plan");
  });

  it("max-pool: a terse latest turn reacting to a failing-test tool result stays non-compact", async () => {
    const c = new ComplexityClassifier(stubEmbedder, cfg);
    const r = await c.classify(
      convo([
        { role: "user", text: "run the suite" },
        { role: "assistant", text: "running" },
        { role: "tool", text: "FAILED: parser handler threw; please debug the root cause" },
        { role: "user", text: "fix it" },
      ]),
    );
    assert.notEqual(r.tier, "compact");
  });

  it("caches by assembled segments", async () => {
    const c = new ComplexityClassifier(stubEmbedder, cfg);
    await c.classify(userReq("implement the parser handler here"));
    const second = await c.classify(userReq("implement the parser handler here"));
    assert.equal(second.source, "cache");
  });

  it("throws (no silent fallback) when the embedding model is unavailable", async () => {
    const c = new ComplexityClassifier(throwingEmbedder, cfg);
    await assert.rejects(
      () => c.classify(userReq("design the architecture")),
      ClassifierUnavailableError,
    );
    assert.equal(c.ready().ready, false);
    assert.ok(c.ready().error);
  });
});
