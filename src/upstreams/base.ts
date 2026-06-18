import type { UpstreamConfig } from "../config/schema.js";
import { fetchWithTimeout, TimeoutError } from "../util/http-fetch.js";
import { parseRetryAfter } from "../util/retry.js";
import { UpstreamError } from "./types.js";

export function isRetryableStatus(status: number): boolean {
  // 401/403/404 from an upstream usually mean *that* provider is misconfigured
  // (bad/missing key, wrong model) — fail over to the next upstream rather than
  // killing the whole request. 5xx / timeouts / rate limits also fail over.
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

/** Resolve the API key for an upstream from inline config or an env var. */
export function resolveApiKey(config: UpstreamConfig): string | undefined {
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv]?.trim();
    if (fromEnv) return fromEnv;
  }
  return config.apiKey?.trim() || undefined;
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 2000);
  } catch {
    return "";
  }
}

/**
 * Perform a JSON request and return the raw Response. On a non-2xx status or a
 * network/timeout error, throws a classified UpstreamError so the failover
 * layer can decide whether to advance the ring.
 */
export async function sendRequest(
  upstreamId: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; timeoutMs: number },
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeoutMs: init.timeoutMs,
      signal,
    });
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new UpstreamError(upstreamId, null, true, null, `timeout: ${err.message}`);
    }
    // Client-initiated abort is not retryable; genuine network failures are.
    if (err instanceof Error && err.name === "AbortError" && signal.aborted) {
      throw new UpstreamError(upstreamId, null, false, null, "client aborted");
    }
    throw new UpstreamError(
      upstreamId,
      null,
      true,
      null,
      `network error: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    const retryable = isRetryableStatus(res.status);
    const body = await safeBodyText(res);
    throw new UpstreamError(
      upstreamId,
      res.status,
      retryable,
      retryAfterMs,
      `HTTP ${res.status} from ${upstreamId}: ${body}`,
    );
  }
  return res;
}
