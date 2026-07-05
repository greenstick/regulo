import { describe, it, expect } from 'vitest';
import { ManualCircuitBreaker, NoopCircuitBreaker } from '../src/breakers';

/*
The manual and no-op breakers implement the full CircuitBreakerStrategy
surface, mostly as no-ops. These tests pin that contract: every method is
callable, never throws, and never changes state except ManualCircuitBreaker's
own open()/close()/reset().
*/

describe('ManualCircuitBreaker', () => {
  it('starts closed with an inert probe/cooldown surface', () => {
    const b = new ManualCircuitBreaker();
    expect(b.state).toBe('closed');
    expect(b.isOpen).toBe(false);
    expect(b.isProbing).toBe(false);
    expect(b.hasProbeInFlight).toBe(false);
    expect(b.probeTaskId).toBeNull();
    expect(b.cooldownRemaining).toBe(0);
  });

  it('open() and close() toggle admission; reset() closes', () => {
    const b = new ManualCircuitBreaker();
    b.open();
    expect(b.isOpen).toBe(true);
    expect(b.checkAndTransition()).toBe(false); // never auto-recovers
    b.close();
    expect(b.isOpen).toBe(false);
    b.open();
    b.reset();
    expect(b.state).toBe('closed');
  });

  it('strategy pass-through methods are no-ops and never open the circuit', () => {
    const b = new ManualCircuitBreaker();
    b.trackAttempt();
    b.recordFailure();
    expect(b.evaluateAndTrip()).toEqual({ tripped: false });
    b.markProbeInFlight();
    b.claimProbeSlot();
    b.releaseProbeSlot();
    b.handleProbeSuccess();
    b.handleProbeFailure();
    expect(b.state).toBe('closed');
    expect(b.hasProbeInFlight).toBe(false);
  });
});

describe('NoopCircuitBreaker', () => {
  it('is permanently closed regardless of failures or probe calls', () => {
    const b = new NoopCircuitBreaker();
    expect(b.state).toBe('closed');
    expect(b.isOpen).toBe(false);
    expect(b.isProbing).toBe(false);
    expect(b.hasProbeInFlight).toBe(false);
    expect(b.probeTaskId).toBeNull();
    expect(b.cooldownRemaining).toBe(0);
    expect(b.checkAndTransition()).toBe(false);
    b.trackAttempt();
    for (let i = 0; i < 100; i++) b.recordFailure();
    expect(b.evaluateAndTrip()).toEqual({ tripped: false });
    b.markProbeInFlight();
    b.claimProbeSlot();
    b.releaseProbeSlot();
    b.handleProbeSuccess();
    b.handleProbeFailure();
    b.reset();
    expect(b.isOpen).toBe(false);
  });
});
