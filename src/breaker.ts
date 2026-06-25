/*
Circuit Breaker

Self-contained state machine.

Transitions
  closed → open       Failure rate crosses threshold (with min-count guards).
  open → half-open    Cooldown elapses; detected on the next acquire() call.
  half-open → closed  Probe request completes successfully.
  half-open → open    Probe request times out; full cooldown restarts.

Transitions are demand-driven: checkAndTransition() is called at the top of
every acquire() so open → half-open fires on the first request after cooldown,
not on a background timer.

State transitions are surfaced as return values so the caller (Semaphore) can
emit events. This keeps CircuitBreaker free of event/metrics dependencies and
usable as a standalone primitive.
*/

import { validateNumber } from "./validation";

import type { CircuitState, CircuitBreakerConfig, CircuitTripResult } from './types';

/*
CircuitBreakerEventWindow — a minimal bucketed sliding window used exclusively
by the circuit breaker. Not exported; consumers use the richer SemaphoreMetrics
windows for observability.
*/
class CircuitBreakerEventWindow {
  private readonly buckets: Int32Array;
  private readonly timestamps: Float64Array;
  private readonly size: number;
  private readonly stepMs: number;

  constructor(size: number, stepMs: number) {
    this.size       = size;
    this.stepMs     = stepMs;
    this.buckets    = new Int32Array(size * 2); // [acquired, timeouts] per bucket
    this.timestamps = new Float64Array(size);
  }

  private idx(): number {
    const now = Date.now();
    const ts = Math.floor(now / this.stepMs) * this.stepMs;
    const i = Math.floor(ts / this.stepMs) % this.size;
    if (this.timestamps[i] !== ts) {
      this.timestamps[i] = ts;
      this.buckets[i * 2] = 0;
      this.buckets[i * 2 + 1] = 0;
    }
    return i;
  }

  public addAcquired(): void { this.buckets[this.idx() * 2]++; }
  public addTimeout(): void  { this.buckets[this.idx() * 2 + 1]++; }

  public snapshot(): { acquired: number; timeouts: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / this.stepMs) * this.stepMs - (this.size - 1) * this.stepMs;
    let acquired = 0, timeouts = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.timestamps[i] >= windowStart) {
        acquired += this.buckets[i * 2];
        timeouts += this.buckets[i * 2 + 1];
      }
    }
    return { acquired, timeouts };
  }

  public reset(): void {
    this.buckets.fill(0);
    this.timestamps.fill(0);
  }
}

export class CircuitBreaker {

  private state: CircuitState = 'closed';
  private openUntil = 0;
  private probeInFlight = false;
  private _probeTaskId: number | null = null;

  private readonly eventWindow: CircuitBreakerEventWindow;
  private readonly threshold: number;
  private readonly window: number;
  private readonly cooldown: number;
  private readonly minThroughput: number;
  private readonly minFailures: number;

  constructor(config: CircuitBreakerConfig = {}) {

    // (0, 1)
    this.threshold = validateNumber(config.threshold ?? 0.5, "CircuitBreaker threshold", 0, 1, false, false);
    // >= 1000
    this.window = validateNumber(config.window ?? 10000, "CircuitBreaker window", 1000, Number.MAX_SAFE_INTEGER, true, true);
    // >= 1000
    this.cooldown = validateNumber(config.cooldown ?? 5000, "CircuitBreaker cooldown", 1000, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.minThroughput = validateNumber(config.minThroughput ?? 10, "CircuitBreaker minThroughput", 1, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.minFailures = validateNumber(config.minFailures ?? 5, "CircuitBreaker minFailures", 1, Number.MAX_SAFE_INTEGER, true, true);

    // One 1-second bucket per second of the window; total coverage >= window ms.
    this.eventWindow = new CircuitBreakerEventWindow(Math.ceil(this.window / 1000), 1000);

    // Integrated Cross-Checks
    if (this.minThroughput < this.minFailures) {
      throw new Error("CircuitBreaker minThroughput must be >= minFailures");
    }
  }

  // Getters
  public get isClosed(): boolean  { return this.state === 'closed'; }
  public get isOpen(): boolean    { return this.state === 'open'; }
  public get isHalfOpen(): boolean { return this.state === 'half-open'; }
  public get hasProbeInFlight(): boolean { return this.probeInFlight; }
  public get probeTaskId(): number | null { return this._probeTaskId; }
  public get cooldownRemaining(): number { return this.isOpen ? Math.max(0, this.openUntil - Date.now()) : 0; }

  /**
   * Records an attempt. Skipped during open/half-open so only closed-circuit
   * traffic counts toward the failure rate.
   */
  public trackAttempt(): void {
    if (this.state === 'closed') this.eventWindow.addAcquired();
  }

  /** Records a timeout unconditionally (used for probe timeouts too). */
  public recordTimeout(): void {
    this.eventWindow.addTimeout();
  }

  /**
   * open → half-open if the cooldown has elapsed.
   * Returns true if the transition just occurred (caller emits CIRCUITHALFOPEN).
   */
  public checkAndTransition(): boolean {
    if (this.state !== 'open') return false;
    if (Date.now() < this.openUntil) return false;
    this.state = 'half-open';
    this.probeInFlight = false;
    this._probeTaskId = null;
    return true;
  }

  /**
   * Evaluates the eventWindow and trips the circuit if the failure rate exceeds
   * the threshold. Min-count guards prevent false trips at low traffic.
   * Returns trip data for the CIRCUITOPEN event payload if tripped.
   */
  public evaluateAndTrip(): CircuitTripResult {
    if (this.state !== 'closed') return { tripped: false };
    const { timeouts: failures, acquired: attempts } = this.eventWindow.snapshot();
    if (attempts < this.minThroughput || failures < this.minFailures) return { tripped: false };
    const timeoutRate = failures / attempts;
    if (timeoutRate < this.threshold) return { tripped: false };
    this.state = 'open';
    this.openUntil = Date.now() + this.cooldown;
    return { tripped: true, timeoutRate, failures, attempts };
  }

  /** Mark a fast-path probe in flight (no queued task ID to track). */
  public markProbeInFlight(): void {
    this.probeInFlight = true;
  }

  /** Register a queued probe task so the scheduler can identify it. */
  public claimProbeSlot(taskId: number): void {
    this.probeInFlight = true;
    this._probeTaskId = taskId;
  }

  /** Release the probe slot without changing circuit state (used on abort). */
  public releaseProbeSlot(): void {
    this.probeInFlight = false;
    this._probeTaskId = null;
  }

  /** half-open → closed. Resets the eventWindow so stale failures don't re-trip. */
  public handleProbeSuccess(): void {
    this.state = 'closed';
    this.probeInFlight = false;
    this._probeTaskId = null;
    this.eventWindow.reset();
  }

  /** half-open → open. Re-arms the full cooldown. */
  public handleProbeFailure(): void {
    this.state = 'open';
    this.probeInFlight = false;
    this._probeTaskId = null;
    this.openUntil = Date.now() + this.cooldown;
  }

  /** Reset circuit breaker. */
  public reset(): void {
    this.state = 'closed';
    this.openUntil = 0;
    this.probeInFlight = false;
    this._probeTaskId = null;
    this.eventWindow.reset();
  }
}
