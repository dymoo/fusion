import { isObject, type JsonObject } from "../adapters/json.js";

/** Decode a JWT payload (no signature verification — we only read claims). */
export function decodeJwtPayload(token: string): JsonObject | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Unix-seconds `exp` claim, or null. */
export function getExp(token: string): number | null {
  const claims = decodeJwtPayload(token);
  const exp = claims?.exp;
  return typeof exp === "number" ? exp : null;
}

/** True if the token is expired or within `skewSec` of expiry. */
export function isExpired(token: string, skewSec = 60, now = Date.now()): boolean {
  const exp = getExp(token);
  if (exp === null) return true;
  return exp * 1000 - now < skewSec * 1000;
}

/** Extract the ChatGPT account id from token claims, by priority. */
export function extractAccountIdFromClaims(claims: JsonObject | null): string | undefined {
  if (!claims) return undefined;
  const root = claims["chatgpt_account_id"];
  if (typeof root === "string" && root) return root;

  const authNs = claims["https://api.openai.com/auth"];
  if (isObject(authNs)) {
    const nested = authNs["chatgpt_account_id"];
    if (typeof nested === "string" && nested) return nested;
  }

  const orgs = claims["organizations"];
  if (Array.isArray(orgs) && isObject(orgs[0])) {
    const id = orgs[0]["id"];
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}
