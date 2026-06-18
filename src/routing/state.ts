import type { PoolsConfig } from "../config/schema.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { RoundRobinRing } from "./ring.js";

/** Process-global routing state: round-robin rings, breakers, session affinity. */
export class RoutingState {
  readonly orchestrator: RoundRobinRing<string>;
  readonly panels: Map<string, RoundRobinRing<string>>;
  private readonly breakers = new Map<string, CircuitBreaker>();
  readonly affinity = new Map<string, string>();

  constructor(pools: PoolsConfig) {
    this.orchestrator = new RoundRobinRing(pools.orchestrator);
    this.panels = new Map(
      Object.entries(pools.panel).map(([name, members]) => [name, new RoundRobinRing(members)]),
    );
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
