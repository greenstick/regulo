import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SaturationCircuitBreaker } from '../src/index';

const config = { threshold: 0.5, window: 5000, cooldown: 3000, minThroughput: 5, minFailures: 3 };

function make() { return new SaturationCircuitBreaker(config); }

describe('SaturationCircuitBreaker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts closed', () => {
    const cb = make();
    expect(cb.isClosed).toBe(true);
    expect(cb.isOpen).toBe(false);
    expect(cb.isHalfOpen).toBe(false);
  });

  describe('evaluateAndTrip', () => {
    it('does not trip below minThroughput', () => {
      const cb = make();
      for (let i = 0; i < 4; i++) { cb.trackAttempt(); cb.recordFailure(); }
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
      expect(cb.isOpen).toBe(false);
    });

    it('does not trip below minFailures', () => {
      const cb = make();
      for (let i = 0; i < 5; i++) cb.trackAttempt();
      for (let i = 0; i < 2; i++) cb.recordFailure();
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
    });

    it('does not trip below threshold', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) cb.trackAttempt();
      for (let i = 0; i < 3; i++) cb.recordFailure(); // 30% < 50%
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
    });

    it('trips when threshold and min guards are met', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      const result = cb.evaluateAndTrip();
      expect(result).toMatchObject({ tripped: true, failures: 10, attempts: 10 });
      if (result.tripped) expect(result.timeoutRate).toBe(1);
      expect(cb.isOpen).toBe(true);
    });

    it('returns tripped:false when not closed', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip(); // opens it
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
    });
  });

  describe('checkAndTransition (open → half-open)', () => {
    it('returns false when closed', () => {
      expect(make().checkAndTransition()).toBe(false);
    });

    it('returns false before cooldown elapses', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      expect(cb.checkAndTransition()).toBe(false);
    });

    it('transitions to half-open after cooldown and returns true', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      vi.advanceTimersByTime(config.cooldown + 1);
      expect(cb.checkAndTransition()).toBe(true);
      expect(cb.isHalfOpen).toBe(true);
      expect(cb.hasProbeInFlight).toBe(false);
      expect(cb.probeTaskId).toBeNull();
    });

    it('returns false on subsequent calls after transition', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      vi.advanceTimersByTime(config.cooldown + 1);
      cb.checkAndTransition();
      expect(cb.checkAndTransition()).toBe(false); // already half-open, not open
    });
  });

  describe('trackAttempt', () => {
    it('records when closed', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) cb.trackAttempt();
      for (let i = 0; i < 5; i++) cb.recordFailure();
      const result = cb.evaluateAndTrip();
      expect(result.tripped).toBe(true);
    });

    it('skips recording when open', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip(); // now open
      // These should not count
      for (let i = 0; i < 10; i++) cb.trackAttempt();
      // Transition to half-open and close
      vi.advanceTimersByTime(config.cooldown + 1);
      cb.checkAndTransition();
      cb.handleProbeSuccess(); // reset window
      // Now closed — window was reset, so no trip from open-state attempts
      for (let i = 0; i < 4; i++) cb.trackAttempt();
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
    });

    it('skips recording when half-open', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      vi.advanceTimersByTime(config.cooldown + 1);
      cb.checkAndTransition(); // now half-open
      cb.trackAttempt(); // should be ignored
      cb.handleProbeSuccess(); // closed, window reset
      for (let i = 0; i < 4; i++) cb.trackAttempt();
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
    });
  });

  describe('probe lifecycle', () => {
    it('markProbeInFlight sets hasProbeInFlight', () => {
      const cb = make();
      cb.markProbeInFlight();
      expect(cb.hasProbeInFlight).toBe(true);
      expect(cb.probeTaskId).toBeNull();
    });

    it('claimProbeSlot sets both flags', () => {
      const cb = make();
      cb.claimProbeSlot(42);
      expect(cb.hasProbeInFlight).toBe(true);
      expect(cb.probeTaskId).toBe(42);
    });

    it('releaseProbeSlot clears both flags', () => {
      const cb = make();
      cb.claimProbeSlot(42);
      cb.releaseProbeSlot();
      expect(cb.hasProbeInFlight).toBe(false);
      expect(cb.probeTaskId).toBeNull();
    });

    it('handleProbeSuccess → closed, window reset', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      vi.advanceTimersByTime(config.cooldown + 1);
      cb.checkAndTransition();
      cb.markProbeInFlight();
      cb.handleProbeSuccess();
      expect(cb.isClosed).toBe(true);
      expect(cb.hasProbeInFlight).toBe(false);
      // Window was reset — should not trip immediately
      for (let i = 0; i < 4; i++) cb.trackAttempt();
      expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
    });

    it('handleProbeFailure → open, cooldown restarted', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      vi.advanceTimersByTime(config.cooldown + 1);
      cb.checkAndTransition();
      cb.markProbeInFlight();
      cb.handleProbeFailure();
      expect(cb.isOpen).toBe(true);
      expect(cb.cooldownRemaining).toBeGreaterThan(0);
    });
  });

  describe('cooldownRemaining', () => {
    it('returns 0 when closed', () => {
      expect(make().cooldownRemaining).toBe(0);
    });

    it('returns > 0 when open', () => {
      const cb = make();
      for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
      cb.evaluateAndTrip();
      expect(cb.cooldownRemaining).toBeGreaterThan(0);
    });
  });

  it('reset restores initial state', () => {
    const cb = make();
    for (let i = 0; i < 10; i++) { cb.trackAttempt(); cb.recordFailure(); }
    cb.evaluateAndTrip();
    cb.reset();
    expect(cb.isClosed).toBe(true);
    expect(cb.cooldownRemaining).toBe(0);
    expect(cb.hasProbeInFlight).toBe(false);
    expect(cb.probeTaskId).toBeNull();
    // Window was reset — should not trip
    for (let i = 0; i < 4; i++) cb.trackAttempt();
    expect(cb.evaluateAndTrip()).toMatchObject({ tripped: false });
  });
});

describe('SaturationCircuitBreaker config and bucket edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects window < windowBucketWidth', () => {
    expect(() => new SaturationCircuitBreaker({ window: 1000, windowBucketWidth: 2000 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
  });

  it('keeps bucket counts when the clock steps backwards into an already-written bucket', () => {
    const b = new SaturationCircuitBreaker({
      threshold: 0.5, window: 5000, windowBucketWidth: 1000,
      minThroughput: 4, minFailures: 4,
    });
    // Two failures in bucket N (second is a bucket-cache hit), advance one
    // bucket, one more, then step back into bucket N: the write must add to
    // the preserved bucket, not clear it.
    b.trackAttempt(); b.recordFailure();
    b.trackAttempt(); b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.trackAttempt(); b.recordFailure();
    vi.setSystemTime(Date.now() - 1000);
    b.trackAttempt(); b.recordFailure();
    vi.setSystemTime(Date.now() + 1000);
    // 4 attempts / 4 failures across the window → rate 1.0 → trips. If the
    // backward-clock write had cleared bucket N, only 2 would remain and the
    // min-count guards would block the trip.
    expect(b.evaluateAndTrip()).toMatchObject({ tripped: true, failures: 4, attempts: 4 });
  });
});
