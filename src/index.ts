// Primary export — the semaphore itself
export { Semaphore } from './semaphore';

// Lazily-populated one-Semaphore-per-key registry
export { KeyedSemaphore } from './keyed';

// Error class — needed for instanceof checks and error code inspection
export { SemaphoreError } from './error';

// Circuit breakers — each composable into a Semaphore via the `circuitBreaker`
// config option, and usable standalone. (Renamed in 1.3.0: the former
// `CircuitBreaker` export is now `SaturationCircuitBreaker`.)
export { SaturationCircuitBreaker, NoopCircuitBreaker, ManualCircuitBreaker } from './breakers';

// Events const — use SemaphoreEvents.CIRCUITOPEN etc. in on() calls
export { SemaphoreEvents } from './types';

// Built-in queue orderings — usable for composing a custom comparator
export { QUEUE_ORDERINGS } from './ordering';

// Public types
export type {
  SemaphoreConfig,
  SemaphoreEventType,
  SemaphoreEventMap,
  SemaphoreEventListener,
  SemaphoreErrorCode,
  SemaphoreMetricsSnapshot,
  SemaphoreMetricsWindowSnapshot,
  CircuitBreakerConfig,
  CircuitBreakerStrategy,
  CircuitState,
  CircuitTripResult,
  Comparator,
  ID,
  OperationOutcome,
  PeekQueueOptions,
  QueueOrder,
  QueuedTaskView,
  WindowOptions,
} from './types';
