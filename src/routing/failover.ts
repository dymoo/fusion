import type { NeutralRequest, NeutralResult, StreamEvent } from "../neutral/types.js";
import type { Upstream, UpstreamCallOptions } from "../upstreams/types.js";
import { UpstreamError } from "../upstreams/types.js";
import { logger } from "../util/logger.js";
import type { RoundRobinRing } from "./ring.js";
import type { RoutingState } from "./state.js";

export class RingExhaustedError extends Error {
  constructor(
    readonly members: readonly string[],
    readonly lastError: unknown,
  ) {
    super(
      `All upstreams failed (${members.join(", ")}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = "RingExhaustedError";
  }
}

/**
 * Runs requests across a round-robin ring with graceful failover: skips open
 * circuit breakers, advances on retryable errors (recording breaker failures
 * and honoring Retry-After), surfaces non-retryable 4xx immediately, and only
 * throws once the whole ring is exhausted.
 */
export class Executor {
  constructor(
    private readonly upstreams: Map<string, Upstream>,
    private readonly state: RoutingState,
    private readonly affinityEnabled: boolean,
  ) {}

  private pickStart(
    ring: RoundRobinRing<string>,
    sessionId: string,
    excluded: Set<string>,
  ): string {
    if (this.affinityEnabled) {
      const pinned = this.state.affinityFor(sessionId);
      if (pinned && ring.members.includes(pinned) && !excluded.has(pinned)) return pinned;
    }
    return ring.next();
  }

  async complete(
    ring: RoundRobinRing<string>,
    req: NeutralRequest,
    opts: UpstreamCallOptions,
    excluded: Set<string> = new Set(),
  ): Promise<{ id: string; result: NeutralResult }> {
    const start = this.pickStart(ring, req.sessionId, excluded);
    const candidates = ring.iterateFrom(start, excluded);
    let lastError: unknown = new Error("no candidates");
    for (const id of candidates) {
      const breaker = this.state.breaker(id);
      if (!breaker.canTry(Date.now())) continue;
      const upstream = this.upstreams.get(id);
      if (!upstream) continue;
      const attemptStart = Date.now();
      try {
        const result = await upstream.complete(req, opts);
        breaker.onSuccess();
        if (this.affinityEnabled) this.state.pinAffinity(req.sessionId, id);
        logger.debug("upstream attempt ok", { upstream: id, ms: Date.now() - attemptStart });
        return { id, result };
      } catch (err) {
        if (err instanceof UpstreamError && !err.retryable) throw err;
        const retryAfter = err instanceof UpstreamError ? err.retryAfterMs : null;
        breaker.onFailure(Date.now(), retryAfter);
        logger.warn("upstream failed, advancing ring", {
          upstream: id,
          ms: Date.now() - attemptStart,
          status: err instanceof UpstreamError ? err.status : null,
          error: (err as Error).message,
        });
        lastError = err;
      }
    }
    throw new RingExhaustedError(ring.members, lastError);
  }

  /**
   * Open a streaming request with failover during the connection phase. Once the
   * first event is received the upstream is committed; a later mid-stream error
   * is surfaced as a neutral error event rather than re-routed.
   */
  async openStream(
    ring: RoundRobinRing<string>,
    req: NeutralRequest,
    opts: UpstreamCallOptions,
    excluded: Set<string> = new Set(),
  ): Promise<{ id: string; stream: AsyncGenerator<StreamEvent> }> {
    const start = this.pickStart(ring, req.sessionId, excluded);
    const candidates = ring.iterateFrom(start, excluded);
    let lastError: unknown = new Error("no candidates");
    for (const id of candidates) {
      const breaker = this.state.breaker(id);
      if (!breaker.canTry(Date.now())) continue;
      const upstream = this.upstreams.get(id);
      if (!upstream) continue;
      const iterator = upstream.stream(req, opts)[Symbol.asyncIterator]();
      let first: IteratorResult<StreamEvent>;
      try {
        first = await iterator.next();
      } catch (err) {
        if (err instanceof UpstreamError && !err.retryable) throw err;
        const retryAfter = err instanceof UpstreamError ? err.retryAfterMs : null;
        breaker.onFailure(Date.now(), retryAfter);
        logger.warn("upstream stream open failed, advancing ring", {
          upstream: id,
          error: (err as Error).message,
        });
        lastError = err;
        continue;
      }
      breaker.onSuccess();
      if (this.affinityEnabled) this.state.pinAffinity(req.sessionId, id);
      return { id, stream: wrapStream(first, iterator) };
    }
    throw new RingExhaustedError(ring.members, lastError);
  }
}

async function* wrapStream(
  first: IteratorResult<StreamEvent>,
  iterator: AsyncIterator<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  if (!first.done) yield first.value;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  } catch (err) {
    yield { type: "error", message: (err as Error).message, retryable: false };
    yield { type: "stop", reason: "error" };
  }
}
