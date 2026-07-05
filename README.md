# **Regulo**

**🔥 Control the heat**

[![npm version](https://img.shields.io/npm/v/regulo.svg)](https://www.npmjs.com/package/regulo)
[![CI](https://github.com/greenstick/regulo/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/greenstick/regulo/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/greenstick/3199efaef7c0b4872452f05d2bf837dd/raw/regulo-coverage.json)](https://github.com/greenstick/regulo/actions/workflows/ci.yml)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/regulo)](https://bundlephobia.com/package/regulo)
[![types](https://img.shields.io/npm/types/regulo.svg)](https://www.npmjs.com/package/regulo)
[![license](https://img.shields.io/npm/l/regulo.svg)](./LICENSE)
[![Socket](https://badge.socket.dev/npm/package/regulo)](https://socket.dev/npm/package/regulo)

---

A concurrency limiter with a built-in circuit breaker, so the expensive parts of your system never boil over. **Regulo** is a priority-queue semaphore with weighted permits, a saturation circuit breaker, adaptive backoff, and built-in windowed metrics. Zero dependencies, ships ESM and CJS, runs on Node.js and other modern JavaScript runtimes.

Like the dial on a gas range, **Regulo** sits between incoming work and the burner. Most concurrency libraries just cap how many things run at once and stop there. **Regulo** is built for the case where that limit is protecting something expensive — SSR rendering, a database pool, a downstream API — and you need to watch the flame, send the important pots to the front, and turn things down cleanly before the system scorches.

## Highlights

- **🎛️ Bounded concurrency, with priority and weighting** — set how many burners are lit, send important work to the front, and let one heavy job claim more than one burner.
- **🛡️ Saturation circuit breaker** — when work backs up faster than it clears, **Regulo** takes the pot off the heat: it opens the circuit and sheds load immediately, then probes for recovery and closes again on its own. (See [How the circuit breaker works](#how-the-circuit-breaker-works) — it trips on saturation, not on your operation's errors.) The breaker is pluggable: feed it downstream errors with `reportFailure()`, or swap in a no-op breaker, a manual kill switch, or your own — see [Circuit breakers](#circuit-breakers).
- **🌡️ Adaptive backoff** — during a timeout burst, dispatch eases down to a simmer and returns to a full boil on its own once things recover.
- **📈 Built-in observability** — windowed 1m/5m/15m/1h/24h rollups (throughput, latency, queue depth, in-flight), lifetime counters, and an event stream, all through one `status()` call.
- **⏳ Head-of-line fairness** — once a caller is in line, nobody jumps the queue ahead of it.
- **🪶 Small footprint, no supply-chain surface** — a single ~34 KB file with zero runtime dependencies, so there's nothing transitive to audit, update, or trust. Tree-shakeable ESM.
- **🧯 Production-minded** — graceful `drain()`, `reset()`, `cancel()`, and `shutdown()`; stale-task purging; double-release safety; strict-mode TypeScript types.

## Install

```bash
npm install regulo
```

Requires Node.js >= 20 (or any runtime providing `AbortSignal`, `queueMicrotask`, and timers).

## Quick start

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10); // 10 concurrent permits — ten burners

const result = await semaphore.use(async () => {
  return await expensiveOperation();
});
```

`use()` acquires a permit, runs your function, and releases the permit afterward — even if the function throws. The primary export is the `Semaphore` class; `regulo` is the dial wrapped around it.

## Core concepts

**Semaphore** — holds a fixed pool of permits (the burners). Callers acquire a permit before doing work and release it when done. When all permits are held, callers queue until one frees up, or until their timeout fires.

**Weighted permits** — a single acquire can consume more than one permit (`weight`). Big pots need more burners, so heavier work reserves proportionally more of the pool.

**Priority queue** — queued callers are dispatched in ascending priority order (lower number = higher priority — the front burner). Default priority is `0`. Dispatch is head-of-line fair: once any caller is queued, later callers always queue behind it rather than grabbing a free permit, so a lower-priority or lighter task can never jump ahead of a waiting higher-priority or heavier one.

**Queue ordering** — `queueOrder` selects a dispatch preset. Priority and arrival order are two independent axes. `'fifoWithPriority'` (the default) and `'lifoWithPriority'` keep priority as the primary sort key and break equal-priority ties earliest- or latest-enqueued first. `'fifo'` and `'lifo'` drop priority entirely and order purely by enqueue time. For full control, pass a `comparator` (lower sorts/dispatches first), which overrides `queueOrder`:

```ts
import { Semaphore, QUEUE_ORDERINGS } from 'regulo';

// Built-in preset — pure arrival order, priority ignored
const a = new Semaphore(4, { queueOrder: 'lifo' });

// Custom: priority first, then lightest work first, then FIFO. The receiver is a
// read-only QueuedTaskView ({ id, priority, enqueueTime, weight }); `id`
// increases with enqueue order. Probe tasks are always dispatched first
// regardless of your comparator, so you never need to handle them.
const b = new Semaphore(4, {
  comparator: (x, y) => (x.priority - y.priority) || (x.weight - y.weight) || (x.id - y.id),
});

// Compose with a preset
const c = new Semaphore(4, { comparator: QUEUE_ORDERINGS.lifoWithPriority });
```

See [Choosing an ordering](#choosing-an-ordering-and-its-implications) for how the ordering interacts with weighted permits and head-of-line dispatch — the choice has real throughput consequences under mixed weights.

**Circuit breaker** — watches for saturation and takes the pot off the heat when the system can't keep up. See the dedicated section below for exactly what it measures.

**Backoff** — exponential backoff eases dispatch down to a simmer during sustained timeout bursts. The delay grows on each timeout and decays continuously over time, throttling dispatch while downstream systems recover and returning to zero on its own once the burst subsides. The current delay is exposed in `status()` and `TASKTIMEOUT` events.

## Choosing an Ordering and Its Implications

Two facts are true of **every** ordering, because they live in the scheduler, not the comparator:

1. **Dispatch follows the configured order strictly.** Whatever sorts to the head dispatches next; nothing behind it jumps ahead (head-of-line fairness).
2. **The scheduler will not dispatch *past* a head that doesn't fit.** With [weighted permits](#core-concepts), if the head needs more permits than are currently free, the scheduler waits for capacity to accumulate rather than skipping to a lighter task behind it. A free permit can therefore sit idle while the head waits. This prevents a lighter/lower-priority task from starving a heavier/higher-priority one — but under a wide weight distribution it can also stall throughput while the head waits.

That second rule is where the **comparator choice matters**: the rule is fixed, but *which task ends up at the head* — and therefore how often the stall bites — is entirely up to your ordering.

| `queueOrder` | Dispatches first | Head-of-line stall exposure under mixed weights |
|---|---|---|
| `fifoWithPriority` (default) | lowest priority value, ties earliest-first | A heavy task only holds the line while it is genuinely the highest-priority (or earliest equal-priority) waiter |
| `lifoWithPriority` | lowest priority value, ties latest-first | Same, but equal-priority ties favor the newest |
| `fifo` | earliest enqueued (priority ignored) | Classic head-of-line: whoever arrived first holds the line until it fits |
| `lifo` | latest enqueued (priority ignored) | The newest arrival holds the line until it fits |
| custom, **heaviest-first** | heaviest weight | **Worst case** — deliberately parks the heaviest task at the head, maximizing the stall |
| custom, **lightest-first** | lightest weight | Minimizes stalls — light work drains while capacity accumulates for heavy work |

If you mix many light acquires with a few heavy ones and care about throughput, prefer a **lightest-first tiebreaker** (e.g. `(a, b) => (a.priority - b.priority) || (a.weight - b.weight) || (a.id - b.id)`), or give each weight class its **own `Semaphore`** so a heavy head in one pool can't stall the other. Conversely, if you must not let light work starve heavy work, the default's strict behavior is what you want.

> **Weight is a cost multiplier, not a task-type selector.** `weight` exists to say "this unit of work costs N burners," for work drawing on the **same** resource pool and **same** failure domain. Don't use weight (or priority) to multiplex unrelated task types or downstreams through one `Semaphore` — the breaker and backoff are shared across everything in the instance (see [Caveats](#caveats)). Use one `Semaphore` per resource instead.

## How the Circuit Breaker Works

The breaker is a **saturation breaker, not a fault breaker**. It watches the rate of *queue-acquisition timeouts* — callers that waited longer than `queueMaxTimeout` for a permit — over a sliding window. When that rate crosses `circuitBreakerThreshold` (and the minimum count guards are met), the circuit opens and new requests are rejected immediately with `CIRCUIT_OPEN`. Tasks already waiting in the queue are evicted at that same moment and rejected with `CIRCUIT_OPEN` too — they would otherwise sit out their full `queueMaxTimeout` only to surface a misleading `TIMEOUT`. Each eviction emits a `QUEUEEVICT` event and increments the `totalEvictions` lifetime counter. After the cooldown elapses, one probe request is allowed through; if it succeeds the circuit closes, if it times out the circuit re-opens and the cooldown restarts.

What this means in practice:

- The breaker trips when work **backs up** faster than permits free — the signature of a saturated or slow downstream. This is what protects the pool: it pulls everything off the heat before the pot boils over.
- The breaker does **not** trip on errors thrown by the function you run inside `use()`. If your operation fails fast, the permit is released normally and the failure never reaches the breaker.

If you also need to trip on downstream *errors* (not just saturation), call [`reportFailure()`](#feeding-downstream-errors-reportfailure) with your own failure signal — the same breaker window applies — or swap the breaker entirely via [Circuit breakers](#circuit-breakers).

## Example: Express Middleware

Cap concurrent handling of an expensive route and shed load with a `503` when the circuit is open or the queue is full:

```ts
import { Semaphore, SemaphoreError, SemaphoreEvents } from 'regulo';
import type { RequestHandler } from 'express';

/*
Middleware
*/

export function limit(semaphore: Semaphore): RequestHandler {
  return async (req, res, next) => {
    let release: (() => void) | undefined;
    try {
      release = await semaphore.acquire();
    } catch (error) {
      // CIRCUIT_OPEN | QUEUE_FULL | TIMEOUT all mean the same to a client:
      // we're overloaded, come back later. No need to branch on error.code.
      if (error instanceof SemaphoreError) {
        res.setHeader('Retry-After', '5').sendStatus(503);
        return;
      }
      return next(error);
    }
    // Hold the permit for the whole request; release however the response ends
    // (success, error, or client disconnect). Regulo's release is idempotent.
    res.once('close', release);
    next();
  };
}

/*
Usage
*/

const reports = new Semaphore(20, { queueMaxLength: 100, queueMaxTimeout: 2000 });

app.get('/report', limit(reports), async (req, res) => {
  res.json(await buildExpensiveReport(req.query));
});

/*
Metrics
*/

// Expose the limiter's state to your metrics endpoint.
app.get('/metrics/semaphore', (_req, res) => res.json(reports.status()));

/*
Event Hooks
*/

// Events fire once per state change for the whole limiter — the right place
// for logging / metrics / alerting, never for responding to a single request.
reports.on(SemaphoreEvents.CIRCUITOPEN, ({ timeoutRate }) => logger.warn(`reports limiter shedding load (timeout rate ${(timeoutRate * 100).toFixed(0)}%)`));
reports.on(SemaphoreEvents.CIRCUITCLOSE, () => logger.info('reports limiter recovered'));
```

## API Reference

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

#### `use<T>(fn, abortSignal?, priority?, weight?): Promise<T>`

Preferred entry point. Acquires a permit, runs `fn()`, and releases — always, even if `fn` throws. With `circuitBreakerFailurePredicate` configured, rejections from `fn()` that match the predicate count as breaker failures, and a matching failure on a probe re-opens the circuit instead of closing it — see [Feeding downstream errors](#feeding-downstream-errors-reportfailure).

#### `tryAcquire(weight?): (() => void) | null`

Non-blocking. Returns a release closure, or `null` if insufficient permits are available **or any tasks are already queued** (head-of-line fairness — `tryAcquire` never jumps the queue).

- `weight` — Permits to consume (integer in `1..count`). Defaults to `1`. Invalid weights return `null`.

#### `drain(timeoutMs?): Promise<void>`

Resolves when the queue is empty and all permits are returned. Multiple callers share the same promise — if a `drain()` is already in flight, later calls return that same promise as-is, so only the *first* caller's `timeoutMs` (if any) governs; a later caller's own `timeoutMs` argument is not applied. Pass `timeoutMs` (a positive integer) to set a deadline — rejects with `TIMEOUT` if not idle in time; an invalid value throws `SemaphoreError` (`INVALID_ARGUMENT`) synchronously, even if it turns out an in-flight drain's promise is what gets returned. Calling `drain()` after `shutdown()` rejects with `SHUTDOWN`.

> Without `timeoutMs`, `drain()` can block indefinitely if a caller holds a permit and never releases it.

#### `reset(options?): void`

Rejects all queued tasks (`SHUTDOWN`) and restores the semaphore to its initial state, so it can be reused. Event listeners are preserved unless `{ clearListeners: true }` is passed. Throws `SemaphoreError` (`SHUTDOWN`) if called after `shutdown()` — a shut-down instance is terminal and cannot be revived.

#### `cancel(): void`

Rejects all currently queued tasks with `CANCELLED`. In-flight permits are unaffected and the semaphore remains fully operational (unlike `shutdown()`).

#### `reportFailure(): void`

Feeds an external failure signal (e.g. a downstream error) into the circuit breaker: records one failure and evaluates the trip condition. A trip behaves exactly like a saturation trip — queued tasks are evicted with `CIRCUIT_OPEN` and `CIRCUITOPEN` fires with `reason: 'reported-failure'`. Only influences trip decisions while the circuit is closed; no-op after `shutdown()`. For `use()`-based workloads, `circuitBreakerFailurePredicate` automates this and additionally makes probes fault-aware. See [Feeding downstream errors](#feeding-downstream-errors-reportfailure).

#### `shutdown(reason?): void`

Permanently stops the semaphore — kills the gas. All queued tasks are rejected, the purge interval is cleared, and metrics collection stops (`status().metrics` returns `null` afterwards; the collector's buffers are released). Outstanding release closures are invalidated and the permit pool is settled, so a `release()` arriving after shutdown is a safe no-op and post-shutdown `status()` reads as terminal. This is terminal: it cannot be reversed, and a later `reset()` on a shut-down instance throws rather than reviving it. Calling `shutdown()` again is a no-op.

#### `on(event, listener) / off(event, listener) / removeAllListeners(event?)`

Standard event emitter interface. Listeners are fully typed — the payload type is inferred from the event, so `on(SemaphoreEvents.TASKACQUIRE, p => …)` gives `p` the correct shape with no `any`. See [Events reference](#events-reference) below.

#### `status()`

Returns a snapshot of current operating state. See [Metrics](#metrics) for the full shape.

> `status()` is O(1) in queue depth — safe to call on a metrics scrape path. (Queue age is read from an enqueue-ordered index, not by scanning the queue.)

#### `peekQueue(): QueuedTaskView[]`

Read-only snapshot of the queue, in enqueue order. Entries additionally carry `isProbe`, so a circuit-breaker probe is identifiable in the view.

#### `isAvailable(): boolean`

Returns `true` if the semaphore is not shut down, the circuit is not open, and a permit is available. This is a capacity signal, not a dispatch guarantee: tasks may still be queued ahead (head-of-line fairness), in which case `tryAcquire()` returns `null` even while `isAvailable()` is `true`.

#### `queueLength: number`

Current number of tasks waiting for a permit.

#### `availablePermits: number`

Number of permits not currently held.

#### `capacity: number`

Total permits the semaphore was constructed with.

#### `circuitState: 'closed' | 'open' | 'probing'`

Current circuit breaker state.

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `queueMaxLength` | `number` | `1024` | Max tasks that may wait in the queue; further acquires reject with `QUEUE_FULL`. Positive integer; pass `Number.MAX_SAFE_INTEGER` for an effectively unbounded queue |
| `queueMaxTimeout` | `number` | `10000` | ms a queued task waits before `TIMEOUT` |
| `queueMaxAge` | `number` | `30000` | ms before the purge interval ejects a task regardless of its own timeout |
| `rejectOnFull` | `boolean` | `false` | Reject immediately when all permits are held (no queuing) |
| `circuitBreakerThreshold` | `number` | `0.5` | Failure rate in `(0,1)` that trips the circuit |
| `circuitBreakerWindow` | `number` | `10000` | Sliding window size in ms for the failure rate. Min: `1000` |
| `circuitBreakerWindowBucketWidth` | `number` | `1000` | Width (ms) of each bucket in the circuit breaker's sliding window; bucket count = `window / windowBucketWidth`. Min: `1` |
| `circuitBreakerCooldown` | `number` | `5000` | ms the circuit stays open before allowing a probe. Min: `1000` |
| `circuitBreakerMinThroughput` | `number` | `10` | Min requests in window before circuit can trip |
| `circuitBreakerMinFailures` | `number` | `5` | Min failures in window before circuit can trip |
| `circuitBreaker` | `CircuitBreakerStrategy` | — | A breaker instance to use instead of the built-in saturation breaker; overrides all `circuitBreaker*` options. See [Circuit breakers](#circuit-breakers) |
| `circuitBreakerFailurePredicate` | `(error: unknown) => boolean` | — | When set, `use()` counts matching rejections as breaker failures and probes become fault-aware. Must not throw. See [Feeding downstream errors](#feeding-downstream-errors-reportfailure) |
| `backoffInitialTimeout` | `number` | `50` | Initial backoff delay (ms) applied to scheduler wakeup on first timeout |
| `backoffMaxTimeout` | `number` | `2000` | Max backoff delay (ms) applied to scheduler wakeup |
| `backoffDecayFactor` | `number` | `0.5` | Backoff decay factor per idle second, in `(0,1)` |
| `purgeIntervalMs` | `number` | `3000` | ms between stale-task purge sweeps. Min: `500` |
| `metricsEnabled` | `boolean` | `true` | Enable windowed metrics collection |
| `metricsWindows` | `WindowOptions[]` | `undefined` (falls back to the built-in 1m/5m/15m/1h/24h set) | Overrides the windows behind `status().metrics`. Each entry is `{ size, stepMs }`; window length = `size × stepMs`. Two windows may not cover the same horizon (their labels would collide); `status()`'s rate fields are computed over the shortest window |
| `queueOrder` | `'fifo' \| 'lifo' \| 'fifoWithPriority' \| 'lifoWithPriority'` | `'fifoWithPriority'` | Queue dispatch order. `fifo`/`lifo` order purely by enqueue time; the `*WithPriority` variants make priority primary and break ties by enqueue time. See [Choosing an ordering](#choosing-an-ordering-and-its-implications). Ignored if `comparator` is set |
| `comparator` | `(a, b) => number` | — | Custom ordering over queued tasks (lower sorts/dispatches first); overrides `queueOrder`. Must be a consistent total order and must not throw (a `NaN`/non-number result degrades safely to an id tie-break; an exception does not) |
| `debug` | `boolean` | `false` | Enable debug logging and the permit-pool invariant check. Does not gate events — all events fire regardless |

Every option is optional. The object below is the complete set of defaults — copy it and change only what you need:

```ts
import { Semaphore, type SemaphoreConfig } from 'regulo';

const config: SemaphoreConfig = {
  // Queue
  queueMaxLength: 1024,                    // max waiting tasks before QUEUE_FULL; min 1
  queueMaxTimeout: 10000,                  // ms a queued task waits before TIMEOUT; min 1
  queueMaxAge: 30000,                      // ms before the purge sweep ejects a task; min 1
  rejectOnFull: false,                     // true = no queuing; reject when all permits held
  // Circuit breaker
  circuitBreakerThreshold: 0.5,            // timeout rate in (0,1) that trips the circuit
  circuitBreakerWindow: 10000,             // ms sliding window for the rate; min 1000
  circuitBreakerWindowBucketWidth: 1000,   // ms per bucket; window / windowBucketWidth = bucket count
  circuitBreakerCooldown: 5000,            // ms open before a probe is allowed; min 1000
  circuitBreakerMinThroughput: 10,         // min requests in window before it can trip; min 1
  circuitBreakerMinFailures: 5,            // min failures in window before it can trip; min 1
  // circuitBreaker: undefined,            // no default — a CircuitBreakerStrategy instance overrides the options above
  // circuitBreakerFailurePredicate: undefined, // no default — use() rejections matching it count as breaker failures
  // Adaptive backoff
  backoffInitialTimeout: 50,               // ms initial delay on first timeout in a burst
  backoffMaxTimeout: 2000,                 // ms ceiling for the backoff delay
  backoffDecayFactor: 0.5,                 // decay per idle second, in (0,1)
  // Maintenance & observability
  purgeIntervalMs: 3000,                   // ms between stale-task purge sweeps; min 500
  metricsEnabled: true,                    // windowed metrics collection
  // metricsWindows: undefined,            // override the default 1m/5m/15m/1h/24h windows
  debug: false,                            // debug logging + permit-pool invariant check
  // Ordering
  queueOrder: 'fifoWithPriority',          // 'fifo' | 'lifo' | 'fifoWithPriority' | 'lifoWithPriority'
  // comparator: undefined,                // no default — if set, overrides queueOrder
};

const semaphore = new Semaphore(10, config);
```

## Events Reference

Listen with `Semaphore.on(SemaphoreEvents.CIRCUITOPEN, handler)`. Payloads are typed per event (see `SemaphoreEventMap`); a handler's argument is inferred from the event constant.

| Event constant | String value | Payload |
|---|---|---|
| `TASKACQUIRE` | `'task-acquire'` | `{ queued, running, probe? }` |
| `TASKRELEASE` | `'task-release'` | `{ queued, running }` |
| `TASKTIMEOUT` | `'task-timeout'` | `{ queueLength, backoffDelay, taskId }` |
| `TASKABORT` | `'task-abort'` | none |
| `QUEUEPURGE` | `'queue-purge'` | `QueuedTaskView` — `{ id, priority, enqueueTime, weight }` |
| `QUEUEEVICT` | `'queue-evict'` | `QueuedTaskView` — task evicted (rejected `CIRCUIT_OPEN`) because the circuit tripped while it was queued |
| `CIRCUITOPEN` | `'circuit-open'` | `{ timeoutRate, recentTimeouts, total, reason? }` |
| `CIRCUITPROBING` | `'circuit-probing'` | none |
| `CIRCUITCLOSE` | `'circuit-close'` | none |
| `SHUTDOWN` | `'shutdown'` | `reason: string` |

## Error Codes

Every error **Regulo** raises — whether rejected from a promise or thrown synchronously — is a `SemaphoreError` instance with a `code` property you can switch on.

| Code | When raised |
|---|---|
| `CIRCUIT_OPEN` | Circuit breaker is open |
| `CIRCUIT_PROBING` | Circuit is probing and a probe is already in flight |
| `INVALID_ARGUMENT` | Invalid constructor/config value, or an invalid `drain()` timeout (thrown synchronously) |
| `INVALID_WEIGHT` | `weight` is not an integer in `1..count` |
| `INVALID_PRIORITY` | `priority` is not a finite number |
| `QUEUE_FULL` | `rejectOnFull` is true, or `queueMaxLength` is exceeded |
| `TIMEOUT` | Task waited longer than `queueMaxTimeout`; or `drain()` exceeded its deadline |
| `ABORTED` | Caller's `AbortSignal` fired |
| `CANCELLED` | Task was rejected by `cancel()` |
| `SHUTDOWN` | `shutdown()` or `reset()` was called while the task was queued; or `reset()`/`drain()` was called on an already shut-down instance |
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
      case 'CIRCUIT_OPEN':    // back off and retry later
      case 'TIMEOUT':         // shed load
      case 'ABORTED':         // client disconnected
    }
  }
}
```

## Metrics

Generated with `status()`.
```ts
{
  status: {
    running: number,           // permits currently held
    queued: number,            // tasks waiting in queue
    available: number,         // free permits
    inFlight: number,          // same as running (alias for clarity)
    pendingReleases: number,   // outstanding release closures; non-zero means permits are held
    circuitOpen: boolean,
    circuitProbing: boolean,
    backoffDelay: number,      // current backoff delay (ms) applied to scheduler wakeup
    requestsPerSecond: number, // over the shortest metrics window (1m by default)
    timeoutRate1m: number,     // timeout % over the shortest metrics window (1m by default)
    queueAge: number,          // ms since oldest queued task was enqueued
  },
  lifetime: {
    totalAcquired: number,
    totalReleased: number,
    totalTimeouts: number,
    totalPurged: number,       // tasks ejected by the stale-task purge (PURGED); not counted as timeouts
    totalEvictions: number,    // tasks evicted from the queue by a circuit trip
    circuitBreakerCooldownRemaining: number, // ms until circuit may probe
  },
  metrics: SemaphoreMetricsSnapshot | null  // null if metricsEnabled: false
}
```

## Circuit Breakers

The breaker behind `Semaphore` is a pluggable strategy. Every breaker — the built-ins below and any you write — implements the `CircuitBreakerStrategy` contract (exported from the package root), and composes into a `Semaphore` via the `circuitBreaker` config option. Injecting an instance overrides the `circuitBreaker*` numeric options, the same precedence `comparator` has over `queueOrder`.

> **Renamed in 1.3.0:** the former `CircuitBreaker` export is now `SaturationCircuitBreaker`, and its `recordTimeout()` method is now `recordFailure()`. Both are straight renames — behavior is unchanged. See the [CHANGELOG](./CHANGELOG.md) for the migration.
>
> **Renamed in 1.4.0:** the breaker's middle state is "probing," not "half-open" — while in this state the breaker admits exactly one canary request, never a fraction of normal capacity, so the old name was misleading. This touches the full public surface with no compatibility aliases: `CircuitState`'s `'half-open'` is now `'probing'`; `isHalfOpen` is now `isProbing`; the `CIRCUITHALFOPEN`/`'circuit-half-open'` event is now `CIRCUITPROBING`/`'circuit-probing'`; the `CIRCUIT_HALF_OPEN` error code is now `CIRCUIT_PROBING`; `status().status.circuitHalfOpen` and the metrics snapshot's `circuitHalfOpen` are now `circuitProbing`; and the `CIRCUITOPEN` event's `reason: 'half-open-probe-failed'` is now `reason: 'probe-failed'`. Behavior is unchanged — see the [CHANGELOG](./CHANGELOG.md) for the full migration table.

| Breaker | Behavior |
|---|---|
| `SaturationCircuitBreaker` | The default. A windowed failure-rate breaker: fed queue timeouts by the semaphore it trips on saturation (the wiring described above); fed your own signal (via [`reportFailure()`](#feeding-downstream-errors-reportfailure) or standalone) it trips on whatever you define as failure. |
| `NoopCircuitBreaker` | Never trips — the semaphore as a pure limiter, with no load shedding. |
| `ManualCircuitBreaker` | An operator kill switch: `open()` sheds new acquires with `CIRCUIT_OPEN` until `close()`. No cooldown, no probe — recovery is a deliberate action. It gates *new* acquires only; call `cancel()` after `open()` if the queue should be shed too. |

```ts
import { Semaphore, NoopCircuitBreaker, ManualCircuitBreaker } from 'regulo';

// Pure limiter — no breaker bookkeeping at all
const pool = new Semaphore(10, { circuitBreaker: new NoopCircuitBreaker() });

// Ops kill switch
const kill = new ManualCircuitBreaker();
const reports = new Semaphore(20, { circuitBreaker: kill });
// ... later, from an admin endpoint:
kill.open();  // shed load now
kill.close(); // resume
```

To write your own, implement `CircuitBreakerStrategy` and pass an instance as `circuitBreaker`. The contract notes live on the exported type's JSDoc — the essentials: `checkAndTransition()` returns `true` exactly once per open → probing transition, `evaluateAndTrip()` reports closed → open trips (the semaphore then emits `CIRCUITOPEN` and evicts the queue), the probe-slot methods may be no-ops if you never enter probing, and methods must not throw.

### Feeding downstream errors: `reportFailure()`

The default breaker trips on saturation, not on your operation's errors (see [How the circuit breaker works](#how-the-circuit-breaker-works)). If you also want error-driven tripping, report the failures you care about — the same window, threshold, cooldown, and probe recovery apply:

```ts
const semaphore = new Semaphore(10, { circuitBreakerThreshold: 0.3 });

await semaphore.use(async () => {
  try {
    return await callDownstream();
  } catch (error) {
    if (isServerError(error)) semaphore.reportFailure(); // count 5xx-style failures only
    throw error;
  }
});
```

A trip via `reportFailure()` behaves exactly like a saturation trip: queued tasks are evicted with `CIRCUIT_OPEN` and the `CIRCUITOPEN` event fires with `reason: 'reported-failure'`. Reported failures influence trip decisions only while the circuit is closed — probe outcomes remain acquisition-based.

For `use()`-based workloads, `circuitBreakerFailurePredicate` does this declaratively — and goes one step further:

```ts
const semaphore = new Semaphore(10, {
  circuitBreakerFailurePredicate: (error) => isServerError(error),
});

// Matching rejections from fn() count as breaker failures automatically —
// no manual reportFailure() call needed.
await semaphore.use(() => callDownstream());
```

With the predicate set, probes become **fault-aware**: a probe dispatched through `use()` whose operation fails with a matching error re-opens the circuit (the `CIRCUITOPEN` event fires with `reason: 'probe-failed'`) instead of closing it on release. A probe whose rejection does *not* match still counts as a successful probe. The predicate must not throw; a thrown predicate is logged via `console.warn` and the rejection is treated as non-matching. The predicate only observes `use()` — callers using bare `acquire()`/`tryAcquire()` should call `reportFailure()` themselves.

### Standalone usage

`SaturationCircuitBreaker` can be used independently — e.g. to wrap an HTTP client — where you decide what counts as a failure by calling `recordFailure()` on whatever signal you choose:

```ts
import { SaturationCircuitBreaker } from 'regulo';

const circuitBreaker = new SaturationCircuitBreaker({
  threshold: 0.5,
  window: 10000,
  cooldown: 5000,
  minThroughput: 10,
  minFailures: 5,
});

async function fetch(url: string) {
  // Check and transition open → probing if cooldown elapsed
  if (circuitBreaker.checkAndTransition()) {
    console.log('Circuit entering probing');
  }
  if (circuitBreaker.isOpen) throw new Error(`Circuit open, retry in ${circuitBreaker.cooldownRemaining}ms`);

  circuitBreaker.trackAttempt();
  try {
    const result = await httpClient.get(url);
    if (circuitBreaker.isProbing) circuitBreaker.handleProbeSuccess();
    return result;
  } catch (error) {
    circuitBreaker.recordFailure();
    if (circuitBreaker.isProbing) circuitBreaker.handleProbeFailure();
    else circuitBreaker.evaluateAndTrip();
    throw error;
  }
}
```

## Feature Comparison

**Regulo** overlaps with several well-known libraries but sits at the intersection of bounded concurrency, prioritization, and resilience, with built-in observability.

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

## Benchmarks

Full, reproducible benchmarks live in [`benchmarks/`](./benchmarks) — run them
yourself with `npm run benchmark:all`. Figures below are from a real run on
Node v22.16.0, darwin x64, mid-2018 Intel i9 Macbook Pro; your numbers will differ — re-run locally. Each
library from [Feature comparison](#feature-comparison) is benchmarked only on the
axis it actually shares with **Regulo**: the concurrency limiters on capping
concurrency, the circuit breakers on per-call overhead.

**🔥 Fast path, uncontended**

| Scenario | ops/sec | vs. fastest |
|---|--:|---|
| `tryAcquire` + `release` (with metrics) | 3.03M | 1.76x slower |
| `tryAcquire` + `release` | 5.35M | fastest |
| `use()` round-trip | 1.16M | 4.61x slower |
| `use()` round-trip (no metrics) | 1.49M | 3.58x slower |

**🎛️ Weighted acquire, uncontended**

| Scenario | ops/sec | vs. fastest |
|---|--:|---|
| `use()` weight=1 | 1.20M | fastest |
| `use()` weight=4 | 1.18M | 1.01x slower |
| `use()` weight=16 | 1.14M | 1.05x slower |

Weighted permits add no meaningful overhead regardless of weight — claiming
16 burners at once costs about the same as claiming one.

**⏳ Contended throughput** (tasks/sec)

| Scenario | tasks/sec | vs. fastest |
|---|--:|---|
| concurrency=4 | 845.1k | 1.09x slower |
| concurrency=16 | 854.8k | 1.08x slower |
| concurrency=64 | 919.6k | fastest |
| concurrency=16, random priority | 812.9k | 1.13x slower |

**📈 `status()` snapshot cost**

| Queue depth | ops/sec | vs. fastest |
|---|--:|---|
| 0 | 725.6k | 1.03x slower |
| 100 | 747.4k | fastest |
| 1000 | 739.8k | 1.01x slower |

`status()` is O(1) in queue depth — the cost is flat across queue depths (within
run-to-run noise) because queue age is read from an enqueue-ordered index rather
than by cloning and scanning the queue. `status()` is safe to call on a metrics
scrape path for arbitrarily long task queues.

**📊 regulo vs. other libraries — uncontended round-trip**

| Library | ops/sec | vs. fastest |
|---|--:|---|
| cockatiel (bulkhead) | 4.17M | fastest |
| regulo | 1.48M | 2.81x slower |
| p-queue | 1.19M | 3.52x slower |
| p-limit | 1.17M | 3.56x slower |
| regulo (with metrics) | 1.14M | 3.64x slower |

**📊 regulo vs. other libraries — contended throughput @ concurrency=16** (tasks/sec)

| Library | tasks/sec | vs. fastest |
|---|--:|---|
| cockatiel (bulkhead) | 1.73M | fastest |
| p-queue | 1.07M | 1.62x slower |
| regulo | 984.8k | 1.76x slower |
| regulo (with metrics) | 893.7k | 1.94x slower |
| p-limit | 877.1k | 1.98x slower |

**🛡️ Circuit breaker overhead — closed/healthy circuit**

| Library | ops/sec | vs. fastest |
|---|--:|---|
| regulo `ManualCircuitBreaker` | 5.18M | fastest |
| regulo `NoopCircuitBreaker` | 4.68M | 1.11x slower |
| regulo `SaturationCircuitBreaker` | 3.92M | 1.32x slower |
| cockatiel (circuitBreaker) | 2.79M | 1.86x slower |
| opossum | 1.61M | 3.21x slower |

The picture is consistent. Cockatiel's bulkhead is the fastest limiter — and
**Regulo** trades raw limiter throughput for an integrated priority heap, weighted
permits, a pluggable circuit breaker, and (by default) windowed metrics in one
component. Even with metrics *enabled* its uncontended round-trip now sits right
alongside `p-limit` and `p-queue`; with metrics disabled it pulls ahead of both
uncontended and matches them under contention. On the breaker axis the
integration goes the other way: every breaker in **Regulo**'s [breakers
module](#circuit-breakers) adds less per-call overhead than the fault breakers
it is compared against. `NoopCircuitBreaker` and `ManualCircuitBreaker` show the
floor (they do no accounting at all), and even `SaturationCircuitBreaker` — the
default, and the only one keeping a real failure window — stays ahead because it
defers failure accounting to an explicit failure signal instead of bookkeeping a
rolling window on every call.

In practice none of this is the bottleneck. **Regulo** guards work that is *far*
more expensive than the limiter itself: SSR renders, database queries,
downstream API calls, measured in milliseconds. Even at ~890k tasks/sec
under contention the per-task overhead is a few microseconds against operations
thousands of times slower. If you only need a bare concurrency cap on cheap
work in a hot loop, reach for a leaner limiter; see [Feature comparison](#feature-comparison).

## Test coverage

```
npx vitest run --coverage
```

```
 ✓ test/queue.test.ts (9 tests)
 ✓ test/ordering.test.ts (13 tests)
 ✓ test/validation.test.ts (5 tests)
 ✓ test/metrics.test.ts (22 tests)
 ✓ test/permit.test.ts (17 tests)
 ✓ test/backoff.test.ts (8 tests)
 ✓ test/heap.test.ts (10 tests)
 ✓ test/list.test.ts (9 tests)
 ✓ test/breaker.test.ts (23 tests)
 ✓ test/breakers-passthrough.test.ts (4 tests)
 ✓ test/semaphore-edges.test.ts (30 tests)
 ✓ test/semaphore.test.ts (111 tests)

 Test Files  12 passed (12)
      Tests  261 passed (261)
```

```
 % Coverage report from v8
----------------|---------|----------|---------|---------|
File            | % Stmts | % Branch | % Funcs | % Lines |
----------------|---------|----------|---------|---------|
All files       |    99.7 |    97.54 |     100 |     100 |
----------------|---------|----------|---------|---------|
```

## Caveats

Before you crank the dial, know where the edges are:

- **One `Semaphore` is one failure domain.** The circuit breaker and adaptive backoff are per-instance and shared across everything routed through it, so a saturation event on one dependency trips the breaker for *all* work in that instance. Don't multiplex unrelated downstreams or task types through a single `Semaphore` (and don't use `weight`/`priority` to fake it) — use one `Semaphore` per protected resource, or one capacity pool plus a standalone [`SaturationCircuitBreaker`](#circuit-breakers) per downstream key. See [Choosing an ordering](#choosing-an-ordering-and-its-implications).
- **A free permit can sit idle behind a heavier head.** The scheduler never dispatches past a head that doesn't fit, so under [weighted permits](#core-concepts) one heavy task at the head can stall throughput even when there's capacity for the lighter tasks behind it. This is by design (it stops light work starving heavy work); how often it bites depends on your ordering — see [Choosing an ordering](#choosing-an-ordering-and-its-implications).
- **`drain()` without a timeout can block indefinitely** if a permit holder never releases. Always pass `timeoutMs` in graceful-shutdown paths.
- **The circuit breaker is a saturation breaker.** It trips on queue-acquisition timeouts, not on errors thrown by your operation. See [How the circuit breaker works](#how-the-circuit-breaker-works).

## License

[MIT](./LICENSE)
