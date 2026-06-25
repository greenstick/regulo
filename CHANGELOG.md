# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-25

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
