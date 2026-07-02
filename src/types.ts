/*
Semaphore
*/

export interface SemaphoreConfig {
  /** Maximum number of tasks that may wait in the queue. Once full, further acquires reject with `QUEUE_FULL`. Must be a positive integer; pass a large value such as `Number.MAX_SAFE_INTEGER` for an effectively unbounded queue. Default: 1024 */
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
  /** The time-width of the circuit window breaker. Denominator for calculating bucket count with: window / windowBucketWidth. Default: 1000 */
  circuitBreakerWindowBucketWidth?: number;
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
  /** Metric windows to use for collection. Default: undefined */
  metricsWindows?: WindowOptions[];
  /** Enable debug logging (console output and the PermitPool invariant check). Does not affect which events are emitted — all events fire regardless. Default: false */
  debug?: boolean;
  /**
   * Dispatch ordering for queued tasks. Ignored when `comparator` is provided.
   * Priority and arrival order are independent axes:
   * - 'fifo': earliest-enqueued first; priority ignored.
   * - 'lifo': latest-enqueued first; priority ignored.
   * - 'fifoWithPriority' (default): priority primary, earliest-enqueued first on ties.
   * - 'lifoWithPriority': priority primary, latest-enqueued first on ties.
   * Default: 'fifoWithPriority'
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
 * Dispatch ordering presets. `fifo`/`lifo` order purely by enqueue time; the
 * `*WithPriority` variants make priority the primary key and break ties by
 * enqueue time.
 */
export type QueueOrder = 'fifo' | 'lifo' | 'fifoWithPriority' | 'lifoWithPriority';

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
  readonly windowBucketWidth?: number;
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

/**
 * Maps each event to its listener argument tuple, so `on`/`off` give consumers
 * a precisely-typed payload instead of `any`. The tuple form (`[Payload]` or
 * `[]`) lets events carry zero or one argument while keeping the listener
 * signature exact.
 */
export interface SemaphoreEventMap {
  'task-acquire':     [payload: { queued: number; running: number; probe?: boolean }];
  'task-release':     [payload: { queued: number; running: number }];
  'task-timeout':     [payload: { queueLength: number; backoffDelay: number; taskId: number }];
  'task-abort':       [];
  'queue-purge':      [task: QueuedTaskView];
  'circuit-open':     [payload: { timeoutRate: number; recentTimeouts: number; total: number; reason?: string }];
  'circuit-half-open': [];
  'circuit-close':    [];
  'shutdown':         [reason: string];
}

/** Listener signature for a given event, derived from {@link SemaphoreEventMap}. */
export type SemaphoreEventListener<E extends SemaphoreEventType> = (...args: SemaphoreEventMap[E]) => void;

/*
Errors
*/

export type SemaphoreErrorCode =
  | 'CIRCUIT_OPEN'
  | 'CIRCUIT_HALF_OPEN'
  | 'INVALID_ARGUMENT'
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
