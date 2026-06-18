import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { shouldConvene } from "../panel/council.js";

describe("shouldConvene (council trigger gate)", () => {
  it("convenes at or above the trigger tier", () => {
    assert.equal(shouldConvene("plan", "plan"), true);
    assert.equal(shouldConvene("regular", "regular"), true);
    assert.equal(shouldConvene("plan", "regular"), true);
  });

  it("does not convene below the trigger tier", () => {
    assert.equal(shouldConvene("compact", "plan"), false);
    assert.equal(shouldConvene("regular", "plan"), false);
    assert.equal(shouldConvene("compact", "regular"), false);
  });

  it("'always' convenes for every tier", () => {
    assert.equal(shouldConvene("compact", "always"), true);
    assert.equal(shouldConvene("regular", "always"), true);
    assert.equal(shouldConvene("plan", "always"), true);
  });
});
