import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Semaphore } from '../src/semaphore';
import { SemaphoreError } from '../src/error';
import { SemaphoreEvents } from '../src/types';

function make(count = 2, config: ConstructorParameters<typeof Semaphore>[1] = {}) {
  return new Semaphore(count, { purgeIntervalMs: 500, ...config });
}

// Fill all permits and return release fns
async function fillPermits(sem: Semaphore, count: number) {
  return Promise.all(Array.from({ length: count }, () => sem.acquire()));
}

describe('Semaphore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // ─── Constructor validation ────────────────────────────────────────────────
  describe('constructor', () => {
    it.each([
      ['count <= 0', () => new Semaphore(0)],
      ['queueMaxLength <= 0', () => new Semaphore(1, { queueMaxLength: 0 })],
      ['queueMaxLength Infinity (non-integer)', () => new Semaphore(1, { queueMaxLength: Infinity })],
      ['queueMaxTimeout NaN (not a valid number)', () => new Semaphore(1, { queueMaxTimeout: NaN })],
      ['queueMaxTimeout <= 0', () => new Semaphore(1, { queueMaxTimeout: 0 })],
      ['backoffDecayFactor out of range', () => new Semaphore(1, { backoffDecayFactor: 1 })],
      ['circuitBreakerThreshold out of range', () => new Semaphore(1, { circuitBreakerThreshold: 0 })],
      ['circuitBreakerWindow < 1000', () => new Semaphore(1, { circuitBreakerWindow: 500 })],
      ['purgeIntervalMs < 500', () => new Semaphore(1, { purgeIntervalMs: 100 })],
      ['backoffMaxTimeout < backoffInitialTimeout', () => new Semaphore(1, { backoffInitialTimeout: 100, backoffMaxTimeout: 50 })],
      ['circuitBreakerMinFailures > circuitBreakerMinThroughput', () => new Semaphore(1, { circuitBreakerMinThroughput: 5, circuitBreakerMinFailures: 10 })],
    ])('throws on invalid config: %s', (_, fn) => {
      expect(fn).toThrow();
    });

    it('throws SemaphoreError with code INVALID_ARGUMENT', () => {
      expect(() => new Semaphore(0)).toThrow(
        expect.objectContaining({ name: 'SemaphoreError', code: 'INVALID_ARGUMENT' })
      );
      // @ts-expect-error invalid preset
      expect(() => make(1, { queueOrder: 'bogus' })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      );
    });
  });

  // ─── Fast-path acquire/release ─────────────────────────────────────────────
  describe('fast-path acquire/release', () => {
    it('returns a release function', async () => {
      const sem = make(2);
      const release = await sem.acquire();
      expect(typeof release).toBe('function');
      release();
    });

    it('reduces availablePermits', async () => {
      const sem = make(2);
      const r = await sem.acquire();
      expect(sem.availablePermits).toBe(1);
      expect(sem.status().status.inFlight).toBe(1);
      r();
      expect(sem.availablePermits).toBe(2);
    });

    it('double-release is a silent no-op', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      r(); r(); // second release must not inflate permits
      expect(sem.availablePermits).toBe(1);
    });

    it('status().status.pendingReleases tracks outstanding closures', async () => {
      const sem = make(2);
      const r1 = await sem.acquire();
      const r2 = await sem.acquire();
      expect(sem.status().status.pendingReleases).toBe(2);
      r1(); r2();
      expect(sem.status().status.pendingReleases).toBe(0);
    });

    it('status().status.queueAge reports the oldest queued task and clears as it drains', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      expect(sem.status().status.queueAge).toBe(0); // empty queue
      const oldest = sem.acquire().then(rel => rel());
      const newer = sem.acquire().then(rel => rel());
      // Oldest task has waited at least as long as the newer one (>= 0).
      expect(sem.status().status.queueAge).toBeGreaterThanOrEqual(0);
      r();
      await Promise.all([oldest, newer]);
      expect(sem.status().status.queueAge).toBe(0); // drained back to empty
    });
  });

  // ─── tryAcquire ────────────────────────────────────────────────────────────
  describe('tryAcquire', () => {
    it('returns release fn when permit available', () => {
      const sem = make(1);
      const r = sem.tryAcquire();
      expect(r).toBeTypeOf('function');
      r!();
    });

    it('returns null when full', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      expect(sem.tryAcquire()).toBeNull();
      r();
    });

    it('returns null when shut down', () => {
      const sem = make(1);
      sem.shutdown();
      expect(sem.tryAcquire()).toBeNull();
    });
  });

  // ─── Queuing ───────────────────────────────────────────────────────────────
  describe('queuing', () => {
    it('queues when full and resolves after release', async () => {
      const sem = make(1);
      const r1 = await sem.acquire();
      const p2 = sem.acquire();
      expect(sem.queueLength).toBe(1);
      r1();
      await expect(p2).resolves.toBeTypeOf('function');
      (await p2)();
    });

    it('rejects immediately when rejectOnFull', async () => {
      const sem = make(1, { rejectOnFull: true });
      const r = await sem.acquire();
      await expect(sem.acquire()).rejects.toMatchObject({ code: 'QUEUE_FULL' });
      r();
    });

    it('rejects when queue is at queueMaxLength', async () => {
      const sem = make(1, { queueMaxLength: 1 });
      const r = await sem.acquire();
      const _p1 = sem.acquire(); // fills queue
      await expect(sem.acquire()).rejects.toMatchObject({ code: 'QUEUE_FULL' });
      r();
      (await _p1)();
    });

    it('defaults queueMaxLength to 1024 (finite guardrail)', async () => {
      const sem = make(1); // no queueMaxLength set
      const r = await sem.acquire();
      const pending = Array.from({ length: 1024 }, () => sem.acquire().catch(() => {}));
      // The 1025th queued acquire exceeds the default ceiling.
      await expect(sem.acquire()).rejects.toMatchObject({ code: 'QUEUE_FULL' });
      sem.cancel();
      r();
      await Promise.all(pending);
    });

    it('dispatches in priority order', async () => {
      const sem = make(1);
      const r1 = await sem.acquire();
      const order: number[] = [];
      const p3 = sem.acquire(undefined, 3).then(r => { order.push(3); r(); });
      const p1 = sem.acquire(undefined, 1).then(r => { order.push(1); r(); });
      const p2 = sem.acquire(undefined, 2).then(r => { order.push(2); r(); });
      r1();
      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
    });

    it('dispatches equal-priority tasks FIFO (head-of-line fairness)', async () => {
      const sem = make(1);
      const r1 = await sem.acquire();
      const order: number[] = [];
      const ps = Array.from({ length: 12 }, (_, i) =>
        sem.acquire().then(r => { order.push(i); r(); })
      );
      r1();
      await Promise.all(ps);
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
  });

  // ─── Queue ordering ───────────────────────────────────────────────────────
  describe('queueOrder / comparator', () => {
    async function collectOrder(sem: Semaphore, n: number, priorities?: number[]) {
      const r1 = await sem.acquire();
      const order: number[] = [];
      const ps = Array.from({ length: n }, (_, i) =>
        sem.acquire(undefined, priorities?.[i] ?? 0).then(r => { order.push(i); r(); })
      );
      r1();
      await Promise.all(ps);
      return order;
    }

    it("'fifoWithPriority' is the default ordering and honors priority", async () => {
      // Default honors priority: descending priorities dispatch lowest-first.
      const order = await collectOrder(make(1), 4, [3, 2, 1, 0]);
      expect(order).toEqual([3, 2, 1, 0]);
    });

    it("'fifoWithPriority' breaks equal-priority ties earliest-first", async () => {
      expect(await collectOrder(make(1, { queueOrder: 'fifoWithPriority' }), 6)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("'lifoWithPriority' honors priority as the primary key", async () => {
      // priorities: lower number dispatched first; ties broken latest-first.
      const order = await collectOrder(make(1, { queueOrder: 'lifoWithPriority' }), 4, [1, 0, 0, 1]);
      // priority 0 group first (indices 1,2 -> latest-first 2,1), then priority 1 group (0,3 -> 3,0)
      expect(order).toEqual([2, 1, 3, 0]);
    });

    it("'fifo' dispatches enqueue-order regardless of priority", async () => {
      // Descending priorities would reorder under 'fifoWithPriority'; here they're ignored.
      const order = await collectOrder(make(1, { queueOrder: 'fifo' }), 4, [3, 2, 1, 0]);
      expect(order).toEqual([0, 1, 2, 3]);
    });

    it("'lifo' dispatches reverse-enqueue-order regardless of priority", async () => {
      // Ascending priorities would keep order under 'lifoWithPriority'; here ignored.
      const order = await collectOrder(make(1, { queueOrder: 'lifo' }), 4, [0, 1, 2, 3]);
      expect(order).toEqual([3, 2, 1, 0]);
    });

    it('custom comparator overrides queueOrder', async () => {
      // queueOrder says fifo, but the comparator sorts by id descending (lifo);
      // the comparator must win.
      const sem = make(1, {
        queueOrder: 'fifo',
        comparator: (a, b) => (a.priority - b.priority) || (b.id - a.id),
      });
      expect(await collectOrder(sem, 6)).toEqual([5, 4, 3, 2, 1, 0]);
    });

    it('degrades to a stable id tie-break when a comparator returns NaN', async () => {
      // A NaN result (e.g. from a non-finite key) would corrupt the heap; the
      // wrapper falls back to FIFO instead of breaking dispatch.
      const sem = make(1, { comparator: () => NaN });
      expect(await collectOrder(sem, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('degrades to a stable id tie-break when a comparator returns a non-number', async () => {
      // A comparator that forgets to return a number must not corrupt the heap.
      const sem = make(1, { comparator: (() => undefined) as never });
      expect(await collectOrder(sem, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('rejects an invalid queueOrder at construction', () => {
      // @ts-expect-error invalid preset
      expect(() => make(1, { queueOrder: 'bogus' })).toThrow(/queueOrder must be one of/);
    });

    it('rejects a non-function comparator at construction', () => {
      // @ts-expect-error wrong type
      expect(() => make(1, { comparator: 42 })).toThrow(/comparator must be a function/);
    });
  });

  // ─── Timeout ───────────────────────────────────────────────────────────────
  describe('queueMaxTimeout', () => {
    it('rejects with TIMEOUT after queueMaxTimeout', async () => {
      const sem = make(1, { queueMaxTimeout: 100 });
      const r = await sem.acquire();
      const p = sem.acquire();
      vi.advanceTimersByTime(100);
      await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
      r();
    });

    it('emits TASKTIMEOUT event', async () => {
      const sem = make(1, { queueMaxTimeout: 100 });
      const r = await sem.acquire();
      const onTimeout = vi.fn();
      sem.on(SemaphoreEvents.TASKTIMEOUT, onTimeout);
      const p = sem.acquire();
      vi.advanceTimersByTime(100);
      await p.catch(() => {});
      expect(onTimeout).toHaveBeenCalledOnce();
      r();
    });

    // The shared watchdog must preserve per-task timeout precision: a task is not
    // evicted early just because an earlier task's deadline came due.
    it('times out each task at its own deadline, not in one coarse batch', async () => {
      const sem = make(1, { queueMaxTimeout: 100 });
      const r = await sem.acquire();
      const aErr = sem.acquire().catch((e: SemaphoreError) => e.code);
      vi.advanceTimersByTime(40);
      const bErr = sem.acquire().catch((e: SemaphoreError) => e.code); // enqueued 40ms later
      vi.advanceTimersByTime(60); // t=100: A's deadline; B still has 40ms to go
      expect(await aErr).toBe('TIMEOUT');
      expect(sem.queueLength).toBe(1); // B was NOT evicted early
      vi.advanceTimersByTime(40); // t=140: B's deadline
      expect(await bErr).toBe('TIMEOUT');
      expect(sem.queueLength).toBe(0);
      r();
    });

    it('evicts a burst of same-deadline tasks on a single timer fire', async () => {
      const sem = make(1, { queueMaxTimeout: 100 });
      const r = await sem.acquire();
      const errs = Array.from({ length: 5 }, () => sem.acquire().catch((e: SemaphoreError) => e.code));
      expect(sem.queueLength).toBe(5);
      vi.advanceTimersByTime(100);
      expect(await Promise.all(errs)).toEqual(['TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
      expect(sem.queueLength).toBe(0);
      r();
    });

    it('does not fire a stray timeout after the queue drains by dispatch', async () => {
      const sem = make(1, { queueMaxTimeout: 100 });
      const r = await sem.acquire();
      const p = sem.acquire();
      r();                 // release → queued task dispatches before its deadline
      const release = await p;
      expect(typeof release).toBe('function'); // got a permit, not a timeout
      vi.advanceTimersByTime(1000); // well past the old deadline — must be a no-op
      expect(sem.queueLength).toBe(0);
      release();
    });
  });

  // ─── AbortSignal ───────────────────────────────────────────────────────────
  describe('AbortSignal', () => {
    it('rejects immediately if already aborted', async () => {
      const sem = make(1);
      const c = new AbortController();
      c.abort();
      await expect(sem.acquire(c.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    });

    it('rejects queued task when signal fires', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const c = new AbortController();
      const p = sem.acquire(c.signal);
      c.abort();
      await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
      r();
    });

    it('abort does not record in CB window', async () => {
      const sem = make(1, {
        circuitBreakerThreshold: 0.5, circuitBreakerWindow: 5000,
        circuitBreakerMinThroughput: 1, circuitBreakerMinFailures: 1,
      });
      const r = await sem.acquire();
      const c = new AbortController();
      const p = sem.acquire(c.signal);
      c.abort();
      await p.catch(() => {});
      r();
      // Circuit should still be closed (abort not counted)
      expect(sem.status().status.circuitOpen).toBe(false);
    });
  });

  // ─── use() ────────────────────────────────────────────────────────────────
  describe('use()', () => {
    it('returns fn result', async () => {
      const sem = make(1);
      const result = await sem.use(async () => 42);
      expect(result).toBe(42);
    });

    it('releases permit even when fn throws', async () => {
      const sem = make(1);
      await expect(sem.use(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(sem.availablePermits).toBe(1);
    });
  });

  // ─── Circuit breaker ──────────────────────────────────────────────────────
  describe('circuit breaker', () => {
    const cbConfig = {
      circuitBreakerThreshold: 0.5,
      circuitBreakerWindow: 5000,
      circuitBreakerCooldown: 2000,
      circuitBreakerMinThroughput: 5,
      circuitBreakerMinFailures: 5,
      queueMaxTimeout: 50,
    };

    // Fill permits, queue 5 tasks, advance timers to trigger timeouts, release permits.
    async function tripCircuit(sem: Semaphore) {
      const releases = await fillPermits(sem, 2);
      const timeouts = [sem.acquire(), sem.acquire(), sem.acquire(), sem.acquire(), sem.acquire()];
      vi.advanceTimersByTime(50);
      await Promise.allSettled(timeouts);
      releases.forEach(r => r());
    }

    it('opens after sustained failures', async () => {
      const sem = make(2, cbConfig);
      await tripCircuit(sem);
      expect(sem.status().status.circuitOpen).toBe(true);
    });

    it('rejects acquire with CIRCUIT_OPEN when open', async () => {
      const sem = make(2, cbConfig);
      await tripCircuit(sem);
      await expect(sem.acquire()).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    });

    it('emits CIRCUITOPEN event', async () => {
      const sem = make(2, cbConfig);
      const onOpen = vi.fn();
      sem.on(SemaphoreEvents.CIRCUITOPEN, onOpen);
      await tripCircuit(sem);
      expect(onOpen).toHaveBeenCalled();
    });

    it('transitions to half-open after cooldown', async () => {
      const sem = make(2, cbConfig);
      await tripCircuit(sem);
      vi.advanceTimersByTime(2000);
      const halfOpenEmit = vi.fn();
      sem.on(SemaphoreEvents.CIRCUITHALFOPEN, halfOpenEmit);
      // tryAcquire calls checkAndTransition → emits CIRCUITHALFOPEN, then claims probe
      const probe = sem.tryAcquire();
      expect(sem.status().status.circuitHalfOpen).toBe(true);
      expect(halfOpenEmit).toHaveBeenCalledOnce();
      probe!();
    });

    it('probe success closes the circuit', async () => {
      const sem = make(2, cbConfig);
      await tripCircuit(sem);
      vi.advanceTimersByTime(2000);
      const closeEmit = vi.fn();
      sem.on(SemaphoreEvents.CIRCUITCLOSE, closeEmit);
      // tryAcquire → half-open → probe slot claimed
      const probe = sem.tryAcquire()!;
      expect(sem.status().status.circuitHalfOpen).toBe(true);
      probe(); // release → handleProbeSuccess → circuit closes
      expect(sem.status().status.circuitOpen).toBe(false);
      expect(sem.status().status.circuitHalfOpen).toBe(false);
      expect(closeEmit).toHaveBeenCalledOnce();
    });

    it('probe failure re-opens the circuit (unit-level via the breaker)', async () => {
      // Focused check of the breaker transition in isolation. The full
      // queued-probe-timeout path through the semaphore is covered end-to-end by
      // the next test.
      const sem = make(2, cbConfig);
      await tripCircuit(sem);
      vi.advanceTimersByTime(2000);
      sem.tryAcquire(); // triggers half-open, claims probe slot
      expect(sem.status().status.circuitHalfOpen).toBe(true);
      // Simulate probe timeout: call handleProbeFailure directly
      (sem as any).circuit.handleProbeFailure();
      expect((sem as any).circuit.isOpen).toBe(true);
      expect((sem as any).circuit.isHalfOpen).toBe(false);
    });

    it('a queued probe timing out re-opens the circuit (half-open → open, public API)', async () => {
      const sem = make(1, cbConfig);
      // Hold the only permit with a task acquired while the circuit is closed, so
      // capacity stays full through the open period and into half-open. This is
      // what forces the probe to *queue* (with a watchdog) rather than take the
      // fast path — the only route that exercises the probe-timeout reopen.
      const held = await sem.acquire();
      const doomed = Array.from({ length: 5 }, () => sem.acquire().catch(() => {}));
      vi.advanceTimersByTime(50);
      await Promise.allSettled(doomed);
      expect(sem.status().status.circuitOpen).toBe(true);

      vi.advanceTimersByTime(2000); // elapse cooldown
      const onHalfOpen = vi.fn();
      const onOpen = vi.fn();
      sem.on(SemaphoreEvents.CIRCUITHALFOPEN, onHalfOpen);
      sem.on(SemaphoreEvents.CIRCUITOPEN, onOpen);

      // First acquire after cooldown: transitions to half-open (the acquire()
      // path, not tryAcquire), then enqueues a queued probe since no permit is free.
      const probe = sem.acquire();
      expect(onHalfOpen).toHaveBeenCalledTimes(1);
      expect(sem.status().status.circuitHalfOpen).toBe(true);

      // Probe's watchdog fires while the permit is still held → probe times out.
      vi.advanceTimersByTime(50);
      await expect(probe).rejects.toMatchObject({ code: 'TIMEOUT' });

      expect(sem.status().status.circuitOpen).toBe(true);
      expect(sem.status().status.circuitHalfOpen).toBe(false);
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ reason: 'half-open-probe-failed' }));

      held();
    });

    it('rejects with CIRCUIT_HALF_OPEN when probe in flight', async () => {
      const sem = make(2, cbConfig);
      await tripCircuit(sem);
      vi.advanceTimersByTime(2000);
      // tryAcquire: checkAndTransition → half-open, then probe slot claimed
      const probeRelease = sem.tryAcquire();
      expect(sem.status().status.circuitHalfOpen).toBe(true);
      expect(probeRelease).not.toBeNull();
      // Probe is in flight — next acquire must reject
      await expect(sem.acquire()).rejects.toMatchObject({ code: 'CIRCUIT_HALF_OPEN' });
      probeRelease!();
    });
  });

  // ─── drain() ──────────────────────────────────────────────────────────────
  describe('drain()', () => {
    it('resolves immediately when idle', async () => {
      await expect(make(1).drain()).resolves.toBeUndefined();
    });

    it('resolves after all permits returned', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const d = sem.drain();
      r();
      await expect(d).resolves.toBeUndefined();
    });

    it('multiple callers share the same promise', async () => {
      const sem = make(1);
      const r = await sem.acquire(); // hold permit so drain queues
      const d1 = sem.drain();
      const d2 = sem.drain();
      expect(d1).toBe(d2);
      r();
      await d1;
    });

    it('rejects with TIMEOUT when drain times out', async () => {
      const sem = make(1);
      await sem.acquire(); // hold permit
      const d = sem.drain(100);
      vi.advanceTimersByTime(100);
      await expect(d).rejects.toMatchObject({ code: 'TIMEOUT' });
    });

    it('rejects if called after shutdown', async () => {
      const sem = make(1);
      sem.shutdown();
      await expect(sem.drain()).rejects.toMatchObject({ code: 'SHUTDOWN' });
    });

    it('throws SemaphoreError(INVALID_ARGUMENT) on an invalid timeoutMs', () => {
      const sem = make(1);
      for (const bad of [0, -5, 1.5]) {
        expect(() => sem.drain(bad)).toThrow(
          expect.objectContaining({ name: 'SemaphoreError', code: 'INVALID_ARGUMENT' })
        );
      }
    });
  });

  // ─── reset() ──────────────────────────────────────────────────────────────
  describe('reset()', () => {
    it('rejects all queued tasks with SHUTDOWN', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const p = sem.acquire();
      sem.reset();
      await expect(p).rejects.toMatchObject({ code: 'SHUTDOWN' });
      r();
    });

    it('restores semaphore to initial state', async () => {
      const sem = make(2);
      const r = await sem.acquire();
      sem.reset();
      expect(sem.availablePermits).toBe(2);
      expect(sem.queueLength).toBe(0);
      // Should be usable again
      await expect(sem.acquire()).resolves.toBeTypeOf('function');
      (await sem.acquire())();
    });

    it('preserves event listeners by default', () => {
      const sem = make(1);
      const listener = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, listener);
      sem.reset();
      sem.shutdown();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('clears listeners when clearListeners: true', () => {
      const sem = make(1);
      const listener = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, listener);
      sem.reset({ clearListeners: true });
      sem.shutdown();
      expect(listener).not.toHaveBeenCalled();
    });

    it('resolves an active drain', async () => {
      const sem = make(1);
      await sem.acquire();
      const d = sem.drain();
      sem.reset();
      await expect(d).resolves.toBeUndefined();
    });

    it('refuses to revive a shut-down semaphore', () => {
      const sem = make(1);
      sem.shutdown();
      expect(() => sem.reset()).toThrow(
        expect.objectContaining({ name: 'SemaphoreError', code: 'SHUTDOWN' })
      );
      expect(sem.isAvailable()).toBe(false);
    });
  });

  // ─── shutdown() ───────────────────────────────────────────────────────────
  describe('shutdown()', () => {
    it('rejects queued tasks with SHUTDOWN', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const p = sem.acquire();
      sem.shutdown();
      await expect(p).rejects.toMatchObject({ code: 'SHUTDOWN' });
      r();
    });

    it('rejects subsequent acquire with SHUTDOWN', async () => {
      const sem = make(1);
      sem.shutdown();
      await expect(sem.acquire()).rejects.toMatchObject({ code: 'SHUTDOWN' });
    });

    it('emits SHUTDOWN event', () => {
      const sem = make(1);
      const listener = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, listener);
      sem.shutdown('test reason');
      expect(listener).toHaveBeenCalledWith('test reason');
    });

    it('is idempotent', () => {
      const sem = make(1);
      expect(() => { sem.shutdown(); sem.shutdown(); }).not.toThrow();
    });
  });

  // ─── purgeStaleTasks ──────────────────────────────────────────────────────
  describe('purgeStaleTasks', () => {
    it('ejects tasks beyond queueMaxAge', async () => {
      const sem = make(1, { queueMaxAge: 1000, queueMaxTimeout: 60000, purgeIntervalMs: 500 });
      const r = await sem.acquire();
      const p = sem.acquire();
      vi.advanceTimersByTime(1500); // > queueMaxAge, triggers purge interval
      await expect(p).rejects.toMatchObject({ code: 'PURGED' });
      r();
    });
  });

  // ─── isAvailable / status ─────────────────────────────────────────────────
  describe('isAvailable / status', () => {
    it('isAvailable returns false when full', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      expect(sem.isAvailable()).toBe(false);
      r();
      expect(sem.isAvailable()).toBe(true);
    });

    it('isAvailable returns false after shutdown', () => {
      const sem = make(1);
      sem.shutdown();
      expect(sem.isAvailable()).toBe(false);
    });

    it('status reflects queue depth and running count', async () => {
      const sem = make(2);
      const r1 = await sem.acquire();
      const r2 = await sem.acquire();
      const s = sem.status().status;
      expect(s.running).toBe(2);
      expect(s.available).toBe(0);
      r1(); r2();
    });
  });

  // ─── Event emitter ────────────────────────────────────────────────────────
  describe('event emitter', () => {
    it('on / off work correctly', async () => {
      const sem = make(1);
      const listener = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, listener);
      sem.off(SemaphoreEvents.SHUTDOWN, listener);
      sem.shutdown();
      expect(listener).not.toHaveBeenCalled();
    });

    it('removeAllListeners clears all events', () => {
      const sem = make(1);
      const l1 = vi.fn(), l2 = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, l1);
      sem.on(SemaphoreEvents.TASKABORT, l2);
      sem.removeAllListeners();
      sem.shutdown();
      expect(l1).not.toHaveBeenCalled();
    });

    it('removeAllListeners(event) clears only that event', () => {
      const sem = make(1);
      const l1 = vi.fn(), l2 = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, l1);
      sem.on(SemaphoreEvents.TASKTIMEOUT, l2);
      sem.removeAllListeners(SemaphoreEvents.SHUTDOWN);
      sem.shutdown();
      expect(l1).not.toHaveBeenCalled();
    });

    it('isolates a throwing listener so other listeners still run', () => {
      const sem = make(1);
      const after = vi.fn();
      sem.on(SemaphoreEvents.SHUTDOWN, () => { throw new Error('listener boom'); });
      sem.on(SemaphoreEvents.SHUTDOWN, after);
      expect(() => sem.shutdown()).not.toThrow();
      expect(after).toHaveBeenCalledTimes(1);
    });

    it('emits task-acquire and task-release without debug mode (fast path)', async () => {
      const sem = make(1); // debug defaults to false
      const onAcquire = vi.fn(), onRelease = vi.fn();
      sem.on(SemaphoreEvents.TASKACQUIRE, onAcquire);
      sem.on(SemaphoreEvents.TASKRELEASE, onRelease);
      const r = await sem.acquire();
      expect(onAcquire).toHaveBeenCalledTimes(1);
      expect(onAcquire).toHaveBeenCalledWith(expect.objectContaining({ queued: 0, running: 1 }));
      r();
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    it('emits task-acquire when a queued task is dispatched (without debug mode)', async () => {
      const sem = make(1);
      const r = await sem.acquire();            // fast path
      const onAcquire = vi.fn();
      sem.on(SemaphoreEvents.TASKACQUIRE, onAcquire); // register after the fast acquire
      const p = sem.acquire();                  // queues behind the held permit
      r();                                      // release -> scheduler dispatches the queued task
      const rel = await p;
      expect(onAcquire).toHaveBeenCalledTimes(1);
      expect(onAcquire).toHaveBeenCalledWith(expect.objectContaining({ queued: 0, running: 1 }));
      rel();
    });
  });

  // ─── Weighted semaphore ───────────────────────────────────────────────────
  describe('weighted semaphore', () => {
    it('tryAcquire(weight) succeeds when sufficient permits available', () => {
      const sem = make(3);
      const r = sem.tryAcquire(2);
      expect(r).toBeTypeOf('function');
      expect(sem.availablePermits).toBe(1);
      r!();
      expect(sem.availablePermits).toBe(3);
    });

    it('tryAcquire(weight) returns null when insufficient permits', () => {
      const sem = make(3);
      const r1 = sem.tryAcquire(2);
      expect(sem.tryAcquire(2)).toBeNull();
      r1!();
    });

    it('tryAcquire returns null for invalid weights', () => {
      const sem = make(3);
      expect(sem.tryAcquire(0)).toBeNull();
      expect(sem.tryAcquire(-1)).toBeNull();
      expect(sem.tryAcquire(4)).toBeNull(); // over capacity
      expect(sem.tryAcquire(1.5)).toBeNull(); // non-integer
    });

    it('acquire(weight) queues and dispatches weighted task', async () => {
      const sem = make(3);
      const r1 = await sem.acquire(undefined, 0, 2);
      expect(sem.availablePermits).toBe(1);
      const p2 = sem.acquire(undefined, 0, 2); // queues, needs 2 permits
      expect(sem.queueLength).toBe(1);
      r1(); // free 2 permits
      const r2 = await p2;
      expect(sem.availablePermits).toBe(1);
      r2();
    });

    it('use(weight) works correctly', async () => {
      const sem = make(5);
      let inFlight = 0;
      await sem.use(async () => { inFlight = sem.status().status.inFlight; }, undefined, 0, 3);
      expect(inFlight).toBe(3);
      expect(sem.availablePermits).toBe(5);
    });

    it('head-of-line blocking: weight-2 task blocks weight-1 task', async () => {
      vi.useRealTimers();
      const sem = new Semaphore(3, { purgeIntervalMs: 100000, backoffInitialTimeout: 0, backoffMaxTimeout: 0 });
      const r1 = await sem.acquire(undefined, 0, 2); // 1 permit left
      const p2 = sem.acquire(undefined, 1, 2); // priority 1, needs 2, queues
      const p3 = sem.acquire(undefined, 2, 1); // priority 2, needs 1
      await new Promise(res => setTimeout(res, 10));
      // p3 could fit the free permit but must not jump ahead of the
      // higher-priority p2 (head-of-line): both stay queued.
      expect(sem.queueLength).toBe(2);
      r1(); // free 2 permits → scheduler dispatches p2 then p3, in order
      const r2 = await p2;
      const r3 = await p3;
      expect(sem.queueLength).toBe(0);
      r2(); r3();
      sem.shutdown();
      vi.useFakeTimers();
    });

    it('acquire rejects invalid weight', async () => {
      const sem = make(3);
      await expect(sem.acquire(undefined, 0, 0)).rejects.toMatchObject({ code: 'INVALID_WEIGHT' });
      await expect(sem.acquire(undefined, 0, 4)).rejects.toMatchObject({ code: 'INVALID_WEIGHT' });
    });

    it('acquire rejects non-finite priority', async () => {
      const sem = make(3);
      await expect(sem.acquire(undefined, NaN)).rejects.toMatchObject({ code: 'INVALID_PRIORITY' });
      await expect(sem.acquire(undefined, Infinity)).rejects.toMatchObject({ code: 'INVALID_PRIORITY' });
      await expect(sem.acquire(undefined, -Infinity)).rejects.toMatchObject({ code: 'INVALID_PRIORITY' });
    });
  });

  // ─── cancel() ─────────────────────────────────────────────────────────────
  describe('cancel()', () => {
    it('rejects all queued tasks with CANCELLED', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const p1 = sem.acquire();
      const p2 = sem.acquire();
      sem.cancel();
      await expect(p1).rejects.toMatchObject({ code: 'CANCELLED' });
      await expect(p2).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(sem.queueLength).toBe(0);
      r();
    });

    it('leaves in-flight permits unaffected', async () => {
      const sem = make(2);
      const r1 = await sem.acquire();
      const r2 = await sem.acquire();
      const p = sem.acquire();
      sem.cancel();
      await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(sem.availablePermits).toBe(0); // both still held
      r1(); r2();
      expect(sem.availablePermits).toBe(2);
    });

    it('semaphore remains usable after cancel', async () => {
      vi.useRealTimers();
      const sem = new Semaphore(1, { purgeIntervalMs: 100000 });
      const r = await sem.acquire();
      const p = sem.acquire();
      sem.cancel();
      await p.catch(() => {});
      r();
      const r2 = await sem.acquire();
      expect(r2).toBeTypeOf('function');
      r2();
      sem.shutdown();
      vi.useFakeTimers();
    });

    it('is a no-op when shut down', () => {
      const sem = make(1);
      sem.shutdown();
      expect(() => sem.cancel()).not.toThrow();
    });

    it('resolves a pending drain() after cancel() leaves the semaphore idle (scheduler parked)', async () => {
      // Repro for the cancel()/drain() hang: with the circuit parked open, the
      // scheduler is not armed, so emptying the queue via cancel() must itself
      // re-run the drain check — otherwise the pending drain() never resolves.
      vi.useRealTimers();
      const sem = new Semaphore(1, {
        purgeIntervalMs: 100000,
        queueMaxTimeout: 50,
        queueMaxAge: 100000,
        circuitBreakerWindow: 1000,
        circuitBreakerCooldown: 60000,
        circuitBreakerMinThroughput: 1,
        circuitBreakerMinFailures: 1,
        circuitBreakerThreshold: 0.01,
        // Disable backoff so no delayed scheduler tick is left pending — the
        // scheduler must be fully parked, otherwise this wouldn't isolate the
        // cancel()-must-reschedule path.
        backoffInitialTimeout: 0,
        backoffMaxTimeout: 0,
      });
      const A = await sem.acquire();              // in-flight
      const pB = sem.acquire().catch(() => {});   // queued ~0ms, times out ~50ms -> trips circuit
      await new Promise(r => setTimeout(r, 40));
      const pC = sem.acquire().catch(() => {});   // queued ~40ms, would time out ~140ms
      await pB;
      expect(sem.status().status.circuitOpen).toBe(true);
      A();                                        // release -> scheduler parks (circuit open), C queued, permit free
      await new Promise(r => setTimeout(r, 5));
      expect(sem.queueLength).toBe(1);
      expect(sem.availablePermits).toBe(1);

      const drained = sem.drain();
      sem.cancel();                               // empties the queue; C's own watchdog is cleared

      // With the fix this resolves promptly; a regression hangs until the race timer.
      const outcome = await Promise.race([
        drained.then(() => 'resolved'),
        new Promise<string>(r => setTimeout(() => r('hung'), 300)),
      ]);
      expect(outcome).toBe('resolved');

      await pC;
      sem.shutdown();
      vi.useFakeTimers();
    });
  });

  // ─── Scheduler re-arm after task removal ─────────────────────────────────
  describe('scheduler re-arm after task removal', () => {
    it('scheduler dispatches next task after timeout', async () => {
      vi.useRealTimers();
      const sem = new Semaphore(2, { queueMaxTimeout: 50, purgeIntervalMs: 100000, backoffInitialTimeout: 0, backoffMaxTimeout: 0 });
      const r1 = await sem.acquire();
      const r2 = await sem.acquire();
      const p1 = sem.acquire();
      p1.catch(() => {});
      await new Promise(res => setTimeout(res, 60)); // p1 times out
      const p2 = sem.acquire(); // enqueued after the timeout, fresh window
      r1(); // free a permit — scheduler should re-arm and dispatch p2
      await new Promise(res => setTimeout(res, 10)); // let scheduler run
      const r3 = await p2;
      expect(sem.queueLength).toBe(0);
      r2(); r3();
      sem.shutdown();
      vi.useFakeTimers();
    });

    it('scheduler dispatches next task after abort', async () => {
      vi.useRealTimers();
      const sem = new Semaphore(1, { purgeIntervalMs: 100000, backoffInitialTimeout: 0, backoffMaxTimeout: 0 });
      const r1 = await sem.acquire();
      const c = new AbortController();
      const p1 = sem.acquire(c.signal);
      const p2 = sem.acquire();
      c.abort(); // p1 aborts
      await p1.catch(() => {});
      r1(); // free a permit — scheduler should re-arm and dispatch p2
      await new Promise(res => setTimeout(res, 10)); // let scheduler run
      const r2 = await p2;
      expect(sem.queueLength).toBe(0);
      r2();
      sem.shutdown();
      vi.useFakeTimers();
    });
  });
});
