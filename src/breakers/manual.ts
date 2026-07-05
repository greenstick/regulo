/*
Manual Circuit Breaker

An operator-controlled kill switch: the circuit is exactly as open as you have
set it. open() sheds new acquires immediately (CIRCUIT_OPEN); close() restores
service. There is no cooldown, no probing, and no probe — recovery is a
deliberate operator action, not an automatic transition.

Note that open() only affects admission of *new* acquires. Tasks already queued
wait out their own timeouts; call Semaphore.cancel() after open() if the queue
should be shed too.
*/

import type { CircuitState, CircuitBreakerStrategy, CircuitTripResult } from '../types';

const NOT_TRIPPED: CircuitTripResult = { tripped: false };

export class ManualCircuitBreaker implements CircuitBreakerStrategy {
  public state: CircuitState = 'closed';

  public get isOpen(): boolean { return this.state === 'open'; }
  public get isProbing(): boolean { return false; }
  public readonly hasProbeInFlight = false;
  public readonly probeTaskId = null;
  public get cooldownRemaining(): number { return 0; }

  /** Open the circuit: new acquires reject with CIRCUIT_OPEN until close(). */
  public open(): void { this.state = 'open'; }
  /** Close the circuit and resume normal admission. */
  public close(): void { this.state = 'closed'; }
  public checkAndTransition(): boolean { return false; } // never auto-recovers
  public trackAttempt(): void {}
  public recordFailure(): void {}
  public evaluateAndTrip(): CircuitTripResult { return NOT_TRIPPED; }
  public markProbeInFlight(): void {}
  public claimProbeSlot(): void {}
  public releaseProbeSlot(): void {}
  public handleProbeSuccess(): void {}
  public handleProbeFailure(): void {}
  public reset(): void { this.state = 'closed'; }
}
