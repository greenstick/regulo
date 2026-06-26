# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.0.4] - 2026-06-26

### Changed (BREAKING)

- **Renamed the queue-ordering presets** so priority is an explicit, named axis
  rather than an implicit default. `queueOrder` values are now:
  `'fifo'` / `'lifo'` (order purely by enqueue time, priority ignored) and
  `'fifoWithPriority'` / `'lifoWithPriority'` (priority primary, enqueue-time
  tie-break). Previously `'fifo'`/`'lifo'` were priority-primary and the
  priority-less variants were `'fifoIgnorePriority'`/`'lifoIgnorePriority'`.
  Migration: `'fifo'` → `'fifoWithPriority'`, `'lifo'` → `'lifoWithPriority'`,
  `'fifoIgnorePriority'` → `'fifo'`, `'lifoIgnorePriority'` → `'lifo'`.
- **Default `queueOrder` is now `'fifoWithPriority'`** (was `'fifo'`). Dispatch
  behavior with no `queueOrder` set is unchanged — priority is still honored by
  default — but the default's *name* changed.
- **`queueMaxLength` now defaults to `1024`** (was `Number.MAX_SAFE_INTEGER`,
  i.e. effectively unbounded). Once the queue is full, further `acquire()` calls
  reject with `QUEUE_FULL`. This adds a finite back-pressure guardrail by
  default; pass `queueMaxLength: Number.MAX_SAFE_INTEGER` to restore the previous
  unbounded behavior.

### Performance

- **`status()` is now O(1) in queue depth** (was O(N)). Queue age is read from a
  new enqueue-ordered index instead of cloning and scanning the queue, so
  `status()` is safe to call on a metrics scrape path even with deep queues. The
  `status()` snapshot benchmark is now flat across queue depths.
- **The stale-task purge sweep is now O(s)** in the number of tasks actually
  evicted per tick (was O(N) every tick), by walking the enqueue-ordered index
  from the head and stopping at the first task young enough to keep.
- **The queue-wait timeout is now driven by a single shared deadline timer**
  instead of one `setTimeout`/`clearTimeout` per queued task. Because every task
  shares `queueMaxTimeout` and the enqueue-ordered index is sorted by deadline,
  the oldest task is always the next to expire, so one self-re-arming timer
  suffices. Timeout precision and circuit-breaker trip timing are unchanged; the
  removed per-task timer churn lifts contended throughput by roughly 15–19% and
  is what makes regulo viable for shorter-duration work (small DB pulls, cache
  fills) rather than only millisecond-scale operations.
- **The priority heap's index is now intrusive.** Each task stores its own heap
  slot (`heapIndex`) instead of the heap maintaining a separate `Map<id, index>`,
  so every sift writes a plain property instead of a hashed map entry. This lifts
  contended throughput by a further ~25–30% (deep queues benefit most); with
  metrics disabled, contended throughput now sits alongside `p-limit`/`p-queue`.

### Internal

- Added `IntrusiveList`, an insertion-ordered index kept alongside the priority
  heap (pointers stored on the task itself, so no per-task allocation or second
  map on the hot path), and removed the now-unnecessary `QueueAgeCache`.

### Documentation

- Added a "Choosing an ordering, and its implications" section explaining how
  ordering interacts with weighted permits and head-of-line dispatch.
- Documented that a single `Semaphore` is one failure domain (its circuit
  breaker and backoff are shared across all work routed through it), and that
  `weight`/`priority` should not be used to multiplex unrelated task types or
  downstreams through one instance.

[1.0.4]: https://github.com/greenstick/regulo/releases/tag/v1.0.4

## [v1.0.0] - 2026-06-25

First public release, published as `regulo`.

### Added

- Priority-queue semaphore with weighted permits and head-of-line-fair dispatch.
- Configurable queue ordering: `fifo` (default), `lifo`, `fifoIgnorePriority`,
  `lifoIgnorePriority`, or a custom `comparator`. Invalid comparator results
  (`NaN` / non-number) fall back to a stable `id` tie-break.
- Integrated saturation circuit breaker (closed → open → half-open → closed)
  with cooldown and single-probe recovery, exported standalone as `CircuitBreaker`.
- Adaptive, wall-clock-decaying backoff that throttles dispatch during timeout
  bursts and returns to zero on its own.
- Built-in windowed metrics (1m/5m/15m/1h/24h) for throughput, latency, queue
  depth, and in-flight count, plus lifetime counters, surfaced via `status()`.
- Lifecycle controls: `acquire`, `use`, `tryAcquire`, `drain`, `reset`,
  `cancel`, `shutdown`.
- Event stream: `task-acquire`, `task-release`, `task-timeout`, `task-abort`,
  `queue-purge`, `circuit-open`, `circuit-half-open`, `circuit-close`,
  `shutdown`. All events fire regardless of `debug`.
- `AbortSignal` support, stale-task purging, and double-release-safe release
  closures.
- Parameter validation for `count`, `weight`, `priority`, `drain` timeout, and
  all configuration options, with dedicated `INVALID_WEIGHT` and
  `INVALID_PRIORITY` error codes.
- Strict-mode TypeScript types; ESM + CJS builds; zero runtime dependencies.

[1.0.0]: https://github.com/greenstick/regulo/releases/tag/v1.0.0
