/** Minimal safe accessors for parsing untrusted/unknown JSON without `any`. */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function getString(obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

export function getNumber(obj: unknown, key: string): number | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function getBoolean(obj: unknown, key: string): boolean | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}

export function getArray(obj: unknown, key: string): unknown[] {
  if (!isObject(obj)) return [];
  return asArray(obj[key]);
}

export function getObject(obj: unknown, key: string): JsonObject | undefined {
  if (!isObject(obj)) return undefined;
  const v = obj[key];
  return isObject(v) ? v : undefined;
}
