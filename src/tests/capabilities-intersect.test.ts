import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { clampMaxTokens, intersectCapabilities } from "../capabilities/intersect.js";
import type { Capabilities } from "../capabilities/types.js";

const a: Capabilities = {
  tools: true,
  modalities: ["text", "image"],
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
};
const b: Capabilities = {
  tools: true,
  modalities: ["text"],
  contextWindow: 32_000,
  maxOutputTokens: 8_192,
};
const c: Capabilities = {
  tools: false,
  modalities: ["text", "image"],
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
};

describe("intersectCapabilities", () => {
  it("ANDs tool support", () => {
    assert.equal(intersectCapabilities([a, b]).tools, true);
    assert.equal(intersectCapabilities([a, c]).tools, false);
  });

  it("intersects modalities (image dropped when any member is text-only)", () => {
    assert.deepEqual(intersectCapabilities([a, b]).modalities, ["text"]);
    assert.deepEqual(intersectCapabilities([a, c]).modalities, ["text", "image"]);
  });

  it("takes the minimum context window and max output", () => {
    const r = intersectCapabilities([a, b, c]);
    assert.equal(r.contextWindow, 32_000);
    assert.equal(r.maxOutputTokens, 8_192);
  });

  it("falls back to a conservative default for an empty route", () => {
    const r = intersectCapabilities([]);
    assert.equal(r.tools, false);
    assert.deepEqual(r.modalities, ["text"]);
  });
});

describe("clampMaxTokens", () => {
  it("uses the floor when the client did not request a limit", () => {
    assert.equal(clampMaxTokens(undefined, b), 8_192);
  });

  it("clamps a request above the floor down to the floor", () => {
    assert.equal(clampMaxTokens(1_000_000, b), 8_192);
  });

  it("keeps a request below the floor", () => {
    assert.equal(clampMaxTokens(2_000, b), 2_000);
  });
});
