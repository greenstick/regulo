# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.2.0] - 2026-07-02

### Added

- **`peekQueue()` method:** Provides a read-only snapshot array of the current queue state in strict enqueue order (`QueuedTaskView[]`).
- **`capacity` and `circuitState` getters:** Publicly exposes the total configured permit capacity and the active state of the circuit breaker (`'closed' | 'open' | 'half-open'`) directly on the `Semaphore` instance.
- **Customizable circuit breaker window buckets:** Added the `circuitBreakerWindowBucketWidth` configuration property to tune the granularity/resolution of the circuit breaker's sliding failure window.
- **Customizable metrics windows:** Added the `metricsWindows` configuration option to override the built-in time windows (1m/5m/15m/1h/24h) with bespoke tracking horizons. Exported the underlying `WindowOptions` type from the package root.

### Changed

- **Immediate queue eviction on circuit trip:** When a timeout causes the circuit breaker to trip open, all other non-probe queued tasks are instantly evicted and rejected with a `CIRCUIT_OPEN` error code, preventing them from waiting out their individual lifetimes and surfacing misleading `TIMEOUT` rejections.
- **Narrowed `QUEUEPURGE` payload:** The `QUEUEPURGE` event now cleanly emits the narrow `QueuedTaskView` shape instead of leaking the raw internal `QueuedTask` instance and its mutative structural links.
- **Unconditional listener exception logging:** Errors thrown inside attached event listeners are now always surfaced via `console.warn` instead of being silenced when `debug: false` is active.
- **Shared `drain()` promise semantics:** Clarified that concurrent, overlapping invocations of `drain()` return the identical in-flight promise. The `timeoutMs` parameter of the *first* caller governs the cycle; subsequent caller deadlines are bypassed.
- **Standardized internal validation errors:** Attempting to double-insert a node into the internal heap or initializing metrics with an empty array now properly throws a `SemaphoreError` with the `INVALID_ARGUMENT` code rather than a generic runtime `Error`.

[1.2.0]: https://github.com/greenstick/regulo/releases/tag/v1.2.0

## [v1.1.0] - 2026-06-28

### Added

- **Typed event payloads.** `on()` and `off()` are now generic over the event name, so a listener's argument is inferred from the event (no more `any`). Exposed via the new `SemaphoreEventMap` and `SemaphoreEventListener<E>` types, both exported from the package entry point. Emitted payloads are unchanged; this is purely a compile-time improvement.
- **`INVALID_ARGUMENT` error code** for argument and configuration validation, so these failures can be distinguished programmatically via `error.code` like every other rejection.

### Changed

- **Argument and configuration validation now throws `SemaphoreError`** (with code `INVALID_ARGUMENT`) instead of a plain `Error`. This covers the `Semaphore` constructor, the `CircuitBreaker`/`BackoffTracker` config checks, the `queueOrder`/`comparator` checks, and an invalid `drain()` timeout. Because `SemaphoreError extends Error`, existing `instanceof Error` and `toThrow()` handling is unaffected.
- **`reset()` now throws `SemaphoreError('SHUTDOWN')` when called on a shut-down instance** instead of silently reviving it. This makes `shutdown()` genuinely terminal, matching its documented "cannot be reversed" contract. If you previously relied on `reset()` to restart a shut-down semaphore, construct a new instance instead.

### Performance

- **`emit()` skips the defensive listener-array snapshot when a single listener is registered** (the common case), invoking it directly. Multi-listener emission still snapshots to stay safe against mid-emit mutation.

### Internal

- Added a `branches: 85` coverage threshold (alongside the existing `lines: 90`) so a branch-coverage regression is caught in CI.

### Documentation

- Corrected several broken in-page anchor links and heading typos, refreshed the events/error-code references for the typed events and `INVALID_ARGUMENT` code, and clarified the `reset()`/`shutdown()`/`drain()` semantics.
- Refreshed all benchmark tables with a new run (Node v22.16.0, darwin x64).

[1.1.0]: https://github.com/greenstick/regulo/releases/tag/v1.1.0

## [v1.0.5] - 2026-06-26

### Performance

- **The queue-wait timeout is now driven by a single shared deadline timer** instead of one `setTimeout`/`clearTimeout` per queued task. Because every task shares `queueMaxTimeout` and the enqueue-ordered index is sorted by deadline, the oldest task is always the next to expire, so one self-re-arming timer suffices. Timeout precision and circuit-breaker trip timing are unchanged; the removed per-task timer churn lifts contended throughput by roughly 15–19% and is what makes regulo viable for shorter-duration work (small DB pulls, cache fills) rather than only millisecond-scale operations.
- **The priority heap's index is now intrusive.** Each task stores its own heap slot (`heapIndex`) instead of the heap maintaining a separate `Map<id, index>`, so every sift writes a plain property instead of a hashed map entry. This lifts contended throughput by a further ~25–30% (deep queues benefit most); with metrics disabled, contended throughput now sits alongside `p-limit`/`p-queue`.

[1.0.5]: https://github.com/greenstick/regulo/releases/tag/v1.0.5

## [v1.0.4] - 2026-06-26

### Changed (BREAKING)

- **Renamed the queue-ordering presets** so priority is an explicit, named axis rather than an implicit default. `queueOrder` values are now: `'fifo'` / `'lifo'` (order purely by enqueue time, priority ignored) and `'fifoWithPriority'` / `'lifoWithPriority'` (priority primary, enqueue-time tie-break). Previously `'fifo'`/`'lifo'` were priority-primary and the priority-less variants were `'fifoIgnorePriority'`/`'lifoIgnorePriority'`. Migration: `'fifo'` → `'fifoWithPriority'`, `'lifo'` → `'lifoWithPriority'`, `'fifoIgnorePriority'` → `'fifo'`, `'lifoIgnorePriority'` → `'lifo'`.
- **Default `queueOrder` is now `'fifoWithPriority'`** (was `'fifo'`). Dispatch behavior with no `queueOrder` set is unchanged — priority is still honored by default — but the default's *name* changed.
- **`queueMaxLength` now defaults to `1024`** (was `Number.MAX_SAFE_INTEGER`, i.e. effectively unbounded). Once the queue is full, further `acquire()` calls reject with `QUEUE_FULL`. This adds a finite back-pressure guardrail by default; pass `queueMaxLength: Number.MAX_SAFE_INTEGER` to restore the previous unbounded behavior.

### Performance

- **`status()` is now O(1) in queue depth** (was O(N)). Queue age is read from a new enqueue-ordered index instead of cloning and scanning the queue, so `status()` is safe to call on a metrics scrape path even with deep queues. The `status()` snapshot benchmark is now flat across queue depths.
- **The stale-task purge sweep is now O(s)** in the number of tasks actually evicted per tick (was O(N) every tick), by walking the enqueue-ordered index from the head and stopping at the first task young enough to keep.

### Internal

- Added `IntrusiveList`, an insertion-ordered index kept alongside the priority heap (pointers stored on the task itself, so no per-task allocation or second map on the hot path), and removed the now-unnecessary `QueueAgeCache`.

### Documentation

- Added a "Choosing an ordering, and its implications" section explaining how ordering interacts with weighted permits and head-of-line dispatch.
- Documented that a single `Semaphore` is one failure domain (its circuit breaker and backoff are shared across all work routed through it), and that `weight`/`priority` should not be used to multiplex unrelated task types or downstreams through one instance.

[1.0.4]: https://github.com/greenstick/regulo/releases/tag/v1.0.4

## [v1.0.0] - 2026-06-25

First public release, published as `regulo`.

### Added

- Priority-queue semaphore with weighted permits and head-of-line-fair dispatch.
- Configurable queue ordering: `fifo` (default), `lifo`, `fifoIgnorePriority`, `lifoIgnorePriority`, or a custom `comparator`. Invalid comparator results (`NaN` / non-number) fall back to a stable `id` tie-break.
- Integrated saturation circuit breaker (closed → open → half-open → closed) with cooldown and single-probe recovery, exported standalone as `CircuitBreaker`.
- Adaptive, wall-clock-decaying backoff that throttles dispatch during timeout bursts and returns to zero on its own.
- Built-in windowed metrics (1m/5m/15m/1h/24h) for throughput, latency, queue depth, and in-flight count, plus lifetime counters, surfaced via `status()`.
- Lifecycle controls: `acquire`, `use`, `tryAcquire`, `drain`, `reset`, `cancel`, `shutdown`.
- Event stream: `task-acquire`, `task-release`, `task-timeout`, `task-abort`, `queue-purge`, `circuit-open`, `circuit-half-open`, `circuit-close`, `shutdown`. All events fire regardless of `debug`.
- `AbortSignal` support, stale-task purging, and double-release-safe release closures.
- Parameter validation for `count`, `weight`, `priority`, `drain` timeout, and all configuration options, with dedicated `INVALID_WEIGHT` and `INVALID_PRIORITY` error codes.
- Strict-mode TypeScript types; ESM + CJS builds; zero runtime dependencies.

[1.0.0]: https://github.com/greenstick/regulo/releases/tag/v1.0.0
