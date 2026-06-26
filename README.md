# 🎛️ Regulo

**Control the heat.**

[![npm version](https://img.shields.io/npm/v/regulo.svg)](https://www.npmjs.com/package/regulo)
[![CI](https://github.com/greenstick/regulo/actions/workflows/ci.yml/badge.svg?branch=master))](https://github.com/greenstick/regulo/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/greenstick/3199efaef7c0b4872452f05d2bf837dd/raw/regulo-coverage.json)](https://github.com/greenstick/regulo/actions/workflows/ci.yml)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/regulo)](https://bundlephobia.com/package/regulo)
[![types](https://img.shields.io/npm/types/regulo.svg)](https://www.npmjs.com/package/regulo)
[![license](https://img.shields.io/npm/l/regulo.svg)](./LICENSE)
[![Socket](https://badge.socket.dev/npm/package/regulo)](https://socket.dev/npm/package/regulo)

---

A concurrency limiter with a built-in circuit breaker, so the expensive parts of your system never boil over. Regulo is a priority-queue semaphore with weighted permits, a saturation circuit breaker, adaptive backoff, and built-in windowed metrics. Zero dependencies, ships ESM and CJS, runs on Node.js and other modern JavaScript runtimes.

Like the dial on a gas range, Regulo sits between incoming work and the burner. Most concurrency libraries just cap how many things run at once and stop there. Regulo is built for the case where that limit is protecting something expensive — SSR rendering, a database pool, a downstream API — and you need to watch the flame, send the important pots to the front, and turn things down cleanly before the system scorches.

## ✨ Highlights

- **🎛️ Bounded concurrency, with priority and weighting** — set how many burners are lit, send important work to the front, and let one heavy job claim more than one burner.
- **🛡️ Saturation circuit breaker** — when work backs up faster than it clears, Regulo takes the pot off the heat: it opens the circuit and sheds load immediately, then probes for recovery and closes again on its own. (See [How the circuit breaker works](#how-the-circuit-breaker-works) — it trips on saturation, not on your operation's errors.)
- **🌡️ Adaptive backoff** — during a timeout burst, dispatch eases down to a simmer and returns to a full boil on its own once things recover.
- **📈 Built-in observability** — windowed 1m/5m/15m/1h/24h rollups (throughput, latency, queue depth, in-flight), lifetime counters, and an event stream, all through one `status()` call.
- **⏳ Head-of-line fairness** — once a caller is in line, nobody jumps the queue ahead of it.
- **🪶 Tiny footprint, no supply-chain surface** — roughly 6.6 KB min+gzip (~26 KB minified, ~6.1 KB brotli) with zero runtime dependencies, so there's nothing transitive to audit, update, or trust. Tree-shakeable ESM.
- **🧯 Production-minded** — graceful `drain()`, `reset()`, `cancel()`, and `shutdown()`; stale-task purging; double-release safety; strict-mode TypeScript types.

## 📦 Install

```bash
npm install regulo
```

Requires Node.js >= 20 (or any runtime providing `AbortSignal`, `queueMicrotask`, and timers).

## 🚀 Quick start

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10); // 10 concurrent permits — ten burners

const result = await semaphore.use(async () => {
  return await expensiveOperation();
});
```

`use()` acquires a permit, runs your function, and releases the permit afterward — even if the function throws. The primary export is the `Semaphore` class; `regulo` is the dial wrapped around it.

## How it compares

Regulo overlaps with several well-known libraries but sits at the intersection of bounded concurrency, prioritization, and resilience, with built-in observability.

| Capability | regulo | p-limit | p-queue | opossum | cockatiel |
|---|---|---|---|---|---|
| Bounded concurrency | Yes | Yes | Yes | No | Yes (bulkhead) |
| Priority queue | Yes | No | Yes | — | No |
| Weighted permits | Yes | No | No | — | No |
| Circuit breaker | Yes | No | No | Yes | Yes |
| Adaptive backoff | Yes | No | No | No | No |
| Windowed metrics | Yes | No | Basic | Yes | No |
| Dependencies | Zero | Minimal | Minimal | Several | Zero |

Capabilities reflect each project's commonly documented feature set at the time of writing; check the respective projects for their current state. If you only need a concurrency cap, `p-limit` is smaller and simpler. If you need rich resilience policy composition (retry, timeout, fallback), `cockatiel` is a strong choice. Reach for `regulo` when you want prioritized, weighted concurrency limiting that you can monitor and that protects itself under sustained load.

## Core concepts

**Semaphore** — holds a fixed pool of permits (the burners). Callers acquire a permit before doing work and release it when done. When all permits are held, callers queue until one frees up, or until their timeout fires.

**Weighted permits** — a single acquire can consume more than one permit (`weight`). Big pots need more burners, so heavier work reserves proportionally more of the pool.

**Priority queue** — queued callers are dispatched in ascending priority order (lower number = higher priority — the front burner). Default priority is `0`. Dispatch is head-of-line fair: once any caller is queued, later callers always queue behind it rather than grabbing a free permit, so a lower-priority or lighter task can never jump ahead of a waiting higher-priority or heavier one.

**Queue ordering** — `queueOrder` selects a dispatch preset. `'fifo'` (the default) and `'lifo'` keep priority as the primary sort key and break equal-priority ties earliest- or latest-enqueued first, respectively. `'fifoIgnorePriority'` and `'lifoIgnorePriority'` drop priority entirely and order purely by enqueue time. For full control, pass a `comparator` (lower sorts/dispatches first), which overrides `queueOrder`:

```ts
import { Semaphore, QUEUE_ORDERINGS } from 'regulo';

// Built-in preset
const a = new Semaphore(4, { queueOrder: 'lifo' });

// Custom: priority first, then heaviest work first, then FIFO. The receiver is a
// read-only QueuedTaskView ({ id, priority, enqueueTime, weight }); `id`
// increases with enqueue order. Probe tasks are always dispatched first
// regardless of your comparator, so you never need to handle them.
const b = new Semaphore(4, {
  comparator: (x, y) => (x.priority - y.priority) || (y.weight - x.weight) || (x.id - y.id),
});

// Compose with a preset
const c = new Semaphore(4, { comparator: QUEUE_ORDERINGS.lifo });
```

**Circuit breaker** — watches for saturation and takes the pot off the heat when the system can't keep up. See the dedicated section below for exactly what it measures.

**Backoff** — exponential backoff eases dispatch down to a simmer during sustained timeout bursts. The delay grows on each timeout and decays continuously over time, throttling dispatch while downstream systems recover and returning to zero on its own once the burst subsides. The current delay is exposed in `status()` and `TASKTIMEOUT` events.

## How the circuit breaker works

The breaker is a **saturation breaker, not a fault breaker**. It watches the rate of *queue-acquisition timeouts* — callers that waited longer than `queueMaxTimeout` for a permit — over a sliding window. When that rate crosses `circuitBreakerThreshold` (and the minimum count guards are met), the circuit opens and new requests are rejected immediately with `CIRCUIT_OPEN`. After the cooldown elapses, one probe request is allowed through; if it succeeds the circuit closes, if it times out the circuit re-opens and the cooldown restarts.

What this means in practice:

- The breaker trips when work **backs up** faster than permits free — the signature of a saturated or slow downstream. This is what protects the pool: it pulls everything off the heat before the pot boils over.
- The breaker does **not** trip on errors thrown by the function you run inside `use()`. If your operation fails fast, the permit is released normally and the failure never reaches the breaker.

If you also need to trip on downstream *errors* (not just saturation), pair the semaphore with a conventional fault breaker around your operation, or use the standalone [`CircuitBreaker`](#standalone-circuitbreaker) and feed it your own failure signal.

## 🍳 Recipe: Express middleware

Cap concurrent handling of an expensive route and shed load with a `503` when the circuit is open or the queue is full:

```ts
import { Semaphore, SemaphoreError } from 'regulo';

const semaphore = new Semaphore(20, { queueMaxLength: 100, queueMaxTimeout: 2000 });

app.get('/report', async (req, res, next) => {
  try {
    const report = await semaphore.use(() => buildExpensiveReport(req.query));
    res.json(report);
  } catch (error) {
    if (error instanceof SemaphoreError) {
      // CIRCUIT_OPEN, QUEUE_FULL, or TIMEOUT — kitchen's slammed, turn them away
      res.setHeader('Retry-After', '5').status(503).end();
      return;
    }
    next(error);
  }
});

// Expose the limiter's state to your metrics endpoint
app.get('/internal/semaphore', (_req, res) => res.json(semaphore.status()));
```

## 📚 API reference

### `new Semaphore(count, config?)`

Creates a semaphore with `count` permits.

### `acquire(abortSignal?, priority?, weight?): Promise<() => void>`

Acquires a permit. Returns a `release` closure. Queues if no permit is available.

- `priority` — Dispatch priority (any finite number; lower dispatches first). Defaults to `0`. Non-finite values (`NaN`, `Infinity`) reject with `INVALID_PRIORITY`.
- `weight` — Permits to consume (integer in `1..count`). Defaults to `1`. Invalid weights reject with `INVALID_WEIGHT`.

```ts

const release = await semaphore.acquire(abortController.signal, 1, 2); // priority 1, weight 2
try {
  await doWork();
} finally {
  release();
}
```

### `use<T>(fn, abortSignal?, priority?, weight?): Promise<T>`

Preferred entry point. Acquires a permit, runs `fn()`, and releases — always, even if `fn` throws.

### `tryAcquire(weight?): (() => void) | null`

Non-blocking. Returns a release closure, or `null` if insufficient permits are available **or any tasks are already queued** (head-of-line fairness — `tryAcquire` never jumps the queue).

- `weight` — Permits to consume (integer in `1..count`). Defaults to `1`. Invalid weights return `null`.

### `drain(timeoutMs?): Promise<void>`

Resolves when the queue is empty and all permits are returned. Multiple callers share the same promise. Pass `timeoutMs` (a positive integer) to set a deadline — rejects with `TIMEOUT` if not idle in time; an invalid value throws synchronously.

> Without `timeoutMs`, `drain()` can block indefinitely if a caller holds a permit and never releases it.

### `reset(options?): void`

Rejects all queued tasks (`SHUTDOWN`) and restores the semaphore to its initial state. Event listeners are preserved unless `{ clearListeners: true }` is passed.

### `cancel(): void`

Rejects all currently queued tasks with `CANCELLED`. In-flight permits are unaffected and the semaphore remains fully operational (unlike `shutdown()`).

### `shutdown(reason?): void`

Permanently stops the semaphore — kills the gas. All queued tasks are rejected. Unlike `reset()`, this cannot be reversed.

### `on(event, listener) / off(event, listener) / removeAllListeners(event?)`

Standard event emitter interface. See [Events reference](#events-reference) below.

### `status()`

Returns a snapshot of current operating state. See [`status()` output](#status-output) for the full shape.

> `status()` calls `queue.toArray()` internally, which is O(N) in the queue depth. Rate-limit calls in high-frequency scrape paths.

### `isAvailable(): boolean`

Returns `true` if the semaphore is not shut down, the circuit is not open, and a permit is available.

### `queueLength: number`

Current number of tasks waiting for a permit.

### `availablePermits: number`

Number of permits not currently held.

## Configuration reference

| Option | Type | Default | Description |
|---|---|---|---|
| `queueMaxLength` | `number` | `Number.MAX_SAFE_INTEGER` | Max tasks that may wait in the queue (positive integer; effectively unbounded by default) |
| `queueMaxTimeout` | `number` | `10000` | ms a queued task waits before `TIMEOUT` |
| `queueMaxAge` | `number` | `30000` | ms before the purge interval ejects a task regardless of its own timeout |
| `rejectOnFull` | `boolean` | `false` | Reject immediately when all permits are held (no queuing) |
| `circuitBreakerThreshold` | `number` | `0.5` | Failure rate in `(0,1)` that trips the circuit |
| `circuitBreakerWindow` | `number` | `10000` | Sliding window size in ms for the failure rate. Min: `1000` |
| `circuitBreakerCooldown` | `number` | `5000` | ms the circuit stays open before allowing a probe. Min: `1000` |
| `circuitBreakerMinThroughput` | `number` | `10` | Min requests in window before circuit can trip |
| `circuitBreakerMinFailures` | `number` | `5` | Min failures in window before circuit can trip |
| `backoffInitialTimeout` | `number` | `50` | Initial backoff delay (ms) applied to scheduler wakeup on first timeout |
| `backoffMaxTimeout` | `number` | `2000` | Max backoff delay (ms) applied to scheduler wakeup |
| `backoffDecayFactor` | `number` | `0.5` | Backoff decay factor per idle second, in `(0,1)` |
| `purgeIntervalMs` | `number` | `3000` | ms between stale-task purge sweeps. Min: `500` |
| `metricsEnabled` | `boolean` | `true` | Enable windowed metrics collection |
| `queueOrder` | `'fifo' \| 'lifo' \| 'fifoIgnorePriority' \| 'lifoIgnorePriority'` | `'fifo'` | Queue dispatch order. `fifo`/`lifo` keep priority primary; the `*IgnorePriority` variants order purely by enqueue time. Ignored if `comparator` is set |
| `comparator` | `(a, b) => number` | — | Custom ordering over queued tasks (lower sorts/dispatches first); overrides `queueOrder` |
| `debug` | `boolean` | `false` | Enable debug logging and the permit-pool invariant check. Does not gate events — all events fire regardless |

## Events reference

Listen with `Semaphore.on(SemaphoreEvents.CIRCUITOPEN, handler)`.

| Event constant | String value | Payload |
|---|---|---|
| `TASKACQUIRE` | `'task-acquire'` | `{ queued, running, probe? }` |
| `TASKRELEASE` | `'task-release'` | `{ queued, running }` |
| `TASKTIMEOUT` | `'task-timeout'` | `{ queueLength, backoffDelay, taskId }` |
| `TASKABORT` | `'task-abort'` | none |
| `QUEUEPURGE` | `'queue-purge'` | `QueuedTask` |
| `CIRCUITOPEN` | `'circuit-open'` | `{ timeoutRate, recentTimeouts, total, reason? }` |
| `CIRCUITHALFOPEN` | `'circuit-half-open'` | none |
| `CIRCUITCLOSE` | `'circuit-close'` | none |
| `SHUTDOWN` | `'shutdown'` | `reason: string` |

## Error codes

All rejections are `SemaphoreError` instances with a `code` property.

| Code | When thrown |
|---|---|
| `CIRCUIT_OPEN` | Circuit breaker is open |
| `CIRCUIT_HALF_OPEN` | Circuit is half-open and a probe is already in flight |
| `INVALID_WEIGHT` | `weight` is not an integer in `1..count` |
| `INVALID_PRIORITY` | `priority` is not a finite number |
| `QUEUE_FULL` | `rejectOnFull` is true, or `queueMaxLength` is exceeded |
| `TIMEOUT` | Task waited longer than `queueMaxTimeout`; or `drain()` exceeded its deadline |
| `ABORTED` | Caller's `AbortSignal` fired |
| `CANCELLED` | Task was rejected by `cancel()` |
| `SHUTDOWN` | `shutdown()` or `reset()` was called while the task was queued |
| `PURGED` | Task was ejected by the stale-task purge interval (`queueMaxAge` exceeded) |

```ts
import { Semaphore, SemaphoreError } from 'regulo';

const semaphore = new Semaphore(10);
try {
  const release = await semaphore.acquire();
  // ...
  release();
} catch (error) {
  if (error instanceof SemaphoreError) {
    switch (error.code) {
      case 'CIRCUIT_OPEN': // back off and retry later
      case 'TIMEOUT':      // shed load
      case 'ABORTED':      // client disconnected
    }
  }
}
```

## `status()` output

```ts
{
  status: {
    running: number,          // permits currently held
    queued: number,           // tasks waiting in queue
    available: number,        // free permits
    inFlight: number,         // same as running (alias for clarity)
    pendingReleases: number,  // outstanding release closures; non-zero means permits are held
    circuitOpen: boolean,
    circuitHalfOpen: boolean,
    backoffDelay: number,     // current backoff delay (ms) applied to scheduler wakeup
    requestsPerSecond: number, // based on 1m window
    timeoutRate1m: number,    // timeout % over last 1m
    queueAge: number,         // ms since oldest queued task was enqueued
  },
  lifetime: {
    totalAcquired: number,
    totalReleased: number,
    totalTimeouts: number,
    circuitBreakerCooldownRemaining: number, // ms until circuit may probe
  },
  metrics: SemaphoreMetricsSnapshot | null  // null if metricsEnabled: false
}
```

## Standalone `CircuitBreaker`

`CircuitBreaker` can be used independently — e.g. to wrap an HTTP client. Unlike the semaphore's saturation breaker, here you decide what counts as a failure by calling `recordTimeout()` on whatever signal you choose:

```ts
import { CircuitBreaker } from 'regulo';

const circuitBreaker = new CircuitBreaker({
  threshold: 0.5,
  window: 10000,
  cooldown: 5000,
  minThroughput: 10,
  minFailures: 5,
});

async function fetch(url: string) {
  // Check and transition open → half-open if cooldown elapsed
  if (circuitBreaker.checkAndTransition()) {
    console.log('Circuit entering half-open');
  }
  if (circuitBreaker.isOpen) throw new Error(`Circuit open, retry in ${circuitBreaker.cooldownRemaining}ms`);

  circuitBreaker.trackAttempt();
  try {
    const result = await httpClient.get(url);
    if (circuitBreaker.isHalfOpen) circuitBreaker.handleProbeSuccess();
    return result;
  } catch (error) {
    circuitBreaker.recordTimeout();
    if (circuitBreaker.isHalfOpen) circuitBreaker.handleProbeFailure();
    else circuitBreaker.evaluateAndTrip();
    throw error;
  }
}
```

## ⚡ Benchmarks

Full, reproducible benchmarks live in [`benchmarks/`](./benchmarks) — run them
yourself with `npm run benchmark:all`. Figures below are from a real run on
Node v22.16.0, darwin x64, mid-2018 Intel i9 Macbook Pro; your numbers will differ — re-run locally. Each
library from [How it compares](#how-it-compares) is benchmarked only on the
axis it actually shares with Regulo: the concurrency limiters on capping
concurrency, the circuit breakers on per-call overhead.

**🔥 Fast path, uncontended**

| Scenario | ops/sec | vs. fastest |
|---|--:|---|
| `tryAcquire` + `release` | 2.19M | 2.36x slower |
| `tryAcquire` + `release` (no metrics) | 5.19M | fastest |
| `use()` round-trip | 1.13M | 4.60x slower |
| `use()` round-trip (no metrics) | 1.77M | 2.92x slower |

**🎛️ Weighted acquire, uncontended**

| Scenario | ops/sec | vs. fastest |
|---|--:|---|
| `use()` weight=1 | 1.16M | 1.04x slower |
| `use()` weight=4 | 1.19M | 1.01x slower |
| `use()` weight=16 | 1.21M | fastest |

Weighted permits add no meaningful overhead regardless of weight — claiming
16 burners at once costs about the same as claiming one.

**⏳ Contended throughput** (tasks/sec)

| Scenario | tasks/sec | vs. fastest |
|---|--:|---|
| concurrency=4 | 469.1k | 1.22x slower |
| concurrency=16 | 562.5k | 1.02x slower |
| concurrency=64 | 571.5k | fastest |
| concurrency=16, random priority | 498.0k | 1.15x slower |

**📈 `status()` snapshot cost**

| Queue depth | ops/sec | vs. fastest |
|---|--:|---|
| 0 | 740.1k | fastest |
| 100 | 678.0k | 1.09x slower |
| 1000 | 498.1k | 1.49x slower |

`status()` is O(N) in queue depth (see [Caveats](#caveats)) — the cost climbs
gradually as the queue grows, roughly 1.5x slower at 1000 queued tasks versus
an empty queue.

**📊 regulo vs. other libraries — uncontended round-trip**

| Library | ops/sec | vs. fastest |
|---|--:|---|
| cockatiel (bulkhead) | 4.13M | fastest |
| p-queue | 1.22M | 3.40x slower |
| p-limit | 1.17M | 3.54x slower |
| regulo (no metrics) | 1.57M | 2.63x slower |
| regulo | 1.02M | 4.05x slower |

**📊 regulo vs. other libraries — contended throughput @ concurrency=16** (tasks/sec)

| Library | tasks/sec | vs. fastest |
|---|--:|---|
| cockatiel (bulkhead) | 1.72M | fastest |
| p-queue | 1.05M | 1.64x slower |
| p-limit | 883.6k | 1.95x slower |
| regulo (no metrics) | 622.4k | 2.76x slower |
| regulo | 493.3k | 3.49x slower |

**🛡️ Circuit breaker overhead — closed/healthy circuit**

| Library | ops/sec | vs. fastest |
|---|--:|---|
| regulo `CircuitBreaker` | 3.71M | fastest |
| cockatiel (circuitBreaker) | 2.79M | 1.33x slower |
| opossum | 1.62M | 2.29x slower |

The picture is consistent. Cockatiel's bulkhead is the fastest limiter — and
Regulo trades raw limiter throughput for an integrated priority heap, weighted
permits, a saturation breaker, and (by default) windowed metrics in one component.
On the breaker axis that integration goes the other way: Regulo's standalone
`CircuitBreaker` is the fastest of the three, because it defers failure
accounting to an explicit timeout signal instead of bookkeeping a rolling
window on every call.

In practice none of this is the bottleneck. Regulo guards work that is *far*
more expensive than the limiter itself: SSR renders, database queries,
downstream API calls, measured in milliseconds. Even at ~500k tasks/sec
under contention the per-task overhead is a few microseconds against operations
thousands of times slower. If you only need a bare concurrency cap on cheap
work in a hot loop, reach for a leaner limiter; see [How it compares](#how-it-compares).

## 🧪 Test coverage

```
npx vitest run --coverage
```

```
 ✓ test/queue.test.ts (11 tests)
 ✓ test/metrics.test.ts (18 tests)
 ✓ test/breaker.test.ts (21 tests)
 ✓ test/permit.test.ts (14 tests)
 ✓ test/backoff.test.ts (6 tests)
 ✓ test/ordering.test.ts (13 tests)
 ✓ test/heap.test.ts (8 tests)
 ✓ test/semaphore.test.ts (88 tests)

 Test Files  8 passed (8)
      Tests  179 passed (179)
```

| File | % Stmts | % Branch | % Funcs | % Lines |
|---|--:|--:|--:|--:|
| **All files** | **95.44** | **88.18** | **98.64** | **98.92** |
| `backoff.ts` | 100 | 100 | 100 | 100 |
| `breaker.ts` | 100 | 100 | 100 | 100 |
| `error.ts` | 100 | 100 | 100 | 100 |
| `heap.ts` | 98.7 | 97.67 | 100 | 100 |
| `metrics.ts` | 96.6 | 83.78 | 97.56 | 97.67 |
| `ordering.ts` | 100 | 100 | 100 | 100 |
| `permit.ts` | 100 | 87.5 | 100 | 100 |
| `queue.ts` | 100 | 82.35 | 100 | 100 |
| `semaphore.ts` | 91.22 | 83.62 | 97.29 | 98.54 |
| `types.ts` | 100 | 100 | 100 | 100 |
| `validation.ts` | 100 | 95.45 | 100 | 100 |

179 tests across 8 suites, all green ✅. Coverage is v8-instrumented; the
handful of uncovered branches sit in `semaphore.ts` and `metrics.ts` (edge-case
branch combinations) and a single line each in `heap.ts`, `permit.ts`, and
`validation.ts`.

## Caveats

Before you crank the dial, know where the edges are:

- **`status()` is O(N)** in the queue depth due to `queue.toArray()`. Do not call it in tight loops under heavy load.
- **`drain()` without a timeout can block indefinitely** if a permit holder never releases. Always pass `timeoutMs` in graceful-shutdown paths.
- **The circuit breaker is a saturation breaker.** It trips on queue-acquisition timeouts, not on errors thrown by your operation. See [How the circuit breaker works](#how-the-circuit-breaker-works).

## License

[MIT](./LICENSE)
