import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { cosine, meanNormalize, normalize } from "../embeddings/vector.js";

describe("vector", () => {
  it("cosine of identical direction is 1, orthogonal is 0", () => {
    assert.ok(Math.abs(cosine([1, 0, 0], [2, 0, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosine([1, 0, 0], [0, 1, 0])) < 1e-9);
  });

  it("cosine handles zero vectors", () => {
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });

  it("normalize returns a unit vector", () => {
    const v = normalize([3, 4]);
    assert.ok(Math.abs(Math.hypot(v[0] as number, v[1] as number) - 1) < 1e-9);
  });

  it("meanNormalize averages then normalizes", () => {
    const c = meanNormalize([
      [1, 0],
      [0, 1],
    ]);
    // mean is [0.5,0.5] → normalized [0.707,0.707]
    assert.ok(Math.abs((c[0] as number) - Math.SQRT1_2) < 1e-9);
    assert.ok(Math.abs((c[1] as number) - Math.SQRT1_2) < 1e-9);
  });
});
