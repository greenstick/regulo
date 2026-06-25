/*
Semaphore
*/

export interface SemaphoreConfig {
  /** Maximum number of tasks that may wait in the queue. Must be a positive integer; pass a large value such as `Number.MAX_SAFE_INTEGER` for an effectively unbounded queue. Default: Number.MAX_SAFE_INTEGER */
  queueMaxLength?: number;
  /** Milliseconds a queued task waits before rejecting with TIMEOUT. Default: 10000 */
  queueMaxTimeout?: number;
  /** Milliseconds before the purge interval ejects a task regardless of its own timeout. Default: 30000 */
  queueMaxAge?: number;
  /** Initial backoff delay on the first timeout in a burst (telemetry only). Default: 50 */
  backoffInitialTimeout?: number;
  /** Maximum backoff delay (telemetry only). Default: 2000 */
  backoffMaxTimeout?: number;
  /** Backoff decay factor per idle second, in (0,1). Default: 0.5 */
  backoffDecayFactor?: number;
  /** Failure-rate threshold in (0,1) that trips the circuit breaker. Default: 0.5 */
  circuitBreakerThreshold?: number;
  /** Sliding window size in ms for circuit breaker failure rate. Min: 1000. Default: 10000 */
  circuitBreakerWindow?: number;
  /** Milliseconds the circuit stays open before allowing a probe. Min: 1000. Default: 5000 */
  circuitBreakerCooldown?: number;
  /** Minimum requests in the window before the circuit can trip. Default: 10 */
  circuitBreakerMinThroughput?: number;
  /** Minimum failures in the window before the circuit can trip. Default: 5 */
  circuitBreakerMinFailures?: number;
  /** Reject immediately when all permits are held (no queuing). Default: false */
  rejectOnFull?: boolean;
  /** Milliseconds between stale-task purge sweeps. Min: 500. Default: 3000 */
  purgeIntervalMs?: number;
  /** Enable windowed metrics collection. Default: true */
  metricsEnabled?: boolean;
  /** Enable debug logging (console output and the PermitPool invariant check). Does not affect which events are emitted — all events fire regardless. Default: false */
  debug?: boolean;
  /**
   * Dispatch ordering for queued tasks. Ignored when `comparator` is provided.
   * - 'fifo' (default): priority primary, earliest-enqueued first on ties.
   * - 'lifo': priority primary, latest-enqueued first on ties.
   * - 'fifoIgnorePriority': earliest-enqueued first, priority ignored.
   * - 'lifoIgnorePriority': latest-enqueued first, priority ignored.
   * Default: 'fifo'
   */
  queueOrder?: QueueOrder;
  /**
   * Custom comparator over queued tasks; the value that sorts lower is
   * dispatched first. Overrides `queueOrder`. Probe tasks (circuit-breaker
   * half-open) are always sorted ahead of everything else regardless of this
   * comparator, so it never needs to account for them.
   */
  comparator?: Comparator<QueuedTaskView>;
}

/**
 * Dispatch ordering presets. The `*IgnorePriority` variants drop the priority
 * key entirely and order purely by enqueue time.
 */
export type QueueOrder = 'fifo' | 'lifo' | 'fifoIgnorePriority' | 'lifoIgnorePriority';

/**
 * Read-only view of a queued task exposed to custom comparators. `id` is a
 * monotonic counter assigned at enqueue time (smaller = enqueued earlier), so
 * `a.id - b.id` yields FIFO and `b.id - a.id` yields LIFO.
 */
export interface QueuedTaskView {
  readonly id: number;
  readonly priority: number;
  readonly enqueueTime: number;
  readonly weight: number;
}

/*
Circuit Breaker
*/

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  readonly threshold?: number;
  readonly window?: number;
  readonly cooldown?: number;
  readonly minThroughput?: number;
  readonly minFailures?: number;
}

export type CircuitTripResult =
  | { tripped: true; timeoutRate: number; failures: number; attempts: number }
  | { tripped: false };

/*
Backoff
*/

export interface BackoffConfig {
  readonly initialTimeout?: number;
  readonly maxTimeout?: number;
  readonly decayFactor?: number;
}

/*
Events
*/

export const SemaphoreEvents = {
  TASKACQUIRE:     'task-acquire',
  TASKRELEASE:     'task-release',
  TASKTIMEOUT:     'task-timeout',
  TASKABORT:       'task-abort',
  QUEUEPURGE:      'queue-purge',
  CIRCUITOPEN:     'circuit-open',
  CIRCUITHALFOPEN: 'circuit-half-open',
  CIRCUITCLOSE:    'circuit-close',
  SHUTDOWN:        'shutdown',
} as const;

export type SemaphoreEventType = typeof SemaphoreEvents[keyof typeof SemaphoreEvents];

/*
Errors
*/

export type SemaphoreErrorCode =
  | 'CIRCUIT_OPEN'
  | 'CIRCUIT_HALF_OPEN'
  | 'INVALID_WEIGHT'
  | 'INVALID_PRIORITY'
  | 'QUEUE_FULL'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'CANCELLED'
  | 'SHUTDOWN'
  | 'PURGED';

/*
Metrics
*/

export interface EventWindowSnapshot {
  acquired: number;
  released: number;
  timeouts: number;
}

export interface SummaryWindowSnapshot {
  avg: number;
  max: number;
  samples: number;
}

export interface AverageWindowSnapshot {
  avg: number;
  count: number;
  total: number;
}

export interface SemaphoreMetricsWindowSnapshot {
  counts:   EventWindowSnapshot;
  inflight: SummaryWindowSnapshot;
  queue:    SummaryWindowSnapshot;
  latency:  AverageWindowSnapshot;
}

export interface SemaphoreMetricsSnapshot {
  windows: Record<string, SemaphoreMetricsWindowSnapshot>;
  meta: {
    inFlightLastMinute:   number;
    queueDepthLastMinute: number;
    totalAcquiredFast:    number;
    totalAcquiredQueued:  number;
    totalReleased:        number;
    totalTimeouts:        number;
    totalAborts:          number;
    capacity:             number;
    circuitOpen:          boolean;
    circuitHalfOpen:      boolean;
  };
}

/*
Data Structures
*/

export type ID = string | number;
export type Comparator<T> = (a: T, b: T) => number;

export interface WindowOptions {
  size: number;
  stepMs: number;
}
