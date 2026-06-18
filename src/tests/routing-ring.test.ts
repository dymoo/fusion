import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { RoundRobinRing } from "../routing/ring.js";

describe("RoundRobinRing", () => {
  it("advances the cursor round-robin", () => {
    const ring = new RoundRobinRing(["a", "b", "c"]);
    assert.equal(ring.next(), "a");
    assert.equal(ring.next(), "b");
    assert.equal(ring.next(), "c");
    assert.equal(ring.next(), "a");
  });

  it("iterates from a member, wrapping once", () => {
    const ring = new RoundRobinRing(["a", "b", "c"]);
    assert.deepEqual(ring.iterateFrom("b"), ["b", "c", "a"]);
  });

  it("skips excluded members", () => {
    const ring = new RoundRobinRing(["a", "b", "c"]);
    assert.deepEqual(ring.iterateFrom("a", new Set(["b"])), ["a", "c"]);
  });

  it("throws when empty", () => {
    const ring = new RoundRobinRing<string>([]);
    assert.throws(() => ring.next());
  });
});
