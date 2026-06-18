/**
 * fetch wrapper that adds a timeout and composes an optional external
 * AbortSignal (so a client disconnect cancels the upstream request too).
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Response> {
  const { method = "GET", headers, body, timeoutMs = 120_000, signal } = options;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);
  try {
    return await fetch(url, {
      method,
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
