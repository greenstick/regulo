import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SemaphoreMetrics, DEFAULT_WINDOW_OPTIONS } from '../src/metrics';

describe('SemaphoreMetrics', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make() { return new SemaphoreMetrics(DEFAULT_WINDOW_OPTIONS); }

  describe('lifetime counters', () => {
    it('markAcquireFast increments totalAcquiredFast', () => {
      const m = make();
      m.markAcquireFast(); m.markAcquireFast();
      expect(m.getSnapshot().meta.totalAcquiredFast).toBe(2);
    });

    it('markAcquireQueued increments totalAcquiredQueued', () => {
      const m = make();
      m.markAcquireQueued(50); m.markAcquireQueued(100);
      expect(m.getSnapshot().meta.totalAcquiredQueued).toBe(2);
    });

    it('markReleased increments totalReleased', () => {
      const m = make();
      m.markReleased(); m.markReleased();
      expect(m.getSnapshot().meta.totalReleased).toBe(2);
    });

    it('markTimeout increments totalTimeouts', () => {
      const m = make();
      m.markTimeout();
      expect(m.getSnapshot().meta.totalTimeouts).toBe(1);
    });

    it('markAbort increments totalAborts but NOT windowed timeouts', () => {
      const m = make();
      m.markAbort(); m.markAbort();
      const snap = m.getSnapshot();
      expect(snap.meta.totalAborts).toBe(2);
      // Windowed timeout counts must be zero — aborts must not inflate the timeout rate
      for (const w of Object.values(snap.windows)) {
        expect(w.counts.timeouts).toBe(0);
      }
    });

    it('markCapacityChange updates capacity', () => {
      const m = make();
      m.markCapacityChange(5);
      expect(m.getSnapshot().meta.capacity).toBe(5);
    });

    it('circuit state flags update correctly', () => {
      const m = make();
      m.markCircuitOpen();
      expect(m.getSnapshot().meta.circuitOpen).toBe(true);
      expect(m.getSnapshot().meta.circuitHalfOpen).toBe(false);
      m.markCircuitHalfOpen();
      expect(m.getSnapshot().meta.circuitOpen).toBe(false);
      expect(m.getSnapshot().meta.circuitHalfOpen).toBe(true);
      m.markCircuitClose();
      expect(m.getSnapshot().meta.circuitOpen).toBe(false);
      expect(m.getSnapshot().meta.circuitHalfOpen).toBe(false);
    });
  });

  describe('windowed counts', () => {
    it('acquired is recorded in windowed counts', () => {
      const m = make();
      m.markAcquireFast();
      m.markAcquireFast();
      const snap = m.getSnapshot();
      expect(snap.windows['1m']!.counts.acquired).toBe(2);
    });

    it('timeout is recorded in windowed counts', () => {
      const m = make();
      m.markTimeout();
      expect(m.getSnapshot().windows['1m']!.counts.timeouts).toBe(1);
    });

    it('released is recorded in windowed counts', () => {
      const m = make();
      m.markReleased();
      expect(m.getSnapshot().windows['1m']!.counts.released).toBe(1);
    });
  });

  describe('getSnapshot', () => {
    it('returns correct window labels', () => {
      const snap = make().getSnapshot();
      expect(Object.keys(snap.windows)).toEqual(['1m', '5m', '15m', '1h', '24h']);
    });

    it('snapshot windows have expected shape', () => {
      const snap = make().getSnapshot();
      for (const w of Object.values(snap.windows)) {
        expect(w).toHaveProperty('counts');
        expect(w).toHaveProperty('inflight');
        expect(w).toHaveProperty('queue');
        expect(w).toHaveProperty('latency');
        expect(w.counts).toHaveProperty('acquired');
        expect(w.counts).toHaveProperty('timeouts');
        expect(w.inflight).toHaveProperty('avg');
        expect(w.latency).toHaveProperty('avg');
      }
    });

    it('latency avg is recorded from markAcquireQueued', () => {
      const m = make();
      m.markAcquireQueued(200);
      m.markAcquireQueued(400);
      expect(m.getSnapshot().windows['1m']!.latency.avg).toBe(300);
    });

    it('sampleInFlight appears in inflight window', () => {
      const m = make();
      m.sampleInFlight(3);
      expect(m.getSnapshot().windows['1m']!.inflight.avg).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('zeroes all lifetime counters', () => {
      const m = make();
      m.markAcquireFast(); m.markAcquireQueued(100); m.markReleased();
      m.markTimeout(); m.markAbort(); m.markCapacityChange(5);
      m.markCircuitOpen();
      m.reset();
      const meta = m.getSnapshot().meta;
      expect(meta.totalAcquiredFast).toBe(0);
      expect(meta.totalAcquiredQueued).toBe(0);
      expect(meta.totalReleased).toBe(0);
      expect(meta.totalTimeouts).toBe(0);
      expect(meta.totalAborts).toBe(0);
      expect(meta.capacity).toBe(0);
      expect(meta.circuitOpen).toBe(false);
    });

    it('zeroes windowed counts', () => {
      const m = make();
      m.markAcquireFast(); m.markTimeout();
      m.reset();
      const snap = m.getSnapshot();
      for (const w of Object.values(snap.windows)) {
        expect(w.counts.acquired).toBe(0);
        expect(w.counts.timeouts).toBe(0);
      }
    });
  });

  describe('custom window options', () => {
    it('labels match custom options', () => {
      const m = new SemaphoreMetrics([{ size: 30, stepMs: 2000 }]); // 1m
      expect(Object.keys(m.getSnapshot().windows)).toEqual(['1m']);
    });

    it('throws if options is empty', () => {
      expect(() => new SemaphoreMetrics([])).toThrow();
    });
  });
});

describe('SemaphoreMetrics window labels and granular samplers', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('labels sub-minute windows in seconds and sub-second windows in ms', () => {
    const secs = new SemaphoreMetrics([{ size: 30, stepMs: 1000 }]);
    expect(secs.primaryLabel).toBe('30s');
    const ms = new SemaphoreMetrics([{ size: 3, stepMs: 100 }]);
    expect(ms.primaryLabel).toBe('300ms');
  });

  it('sampleQueueDepth records a queue gauge sample in every window', () => {
    const m = new SemaphoreMetrics(DEFAULT_WINDOW_OPTIONS);
    m.sampleQueueDepth(7);
    const snap = m.getSnapshot();
    expect(snap.windows['1m']!.queue.samples).toBe(1);
    expect(snap.windows['1m']!.queue.max).toBe(7);
  });

  it('keeps in-bucket counts when the clock steps backwards into an already-written bucket', () => {
    const m = new SemaphoreMetrics([{ size: 60, stepMs: 1000 }]);
    m.markAcquireFast();                       // bucket N
    vi.advanceTimersByTime(1000);
    m.markAcquireFast();                       // bucket N+1 (cache now points here)
    vi.setSystemTime(Date.now() - 1000);
    m.markAcquireFast();                       // back in bucket N: must add, not clear
    vi.setSystemTime(Date.now() + 1000);
    expect(m.getSnapshot().windows['1m']!.counts.acquired).toBe(3);
  });
});

describe('SemaphoreMetrics purge accounting', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('onPurge counts lifetime purges and samples queue depth, never timeouts', () => {
    const m = new SemaphoreMetrics(DEFAULT_WINDOW_OPTIONS);
    m.onPurge(Date.now(), 3);
    m.onPurge(Date.now(), 1);
    const snap = m.getSnapshot();
    expect(snap.meta.totalPurged).toBe(2);
    expect(snap.meta.totalTimeouts).toBe(0);
    expect(snap.windows['1m']!.counts.timeouts).toBe(0);
    expect(snap.windows['1m']!.queue.samples).toBe(2);
    m.reset();
    expect(m.getSnapshot().meta.totalPurged).toBe(0);
  });
});
