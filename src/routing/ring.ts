/**
 * Round-robin ring. `next()` advances the cursor and returns the new head;
 * `iterateFrom()` yields members starting at a given one, wrapping exactly once,
 * skipping any excluded members (used by the failover loop).
 */
export class RoundRobinRing<T> {
  private cursor = -1;
  readonly members: readonly T[];

  constructor(members: readonly T[]) {
    this.members = [...members];
  }

  get size(): number {
    return this.members.length;
  }

  next(): T {
    if (this.members.length === 0) throw new Error("RoundRobinRing is empty");
    this.cursor = (this.cursor + 1) % this.members.length;
    return this.members[this.cursor] as T;
  }

  iterateFrom(start: T, excluded: ReadonlySet<T> = new Set()): T[] {
    const n = this.members.length;
    const startIdx = Math.max(0, this.members.indexOf(start));
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const member = this.members[(startIdx + i) % n] as T;
      if (!excluded.has(member)) out.push(member);
    }
    return out;
  }
}
