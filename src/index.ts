// Primary export — the semaphore itself
export { Semaphore } from './semaphore';

// Error class — needed for instanceof checks and error code inspection
export { SemaphoreError } from './error';

// Standalone circuit breaker — usable independently of the semaphore
export { CircuitBreaker } from './breaker';

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
  CircuitTripResult,
  Comparator,
  QueueOrder,
  QueuedTaskView,
} from './types';
