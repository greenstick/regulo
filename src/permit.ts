/*
Permit Pool

Owns the core semaphore invariant:
  inFlight + available === capacity at all times.

Permits are counted, not tasks: a weighted acquire consumes `weight` permits
and the matching release returns the same `weight`. Both mutators are guarded:
release() clamps to capacity (double-release safe) and the inFlight decrement
clamps to zero (reset-order safe).
*/

export class PermitPool {
  // Deliberately `private`, not `#private`: test/permit.test.ts corrupts
  // _available directly to force assertInvariant() into its violation branch.
  // Once acquire()/release()/reset() are the only mutators, that branch is
  // unreachable through any real caller — true `#private` would make it
  // untestable rather than just hard to reach, so these two stay reachable
  // via `(pool as any)._available` for that one white-box test.
  private _available: number;
  private _inFlight = 0;
  public readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this._available = capacity;
  }

  public get available(): number { return this._available; }
  public get inFlight(): number { return this._inFlight; }
  public get isFull(): boolean { return this._available === 0; }

  /** True if at least `weight` permits are free. The weighted form of !isFull. */
  public hasCapacityFor(weight: number): boolean { return this._available >= weight; }

  /** Consume `weight` permits. Caller must verify hasCapacityFor(weight) first. */
  public acquire(weight = 1): void {
    this._available -= weight;
    this._inFlight += weight;
  }

  /** Return `weight` permits. Safe against double-release and negative inFlight. */
  public release(weight = 1): void {
    this._available = Math.min(this._available + weight, this.capacity);
    this._inFlight = this._inFlight < weight ? 0 : this._inFlight - weight;
  }

  /** Logs invariant violations in debug mode. Call after every acquire/release. */
  public assertInvariant(debug: boolean): void {
    if (!debug) return;
    const actual = this._inFlight + this._available;
    if (actual !== this.capacity) {
      console.error(
        `[Semaphore] Invariant violation: inFlight(${this._inFlight}) + available(${this._available}) = ${actual}, expected capacity(${this.capacity})`
      );
    }
  }

  public reset(): void {
    this._available = this.capacity;
    this._inFlight = 0;
  }
}
