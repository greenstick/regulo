/*
No-op Circuit Breaker

Never opens. Inject via `circuitBreaker` when you want the semaphore as a pure
concurrency limiter: bounded permits, priority queue, and backoff, with no
load-shedding trip — and no breaker bookkeeping on the hot path.
*/

import type { CircuitState, CircuitBreakerStrategy, CircuitTripResult } from '../types';

const NOT_TRIPPED: CircuitTripResult = { tripped: false };

export class NoopCircuitBreaker implements CircuitBreakerStrategy {
  public readonly state: CircuitState = 'closed';
  public readonly isOpen = false;
  public readonly isProbing = false;
  public readonly hasProbeInFlight = false;
  public readonly probeTaskId = null;
  public readonly cooldownRemaining = 0;

  public checkAndTransition(): boolean { return false; }
  public trackAttempt(): void {}
  public recordFailure(): void {}
  public evaluateAndTrip(): CircuitTripResult { return NOT_TRIPPED; }
  public markProbeInFlight(): void {}
  public claimProbeSlot(): void {}
  public releaseProbeSlot(): void {}
  public handleProbeSuccess(): void {}
  public handleProbeFailure(): void {}
  public reset(): void {}
}
