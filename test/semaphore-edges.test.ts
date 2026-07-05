import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Semaphore } from '../src/semaphore';
import { SemaphoreEvents } from '../src/types';
import { ManualCircuitBreaker } from '../src/breakers';
import type { CircuitBreakerStrategy, CircuitState, CircuitTripResult, SemaphoreConfig } from '../src/types';

/*
Edge-path coverage for Semaphore: debug logging, metrics-disabled operation,
listener error isolation, queued circuit-breaker probes, and the scheduler's
defensive guards. Complements the behavioral suite in semaphore.test.ts.
*/

function make(count = 2, config: SemaphoreConfig = {}) {
  return new Semaphore(count, { purgeIntervalMs: 500, ...config });
}

async function fillPermits(sem: Semaphore, count: number) {
  return Promise.all(Array.from({ length: count }, () => sem.acquire()));
}

// Trip the breaker without any queue timeouts: one tracked attempt plus one
// reported failure crosses the (deliberately minimal) thresholds.
const instantTripConfig: SemaphoreConfig = {
  circuitBreakerThreshold: 0.5,
  circuitBreakerWindow: 5000,
  circuitBreakerCooldown: 1000,
  circuitBreakerMinThroughput: 1,
  circuitBreakerMinFailures: 1,
};

async function tripViaReportFailure(sem: Semaphore) {
  (await sem.acquire())(); // one tracked attempt
  sem.reportFailure();
  expect(sem.status().status.circuitOpen).toBe(true);
}

describe('Semaphore edge paths', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const warned = (fragment: string) =>
    warnSpy.mock.calls.some((args: unknown[]) => String(args[0]).includes(fragment));
  const logged = (fragment: string) =>
    infoSpy.mock.calls.some((args: unknown[]) => String(args[0]).includes(fragment));

  // ─── Debug logging ─────────────────────────────────────────────────────────
  describe('debug mode', () => {
    it('warns on double release', async () => {
      const sem = make(1, { debug: true });
      const r = await sem.acquire();
      r();
      r();
      expect(warned('already released')).toBe(true);
    });

    it('logs task timeout, circuit trip, and queue eviction', async () => {
      const sem = make(1, {
        debug: true, queueMaxTimeout: 50,
        circuitBreakerThreshold: 0.5, circuitBreakerWindow: 5000,
        circuitBreakerCooldown: 1000, circuitBreakerMinThroughput: 2, circuitBreakerMinFailures: 2,
      });
      const r = await sem.acquire();
      const doomed = [sem.acquire().catch(e => e), sem.acquire().catch(e => e)];
      vi.advanceTimersByTime(30);
      const evictable = sem.acquire().catch(e => e);
      vi.advanceTimersByTime(20); // doomed time out → trip → evictable evicted
      await Promise.all(doomed);
      expect(warned('timed out after')).toBe(true);
      expect(warned('Circuit opened')).toBe(true);
      expect(warned('Evicted queued task')).toBe(true);
      expect((await evictable).code).toBe('CIRCUIT_OPEN');
      r();
    });

    it('logs probing transitions from tryAcquire and acquire, and probe close', async () => {
      const sem = make(1, { ...instantTripConfig, debug: true });
      await tripViaReportFailure(sem);
      vi.advanceTimersByTime(1000);
      const probe = sem.tryAcquire()!; // open → probing via tryAcquire
      expect(logged('entering probing')).toBe(true);
      probe(); // probe success → close
      expect(logged('Circuit closed after successful probe')).toBe(true);

      await tripViaReportFailure(sem);
      vi.advanceTimersByTime(1000);
      infoSpy.mockClear();
      const events: boolean[] = [];
      sem.on(SemaphoreEvents.TASKACQUIRE, p => events.push(p.probe === true));
      const release = await sem.acquire(); // open → probing via acquire; probe fast path
      expect(logged('entering probing')).toBe(true);
      expect(events).toEqual([true]); // TASKACQUIRE carries probe: true
      release();
      expect(sem.status().status.circuitOpen).toBe(false);
    });

    it('logs aborts, purges, cancel, reset, shutdown, and reportFailure trips', async () => {
      const sem = make(1, { ...instantTripConfig, debug: true, queueMaxAge: 300, purgeIntervalMs: 500, queueMaxTimeout: 10000 });
      const r = await sem.acquire();

      const c = new AbortController();
      const aborted = sem.acquire(c.signal).catch(e => e.code);
      c.abort();
      expect(await aborted).toBe('ABORTED');
      expect(logged('aborted')).toBe(true);

      const purged = sem.acquire().catch(e => e.code);
      vi.advanceTimersByTime(500); // purge sweep at 500ms; task is 500ms > 300ms old
      expect(await purged).toBe('PURGED');
      expect(warned('Purged stale task')).toBe(true);
      expect(logged('Purged 1 stale tasks')).toBe(true);

      const cancelled = sem.acquire().catch(e => e.code);
      sem.cancel();
      expect(await cancelled).toBe('CANCELLED');
      expect(logged('Cancelled 1 queued tasks')).toBe(true);

      r();
      // Four attempts were tracked above (initial + aborted + purged +
      // cancelled), so cross the 0.5 threshold with matching failures.
      sem.reportFailure(); sem.reportFailure(); sem.reportFailure(); sem.reportFailure();
      expect(warned('Circuit opened via reportFailure()')).toBe(true);

      sem.reset();
      expect(logged('Reset to initial state')).toBe(true);

      sem.shutdown('bye');
      expect(logged('Shutdown: bye')).toBe(true);
    });

    it('logs when a probe operation fails through use()', async () => {
      const sem = make(1, {
        ...instantTripConfig, debug: true,
        circuitBreakerFailurePredicate: (e) => e instanceof Error && e.message === 'downstream',
      });
      await tripViaReportFailure(sem);
      vi.advanceTimersByTime(1000);
      const result = await sem.use(() => Promise.reject(new Error('downstream'))).catch(e => e.message);
      expect(result).toBe('downstream');
      expect(warned('probe operation failed')).toBe(true);
      expect(sem.status().status.circuitOpen).toBe(true);
    });
  });

  // ─── Metrics disabled ──────────────────────────────────────────────────────
  describe('metricsEnabled: false', () => {
    it('operates fully and reports null metrics with zeroed rates', async () => {
      const sem = make(1, { metricsEnabled: false, queueMaxTimeout: 50 });
      const r = await sem.acquire();
      const queuedTimeout = sem.acquire().catch(e => e.code);
      vi.advanceTimersByTime(50);
      expect(await queuedTimeout).toBe('TIMEOUT');
      r();

      const st = sem.status();
      expect(st.metrics).toBeNull();
      expect(st.status.requestsPerSecond).toBe(0);
      expect(st.status.timeoutRate1m).toBe(0);
      expect(st.lifetime.totalAcquired).toBe(1);
      expect(st.lifetime.totalTimeouts).toBe(1);

      sem.reset();  // reset with no metrics collector
      sem.shutdown(); // destroy with no metrics collector
    });

    it('grants and closes a probe without a metrics collector', async () => {
      const sem = make(1, { ...instantTripConfig, metricsEnabled: false });
      await tripViaReportFailure(sem);
      vi.advanceTimersByTime(1000);
      const probeRelease = await sem.acquire(); // probe via the fast path
      probeRelease();
      expect(sem.status().status.circuitOpen).toBe(false);
      expect(sem.status().status.circuitProbing).toBe(false);
    });
  });

  // ─── Event listener error isolation ────────────────────────────────────────
  describe('listener error isolation', () => {
    it('catches a throwing listener on the single-listener fast path', async () => {
      const sem = make(1);
      sem.on(SemaphoreEvents.TASKACQUIRE, () => { throw new Error('boom'); });
      const r = await sem.acquire();
      r();
      expect(warned('Error in listener for "task-acquire"')).toBe(true);
    });

    it('catches a throwing listener mid-emit and still calls the rest', async () => {
      const sem = make(1);
      const second = vi.fn();
      sem.on(SemaphoreEvents.TASKACQUIRE, () => { throw new Error('boom'); });
      sem.on(SemaphoreEvents.TASKACQUIRE, second);
      const r = await sem.acquire();
      r();
      expect(warned('Error in listener for "task-acquire"')).toBe(true);
      expect(second).toHaveBeenCalledOnce();
    });

    it('off() removes one listener while keeping the rest registered', async () => {
      const sem = make(1);
      const a = vi.fn(); const b = vi.fn();
      sem.on(SemaphoreEvents.TASKACQUIRE, a);
      sem.on(SemaphoreEvents.TASKACQUIRE, b);
      sem.off(SemaphoreEvents.TASKACQUIRE, a);
      const r = await sem.acquire();
      r();
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledOnce();
    });
  });

  // ─── Queued circuit-breaker probes ─────────────────────────────────────────
  // A probe queues (rather than taking the fast path) when the circuit goes
  // probing while every permit is still held.
  describe('queued probes', () => {
    async function queueProbe(sem: Semaphore) {
      const [release] = await fillPermits(sem, 1);
      sem.reportFailure(); // trips: circuit open while the permit is held
      expect(sem.status().status.circuitOpen).toBe(true);
      vi.advanceTimersByTime(1000); // cooldown elapses
      const probePromise = sem.acquire(); // probing, no capacity → queued probe
      expect(sem.queueLength).toBe(1);
      expect(sem.peekQueue()[0]!.isProbe).toBe(true);
      return { release, probePromise };
    }

    it('dispatches the queued probe on release and emits TASKACQUIRE with probe: true', async () => {
      const sem = make(1, instantTripConfig);
      const { release, probePromise } = await queueProbe(sem);
      const probeFlags: (boolean | undefined)[] = [];
      sem.on(SemaphoreEvents.TASKACQUIRE, p => probeFlags.push(p.probe));
      release();
      const probeRelease = await probePromise;
      expect(probeFlags).toEqual([true]);
      probeRelease();
      expect(sem.status().status.circuitOpen).toBe(false);
      expect(sem.status().status.circuitProbing).toBe(false);
    });

    it('releases the probe slot when a queued probe is aborted', async () => {
      const sem = make(1, instantTripConfig);
      const [release] = await fillPermits(sem, 1);
      sem.reportFailure();
      vi.advanceTimersByTime(1000);
      const c = new AbortController();
      const probe = sem.acquire(c.signal).catch(e => e.code);
      expect(sem.peekQueue()[0]!.isProbe).toBe(true);
      c.abort();
      expect(await probe).toBe('ABORTED');
      // Slot released: a fresh acquire may become the new probe.
      const retry = sem.acquire();
      expect(sem.peekQueue()[0]!.isProbe).toBe(true);
      release();
      (await retry)();
      expect(sem.status().status.circuitOpen).toBe(false);
    });

    it('releases the probe slot when a queued probe is cancelled', async () => {
      const sem = make(1, instantTripConfig);
      const { release, probePromise } = await queueProbe(sem);
      const rejected = probePromise.catch(e => e.code);
      sem.cancel();
      expect(await rejected).toBe('CANCELLED');
      expect(sem.queueLength).toBe(0);
      release();
      // Slot freed: the next acquire becomes the probe and can close the circuit.
      (await sem.acquire())();
      expect(sem.status().status.circuitOpen).toBe(false);
    });

    it('releases the probe slot when a queued probe is purged as stale', async () => {
      const sem = make(1, { ...instantTripConfig, queueMaxAge: 300, purgeIntervalMs: 500, queueMaxTimeout: 10000 });
      const { release, probePromise } = await queueProbe(sem);
      const rejected = probePromise.catch(e => e.code);
      vi.advanceTimersByTime(500); // purge sweep: probe is 500ms > 300ms old
      expect(await rejected).toBe('PURGED');
      release();
      (await sem.acquire())();
      expect(sem.status().status.circuitOpen).toBe(false);
    });

    it('re-opens the circuit when a queued probe times out', async () => {
      const sem = make(1, { ...instantTripConfig, queueMaxTimeout: 100, debug: true });
      const { release, probePromise } = await queueProbe(sem);
      const rejected = probePromise.catch(e => e.code);
      const onOpen = vi.fn();
      sem.on(SemaphoreEvents.CIRCUITOPEN, onOpen);
      vi.advanceTimersByTime(100);
      expect(await rejected).toBe('TIMEOUT');
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ reason: 'probe-failed' }));
      expect(warned('probe timed out')).toBe(true);
      expect(sem.status().status.circuitOpen).toBe(true);
      release();
    });
  });

  // ─── Shared timeout watchdog self-correction ───────────────────────────────
  describe('watchdog early fire', () => {
    it('re-arms without evicting when the timer fires at a stale (dispatched) deadline', async () => {
      const sem = make(1, { queueMaxTimeout: 100 });
      const r = await sem.acquire();
      const a = sem.acquire();          // t=0: watchdog armed for t=100
      vi.advanceTimersByTime(40);
      const b = sem.acquire().catch(e => e.code); // t=40: deadline t=140
      r();                              // A dispatches; timer still points at t=100
      const releaseA = await a;
      vi.advanceTimersByTime(60);       // t=100: stale fire — B not expired, nothing evicted
      expect(sem.queueLength).toBe(1);
      vi.advanceTimersByTime(40);       // t=140: re-armed timer fires B's real deadline
      expect(await b).toBe('TIMEOUT');
      releaseA();
    });
  });

  // ─── Scheduler guards ──────────────────────────────────────────────────────
  describe('scheduler guards', () => {
    it('holds queued tasks while a manual breaker is open, then dispatches after close', async () => {
      const breaker = new ManualCircuitBreaker();
      const sem = make(1, { circuitBreaker: breaker });
      const r = await sem.acquire();
      const queued = sem.acquire();
      breaker.open();
      r(); // wake scheduler: must break on open circuit, keeping the task queued
      await vi.advanceTimersByTimeAsync(0);
      expect(sem.queueLength).toBe(1);
      breaker.close();
      // A release-driven wakeup is the normal re-arm; simulate via tryAcquire+release.
      const extra = sem.tryAcquire(); // null: queue non-empty (head-of-line)
      expect(extra).toBeNull();
      sem.cancel();
      await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('does not dispatch a non-probe head while probing (stub breaker)', async () => {
      // Contract-level stub: probing with a probe id that never matches the
      // queued head, so the scheduler's probing guard must hold the queue.
      let probing = false;
      const stub: CircuitBreakerStrategy = {
        get state(): CircuitState { return probing ? 'probing' : 'closed'; },
        get isOpen() { return false; },
        get isProbing() { return probing; },
        hasProbeInFlight: false,
        probeTaskId: 999,
        cooldownRemaining: 0,
        checkAndTransition: () => false,
        trackAttempt() {}, recordFailure() {},
        evaluateAndTrip: (): CircuitTripResult => ({ tripped: false }),
        markProbeInFlight() {}, claimProbeSlot() {}, releaseProbeSlot() {},
        handleProbeSuccess() {}, handleProbeFailure() {}, reset() {},
      };
      const sem = make(1, { circuitBreaker: stub });
      const r = await sem.acquire();
      const queued = sem.acquire();
      probing = true;
      r();
      await vi.advanceTimersByTimeAsync(0);
      expect(sem.queueLength).toBe(1); // held: head id !== probeTaskId
      probing = false;
      sem.cancel();
      await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('evicts a queued non-probe task but preserves a queued probe (stub breaker, defensive fallback)', async () => {
      // Contract-level stub: an ordinary task is already queued when a
      // non-compliant breaker transitions straight to probing and queues a
      // probe behind it without evicting first. Unreachable through the
      // built-in breaker — evaluateAndTrip() only trips (and evicts) from
      // closed, and a probe only exists while probing, so an ordinary task
      // can never still be queued by the time a probe joins it — but
      // _evictQueueOnCircuitOpen()'s selective fallback still needs to be
      // exercised against a strategy that violates that contract.
      //
      // Note: a second live `acquire()` can't be used to queue the ordinary
      // task *after* the probe exists — `_acquire()` rejects any call with
      // CIRCUIT_PROBING once `isProbing && hasProbeInFlight`, before it would
      // ever reach the queue. So the ordinary task is queued first, while
      // still "closed", and probing begins only afterward.
      let probing = false;
      let hasProbe = false;
      let probeId: number | null = null;
      const stub: CircuitBreakerStrategy = {
        get state(): CircuitState { return probing ? 'probing' : 'closed'; },
        get isOpen() { return false; },
        get isProbing() { return probing; },
        get hasProbeInFlight() { return hasProbe; },
        get probeTaskId() { return probeId; },
        cooldownRemaining: 0,
        checkAndTransition: () => false,
        trackAttempt() {}, recordFailure() {},
        evaluateAndTrip: (): CircuitTripResult => ({ tripped: true, timeoutRate: 1, failures: 1, attempts: 1 }),
        markProbeInFlight() { hasProbe = true; },
        claimProbeSlot(taskId: number) { hasProbe = true; probeId = taskId; },
        releaseProbeSlot() { hasProbe = false; probeId = null; },
        handleProbeSuccess() {}, handleProbeFailure() {}, reset() {},
      };
      const sem = make(1, { circuitBreaker: stub });
      const held = await sem.acquire();  // fast-path grant while closed; capacity now exhausted
      const other = sem.acquire();       // still closed, no capacity → queues as an ordinary task
      probing = true;                    // non-compliant closed → probing transition, no eviction
      const probe = sem.acquire();       // no capacity, isProbing, no probe in flight yet → queues as the probe
      expect(sem.queueLength).toBe(2);

      sem.reportFailure(); // evaluateAndTrip() → tripped: true → _evictQueueOnCircuitOpen()

      await expect(other).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
      expect(sem.queueLength).toBe(1); // the probe survives, still queued
      expect(sem.peekQueue()[0]!.isProbe).toBe(true);

      sem.cancel();
      await expect(probe).rejects.toMatchObject({ code: 'CANCELLED' });
      held();
    });

    it('catches and logs a scheduler exception (Error and non-Error)', async () => {
      for (const thrown of [new Error('breaker exploded'), 'string-explosion']) {
        let armed = false;
        const stub: CircuitBreakerStrategy = {
          state: 'closed',
          get isOpen(): boolean { if (armed) throw thrown; return false; },
          isProbing: false, hasProbeInFlight: false, probeTaskId: null, cooldownRemaining: 0,
          checkAndTransition: () => false,
          trackAttempt() {}, recordFailure() {},
          evaluateAndTrip: (): CircuitTripResult => ({ tripped: false }),
          markProbeInFlight() {}, claimProbeSlot() {}, releaseProbeSlot() {},
          handleProbeSuccess() {}, handleProbeFailure() {}, reset() {},
        };
        const sem = make(1, { circuitBreaker: stub });
        const r = await sem.acquire();
        const queued = sem.acquire();
        armed = true;
        r(); // scheduler wakeup hits the throwing getter inside the try block
        await vi.advanceTimersByTimeAsync(0);
        expect(errorSpy.mock.calls.some((args: unknown[]) => String(args[0]).includes('Scheduler error'))).toBe(true);
        armed = false;
        sem.cancel();
        await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
        errorSpy.mockClear();
      }
    });
  });

  // ─── Breaker attempt accounting ────────────────────────────────────────────
  // Attempts are tracked at admission (permit granted or task enqueued), so
  // acquire() and tryAcquire() cannot double-count and rejected admissions
  // never dilute the failure rate.
  describe('breaker attempt accounting', () => {
    const strictConfig: SemaphoreConfig = {
      circuitBreakerThreshold: 0.9, // trips only if rejected admissions are NOT counted
      circuitBreakerWindow: 5000,
      circuitBreakerCooldown: 1000,
      circuitBreakerMinThroughput: 1,
      circuitBreakerMinFailures: 1,
    };

    it('counts tryAcquire() grants as attempts', async () => {
      const sem = make(1, {
        ...strictConfig,
        circuitBreakerThreshold: 0.5, circuitBreakerMinThroughput: 2, circuitBreakerMinFailures: 2,
      });
      sem.tryAcquire()!();
      sem.tryAcquire()!();
      // 2 attempts satisfy minThroughput only if tryAcquire grants counted.
      sem.reportFailure();
      sem.reportFailure();
      expect(sem.status().status.circuitOpen).toBe(true);
    });

    it('does not count a null tryAcquire() (no capacity) as an attempt', async () => {
      const sem = make(1, strictConfig);
      const r = await sem.acquire(); // 1 attempt
      for (let i = 0; i < 5; i++) expect(sem.tryAcquire()).toBeNull();
      r();
      sem.reportFailure(); // 1 failure / 1 attempt = 1.0 ≥ 0.9 → trips.
      // If the 5 nulls had been counted the rate would be 1/6 and stay closed.
      expect(sem.status().status.circuitOpen).toBe(true);
    });

    it('does not count QUEUE_FULL rejections as attempts', async () => {
      const sem = make(1, { ...strictConfig, rejectOnFull: true });
      const r = await sem.acquire(); // 1 attempt
      for (let i = 0; i < 5; i++) {
        await expect(sem.acquire()).rejects.toMatchObject({ code: 'QUEUE_FULL' });
      }
      r();
      sem.reportFailure(); // 1 failure / 1 attempt = 1.0 ≥ 0.9 → trips.
      // If the 5 QUEUE_FULL rejections had been counted the rate would be 1/6.
      expect(sem.status().status.circuitOpen).toBe(true);
    });
  });

  // ─── Purge accounting ──────────────────────────────────────────────────────
  describe('purge accounting', () => {
    it('counts purges in totalPurged, not in timeouts or the breaker', async () => {
      const sem = make(1, { queueMaxAge: 300, purgeIntervalMs: 500, queueMaxTimeout: 10000 });
      const r = await sem.acquire();
      const purged = sem.acquire().catch(e => e.code);
      vi.advanceTimersByTime(500);
      expect(await purged).toBe('PURGED');
      const st = sem.status();
      expect(st.lifetime.totalPurged).toBe(1);
      expect(st.lifetime.totalTimeouts).toBe(0);
      expect(st.status.timeoutRate1m).toBe(0);
      expect(st.metrics!.meta.totalPurged).toBe(1);
      expect(st.metrics!.meta.totalTimeouts).toBe(0);
      expect(st.metrics!.windows['1m']!.counts.timeouts).toBe(0);
      r();
    });

    it('reset() clears totalPurged', async () => {
      const sem = make(1, { queueMaxAge: 300, purgeIntervalMs: 500, queueMaxTimeout: 10000 });
      const r = await sem.acquire();
      const purged = sem.acquire().catch(e => e.code);
      vi.advanceTimersByTime(500);
      expect(await purged).toBe('PURGED');
      r();
      sem.reset();
      expect(sem.status().lifetime.totalPurged).toBe(0);
    });
  });

  // ─── Lifecycle odds and ends ───────────────────────────────────────────────
  describe('lifecycle edges', () => {
    it('shutdown() resolves a pending drain()', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const drained = sem.drain();
      sem.shutdown();
      await expect(drained).resolves.toBeUndefined();
      r(); // stale release after shutdown is a safe no-op path
    });

    it('drain(timeoutMs) resolves and clears its deadline timer when idle beats the deadline', async () => {
      const sem = make(1);
      const r = await sem.acquire();
      const drained = sem.drain(5000);
      r(); // idle before the deadline: wrapped resolve clears the timer
      await expect(drained).resolves.toBeUndefined();
      vi.advanceTimersByTime(5000); // deadline passing later must be a no-op
    });

    it('shutdown() invalidates outstanding release closures and settles the pool', async () => {
      const sem = make(2);
      const r = await sem.acquire();
      expect(sem.availablePermits).toBe(1);
      sem.shutdown();
      expect(sem.availablePermits).toBe(2); // pool settled at shutdown
      expect(sem.status().status.pendingReleases).toBe(0);
      r(); // stale generation: must be a no-op, not a double credit
      expect(sem.availablePermits).toBe(2);
      expect(sem.status().status.pendingReleases).toBe(0);
    });

    it('shutdown() is idempotent and gates cancel/reportFailure', () => {
      const sem = make(1);
      sem.shutdown('first');
      sem.shutdown('second'); // early-return
      sem.cancel();           // no-op after shutdown
      sem.reportFailure();    // no-op after shutdown
      expect(sem.isAvailable()).toBe(false);
    });

    it('removeAllListeners clears one event or all', async () => {
      const sem = make(1);
      const a = vi.fn(); const b = vi.fn();
      sem.on(SemaphoreEvents.TASKACQUIRE, a);
      sem.on(SemaphoreEvents.TASKRELEASE, b);
      sem.removeAllListeners(SemaphoreEvents.TASKACQUIRE);
      const r = await sem.acquire();
      r();
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledOnce();
      sem.removeAllListeners();
      const r2 = await sem.acquire();
      r2();
      expect(b).toHaveBeenCalledOnce();
    });
  });
});
