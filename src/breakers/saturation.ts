/*
Saturation Circuit Breaker

The default breaker behind Semaphore, and a self-contained state machine usable
standalone. It is a windowed failure-rate breaker: what it means depends on the
signal feeding recordFailure(). Fed queue-acquisition timeouts (the semaphore's
default wiring) it is a saturation breaker; fed downstream errors (via
Semaphore.reportFailure(), or directly when standalone) it is an error-rate
breaker.

Transitions
  closed → open       Failure rate crosses threshold (with min-count guards).
  open → probing    Cooldown elapses; detected on the next acquire() call.
  probing → closed  Probe request completes successfully.
  probing → open    Probe request fails; full cooldown restarts.

Transitions are demand-driven: checkAndTransition() is called at the top of
every acquire() so open → probing fires on the first request after cooldown,
not on a background timer.

State transitions are surfaced as return values so the caller (Semaphore) can
emit events. This keeps the breaker free of event/metrics dependencies and
usable as a standalone primitive.
*/

import { validateNumber } from "../validation";
import { SemaphoreError } from '../error';

import type { CircuitState, CircuitBreakerConfig, CircuitBreakerStrategy, CircuitTripResult } from '../types';

/*
CircuitBreakerEventWindow — a minimal bucketed sliding window used exclusively
by the circuit breaker. Not exported; consumers use the richer SemaphoreMetrics
windows for observability.
*/
class CircuitBreakerEventWindow {
  readonly #buckets: Int32Array;
  readonly #timestamps: Float64Array;
  readonly #size: number;
  readonly #stepMs: number;

  // Current-bucket cache (see CombinedWindow.bucket in ../metrics): hot-path
  // resolution is two comparisons; the division runs only on step rollover.
  #cachedIndex = -1;
  #cachedUntil = 0;

  constructor(size: number, stepMs: number) {
    this.#size       = size;
    this.#stepMs     = stepMs;
    this.#buckets    = new Int32Array(size * 2); // [acquired, timeouts] per bucket
    this.#timestamps = new Float64Array(size);
  }

  #idx(now: number): number {
    if (now < this.#cachedUntil && now >= this.#cachedUntil - this.#stepMs) return this.#cachedIndex;
    const ts = Math.floor(now / this.#stepMs) * this.#stepMs;
    const i = Math.floor(ts / this.#stepMs) % this.#size;
    if (this.#timestamps[i] !== ts) {
      this.#timestamps[i] = ts;
      this.#buckets[i * 2] = 0;
      this.#buckets[i * 2 + 1] = 0;
    }
    this.#cachedIndex = i;
    this.#cachedUntil = ts + this.#stepMs;
    return i;
  }

  public addAcquired(now = Date.now()): void { this.#buckets[this.#idx(now) * 2]++; }
  public addTimeout(): void  { this.#buckets[this.#idx(Date.now()) * 2 + 1]++; }

  public snapshot(): { acquired: number; timeouts: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / this.#stepMs) * this.#stepMs - (this.#size - 1) * this.#stepMs;
    let acquired = 0, timeouts = 0;
    for (let i = 0; i < this.#size; i++) {
      if (this.#timestamps[i] >= windowStart) {
        acquired += this.#buckets[i * 2];
        timeouts += this.#buckets[i * 2 + 1];
      }
    }
    return { acquired, timeouts };
  }

  public reset(): void {
    this.#cachedIndex = -1;
    this.#cachedUntil = 0;
    this.#buckets.fill(0);
    this.#timestamps.fill(0);
  }
}

export class SaturationCircuitBreaker implements CircuitBreakerStrategy {

  public state: CircuitState = 'closed';
  #openUntil = 0;
  #probeInFlight = false;
  #probeTaskId: number | null = null;

  readonly #eventWindow: CircuitBreakerEventWindow;
  readonly #threshold: number;
  readonly #window: number;
  readonly #windowBucketWidth: number;
  readonly #windowBucketCount: number;
  readonly #cooldown: number;
  readonly #minThroughput: number;
  readonly #minFailures: number;

  constructor(config: CircuitBreakerConfig = {}) {

    // (0, 1)
    this.#threshold = validateNumber(config.threshold ?? 0.5, "SaturationCircuitBreaker threshold", 0, 1, false, false);
    // >= 1000
    this.#window = validateNumber(config.window ?? 10000, "SaturationCircuitBreaker window", 1000, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.#windowBucketWidth = validateNumber(config.windowBucketWidth ?? 1000, "SaturationCircuitBreaker windowBucketWidth", 1, Number.MAX_SAFE_INTEGER, true, true);
    // > 1
    this.#windowBucketCount = Math.ceil(this.#window / this.#windowBucketWidth); // See integrated cross-check below for validation
    // >= 1000
    this.#cooldown = validateNumber(config.cooldown ?? 5000, "SaturationCircuitBreaker cooldown", 1000, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.#minThroughput = validateNumber(config.minThroughput ?? 10, "SaturationCircuitBreaker minThroughput", 1, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.#minFailures = validateNumber(config.minFailures ?? 5, "SaturationCircuitBreaker minFailures", 1, Number.MAX_SAFE_INTEGER, true, true);

    // Integrated Cross-Checks
    if (this.#window < this.#windowBucketWidth) {
      throw new SemaphoreError("SaturationCircuitBreaker window must be >= windowBucketWidth", 'INVALID_ARGUMENT');
    }
    if (this.#minThroughput < this.#minFailures) {
      throw new SemaphoreError("SaturationCircuitBreaker minThroughput must be >= minFailures", 'INVALID_ARGUMENT');
    }
    // A single-bucket window (window === windowBucketWidth) reuses the same
    // bucket every step: a write that lands just after a wall-clock bucket
    // rollover zeroes it before recording, silently discarding counts from
    // earlier in the same logical window. Two or more buckets guarantee the
    // oldest bucket is only ever reused once it has actually aged out of the
    // window, so in-window data is never clobbered by a same-window write.
    if (this.#windowBucketCount < 2) {
      throw new SemaphoreError("SaturationCircuitBreaker window must span at least 2 windowBucketWidth buckets", 'INVALID_ARGUMENT');
    }

    // Default of one 1-second bucket per second of the window; total coverage >= window ms.
    this.#eventWindow = new CircuitBreakerEventWindow(this.#windowBucketCount, this.#windowBucketWidth);
  }

  // Getters
  public get isClosed(): boolean  { return this.state === 'closed'; }
  public get isOpen(): boolean    { return this.state === 'open'; }
  public get isProbing(): boolean { return this.state === 'probing'; }
  public get hasProbeInFlight(): boolean { return this.#probeInFlight; }
  public get probeTaskId(): number | null { return this.#probeTaskId; }
  public get cooldownRemaining(): number { return this.isOpen ? Math.max(0, this.#openUntil - Date.now()) : 0; }

  /**
   * Records an attempt. Skipped during open/probing so only closed-circuit
   * traffic counts toward the failure rate.
   *
   * Accepts an optional caller-supplied timestamp so a caller that has
   * already read the clock for the same admission (the semaphore's metrics
   * path) doesn't pay a second Date.now() on the hot path.
   */
  public trackAttempt(now?: number): void {
    if (this.state === 'closed') this.#eventWindow.addAcquired(now);
  }

  /** Records a failure unconditionally (used for probe timeouts too). */
  public recordFailure(): void {
    this.#eventWindow.addTimeout();
  }

  /**
   * open → probing if the cooldown has elapsed.
   * Returns true if the transition just occurred (caller emits CIRCUITPROBING).
   */
  public checkAndTransition(): boolean {
    if (this.state !== 'open') return false;
    if (Date.now() < this.#openUntil) return false;
    this.state = 'probing';
    this.#probeInFlight = false;
    this.#probeTaskId = null;
    return true;
  }

  /**
   * Evaluates the eventWindow and trips the circuit if the failure rate exceeds
   * the threshold. Min-count guards prevent false trips at low traffic.
   * Returns trip data for the CIRCUITOPEN event payload if tripped.
   */
  public evaluateAndTrip(): CircuitTripResult {
    if (this.state !== 'closed') return { tripped: false };
    const { timeouts: failures, acquired: attempts } = this.#eventWindow.snapshot();
    if (attempts < this.#minThroughput || failures < this.#minFailures) return { tripped: false };
    const timeoutRate = failures / attempts;
    if (timeoutRate < this.#threshold) return { tripped: false };
    this.state = 'open';
    this.#openUntil = Date.now() + this.#cooldown;
    return { tripped: true, timeoutRate, failures, attempts };
  }

  /** Mark a fast-path probe in flight (no queued task ID to track). */
  public markProbeInFlight(): void {
    this.#probeInFlight = true;
  }

  /** Register a queued probe task so the scheduler can identify it. */
  public claimProbeSlot(taskId: number): void {
    this.#probeInFlight = true;
    this.#probeTaskId = taskId;
  }

  /** Release the probe slot without changing circuit state (used on abort). */
  public releaseProbeSlot(): void {
    this.#probeInFlight = false;
    this.#probeTaskId = null;
  }

  /** probing → closed. Resets the eventWindow so stale failures don't re-trip. */
  public handleProbeSuccess(): void {
    this.state = 'closed';
    this.#probeInFlight = false;
    this.#probeTaskId = null;
    this.#eventWindow.reset();
  }

  /** probing → open. Re-arms the full cooldown. */
  public handleProbeFailure(): void {
    this.state = 'open';
    this.#probeInFlight = false;
    this.#probeTaskId = null;
    this.#openUntil = Date.now() + this.#cooldown;
  }

  /** Reset circuit breaker. */
  public reset(): void {
    this.state = 'closed';
    this.#openUntil = 0;
    this.#probeInFlight = false;
    this.#probeTaskId = null;
    this.#eventWindow.reset();
  }
}
