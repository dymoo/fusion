import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { lookupModelsDev } from "../capabilities/sources/models-dev.js";

describe("lookupModelsDev — Ollama Cloud model families", () => {
  // Without these entries, glm/kimi/minimax fall back to CONSERVATIVE_DEFAULT
  // (tools:false, maxOutputTokens:4096), which mis-advertises tools and truncates
  // long replies on a fresh install (no config capabilityOverrides).
  for (const id of ["glm-5.2", "kimi-k2.7-code", "minimax-m3"]) {
    it(`${id} resolves to tools:true with a real output budget`, () => {
      const caps = lookupModelsDev(id);
      assert.ok(caps, `expected a registry entry for ${id}`);
      assert.equal(caps.tools, true);
      assert.ok(caps.maxOutputTokens > 4096, `expected maxOutputTokens > 4096 for ${id}`);
      assert.ok(caps.contextWindow >= 32_768);
    });
  }
});
