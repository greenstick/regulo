/*
Semaphore

A priority-queue semaphore with an integrated circuit breaker, designed to
cap concurrency of expensive operations while protecting the system from
sustained overload.

Permit lifecycle
  acquire()   — Fast path: a slot is free; return a release closure immediately.
              — Queued path: no slot; wrap in a QueuedTask with a timeout watchdog
                and optional abort signal; let the scheduler dispatch it.
  release()   — return permit to PermitPool, wake the scheduler.

Core invariant: permits.inFlight + permits.available === permits.capacity.
Verified by PermitPool.assertInvariant() in debug mode after every mutation.

Circuit breaker   closed → open → half-open → closed
  All state and transitions live in CircuitBreaker. The semaphore calls
  checkAndTransition() at the top of every acquire() and emits the appropriate
  event when a transition is reported.

Metrics
  Two independent systems:
  CircuitBreaker  — owns a single sliding window for trip decisions only.
  SemaphoreMetrics — MultiWindow exposing 1m/5m/15m/1h/24h rollups for dashboards.
*/

import { validateNumber } from "./validation";
import { SemaphoreError } from './error';
import { PermitPool } from './permit';
import { CircuitBreaker } from './breaker';
import { BackoffTracker } from './backoff';
import { QueuedTask } from './queue';
import { IndexedBinaryHeap } from "./heap";
import { IntrusiveList } from "./list";
import { SemaphoreMetrics } from './metrics';
import { buildComparator } from './ordering';
import { SemaphoreEvents } from './types';

import type { SemaphoreConfig, SemaphoreEventType, SemaphoreMetricsSnapshot } from './types';

export class Semaphore {

  // Sub-systems
  // The queue is indexed twice over the same tasks: `queue` (priority heap)
  // drives dispatch order; `enqueueOrder` (insertion-ordered linked list) gives
  // O(1) queue-age reads and an O(s) stale purge. Both are kept in lockstep —
  // every queued task is present in both, or neither (see _enqueue/_dequeue).
  private queue: IndexedBinaryHeap<QueuedTask>;
  private readonly enqueueOrder: IntrusiveList<QueuedTask>;
  private readonly permits:  PermitPool;
  private readonly circuit:  CircuitBreaker;
  private readonly backoff:  BackoffTracker;
  private readonly metricsCollector?: SemaphoreMetrics;

  // Config
  private readonly queueMaxLength:  number;
  private readonly queueMaxTimeout: number;
  private readonly queueMaxAge:     number;
  private readonly rejectOnFull:    boolean;
  private readonly purgeIntervalMs: number;
  private readonly metricsEnabled:  boolean;
  private readonly debug:           boolean;

  // State
  // Outstanding (un-called) release closures. Each closure carries its own
  // one-shot `released` flag plus the generation it was minted in; reset() bumps
  // the generation so stale closures from a prior lifecycle become no-ops. This
  // replaces a Set<symbol> — no Symbol, string, or Set mutation per acquire.
  private pendingReleaseCount = 0;
  private releaseGeneration   = 0;
  private scheduled        = false;
  private isShutdown       = false;
  private taskIdCounter    = 0;
  private totalAcquired    = 0;
  private totalReleased    = 0;
  private totalTimeouts    = 0;
  private eventListeners   = new Map<string, Set<(...args: any[]) => void>>();
  private drainPromise:    Promise<void> | null = null;
  private drainResolve:    (() => void) | null = null;
  private purgeIntervalId: ReturnType<typeof setInterval> | null = null;

constructor(count: number, config: SemaphoreConfig = {}) {

    // count > 0
    validateNumber(count, "Semaphore count", 0, Number.MAX_SAFE_INTEGER, true, false);
    // >= 500
    this.purgeIntervalMs = validateNumber(config.purgeIntervalMs ?? 3000, "Semaphore purgeIntervalMs", 500, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.queueMaxTimeout = validateNumber(config.queueMaxTimeout ?? 10000, "Semaphore queueMaxTimeout", 1, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.queueMaxLength = validateNumber(config.queueMaxLength ?? 1024, "Semaphore queueMaxLength", 1, Number.MAX_SAFE_INTEGER, true, true);
    // > 0
    this.queueMaxAge = validateNumber(config.queueMaxAge ?? 30000, "Semaphore queueMaxAge", 1, Number.MAX_SAFE_INTEGER, true, true);

    // Assign Booleans / Feature Flags
    this.rejectOnFull    = config.rejectOnFull    ?? false;
    this.metricsEnabled  = config.metricsEnabled  ?? true;
    this.debug           = config.debug           ?? false;

    // Initialize Sub-systems
    // Ascending priority; ties broken per the configured ordering
    // ('fifoWithPriority' by default) or a custom comparator. Probe tasks are forced to the head by the
    // wrapper so the half-open scheduler can always find them. The id tie-break
    // in the built-in orderings keeps the binary heap stable; without it later
    // callers could jump ahead, violating head-of-line fairness.
    const comparator = buildComparator<QueuedTask>({ queueOrder: config.queueOrder, comparator: config.comparator });
    this.queue        = new IndexedBinaryHeap<QueuedTask>(comparator);
    this.enqueueOrder = new IntrusiveList<QueuedTask>();
    this.permits      = new PermitPool(count);
    // Validation performed in CircuitBreaker
    this.circuit  = new CircuitBreaker({
      threshold:     config.circuitBreakerThreshold,
      window:        config.circuitBreakerWindow,
      cooldown:      config.circuitBreakerCooldown,
      minThroughput: config.circuitBreakerMinThroughput,
      minFailures:   config.circuitBreakerMinFailures,
    });
    // Validation performed in BackoffTracker
    this.backoff  = new BackoffTracker({
      initialTimeout: config.backoffInitialTimeout,
      maxTimeout:     config.backoffMaxTimeout,
      decayFactor:    config.backoffDecayFactor,
    });

    this.metricsCollector = this.metricsEnabled ? new SemaphoreMetrics() : undefined;
    this.metricsCollector?.markCapacityChange(this.permits.capacity);
    this.metricsCollector?.sampleGauges(Date.now(), this.permits.inFlight, this.queue.size);

    // Start
    this._startPurgeInterval();
  }

  /*
  Event Emitter
  */

  public on(event: SemaphoreEventType, listener: (...args: any[]) => void): void {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
    this.eventListeners.get(event)!.add(listener);
  }

  public off(event: SemaphoreEventType, listener: (...args: any[]) => void): void {
    this.eventListeners.get(event)?.delete(listener);
    if (this.eventListeners.get(event)?.size === 0) this.eventListeners.delete(event);
  }

  public removeAllListeners(event?: SemaphoreEventType): void {
    if (event) this.eventListeners.delete(event);
    else this.eventListeners.clear();
  }

  // Cheap guard so hot-path callers can skip building an event payload object
  // when nobody is listening (the common case under load).
  private hasListeners(event: SemaphoreEventType): boolean {
    const listeners = this.eventListeners.get(event);
    return listeners !== undefined && listeners.size > 0;
  }

  private emit(event: SemaphoreEventType, ...args: any[]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners || listeners.size === 0) return;
    for (const listener of Array.from(listeners)) {
      try { listener(...args); }
      catch (err) { if (this.debug) console.warn(`[Semaphore] Error in listener for "${event}":`, err); }
    }
  }

  // Fast-path Acquire
  private _tryAcquireFast(weight: number): (() => void) | null {
    if (this.circuit.isHalfOpen) {
      if (this.circuit.hasProbeInFlight || !this.permits.hasCapacityFor(weight)) return null;
      this.circuit.markProbeInFlight();
      this.permits.acquire(weight);
      this.totalAcquired++;
      this.metricsCollector?.onAcquireFast(Date.now(), this.permits.inFlight, this.queue.size);
      if (this.hasListeners(SemaphoreEvents.TASKACQUIRE)) {
        this.emit(SemaphoreEvents.TASKACQUIRE, { queued: this.queue.size, running: this.permits.capacity - this.permits.available, probe: true });
      }
      return this._createRelease(true, weight);
    }

    // Head-of-line fairness: never grant the fast path while tasks are queued.
    // A free permit can coexist with a non-empty queue only because the queued
    // head is heavier than the current availability and was held back by the
    // scheduler's head-of-line guard. Taking that permit here would let this
    // caller jump ahead of an already-waiting (possibly higher-priority or
    // heavier) task. Refuse the fast path and let the caller enqueue so the
    // scheduler dispatches everyone in priority order.
    if (this.queue.size > 0) return null;

    if (!this.permits.hasCapacityFor(weight)) return null;

    this.permits.acquire(weight);
    this.totalAcquired++;
    this.metricsCollector?.onAcquireFast(Date.now(), this.permits.inFlight, this.queue.size);
    if (this.hasListeners(SemaphoreEvents.TASKACQUIRE)) {
      this.emit(SemaphoreEvents.TASKACQUIRE, { queued: this.queue.size, running: this.permits.capacity - this.permits.available });
    }
    return this._createRelease(false, weight);
  }

  // Double-release safety without a per-acquire Symbol/Set: the closure owns a
  // one-shot `released` flag, and `generation` guards against a release that
  // outlived a reset() (which bumps releaseGeneration). Releases exactly the
  // `weight` permits the matching acquire consumed.
  private _createRelease(isProbe = false, weight = 1): () => void {
    this.pendingReleaseCount++;
    const generation = this.releaseGeneration;
    let released = false;

    return () => {
      if (released || generation !== this.releaseGeneration) {
        if (this.debug) console.warn('[Semaphore] release() called after already released (no-op)');
        return;
      }
      released = true;
      this.pendingReleaseCount--;
      this.permits.release(weight);
      this.totalReleased++;
      this.metricsCollector?.onRelease(Date.now(), this.permits.inFlight, this.queue.size);

      if (isProbe && this.circuit.isHalfOpen) {
        this.circuit.handleProbeSuccess();
        this.emit(SemaphoreEvents.CIRCUITCLOSE);
        this.metricsCollector?.markCircuitClose();
        if (this.debug) console.info('[Semaphore] Circuit closed after successful probe');
      }

      this.permits.assertInvariant(this.debug);
      if (this.hasListeners(SemaphoreEvents.TASKRELEASE)) {
        this.emit(SemaphoreEvents.TASKRELEASE, { queued: this.queue.size, running: this.permits.capacity - this.permits.available });
      }
      this.schedule();
    };
  }

  /*
  Queue mutation — keeps the priority heap and the enqueue-ordered list in sync.
  Every queued task lives in both structures or neither, so these are the only
  two methods that add to / remove from the queue (the scheduler's pop() is the
  one exception: it pops the heap head directly, then drops the same id here).
  */

  private _enqueue(task: QueuedTask): void {
    this.queue.insert(task);
    this.enqueueOrder.pushTail(task);
  }

  // Remove from the heap first; only unlink from the intrusive list on a
  // confirmed hit. heap.delete returns undefined when the id is absent, so this
  // is idempotent and never double-unlinks a task (which would corrupt the
  // list's head/tail). Heap and list stay in lockstep, so heap-has <=> list-has.
  private _dequeue(task: QueuedTask): void {
    if (this.queue.delete(task.id) !== undefined) this.enqueueOrder.remove(task);
  }

  /*
  Task Terminal Handlers
  */

  private _onTaskTimeout(task: QueuedTask, reject: (err: Error) => void): void {
    this._dequeue(task);
    this.totalTimeouts++;
    this.circuit.recordTimeout();
    this.backoff.onTimeout();

    if (task.isProbe) {
      this.circuit.handleProbeFailure();
      this.emit(SemaphoreEvents.CIRCUITOPEN, { timeoutRate: 1, recentTimeouts: 1, total: 1, reason: 'half-open-probe-failed' });
      this.metricsCollector?.markCircuitOpen();
      if (this.debug) console.warn('[Semaphore] Circuit re-opened: half-open probe timed out');
    } else {
      const result = this.circuit.evaluateAndTrip();
      if (result.tripped) {
        this.emit(SemaphoreEvents.CIRCUITOPEN, { timeoutRate: result.timeoutRate, recentTimeouts: result.failures, total: result.attempts });
        this.metricsCollector?.markCircuitOpen();
        if (this.debug) console.warn(`[Semaphore] Circuit opened. Rate: ${(result.timeoutRate * 100).toFixed(1)}%`);
      }
    }

    this.metricsCollector?.onTimeout(Date.now(), this.queue.size);
    this.emit(SemaphoreEvents.TASKTIMEOUT, { queueLength: this.queue.size, backoffDelay: this.backoff.currentDelay, taskId: task.id });
    if (this.debug) console.warn(`[Semaphore] Task #${task.id} timed out after ${this.queueMaxTimeout}ms`);
    reject(new SemaphoreError(`Semaphore acquire timed out after ${this.queueMaxTimeout}ms (queue: ${this.queue.size})`, 'TIMEOUT'));
    this.schedule();
  }

  private _onTaskAbort(task: QueuedTask, reject: (err: Error) => void): void {
    this._dequeue(task);
    if (task.isProbe) this.circuit.releaseProbeSlot();
    this.metricsCollector?.onAbort(Date.now(), this.queue.size);
    this.emit(SemaphoreEvents.TASKABORT);
    if (this.debug) console.info(`[Semaphore] Task #${task.id} aborted`);
    reject(new SemaphoreError('Semaphore acquire aborted', 'ABORTED'));
    this.schedule();
  }

  /*
  Scheduler
  */

  // The scheduler wakes on a microtask normally. When backoff is active
  // (sustained timeouts), the wakeup is deferred by the current backoff delay so
  // the dispatch rate slows while the downstream recovers. The `scheduled` flag
  // coalesces concurrent calls regardless of which path armed the wakeup. The
  // timer is unref'd: queued tasks keep their own (ref'd) watchdog timers alive,
  // so an unref'd scheduler tick never holds the process open on its own.
  private schedule(): void {
    if (this.scheduled || this.isShutdown) return;
    this.scheduled = true;
    const delay = this.backoff.currentDelay;
    if (delay > 0) {
      const t = setTimeout(() => { this._runScheduler(); }, delay);
      (t as any).unref?.();
    } else {
      queueMicrotask(() => { this._runScheduler(); });
    }
  }

  private _runScheduler(): void {
    if (this.isShutdown) return;
    this.scheduled = false;

    try {
      // Drain everything dispatchable. The loop only stops when there is nothing
      // left to do (queue empty), the head cannot fit (waits for a release), or
      // the circuit blocks dispatch. None of those clear on a microtask, so the
      // scheduler is re-armed by the events that do change them — release(),
      // enqueue, probe close, or a task watchdog — never by self-rescheduling
      // (which would busy-loop and starve the event loop while blocked).
      while (this.queue.size > 0) {
        if (this.circuit.isOpen) break;

        const next = this.queue.peek();
        if (!next) break;

        // In half-open only the designated probe task may dispatch.
        if (this.circuit.isHalfOpen && next.id !== this.circuit.probeTaskId) break;

        // Head-of-line: if the highest-priority task cannot fit, lower-priority
        // tasks must not jump ahead of it (prevents starvation inversion).
        if (!this.permits.hasCapacityFor(next.weight)) break;

        const task = this.queue.pop()!;
        this.enqueueOrder.remove(task);
        const now = Date.now();
        const waitMs = Math.max(0, now - task.enqueueTime);
        this.permits.acquire(task.weight);
        this.totalAcquired++;
        this.metricsCollector?.onAcquireQueued(now, waitMs, this.permits.inFlight, this.queue.size);
        this.permits.assertInvariant(this.debug);
        const dispatched = task.dispatch(() => this._createRelease(task.isProbe, task.weight));
        if (dispatched && this.hasListeners(SemaphoreEvents.TASKACQUIRE)) {
          this.emit(SemaphoreEvents.TASKACQUIRE, {
            queued: this.queue.size,
            running: this.permits.capacity - this.permits.available,
            ...(task.isProbe ? { probe: true } : {}),
          });
        }
      }

      if (this.queue.size === 0 && this.permits.available === this.permits.capacity && this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
        this.drainPromise = null;
      }
    } catch (err: unknown) {
      if (err instanceof Error) { console.error('[Semaphore] Scheduler error:', err.message, err.stack); }
      else { console.error('[Semaphore] Scheduler error:', err); }
    }
  }

  /*
  Task Purging
  */

  private _startPurgeInterval(): void {
    if (this.purgeIntervalId !== null) clearInterval(this.purgeIntervalId);
    this.purgeIntervalId = setInterval(() => {
      if (!this.isShutdown) this._purgeStaleTasks();
    }, this.purgeIntervalMs);
    (this.purgeIntervalId as any).unref?.();
  }

  private _purgeStaleTasks(): void {
    const now = Date.now();
    const before = this.queue.size;

    // enqueueOrder is strictly enqueue-ordered head -> tail, so ages are
    // monotonically non-increasing along it: the head is the oldest task. Walk
    // from the head and stop at the first task still young enough to keep —
    // nothing behind it can be older. This touches only the tasks actually
    // purged (O(s)) instead of scanning the whole queue every tick (O(N)).
    let head = this.enqueueOrder.peekHead();
    while (head !== undefined && now - head.enqueueTime > this.queueMaxAge) {
      if (this.circuit.probeTaskId === head.id) this.circuit.releaseProbeSlot();
      const discarded = head.discard(new SemaphoreError(`Task purged after ${this.queueMaxAge}ms`, 'PURGED'));
      // `head` is a confirmed list member (just peeked), so unlink it directly:
      // every iteration removes the current head, which guarantees the loop
      // advances (and terminates) without relying on the heap/list lockstep.
      this.queue.delete(head.id);
      this.enqueueOrder.remove(head);
      if (discarded) {
        this.totalTimeouts++;
        this.metricsCollector?.onTimeout(Date.now(), this.queue.size);
        this.emit(SemaphoreEvents.QUEUEPURGE, head);
        if (this.debug) console.warn(`[Semaphore] Purged stale task #${head.id}`);
      }
      head = this.enqueueOrder.peekHead();
    }

    if (this.debug && this.queue.size < before) {
      console.info(`[Semaphore] Purged ${before - this.queue.size} stale tasks`);
    }

    if (this.queue.size < before) this.schedule();
  }

  /*
  Public API
  */

  /**
   * Non-blocking acquire. Returns a release closure or null.
   * @param weight Permits to consume (integer in 1..count). Invalid weights return null.
   */
  public tryAcquire(weight = 1): (() => void) | null {
    if (this.isShutdown) return null;
    if (!Number.isInteger(weight) || weight < 1 || weight > this.permits.capacity) return null;
    if (this.circuit.checkAndTransition()) {
      this.emit(SemaphoreEvents.CIRCUITHALFOPEN);
      this.metricsCollector?.markCircuitHalfOpen();
      if (this.debug) console.info('[Semaphore] Circuit entering half-open');
      this.schedule();
    }
    if (this.circuit.isOpen) return null;
    this.circuit.trackAttempt();
    return this._tryAcquireFast(weight);
  }

  /**
   * Acquire a permit. Queues if no slot is immediately available.
   *
   * Rejects with SemaphoreError on: SHUTDOWN, INVALID_WEIGHT, INVALID_PRIORITY,
   * CIRCUIT_OPEN, CIRCUIT_HALF_OPEN, ABORTED, QUEUE_FULL, TIMEOUT, PURGED.
   * @param priority Dispatch priority (any finite number; lower dispatches first). Defaults to 0.
   * @param weight Permits to consume (integer in 1..count). Defaults to 1.
   */
  public acquire(abortSignal?: AbortSignal, priority = 0, weight = 1): Promise<() => void> {
    if (this.isShutdown) return Promise.reject(new SemaphoreError('Semaphore is shut down', 'SHUTDOWN'));
    if (!Number.isInteger(weight) || weight < 1 || weight > this.permits.capacity) {
      return Promise.reject(new SemaphoreError(`Invalid weight: ${weight} (must be integer in 1..${this.permits.capacity})`, 'INVALID_WEIGHT'));
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return Promise.reject(new SemaphoreError(`Invalid priority: ${priority} (must be a finite number)`, 'INVALID_PRIORITY'));
    }

    if (this.circuit.checkAndTransition()) {
      this.emit(SemaphoreEvents.CIRCUITHALFOPEN);
      this.metricsCollector?.markCircuitHalfOpen();
      if (this.debug) console.info('[Semaphore] Circuit entering half-open');
      this.schedule();
    }

    if (this.circuit.isOpen) {
      return Promise.reject(new SemaphoreError(`Circuit breaker open, retry in ${this.circuit.cooldownRemaining}ms`, 'CIRCUIT_OPEN'));
    }

    if (this.circuit.isHalfOpen && this.circuit.hasProbeInFlight) {
      return Promise.reject(new SemaphoreError('Circuit breaker half-open, probe in flight', 'CIRCUIT_HALF_OPEN'));
    }

    if (abortSignal?.aborted) {
      return Promise.reject(new SemaphoreError('Semaphore acquire aborted before start', 'ABORTED'));
    }

    this.circuit.trackAttempt();

    const release = this._tryAcquireFast(weight);
    if (release) return Promise.resolve(release);

    const isHalfOpenProbe = this.circuit.isHalfOpen && !this.circuit.hasProbeInFlight;

    if (!isHalfOpenProbe && this.rejectOnFull) {
      return Promise.reject(new SemaphoreError('Semaphore at capacity (rejectOnFull)', 'QUEUE_FULL'));
    }
    if (!isHalfOpenProbe && this.queue.size >= this.queueMaxLength) {
      return Promise.reject(new SemaphoreError(`Queue full (${this.queueMaxLength})`, 'QUEUE_FULL'));
    }

    return new Promise<() => void>((resolve, reject) => {
      const taskId = ++this.taskIdCounter;
      const enqueueTime = Date.now();
      const isProbe = isHalfOpenProbe;

      const task = new QueuedTask({ id: taskId, priority: isProbe ? Number.MIN_SAFE_INTEGER : priority, enqueueTime, isProbe, resolve, reject, abortSignal, weight });
      task.arm(this.queueMaxTimeout, () => this._onTaskTimeout(task, reject), () => this._onTaskAbort(task, reject));

      if (isProbe) this.circuit.claimProbeSlot(taskId);

      this.metricsCollector?.sampleQueueDepthAt(Date.now(), this.queue.size + 1);
      this._enqueue(task);
      this.schedule();
    });
  }

  /**
   * Preferred entry point. Acquires a permit, runs fn(), then releases.
   * The permit is always released even if fn() throws.
   * @param weight Permits to consume (integer in 1..count). Defaults to 1.
   */
  public async use<T>(fn: () => Promise<T>, abortSignal?: AbortSignal, priority = 0, weight = 1): Promise<T> {
    const release = await this.acquire(abortSignal, priority, weight);
    try { return await fn(); }
    finally { release(); }
  }

  /**
   * Resolves once the queue is empty and all permits have been returned.
   * Multiple callers receive the same promise.
   * @param timeoutMs Optional deadline (positive integer ms). Rejects with TIMEOUT if not idle in time. Throws if invalid.
   */
  public drain(timeoutMs?: number): Promise<void> {
    if (this.isShutdown) return Promise.reject(new SemaphoreError('Cannot drain: semaphore is shut down', 'SHUTDOWN'));
    if (timeoutMs !== undefined) validateNumber(timeoutMs, "drain timeoutMs", 1, Number.MAX_SAFE_INTEGER, true, true);
    if (this.drainPromise) return this.drainPromise;
    if (this.queue.size === 0 && this.permits.available === this.permits.capacity) return Promise.resolve();

    this.drainPromise = new Promise<void>((resolve, reject) => {
      this.drainResolve = resolve;

      if (timeoutMs !== undefined) {
        // The deadline timer is kept ref'd so it reliably fires even if the
        // process is otherwise idle. Whichever side wins cleans up after itself:
        // a normal resolution (below) clears the timer; the timer (here) tears
        // down the drain state so a later drain() starts fresh.
        const t = setTimeout(() => {
          this.drainResolve = null;
          this.drainPromise = null;
          reject(new SemaphoreError(`drain() timed out after ${timeoutMs}ms`, 'TIMEOUT'));
        }, timeoutMs);
        const orig = this.drainResolve;
        this.drainResolve = () => { clearTimeout(t); orig(); };
      }
    });

    return this.drainPromise;
  }

  /**
   * Rejects all queued tasks and restores the semaphore to its initial state.
   * Event listeners are preserved unless { clearListeners: true } is passed.
   */
  public reset(options: { clearListeners?: boolean } = {}): void {
    for (const task of this.queue.toArray()) task.discard(new SemaphoreError('Semaphore reset', 'SHUTDOWN'));
    this.queue.clear();
    this.enqueueOrder.clear();
    this.metricsCollector?.reset();
    this.permits.reset();
    this.backoff.reset();
    this.circuit.reset();
    // Invalidate any release closure minted before this reset, and clear the
    // outstanding count.
    this.releaseGeneration++;
    this.pendingReleaseCount = 0;
    this.scheduled = false;
    this.isShutdown = false;
    this.taskIdCounter = 0;
    this.totalAcquired = 0;
    this.totalReleased = 0;
    this.totalTimeouts = 0;

    if (options.clearListeners) this.eventListeners.clear();

    if (this.drainResolve) { this.drainResolve(); this.drainResolve = null; this.drainPromise = null; }

    this._startPurgeInterval();
    this.metricsCollector?.markCapacityChange(this.permits.capacity);
    this.metricsCollector?.sampleGauges(Date.now(), this.permits.inFlight, this.queue.size);
    if (this.debug) console.info('[Semaphore] Reset to initial state');
  }

  /**
   * Permanently stops the semaphore. All queued tasks are rejected.
   * Unlike reset(), this cannot be reversed.
   */
  public shutdown(reason = 'Semaphore shutdown'): void {
    if (this.isShutdown) return;
    this.isShutdown = true;
    if (this.debug) console.info(`[Semaphore] Shutdown: ${reason}`);
    if (this.purgeIntervalId !== null) { clearInterval(this.purgeIntervalId); this.purgeIntervalId = null; }
    for (const task of this.queue.toArray()) task.discard(new SemaphoreError(reason, 'SHUTDOWN'));
    this.queue.clear();
    this.enqueueOrder.clear();
    this.metricsCollector?.destroy();
    if (this.drainResolve) { this.drainResolve(); this.drainResolve = null; this.drainPromise = null; }
    this.emit(SemaphoreEvents.SHUTDOWN, reason);
  }

  /**
   * Reject all currently queued tasks with CANCELLED. In-flight permits
   * are unaffected and the semaphore remains fully operational.
   */
  public cancel(): void {
    if (this.isShutdown) return;
    const tasks = this.queue.toArray();
    for (const task of tasks) {
      if (task.isProbe) this.circuit.releaseProbeSlot();
      task.discard(new SemaphoreError('Semaphore acquire cancelled', 'CANCELLED'));
      this._dequeue(task);
    }
    this.metricsCollector?.sampleQueueDepthAt(Date.now(), this.queue.size);
    if (this.debug) console.info(`[Semaphore] Cancelled ${tasks.length} queued tasks`);
    // Re-arm the scheduler so a pending drain() resolves: emptying the queue may
    // have left the semaphore idle, but the scheduler can be parked (circuit
    // open, or half-open with a non-probe head) with no other event coming to
    // run the drain check. _runScheduler runs that check after its dispatch loop
    // regardless of circuit state.
    this.schedule();
  }

  /*
  Accessors
  */

  /** Returns a snapshot of current operating state, lifetime counters, and windowed metrics. */
  public status() {
    const windowStats = this.metricsCollector?.getSnapshot() ?? null;
    const oneMin = windowStats?.windows?.['1m']?.counts;
    const acquired1m = oneMin?.acquired ?? 0;
    const timeout1m  = oneMin?.timeouts ?? 0;
    // O(1): the enqueue-ordered list's head is always the oldest queued task.
    const oldest = this.enqueueOrder.peekHead();
    const queueAge = oldest === undefined ? 0 : Math.max(0, Date.now() - oldest.enqueueTime);
    return {
      status: {
        running:          this.permits.capacity - this.permits.available,
        queued:           this.queue.size,
        available:        this.permits.available,
        inFlight:         this.permits.inFlight,
        /** Number of release closures currently outstanding. Non-zero means permits are held. */
        pendingReleases:  this.pendingReleaseCount,
        circuitOpen:      this.circuit.isOpen,
        circuitHalfOpen:  this.circuit.isHalfOpen,
        backoffDelay:     Math.round(this.backoff.currentDelay),
        requestsPerSecond: +((acquired1m / 60).toFixed(2)),
        timeoutRate1m: (acquired1m + timeout1m) > 0
          ? +((timeout1m / (acquired1m + timeout1m)) * 100).toFixed(1)
          : 0,
        /** Age in ms of the oldest queued task. O(1). */
        queueAge,
      },
      lifetime: {
        totalAcquired:  this.totalAcquired,
        totalReleased:  this.totalReleased,
        totalTimeouts:  this.totalTimeouts,
        circuitBreakerCooldownRemaining: this.circuit.cooldownRemaining,
      },
      metrics: windowStats as SemaphoreMetricsSnapshot | null,
    };
  }

  /** True if the semaphore is not shut down, circuit is not open, and a permit is available. */
  public isAvailable(): boolean {
    return !this.isShutdown && !this.circuit.isOpen && !this.permits.isFull;
  }

  public get queueLength(): number    { return this.queue.size; }
  public get availablePermits(): number { return this.permits.available; }
}
