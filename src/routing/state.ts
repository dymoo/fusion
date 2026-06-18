import type { PoolsConfig } from "../config/schema.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { RoundRobinRing } from "./ring.js";

/** Process-global routing state: round-robin rings, breakers, session affinity. */
export class RoutingState {
  readonly orchestrator: RoundRobinRing<string>;
  readonly panels: Map<string, RoundRobinRing<string>>;
  /** Named single-route rings used by smart tiers: orchestrator | compact | regular. */
  private readonly singleRings: Map<string, RoundRobinRing<string>>;
  private readonly breakers = new Map<string, CircuitBreaker>();
  /** sessionId -> pinned upstream id. Bounded so a long-running daemon can't leak. */
  private readonly affinity = new Map<string, string>();
  private readonly affinityCap = 2000;

  constructor(pools: PoolsConfig) {
    this.orchestrator = new RoundRobinRing(pools.orchestrator);
    this.panels = new Map(
      Object.entries(pools.panel).map(([name, members]) => [name, new RoundRobinRing(members)]),
    );
    const first = pools.orchestrator[0] as string;
    const compact = pools.compact ?? [first];
    const regular = pools.regular ?? pools.orchestrator.slice(0, 2);
    // Agentic/tool turns drive through the "actor" ring (the strong tool-driver);
    // defaults to the orchestrator members when no dedicated actor pool is set.
    const actor = pools.actor ?? [...pools.orchestrator];
    this.singleRings = new Map([
      ["orchestrator", this.orchestrator],
      ["compact", new RoundRobinRing(compact)],
      ["regular", new RoundRobinRing(regular)],
      ["actor", new RoundRobinRing(actor)],
    ]);
  }

  /** Resolve a single-route ring by name, falling back to the orchestrator ring. */
  singleRing(name: string | undefined): RoundRobinRing<string> {
    return (name && this.singleRings.get(name)) || this.orchestrator;
  }

  /** The upstream a session is pinned to (session affinity), if any. */
  affinityFor(sessionId: string): string | undefined {
    return this.affinity.get(sessionId);
  }

  /** Pin a session to an upstream, evicting the oldest entry past the cap (≈LRU). */
  pinAffinity(sessionId: string, id: string): void {
    // Re-insert so a re-pinned session moves to the most-recent slot.
    this.affinity.delete(sessionId);
    this.affinity.set(sessionId, id);
    if (this.affinity.size > this.affinityCap) {
      const oldest = this.affinity.keys().next().value;
      if (oldest !== undefined) this.affinity.delete(oldest);
    }
  }

  breaker(id: string): CircuitBreaker {
    let b = this.breakers.get(id);
    if (!b) {
      b = new CircuitBreaker();
      this.breakers.set(id, b);
    }
    return b;
  }

  panelRing(name: string): RoundRobinRing<string> | undefined {
    return this.panels.get(name);
  }

  firstPanelName(): string | undefined {
    return this.panels.keys().next().value;
  }
}
