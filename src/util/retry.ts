/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

/** Exponential backoff with cap (no jitter; deterministic for tests). */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
}
