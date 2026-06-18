/**
 * Per-upstream circuit breaker.
 *
 * closed    → normal; counts consecutive failures, opens at `threshold`.
 * open      → `canTry` is false until `openUntil`; then becomes half-open.
 * half-open → allows a single probe; success closes, failure re-opens with
 *             exponential backoff (capped).
 */
export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private consecutiveOpens = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 300_000;
  }

  state(now: number): BreakerState {
    if (this.openUntil === 0) return "closed";
    if (now < this.openUntil) return "open";
    return "half-open";
  }

  canTry(now: number): boolean {
    return this.state(now) !== "open";
  }

  onSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.consecutiveOpens = 0;
  }

  onFailure(now: number, retryAfterMs: number | null): void {
    this.failures += 1;
    if (this.failures >= this.threshold || retryAfterMs !== null) {
      const backoff = Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** this.consecutiveOpens);
      const cooldown = Math.max(backoff, retryAfterMs ?? 0);
      this.openUntil = now + cooldown;
      this.consecutiveOpens += 1;
      this.failures = 0;
    }
  }
}
