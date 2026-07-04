# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.3.5] - 2026-07-04

### Added

- **`totalPurged` lifetime counter** in `status().lifetime` and `getSnapshot().meta` — tasks ejected by the stale-task purge (`queueMaxAge` exceeded, rejected `PURGED`) now have their own counter.

### Changed

- **Purged tasks no longer count as timeouts.** Previously a purge incremented `totalTimeouts` and the windowed timeout counts (inflating `timeoutRate1m` and dashboard timeout rates) while *not* feeding the circuit breaker — an inconsistent middle ground. Purges are janitorial: they now count only in `totalPurged` (plus a queue-depth gauge sample) and stay out of both the timeout rate and the breaker. If you monitored purge volume through `totalTimeouts`, read `totalPurged` instead.
- **Breaker attempt tracking moved to the admission points.** `trackAttempt()` now fires exactly where admission happens — a granted fast-path acquire or a task enqueued — instead of at the top of `acquire()`. Two consequences: `tryAcquire()` grants now count toward the breaker's throughput (previously they never did, so a `tryAcquire()` + `reportFailure()` app could never trip the breaker — attempts stayed below `circuitBreakerMinThroughput` forever); and rejected admissions (`QUEUE_FULL`, `rejectOnFull`, a null `tryAcquire()`) no longer count, so shed load no longer dilutes the failure rate exactly when the system is overloaded. The `CircuitBreakerStrategy.trackAttempt()` contract note is updated to match.
- **`shutdown()` now invalidates outstanding release closures** (as `reset()` always has) and settles the permit pool. A `release()` arriving after shutdown is a safe no-op instead of mutating the dead pool, and post-shutdown `status()` reads as terminal (`pendingReleases: 0`, all permits available).

### Performance

- **The attempt-tracking fix has a measured cost on the raw `tryAcquire` fast path with the default breaker.** Counting an attempt buckets it by time, which costs one `Date.now()` per grant — a path that previously had zero clock reads when metrics are disabled. Interleaved A/B on the benchmark suite: `tryAcquire`+`release` (no metrics) ≈ **-40%** (~8.3M → ~5.0M ops/sec); this is the price of the breaker actually seeing `tryAcquire` traffic (previously it was blind to it — the bug fixed above). All other paths are at parity or better: with metrics enabled the clock read is shared with the metrics rollup, so `tryAcquire`+`release` is within noise of the previous release and the `use()` round-trip is ~10% *faster* (one `Date.now()` per admission instead of two). If you use the semaphore as a pure limiter, `NoopCircuitBreaker` skips attempt bucketing entirely and restores the clock-free fast path (~7.3M ops/sec, within ~12% of the previous release — the residual is the strategy call itself).
- `SaturationCircuitBreaker.trackAttempt(now?)` accepts an optional caller-supplied timestamp (and the `CircuitBreakerStrategy` contract documents it) so a caller that already read the clock for the same admission doesn't pay a second read. The fast-path grant no longer allocates a wrapper object.

### Fixed

- **Scheduler dispatch can no longer leak permits on a lost claim race.** Permits, counters, and metrics for a queued dispatch are now committed inside the dispatch callback, which runs only after the task wins its one-shot `claim()`. Previously permits were acquired before the claim check; the defensive `dispatch() === false` path (unreachable through the public API today, but guarded) would have leaked them permanently.
- **`use()` no longer infers probe-ness from circuit state after acquiring.** Whether an acquisition is the half-open probe is now reported by the acquisition itself. Previously `use()` read `circuit.isHalfOpen` on the continuation after `acquire()` resolved, which raced against transitions occurring in between — a mislabeled acquisition could re-open the circuit on an ordinary matching failure.
- Removed the dead `triggeringTask` exclusion from circuit-trip queue eviction (the watchdog dequeues the triggering task before eviction runs, so it could never match). The probe-skip guard is retained deliberately: it protects against an injected breaker that trips outside the closed state, where evicting the live probe would wedge the circuit in half-open.

## [v1.3.0] - 2026-07-02

### Added

- **Pluggable circuit breakers.** The breaker behind `Semaphore` is now a strategy. The new `CircuitBreakerStrategy` interface (exported) defines the exact contract the semaphore drives, and an instance can be injected via the new `circuitBreaker` config option — it overrides the `circuitBreaker*` numeric options, the same precedence `comparator` has over `queueOrder`. The built-ins live in a breakers module (`src/breakers/`):
  - `SaturationCircuitBreaker` — the existing default, behavior unchanged; a windowed failure-rate breaker whose meaning follows its signal (queue timeouts → saturation; reported errors → error rate).
  - `NoopCircuitBreaker` — never trips; the semaphore as a pure limiter.
  - `ManualCircuitBreaker` — an operator kill switch (`open()`/`close()`); no cooldown, no probe.
- **`Semaphore.reportFailure()`** — feeds an external failure signal (e.g. downstream 5xx errors) into the breaker, making the default breaker double as an error-rate breaker: the same window, threshold, cooldown, probe recovery, and queue eviction apply, and a trip emits `CIRCUITOPEN` with `reason: 'reported-failure'`. Reported failures influence trip decisions only while the circuit is closed; no-op after shutdown.
- **`circuitBreakerFailurePredicate` config option** — declarative fault scoring for `use()`. Rejections from your function for which the predicate returns `true` count as one breaker failure each (as via `reportFailure()`), and half-open probes become fault-aware: a probe dispatched through `use()` whose operation fails with a matching error re-opens the circuit (`CIRCUITOPEN` with `reason: 'half-open-probe-failed'`) instead of closing it on release; a non-matching rejection still counts as a successful probe. A predicate that throws is logged via `console.warn` and treated as non-matching. Only observes `use()` — bare `acquire()`/`tryAcquire()` callers use `reportFailure()`.
- Exported the `CircuitState` type from the package root.

### Changed (BREAKING)

- **Renamed the breaker's public names to match the breakers module.** The `CircuitBreaker` export is now `SaturationCircuitBreaker`, and its `recordTimeout()` method is now `recordFailure()` (the failure signal is caller-defined, not inherently a timeout). Both are straight renames with unchanged behavior; no compatibility aliases are kept. Migration: `import { CircuitBreaker } from 'regulo'` → `import { SaturationCircuitBreaker } from 'regulo'`; `breaker.recordTimeout()` → `breaker.recordFailure()`. Shipping this rename in a minor release is a deliberate project decision, documented here and in the README, in place of carrying aliases forward.

### Performance

- **Current-bucket caching in the metrics and breaker windows.** Hot-path bucket resolution is now two comparisons instead of a float division + modulo + timestamp check per event per window; the full computation runs only on step rollover. Measured on the benchmark suite: uncontended `tryAcquire`+`release` ≈ +80%, `use()` round-trip ≈ +65%, contended throughput ≈ +30–50%.
- **Pre-bound scheduler callback** — scheduler wakeups no longer allocate a fresh closure per `schedule()` on the contended path.

[1.3.0]: https://github.com/greenstick/regulo/releases/tag/v1.3.0

## [v1.2.0] - 2026-07-02

### Added

- **`peekQueue()` method:** Provides a read-only snapshot array of the current queue state in strict enqueue order (`QueuedTaskView[]`).
- **`capacity` and `circuitState` getters:** Publicly exposes the total configured permit capacity and the active state of the circuit breaker (`'closed' | 'open' | 'half-open'`) directly on the `Semaphore` instance.
- **Customizable circuit breaker window buckets:** Added the `circuitBreakerWindowBucketWidth` configuration property to tune the granularity/resolution of the circuit breaker's sliding failure window.
- **Customizable metrics windows:** Added the `metricsWindows` configuration option to override the built-in time windows (1m/5m/15m/1h/24h) with bespoke tracking horizons. Exported the underlying `WindowOptions` type from the package root. Windows that collide on the same horizon label (which would silently overwrite each other in the snapshot) are rejected at construction with `INVALID_ARGUMENT`.
- **`QUEUEEVICT` event and `totalEvictions` lifetime counter:** Tasks evicted by a circuit trip are now observable — one `QUEUEEVICT` event (payload: `QueuedTaskView`) per evicted task, plus a `totalEvictions` counter in `status().lifetime`, so eviction volume is distinguishable from ordinary open-circuit rejections.

### Changed

- **Immediate queue eviction on circuit trip:** When a timeout causes the circuit breaker to trip open, all other non-probe queued tasks are instantly evicted and rejected with a `CIRCUIT_OPEN` error code, preventing them from waiting out their individual lifetimes and surfacing misleading `TIMEOUT` rejections.
- **Narrowed `QUEUEPURGE` payload:** The `QUEUEPURGE` event now cleanly emits the narrow `QueuedTaskView` shape instead of leaking the raw internal `QueuedTask` instance and its mutative structural links.
- **Unconditional listener exception logging:** Errors thrown inside attached event listeners are now always surfaced via `console.warn` instead of being silenced when `debug: false` is active.
- **Shared `drain()` promise semantics:** Clarified that concurrent, overlapping invocations of `drain()` return the identical in-flight promise. The `timeoutMs` parameter of the *first* caller governs the cycle; subsequent caller deadlines are bypassed.
- **Standardized internal validation errors:** Attempting to double-insert a node into the internal heap or initializing metrics with an empty array now properly throws a `SemaphoreError` with the `INVALID_ARGUMENT` code rather than a generic runtime `Error`.
- **`tryAcquire()` no longer records a circuit-breaker attempt.** Previously every `tryAcquire` call — including ones that returned `null` — counted toward the breaker window's attempt denominator, diluting the timeout rate. Since `tryAcquire` can never queue (and therefore never time out), it no longer participates in breaker accounting at all. In `tryAcquire`-heavy workloads the breaker now trips somewhat more readily than in 1.1.0.
- **`status().metrics` returns `null` after `shutdown()`** (previously a zeroed snapshot). The collector's typed-array buffers are released on shutdown.
- **`status()` rate fields are computed over the shortest configured metrics window** (`requestsPerSecond`, `timeoutRate1m`). With the default windows this is the 1m window, unchanged; with custom `metricsWindows` the fields previously looked up a hard-coded `'1m'` label and silently reported 0 when it was absent.

### Fixed

- **`drain()` resolution no longer depends on a scheduler tick.** The idle check now runs synchronously at every transition that can reach idle (release, timeout, abort, purge, `cancel()`). Previously it ran only on scheduler wakeups, which adaptive backoff defers on an *unref'd* timer — delaying drain resolution by up to the backoff delay and, in a process with nothing else keeping the event loop alive, allowing exit before a pending `drain()` resolved.

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
