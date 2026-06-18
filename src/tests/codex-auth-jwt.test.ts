import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decodeJwtPayload, extractAccountIdFromClaims, getExp, isExpired } from "../auth/jwt.js";

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

describe("jwt", () => {
  it("decodes a payload", () => {
    const token = makeJwt({ exp: 123, foo: "bar" });
    assert.deepEqual(decodeJwtPayload(token), { exp: 123, foo: "bar" });
  });

  it("reads exp and applies skew", () => {
    const now = 1_000_000_000_000;
    const soon = makeJwt({ exp: Math.floor(now / 1000) + 30 }); // 30s left
    const later = makeJwt({ exp: Math.floor(now / 1000) + 600 }); // 10m left
    assert.equal(getExp(soon), Math.floor(now / 1000) + 30);
    assert.equal(isExpired(soon, 60, now), true); // within 60s skew
    assert.equal(isExpired(later, 60, now), false);
  });

  it("treats a malformed token as expired", () => {
    assert.equal(isExpired("not.a.jwt", 60, Date.now()), true);
  });

  it("extracts account id by priority", () => {
    assert.equal(extractAccountIdFromClaims({ chatgpt_account_id: "root" }), "root");
    assert.equal(
      extractAccountIdFromClaims({
        "https://api.openai.com/auth": { chatgpt_account_id: "nested" },
      }),
      "nested",
    );
    assert.equal(extractAccountIdFromClaims({ organizations: [{ id: "org-1" }] }), "org-1");
    assert.equal(extractAccountIdFromClaims({}), undefined);
  });
});
