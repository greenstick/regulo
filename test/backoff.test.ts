import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackoffTracker } from '../src/backoff';

describe('BackoffTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts at zero delay', () => {
    expect(new BackoffTracker().currentDelay).toBe(0);
  });

  it('grows to initialTimeout on the first timeout', () => {
    const b = new BackoffTracker({ initialTimeout: 100, maxTimeout: 1000, decayFactor: 0.5 });
    b.onTimeout();
    expect(b.currentDelay).toBe(100); // read at same instant → no decay
  });

  it('compounds on rapid successive timeouts', () => {
    const b = new BackoffTracker({ initialTimeout: 100, maxTimeout: 1000, decayFactor: 0.5 });
    b.onTimeout(); // 100
    b.onTimeout(); // no time elapsed → doubles to 200
    expect(b.currentDelay).toBe(200);
  });

  it('caps growth at maxTimeout', () => {
    const b = new BackoffTracker({ initialTimeout: 800, maxTimeout: 1000, decayFactor: 0.5 });
    b.onTimeout(); // 800
    b.onTimeout(); // min(1600, 1000) = 1000
    expect(b.currentDelay).toBe(1000);
  });

  it('decays continuously over time and floors to 0 below 1ms', () => {
    const b = new BackoffTracker({ initialTimeout: 100, maxTimeout: 1000, decayFactor: 0.5 });
    b.onTimeout(); // 100 at t0
    vi.advanceTimersByTime(1000); // 1s elapsed → 100 * 0.5^1 = 50
    expect(b.currentDelay).toBeCloseTo(50, 5);
    vi.advanceTimersByTime(6000); // 7s total → 100 * 0.5^7 ≈ 0.78 < 1 → floored to 0
    expect(b.currentDelay).toBe(0);
  });

  it('reset clears the accumulated delay', () => {
    const b = new BackoffTracker({ initialTimeout: 100 });
    b.onTimeout();
    b.reset();
    expect(b.currentDelay).toBe(0);
  });
});
