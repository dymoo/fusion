import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CircuitBreaker } from "../routing/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and blocks tries during cooldown", () => {
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    const t0 = 1_000_000;
    assert.equal(b.canTry(t0), true);
    b.onFailure(t0, null);
    b.onFailure(t0, null);
    assert.equal(b.canTry(t0), true); // still under threshold
    b.onFailure(t0, null); // third → open
    assert.equal(b.canTry(t0 + 500), false);
    assert.equal(b.state(t0 + 500), "open");
  });

  it("becomes half-open after cooldown, then closes on success", () => {
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    const t0 = 2_000_000;
    b.onFailure(t0, null);
    assert.equal(b.state(t0 + 999), "open");
    assert.equal(b.state(t0 + 1001), "half-open");
    assert.equal(b.canTry(t0 + 1001), true);
    b.onSuccess();
    assert.equal(b.state(t0 + 1001), "closed");
  });

  it("honors Retry-After when longer than the cooldown", () => {
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    const t0 = 3_000_000;
    b.onFailure(t0, 60_000);
    assert.equal(b.canTry(t0 + 30_000), false);
    assert.equal(b.canTry(t0 + 61_000), true);
  });
});
