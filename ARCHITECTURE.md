# Regulo v1.4.0 — Architecture, Correctness, and Complexity Audit

**Subject:** `regulo`, a priority-queue semaphore with an integrated circuit breaker<br/> 
**Version audited:** 1.4.0<br/>
**Scope:** full source tree (`src/`), test suite (`test/`), build configuration, and published documentation (`README.md`, `CHANGELOG.md`)

## How this report was produced

Every claim below was checked directly against the source in `src/`, not inferred from the README alone. Concretely: the full implementation of each subsystem (semaphore, heap, list, backoff, circuit breakers, metrics, validation) was read end to end; the package was rebuilt from a clean `dist/` with `npm run build`; the full test suite (261 tests across 12 files) was run along with `tsc --noEmit` and the coverage report; and the published bundle was measured directly with `gzip` and `brotli` rather than quoted from a badge. Where a number comes from the project's own documented benchmark runs rather than from this audit, that is stated explicitly with its source. Nothing in this document is copied from marketing copy without independent verification.

---

## Table of Contents

1. [What Problem Does Regulo Solve?](#1-what-problem-does-regulo-solve)
2. [Build System and Packaging](#2-build-system-and-packaging)
3. [Core API and Task Lifecycle](#3-core-api-and-task-lifecycle)
4. [Scheduling Internals: Data Structures and Complexity](#4-scheduling-internals-data-structures-and-complexity)
5. [The Single-Timer Watchdog](#5-the-single-timer-watchdog)
6. [Resilience Architecture](#6-resilience-architecture)
7. [Observability](#7-observability)
8. [Backpressure, Memory Safety, and Bulk-Operation Complexity](#8-backpressure-memory-safety-and-bulk-operation-complexity)
9. [Configuration Reference](#9-configuration-reference)
10. [Complexity Summary Table](#10-complexity-summary-table)
11. [Performance Characteristics](#11-performance-characteristics)
12. [Summary and Recommendations](#12-summary-and-recommendations)

---

## 1. What Problem Does Regulo Solve?

Regulo's `package.json` describes it as "a priority-queue semaphore with weighted permits, a saturation circuit breaker, adaptive backoff, and built-in metrics." Each of those five ideas is a well-known pattern on its own; Regulo's contribution is combining them into one class (`Semaphore`) instead of making an application wire four separate libraries together. Before auditing the implementation, it's worth being precise about what each piece means, since the rest of this report leans on this vocabulary throughout.

**A semaphore**, in the classical operating-systems sense, is a counter that gates access to a limited resource: a caller must acquire a *permit* before proceeding and must release it when done, and the semaphore blocks (or rejects) callers once all permits are in use. Regulo's counter is generalized to *weighted* permits — an operation can request more than one permit at a time (`weight`), which is useful when tasks consume the guarded resource unevenly (e.g., a large batch request might reasonably be modeled as "costing" 4 permits out of a pool of 20).

**A priority queue** is the data structure a semaphore needs the moment more callers are waiting than there are permits: something has to decide who gets the next freed permit. Regulo backs its queue with a binary heap (explained in [Section 4](#4-scheduling-internals-data-structures-and-complexity)) so that dispatch order can depend on a caller-supplied `priority`, not just arrival order.

**A circuit breaker** is a pattern for protecting a struggling downstream dependency from a struggling caller: instead of continuing to send requests to a service that is clearly failing (and making the failure worse by piling on load), the breaker "trips" and starts rejecting calls immediately, giving the dependency room to recover, then cautiously tests the water before resuming full traffic. The name comes directly from the electrical device: it interrupts current before something downstream burns out.

**Exponential backoff** is the standard response to repeated failure: rather than retrying (or, here, dispatching) at a constant rate immediately after a failure, wait longer after each additional failure, and shrink that wait once things stabilize. This avoids a "thundering herd," where a burst of retries at a fixed rate re-triggers the very overload that caused the failures.

Regulo's `Semaphore` class wires all four of these together: permits gate concurrency, a binary heap and a linked list jointly manage the wait queue, a pluggable circuit breaker sheds load when the queue itself starts backing up, and a backoff tracker throttles the dispatch rate during sustained trouble. The remainder of this report audits that implementation piece by piece.

---

## 2. Build System and Packaging

### 2.1 Toolchain

| Attribute | Specification | Verified how |
|---|---|---|
| Bundler | [`tsup`](https://tsup.egoist.dev/) (esbuild-based) | `tsup.config.ts`; confirmed by running `npm run build` |
| Output formats | Dual ESM (`dist/index.js`) and CommonJS (`dist/index.cjs`) | `package.json` `exports` map; both files present after build |
| Type declarations | `dist/index.d.ts` (ESM) and `dist/index.d.cts` (CJS), generated by `tsup`'s `dts: true` | Present after build; validated by `attw` (below) |
| Type-checking mode | `strict: true` in `tsconfig.json`, target `ES2020` | Read directly from `tsconfig.json` |
| Type-resolution testing | [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (`attw --pack`) | Ran `npm run lint:package`: all four resolution modes (node10, node16-from-CJS, node16-from-ESM, bundler) report 🟢 |
| Package-shape linting | [`publint`](https://publint.dev/) | Same run: "All good!" |
| Test runner | [`vitest`](https://vitest.dev/) v4, `environment: 'node'` | `vitest.config.ts`; ran `npm test` |
| Coverage provider | `@vitest/coverage-v8` | `vitest.config.ts`; ran `npm run test:coverage` |
| Coverage thresholds enforced | Lines 100%, Functions 100%, Branches ≥ 97% | `vitest.config.ts` `thresholds` block; confirmed by a fresh coverage run (below) |
| Runtime dependencies | **Zero** — no `dependencies` key in `package.json` at all | Read `package.json` directly |
| Node.js floor | `>= 20.0.0` (`engines` field), `tsup` target `node20` | `package.json`, `tsup.config.ts` |

The zero-runtime-dependency design means there is no transitive dependency tree to audit: nothing Regulo does at runtime can be affected by an upstream package's vulnerability disclosure, breaking change, or abandonment, because there is no upstream package. `sideEffects: false` and `treeshake: true` (in `tsup.config.ts`) additionally mean a bundler consuming Regulo's ESM build can drop unused exports.

One clarification worth making precisely, since it's easy to conflate two different kinds of "compatibility": shipping **both ESM and CJS** output is about *module-format* compatibility — it lets a project still using `require()`, or a bundler that doesn't fully understand ESM, consume the package without extra configuration. It says nothing about which *Node.js versions* are supported. That's a separate axis, and on that axis Regulo requires a comparatively recent runtime (Node ≥ 20, released April 2023) — a currently well-supported floor, not "legacy" support. The `engines` field enforces this at install time via package managers that respect it; nothing in the build silently downlevels the output to run on older Node.

### 2.2 Package size

The README states the published bundle is "a single ~34 KB file." A clean rebuild from this audit's copy of the source confirms that figure directly, measured as raw byte counts (KB below is decimal, bytes ÷ 1000) rather than quoted from `tsup`'s own console output:

| Artifact | Size | How measured |
|---|---|---|
| `dist/index.js` (ESM, minified) | 34,410 B ≈ 34.41 KB | `wc -c` on the built artifact |
| `dist/index.cjs` (CJS, minified) | 34,452 B ≈ 34.45 KB | `wc -c` on the built artifact |
| `dist/index.js`, gzip -9 | 8,480 B ≈ 8.48 KB | `gzip -9 -c dist/index.js \| wc -c` |
| `dist/index.cjs`, gzip -9 | 8,491 B ≈ 8.49 KB | same, on the CJS artifact |
| `dist/index.js`, Brotli | 7,661 B ≈ 7.66 KB | `brotli -c dist/index.js \| wc -c` |
| `dist/index.d.ts` / `dist/index.d.cts` (type declarations) | 22,493 B ≈ 22.49 KB each | `wc -c` on the built artifact |

Minification is aggressive by design: `tsup.config.ts` sets `minifyWhitespace`, `minifyIdentifiers`, `minifySyntax`, `legalComments: 'none'`, and `keepNames: false`. This is what gets the runtime payload from the full multi-file TypeScript source down to ~34 KB of minified JavaScript, and to roughly a quarter of that (~8.5 KB) once gzip-compressed in transit — the number that actually matters for cold-start or edge-function download overhead, since HTTP responses are typically served gzip- or brotli-encoded.

---

## 3. Core API and Task Lifecycle

The public surface is the `Semaphore` class (`src/semaphore.ts`). This section walks through its lifecycle methods; complexity for each is summarized in [Section 10](#10-complexity-summary-table).

### 3.1 Construction and validation

`new Semaphore(count, config?)` validates `count` and every numeric config option through a shared `validateNumber()` helper (`src/validation.ts`), which throws `SemaphoreError` with code `INVALID_ARGUMENT` on anything non-numeric, non-integer (where an integer is required), or out of the documented bounds. Several options are additionally cross-validated against each other at construction time — for example, `backoffMaxTimeout` must be `>= backoffInitialTimeout`, and the circuit breaker's `window` must be `>= windowBucketWidth` and span at least two buckets. Constructing a `Semaphore` with an inconsistent configuration therefore fails immediately and synchronously, rather than producing confusing behavior later at runtime.

### 3.2 Acquiring a permit

`acquire(abortSignal?, priority = 0, weight = 1)` is the primary entry point. Before doing anything else, it validates its own arguments independently of the constructor-time checks above:

- `weight` must be an integer between 1 and the semaphore's total capacity — otherwise the returned promise rejects with `INVALID_WEIGHT`.
- `priority` must be a finite number — passing `NaN` or `Infinity` rejects with `INVALID_PRIORITY`. (`Number.isFinite()` is what's checked, so both of those specific values are caught, not just `NaN`.)

If validation passes and a permit is immediately available with nothing else waiting, `acquire()` resolves synchronously-fast (no queueing) with a **release closure** — a zero-argument function that, when called, returns the permit(s) and wakes the scheduler. If no permit is free, or another task is already waiting (see head-of-line fairness below), the call is wrapped in an internal `QueuedTask`, inserted into the wait queue, and the returned promise resolves only once the scheduler dispatches it.

**Double-release safety.** Each release closure closes over a private `released` flag and the semaphore's current "generation" counter. The first call flips the flag, returns the permit, and wakes the scheduler; every subsequent call is a no-op (it logs a warning if `debug: true`, otherwise it's silent). The generation counter exists so that a release closure minted before a `reset()` cannot corrupt state if called after — `reset()` bumps the generation, so any closure from a prior lifecycle silently no-ops instead of returning a permit that no longer conceptually exists. Note that this is a deliberate design choice, not an unavoidable one: because both the one-shot flag and the generation check live on the closure itself, this achieves double-release protection without a `Set<symbol>` or similar bookkeeping structure — one fewer allocation and one fewer collection to maintain per acquire.

### 3.3 `tryAcquire()` — synchronous, strict fairness

`tryAcquire(weight = 1)` never queues: it returns a release closure immediately if a permit is available, or `null` otherwise. Critically, it returns `null` if **any** task is already waiting in the queue, even if enough permits happen to be free — a lighter or newly-arrived caller is never allowed to jump ahead of an already-waiting task just because it happened to ask synchronously. This is what the library calls head-of-line fairness. The one documented exception is the circuit breaker's probing state (see [Section 6.1](#61-circuit-breaker)): a `tryAcquire()` call made while the breaker is probing can become *the* probe itself, since by construction there is nothing else it could validly be granting on the fast path in that state.

### 3.4 `use()` — the recommended entry point

`use(fn, abortSignal?, priority?, weight?)` acquires a permit, runs `fn()`, and releases the permit whether `fn()` resolves or rejects. It is implemented as follows (paraphrased from `src/semaphore.ts`):

```ts
const release = await this._acquire(abortSignal, priority, weight);
try {
  const result = await fn();
  release();
  return result;
} catch (error) {
  // ... optional circuit-breaker failure-predicate handling ...
  release();
  throw error;
}
```

This is a `try`/`catch` with an explicit `release()` call in both branches — **not** a `try`/`finally`, despite that being the more obvious way to guarantee "always release." The reason is ordering: when a `circuitBreakerFailurePredicate` is configured, the `catch` branch needs to feed the failure into the circuit breaker (and, if this acquisition happened to be the breaker's probe, re-open the circuit) *before* the permit is released — a plain `finally` block would run after that logic just as well, but the current structure makes the sequencing explicit at the call site. The externally observable guarantee is the one the README documents: the permit is released exactly once, regardless of how `fn()` finishes.

### 3.5 Administrative methods

| Method | Behavior |
|---|---|
| `drain(timeoutMs?)` | Returns a promise that resolves once the queue is empty **and** every outstanding permit has been released. If `timeoutMs` is given and elapses first, the promise rejects with a `TIMEOUT` error instead of hanging forever on a lost release closure. Multiple concurrent callers share the same underlying promise. |
| `reset(options?)` | Rejects every queued task with a `SHUTDOWN` error and restores the semaphore (permits, backoff, circuit breaker, lifetime counters) to its constructed state. Event listeners are preserved unless `{ clearListeners: true }` is passed. Throws if the semaphore has already been permanently `shutdown()` — `reset()` cannot revive a shut-down instance. |
| `cancel()` | Rejects every currently queued task with a `CANCELLED` error. Tasks that already hold a permit and are mid-flight are completely unaffected, and the semaphore remains open for new work afterward. |
| `shutdown(reason?)` | Permanently disables the semaphore: rejects everything queued, and every future `acquire()`/`use()`/`tryAcquire()` call is refused from then on. Unlike `reset()`, this cannot be undone. |
| `reportFailure()` | Feeds one external failure signal (e.g., a downstream HTTP 5xx) into the circuit breaker's trip evaluation, independent of the queue-timeout signal the breaker normally watches. See [Section 6.1](#61-circuit-breaker). |
| `peekQueue()` | Returns a read-only, enqueue-ordered snapshot of everything currently waiting, for diagnostics. |
| `status()` | A snapshot of live state, lifetime counters, and windowed metrics. See [Section 7.1](#71-metrics). |

### 3.6 Error codes

Every rejection Regulo produces carries a `.code` on a `SemaphoreError` (which extends `Error`, so ordinary `instanceof Error` handling still works):

| Code | Raised when |
|---|---|
| `INVALID_ARGUMENT` | A constructor/config value fails validation, or `drain()` is given an invalid timeout (thrown synchronously, not a rejection) |
| `INVALID_WEIGHT` | `weight` is not an integer in `1..count` |
| `INVALID_PRIORITY` | `priority` is not a finite number |
| `CIRCUIT_OPEN` | The circuit breaker is open; the call was shed immediately |
| `CIRCUIT_PROBING` | The breaker is probing and a probe is already in flight (see [Section 6.1](#61-circuit-breaker)) |
| `QUEUE_FULL` | Either `rejectOnFull` is `true` and no permit was free, or the queue was already at `queueMaxLength` |
| `TIMEOUT` | A queued task waited longer than `queueMaxTimeout`, or `drain()` exceeded its own deadline |
| `ABORTED` | The caller's `AbortSignal` fired while the task was queued |
| `CANCELLED` | The task was queued when `cancel()` was called |
| `SHUTDOWN` | `shutdown()` (or `reset()`) ran while the task was queued, or an operation was attempted on an already shut-down instance |
| `PURGED` | The background stale-task sweep evicted the task after `queueMaxAge` (see [Section 8.2](#82-the-purge-sweep)) |

---

## 4. Scheduling Internals: Data Structures and Complexity

Regulo needs to answer two different questions about its wait queue at different moments: *"who dispatches next?"* (priority order) and *"who has been waiting longest?"* (arrival order, needed for age-based logic like the purge sweep and `status()`'s queue-age reading). Rather than picking one structure and paying to reconstruct the other view when needed, Regulo maintains two structures over the same set of tasks at all times: a **binary heap** for priority order, and a **doubly linked list** for arrival order. Every task lives in both, or neither — `_enqueue()`/`_dequeue()` are the only two places tasks are added to or removed from the queue (aside from the scheduler's dispatch loop, which pops the heap directly and then removes the same task from the list), so the two structures cannot drift out of sync.

### 4.1 The priority heap

A **binary heap** is a complete binary tree stored compactly in a flat array, where each node's children live at fixed index offsets (`2i+1` and `2i+2` for a node at index `i`) — no pointers needed. A *min-heap* additionally maintains the invariant that every node compares less than or equal to its children, which means the array's first element is always the minimum (here: the next task to dispatch). Inserting or removing an element may require "sifting" it up or down past its neighbors to restore that invariant, and because the tree has height `⌊log₂ n⌋` for `n` elements, each sift touches at most `O(log n)` nodes. This is the standard textbook data structure behind priority queues, and it's exactly what `IndexedBinaryHeap<T>` (`src/heap.ts`) implements.

The one non-obvious refinement is **arbitrary-element deletion**. A textbook heap normally only supports popping the root; Regulo also needs to remove a specific task from the middle of the heap on demand (a task can be cancelled, aborted, or purged while sitting anywhere in the queue, not just at the front). Deleting an arbitrary element from a heap is still `O(log n)` — swap it with the last element, shrink the array, then sift the swapped-in element up or down as needed — but doing so requires knowing that element's *current* array index, which changes every time a sift happens anywhere near it.

Regulo solves this by having each queued task carry its own `heapIndex` field, updated by the heap on every swap. This is called an **intrusive** index, because the bookkeeping lives on the element itself rather than in a separate structure the heap owns. The alternative would be a `Map<taskId, arrayIndex>` maintained alongside the array. **It's worth being precise about what this optimization does and doesn't change**: both approaches are `O(log n)` for insert, delete, and pop — the intrusive index does not change the asymptotic complexity class. What it changes is the constant factor and allocation profile: writing `task.heapIndex = i` is a direct property store, while `map.set(id, i)` involves hashing the key, a bucket lookup, and possible rehashing as the map grows, on every single sift step during every insert and delete. The project's own benchmark suite measures this as a further ~25–30% contended-throughput improvement over the non-intrusive version (see [Section 11](#11-performance-characteristics)) — a meaningful constant-factor win, not a different Big-O class.

### 4.2 The enqueue-ordered list

`IntrusiveList<T>` (`src/list.ts`) is a doubly linked list using the same trick: `prev`/`next` pointers live directly on each task object instead of in separate wrapper nodes. Given a direct reference to a member node (which Regulo always has, since it's the same task object indexed in the heap), appending to the tail or unlinking a node is `O(1)` — no traversal needed, because there's no searching for the node; it's already in hand. The list is kept strictly in arrival order, which gives two things "for free":

- `status()` can read the age of the oldest queued task in `O(1)`: it's just `Date.now() - list.peekHead().enqueueTime`.
- The stale-task purge sweep ([Section 8.2](#82-the-purge-sweep)) can walk from the head and stop at the first task young enough to keep, since ages only decrease (or stay equal) moving toward the tail — nothing further along the walk can be *older* than a task it has already decided to keep — so there's no need to scan the whole queue.

### 4.3 Data structure complexity at a glance

| Structure | Operation | Complexity | Notes |
|---|---|---|---|
| `IndexedBinaryHeap` | `insert` | O(log n) | Sift-up after appending |
| | `pop` (remove minimum) | O(log n) | Swap-with-last then sift-down |
| | `delete(item)` (arbitrary element) | O(log n) | Enabled by the intrusive `heapIndex` |
| | `peek` | O(1) | Just reads index 0 |
| | `has(item)` | O(1) | Index bounds + identity check |
| | `clear` | O(n) | Resets every element's `heapIndex`, then drops the array |
| `IntrusiveList` | `pushTail` | O(1) | |
| | `remove(item)` | O(1) | Given a direct reference — no search |
| | `peekHead` | O(1) | |
| | `clear` | O(1) | Just nulls `head`/`tail` and zeroes the size counter |

---

## 5. The Single-Timer Watchdog

A queued task that waits too long should time out — but naively, that means arming one `setTimeout` per queued task and clearing it if the task dispatches or is cancelled first. Under sustained load with a deep queue, that's `O(n)` live timer objects at any given moment, each costing an insertion into (and likely a removal from) Node's internal timer data structure. Regulo avoids this with a single shared timer, justified by a short argument:

Let every queued task's arrival time be $t_i$, for tasks numbered in the order they were enqueued, so that:

$$t_0 \le t_1 \le t_2 \le \dots \le t_{n-1}$$

Every task in a given semaphore shares the *same* configured `queueMaxTimeout`, call it $T$. So each task's expiration deadline is:

$$D_i = t_i + T$$

Because $T$ is a constant added to both sides of every inequality above, the deadlines inherit the same ordering as the arrival times:

$$D_0 \le D_1 \le D_2 \le \dots \le D_{n-1}$$

(These are "≤," not strict "<" — two tasks enqueued at the same millisecond have equal deadlines, and the argument still holds; the correct description is that deadlines are **monotonically non-decreasing** in arrival order, not *strictly* increasing.)

The consequence: the task with the earliest deadline is *always* the one at the head of the arrival-ordered list — the same `IntrusiveList` from [Section 4.2](#42-the-enqueue-ordered-list). So Regulo only ever needs one live timer, armed for the current head's deadline. When that timer fires, it evicts every task whose deadline has now passed (usually just the one, but possibly a short burst if several arrived within the same instant), then re-arms itself for the new head's deadline — or does nothing if the queue is empty. When the head is dispatched or removed by some other path (cancellation, abort, an earlier purge), the timer is left pointing at a deadline that's now moot; it simply fires a little early, finds nothing actually expired yet, and re-arms against the real new head. It can never fire *late*, because the new head's deadline is never earlier than the stale one it was armed against.

**Complexity:** one live timer at all times, versus `O(n)` in the naive per-task design — arming and clearing are both `O(1)` (they only ever touch the list head), and a firing event is `O(k)` for `k` tasks expiring in that instant, which is `O(1)` amortized per task over the queue's lifetime, since each task can only expire once.

The project's own benchmark suite attributes a 15–19% contended-throughput improvement to this design, specifically to removing the per-task timer churn — see [Section 11](#11-performance-characteristics) for sourcing.

---

## 6. Resilience Architecture

### 6.1 Circuit breaker

Regulo's default breaker (`SaturationCircuitBreaker`, in `src/breakers/saturation.ts`) differs from a conventional circuit breaker in *what it watches*. A conventional breaker counts application-level failures — thrown exceptions, HTTP 5xx responses. That signal misses a common and dangerous failure mode: a downstream dependency that is still returning 200s, just slower and slower, until requests pile up behind it. Regulo's default breaker instead watches **queue-wait timeouts** — the rate at which tasks are giving up before ever getting a permit — which is a direct measurement of the thing actually being protected (the wait queue itself backing up), independent of whether the eventual operation would have "succeeded" or "failed" in an application sense.

The breaker is a three-state machine: **Closed**, **Open**, and **Probing**.

```
                    +---------------------------+
                    |          CLOSED           | <=====================+
                    |     (normal dispatch)      |                      |
                    +---------------------------+                       |
                                 |                                      |
                                 | timeout rate exceeds                 |
                                 | circuitBreakerThreshold              | probe
                                 | (with minThroughput/                 | succeeds
                                 |  minFailures guards met)             |
                                 v                                      |
                    +---------------------------+                       |
                    |           OPEN             |                      |
                    |  (reject every acquire      |                     |
                    |   immediately)              |                     |
                    +---------------------------+                       |
                                 |                                      |
                                 | circuitBreakerCooldown elapses       |
                                 v                                      |
                    +---------------------------+                       |
                    |          PROBING          | ----------------------+
                    |  (exactly one canary      |
                    |   request admitted; every |
                    |   other acquire still     | -- probe fails or ----+
                    |   rejected)               |    times out          |
                    +---------------------------+                       |
                                 ^                                      |
                                 |                                      |
                                 +--------------------------------------+
                                         (restarts the full cooldown)
```

**Closed** is normal operation: every admission is tracked in a sliding time window, and if the fraction of admissions that time out crosses `circuitBreakerThreshold`, the breaker trips — but only once at least `circuitBreakerMinThroughput` admissions and `circuitBreakerMinFailures` timeouts have been observed in the window, so a single timeout under near-zero traffic can't trip the breaker.

**Open** rejects every `acquire()`/`use()`/`tryAcquire()` call immediately with `CIRCUIT_OPEN`, without touching the queue at all. Anything already queued at the moment of the trip is evicted right away (rejected with `CIRCUIT_OPEN` rather than being left to time out on its own clock) — the one exception being a live probe task, which is deliberately left alone (more on that below).

**Probing** admits exactly **one** request as a live canary; every other call is still rejected. Once `circuitBreakerCooldown` has elapsed, the *next* call to `acquire()` or `tryAcquire()` transitions the breaker into this state. What happens to that same call next depends on how it asked: an `acquire()`/`use()` call always becomes the probe, immediately if a permit is free or as a queued probe (jumping straight to the front of the priority queue) if not — because `acquire()` is allowed to wait. A `tryAcquire()` call, which never queues, only becomes the probe if a permit happens to be free at that exact instant; if not, it simply returns `null`, the breaker is left in Probing with no probe yet claimed, and the next call capable of claiming one (another `tryAcquire()` with capacity, or any `acquire()`) becomes the probe instead. Either way, exactly one request is ever admitted as the live canary at a time — any further `acquire()`/`use()` call arriving while that probe is already in flight is rejected with the dedicated `CIRCUIT_PROBING` code (a `tryAcquire()` in the same situation just returns `null`, as it does for every other rejection reason). If the probe succeeds, the breaker closes and its failure window resets. If the probe fails or times out, the breaker returns straight to Open and restarts the full cooldown.

#### Sliding window complexity

The failure-rate window (`CircuitBreakerEventWindow` in `src/breakers/saturation.ts`) is a fixed-size ring of buckets — `windowBucketCount = ⌈window / windowBucketWidth⌉` of them (10, with the defaults of a 10-second window in 1-second buckets), each just two integer counters (admissions, timeouts). Recording an event is `O(1)` (resolve the current bucket, increment); evaluating the trip condition sums across all buckets, which is `O(w)` for `w` buckets — a small **fixed constant**, not something that grows with request volume. Contrast this with the naive alternative of storing every event's timestamp and filtering by age on each check, which would be `O(events in the window)` per check and use unbounded memory as traffic grows. The bucketed design trades a small amount of time resolution (events within the same bucket-width are indistinguishable) for genuinely constant memory and per-check cost.

#### Pluggability

The breaker behind a `Semaphore` is not fixed. `CircuitBreakerStrategy` (`src/types.ts`) is an exported interface, and the semaphore drives whatever implements it through exactly that contract. Three implementations ship in `src/breakers/`:

- **`SaturationCircuitBreaker`** — the default, described above.
- **`NoopCircuitBreaker`** — never trips; useful when only the bounded-concurrency/priority-queue behavior is wanted, with no load-shedding.
- **`ManualCircuitBreaker`** — a pure operator kill switch (`open()`/`close()`), with no cooldown, no automatic recovery, and no probing state at all — recovery is a deliberate human action.

A `Semaphore` can also be told about failures it wouldn't otherwise see: `reportFailure()` feeds one external failure signal (e.g., a downstream 5xx) into the same trip evaluation a queue timeout would trigger, and the `circuitBreakerFailurePredicate` config option automates this for `use()` — a rejection from the wrapped function that matches the predicate counts as a breaker failure, and additionally makes an in-flight probe "fault-aware" (a probe whose *operation* fails, not just times out, re-opens the circuit instead of closing it on release).

### 6.2 Adaptive backoff

Independent of the circuit breaker's binary open/closed decision, `BackoffTracker` (`src/backoff.ts`) throttles *how fast* the scheduler dispatches queued work during a burst of timeouts, and eases that throttle back down once things quiet down. Two rules govern it:

**Growth**, on each timeout: the delay doubles from its current (already-decayed) value, or starts at `backoffInitialTimeout` if it was previously zero — capped at `backoffMaxTimeout`.

**Decay**, continuously, based on wall-clock time rather than events: at any moment $t$, the delay is

$$\text{delay}(t) = \text{delay}_{\text{last}} \cdot \gamma^{\Delta t}$$

where $\text{delay}_{\text{last}}$ is the delay as of the most recent timeout, $\gamma$ is `backoffDecayFactor` (constrained to the open interval $(0, 1)$), and $\Delta t$ is the elapsed time in seconds since that timeout. Because decay is a function of *elapsed wall-clock time* rather than "the next event," the delay genuinely relaxes back toward zero on its own once timeouts stop — a purely event-driven scheme (only re-evaluating on the next timeout) would leave the delay pinned at its last value indefinitely if timeouts simply stopped occurring, which is precisely the case backoff is supposed to relax for.

Both `currentDelay` reads and `onTimeout()` updates are `O(1)` — a single `Math.pow` call and a couple of arithmetic comparisons, regardless of queue depth or how long it's been since the last timeout.

---

## 7. Observability

### 7.1 Metrics

`status()` returns a snapshot of live state, lifetime counters, and windowed metrics in one call. Live state fields (`running`, `queued`, `available`, `circuitOpen`, `circuitProbing`, the oldest queued task's age, and so on) are all `O(1)` field or getter reads — none of them scan the queue.

The windowed metrics are more subtle. By default, Regulo tracks five rolling horizons — 1 minute, 5 minutes, 15 minutes, 1 hour, and 24 hours — each internally divided into 60 fixed buckets (so a bucket in the 1-minute window covers 1 second, while a bucket in the 24-hour window covers 24 minutes). Recording an acquire, release, or timeout is `O(1)`: resolve the current bucket for each of the five windows (cached between calls, recomputed only on a bucket rollover) and increment a few counters. Reading a full snapshot via `getSnapshot()` sums across every bucket of every window — a fixed 5 × 60 = 300 array reads, regardless of how deep the queue is, how many permits are in flight, or how many requests have been served over the semaphore's lifetime.

This is what the project means by `status()` being "`O(1)`," and it's worth being precise about the claim rather than repeating it uncritically: it is `O(1)` *with respect to queue depth, in-flight count, and lifetime request volume* — the quantities that would make a naive metrics implementation (one that, say, scanned the live queue or kept a growing log of timestamped events) slow down as load increases. It is technically `O(w)` in the number of *configured* metrics buckets, but `w` is a small constant fixed at construction time (300 by default) that never grows with traffic. That distinction is exactly why `status()` is safe to call from a high-frequency Prometheus scrape endpoint even while the queue is deeply backed up — the cost of the call doesn't depend on how backed up it is.

Four kinds of data are tracked per window:

| Metric | What it measures | What it does *not* measure |
|---|---|---|
| Throughput (`counts.acquired` / `.released`) | Volume of permits granted/returned in the window | — |
| **Latency** (`latency.avg`) | Average **queue-wait time** — milliseconds from `enqueueTime` to the moment a queued task acquires its permit | **Not** the duration of the caller's own operation. `use()` never times how long `fn()` takes to run; there is no hook around the wrapped function's execution at all. If you need end-to-end operation latency, time `fn()` yourself. |
| Queue depth (`queue.avg` / `.max`) | Queue length sampled at each tracked event | — |
| In-flight count (`inflight.avg` / `.max`) | Permits currently consumed, sampled at each tracked event | — |

If `metricsEnabled: false`, none of this bookkeeping runs — `metricsCollector` is simply `undefined`, and every call site that would have updated it is skipped via an `undefined` check, restoring the same clock-read profile as a bare, un-instrumented limiter.

### 7.2 Event stream

`Semaphore` extends a small internal event emitter (`on`/`off`/`removeAllListeners`), and events fire unconditionally — `debug: true` controls console logging, not which events are dispatched. The full set, with exact payload types as declared in `src/types.ts`:

| Constant | String value | Payload | Fires when |
|---|---|---|---|
| `TASKACQUIRE` | `'task-acquire'` | `{ queued: number; running: number; probe?: boolean }` | A task acquires its permit(s). `probe` is present and `true` only when the admission was the circuit breaker's probe; it is omitted (not `false`) otherwise. |
| `TASKRELEASE` | `'task-release'` | `{ queued: number; running: number }` | A task's permit(s) are released. |
| `TASKTIMEOUT` | `'task-timeout'` | `{ queueLength: number; backoffDelay: number; taskId: number }` | A queued task exceeds `queueMaxTimeout`. Note `taskId` is a `number` (an internal monotonic counter), not a string. |
| `TASKABORT` | `'task-abort'` | none | A queued task's `AbortSignal` fires. |
| `QUEUEPURGE` | `'queue-purge'` | `QueuedTaskView` — `{ id, priority, enqueueTime, weight }` | The background purge sweep evicts a stale task. The payload is the narrow, read-only `QueuedTaskView` shape — not the internal `QueuedTask` instance, which additionally carries heap/list pointers and one-shot finalization methods that a listener has no legitimate reason to touch. |
| `QUEUEEVICT` | `'queue-evict'` | `QueuedTaskView` | A queued (non-probe) task is evicted because the circuit just tripped to Open while it was waiting. |
| `CIRCUITOPEN` | `'circuit-open'` | `{ timeoutRate: number; recentTimeouts: number; total: number; reason?: string }` | The breaker trips to Open. `reason` is present (e.g. `'probe-failed'`, `'reported-failure'`) only on some trip paths — a plain saturation trip from the Closed state carries no `reason` field at all. |
| `CIRCUITPROBING` | `'circuit-probing'` | none | The breaker transitions from Open into Probing. |
| `CIRCUITCLOSE` | `'circuit-close'` | none | The probe succeeds and the breaker returns to Closed. |
| `SHUTDOWN` | `'shutdown'` | `reason: string` | `shutdown()` is called. |

Two details worth calling out because they're easy to get wrong by skimming rather than reading the type declarations: several payload fields (`probe`, `reason`) are genuinely *optional* — code that assumes they're always present will misbehave on the common case where they're simply absent, not present-and-`false`. And `QUEUE_EVICT` is a distinct event from `QUEUE_PURGE` — one is the circuit breaker shedding queued load on a trip, the other is the janitorial stale-task sweep — a monitoring setup that only listens for one will silently miss the other.

---

## 8. Backpressure, Memory Safety, and Bulk-Operation Complexity

### 8.1 Bounded queue

An unbounded wait queue in front of a stalled downstream dependency is a classic way to run out of memory: every pending `acquire()` call holds a promise (and everything closed over by its caller) in memory indefinitely. Regulo bounds this by default: `queueMaxLength` (default 1024) caps how many tasks may wait at once, and once full, further `acquire()` calls reject immediately with `QUEUE_FULL`. For workloads that genuinely want an unbounded queue, the option accepts `Number.MAX_SAFE_INTEGER` as an explicit escape hatch — this is documented in the type's own JSDoc, not an undocumented workaround.

A related but distinct option, `rejectOnFull` (default `false`), rejects immediately whenever *no permit is free*, bypassing the queue entirely regardless of how empty it is — a fail-fast mode for callers who would rather get an immediate error than wait at all. `queueMaxLength` and `rejectOnFull` both raise `QUEUE_FULL`, but are triggered by different conditions: one caps the backlog, the other refuses to form a backlog at all.

### 8.2 The purge sweep

Independent of the per-task timeout described in [Section 5](#5-the-single-timer-watchdog), a background interval (every `purgeIntervalMs`, default 3000 ms) sweeps for tasks that have been queued longer than `queueMaxAge` (default 30000 ms) and evicts them with a `PURGED` error — a backstop against a task whose own timeout somehow never fired, or whose release closure was lost. Because the enqueue-ordered list ([Section 4.2](#42-the-enqueue-ordered-list)) guarantees ages are non-increasing from the head, the sweep walks from the head and stops at the first task still young enough to keep — its cost is `O(s)` for `s` tasks actually evicted that tick, not `O(n)` for the queue's total size. A queue that's entirely healthy costs the sweep nothing beyond a single age check.

Purged tasks are counted separately from timeouts (`totalPurged`, distinct from `totalTimeouts`) and do **not** feed the circuit breaker's failure window — `queueMaxAge` is meant as a backstop far above the normal timeout, not a second saturation signal, so a healthy system tripping its own `queueMaxTimeout` regularly should never be relying on the purge sweep to notice.

### 8.3 Bulk rejection: `cancel()`, `reset()`, `shutdown()`, and circuit-trip eviction

Four paths reject every queued task at once: `cancel()`, `reset()`, `shutdown()`, and the circuit breaker's own `_evictQueueOnCircuitOpen()`. All four walk the `enqueueOrder` list directly rather than copying the heap into an array first, and all four bulk-clear both indexes in one pass rather than removing tasks one at a time — the difference between them is only in *whether* a bulk clear is safe to take unconditionally:

- `cancel()`, `reset()`, and `shutdown()` reject every queued task unconditionally, including a live probe if one happens to be queued. Each is `O(n)`: one pass over the list rejecting every task (`O(1)` each — nothing here touches the heap), followed by a single bulk `heap.clear()` and `list.clear()`.
- `_evictQueueOnCircuitOpen()` has one more constraint: it must *not* evict a live probe, since dropping it would wedge the circuit in the probing state permanently with no task left to dispatch and close it. It takes the same `O(n)` bulk-clear path whenever no probe is queued — the only case a compliant breaker ever reaches this method in, since a probe can only exist while probing and a trip can only occur from closed, so the two conditions never coincide for the built-in `SaturationCircuitBreaker` (or any correctly-implemented custom one). A slower, selective `O(n log n)` fallback — removing tasks one at a time via the heap's arbitrary-element `delete()`, skipping the probe — exists purely as a defensive backstop against a custom `CircuitBreakerStrategy` that violates that contract.

At Regulo's default `queueMaxLength` of 1024, even that defensive fallback is cheap in absolute terms — `log₂(1024) = 10`, so a worst-case full-queue eviction is on the order of ten thousand basic operations, comfortably sub-millisecond — but it is worth knowing that path is a backstop for a misbehaving breaker, not the normal cost of a circuit trip.

### 8.4 Single failure domain: an architectural risk, not a bug

A single `Semaphore` instance is one shared failure domain: its circuit breaker and backoff tracker accumulate signal across *everything* routed through that instance, because they are simply fields on that one object. This is a design property to plan around, not a defect.

**Concrete risk:** routing two unrelated workloads through one shared `Semaphore` — say, a fast authentication check and a slow PDF-rendering job — means a slowdown in the slow workload (timeouts piling up from the PDF renderer) can trip the *shared* breaker, which then also rejects the authentication traffic outright, even though nothing is actually wrong with authentication. The breaker has no way to distinguish "this workload is struggling" from "some workload sharing my instance is struggling," because it only ever sees the aggregate.

**Mitigation:** give each distinct downstream dependency, integration point, or workload class its own dedicated `Semaphore` instance. This is cheap (the class itself is lightweight) and it's what makes each breaker's saturation signal actually mean something specific.

---

## 9. Configuration Reference

All twenty-one `SemaphoreConfig` options (everything passed as the constructor's second, optional argument — distinct from `count`, the required first argument setting total permit capacity), with defaults and validation bounds as enforced in `src/semaphore.ts`, `src/breakers/saturation.ts`, and `src/backoff.ts`:

| Option | Type | Default | Bounds enforced at construction | Purpose |
|---|---|---|---|---|
| `queueMaxLength` | `number` | `1024` | integer ≥ 1 | Backpressure cap; further acquires reject `QUEUE_FULL` once reached |
| `queueMaxTimeout` | `number` (ms) | `10000` | integer ≥ 1 | How long a queued task waits before `TIMEOUT` |
| `queueMaxAge` | `number` (ms) | `30000` | integer ≥ 1 | Backstop age for the purge sweep, independent of `queueMaxTimeout` |
| `rejectOnFull` | `boolean` | `false` | — | Reject immediately with no free permit, bypassing the queue |
| `purgeIntervalMs` | `number` (ms) | `3000` | integer ≥ 500 | How often the stale-task sweep runs |
| `circuitBreakerThreshold` | `number` | `0.5` | `(0, 1)` exclusive | Timeout-rate fraction that trips the breaker |
| `circuitBreakerWindow` | `number` (ms) | `10000` | integer ≥ 1000, and ≥ `windowBucketWidth` | Sliding window over which the rate is computed |
| `circuitBreakerWindowBucketWidth` | `number` (ms) | `1000` | integer ≥ 1 | Bucket granularity; bucket count = `window / windowBucketWidth`, must be ≥ 2 |
| `circuitBreakerCooldown` | `number` (ms) | `5000` | integer ≥ 1000 | How long the breaker stays Open before probing |
| `circuitBreakerMinThroughput` | `number` | `10` | integer ≥ 1, and ≥ `minFailures` | Minimum admissions in-window before a trip can occur at all |
| `circuitBreakerMinFailures` | `number` | `5` | integer ≥ 1 | Minimum timeouts in-window before a trip can occur at all |
| `circuitBreaker` | `CircuitBreakerStrategy` | — | must implement the interface | Inject a custom/alternate breaker; overrides all `circuitBreaker*` numeric options |
| `circuitBreakerFailurePredicate` | `(error: unknown) => boolean` | — | must be a function if provided | Declarative fault-scoring for `use()`; see [Section 6.1](#61-circuit-breaker) |
| `backoffInitialTimeout` | `number` (ms) | `50` | integer ≥ 0 | Delay applied on the first timeout of a burst |
| `backoffMaxTimeout` | `number` (ms) | `2000` | integer ≥ 0, and ≥ `initialTimeout` | Ceiling on the backoff delay |
| `backoffDecayFactor` | `number` | `0.5` | `(0, 1)` exclusive | Per-second decay multiplier, $\gamma$ in [Section 6.2](#62-adaptive-backoff) |
| `metricsEnabled` | `boolean` | `true` | — | Enable windowed metrics collection |
| `metricsWindows` | `WindowOptions[]` | built-in 1m/5m/15m/1h/24h set | each `{ size, stepMs }`; no two windows may share a horizon | Overrides the windows behind `status().metrics` |
| `queueOrder` | `'fifo' \| 'lifo' \| 'fifoWithPriority' \| 'lifoWithPriority'` | `'fifoWithPriority'` | must be one of the four (or a valid custom string) | Dispatch ordering preset; ignored if `comparator` is set |
| `comparator` | `(a, b) => number` | — | must be a function if provided | Custom total order over queued tasks; overrides `queueOrder` |
| `debug` | `boolean` | `false` | — | Console logging and the permit-pool invariant assertion; does **not** gate which events fire |

Two cross-field rules enforced at construction (not just documented, but actually thrown as `INVALID_ARGUMENT` if violated): `backoffMaxTimeout >= backoffInitialTimeout`, and `circuitBreakerMinThroughput >= circuitBreakerMinFailures`. Misconfiguring either fails fast at `new Semaphore(...)` time rather than producing confusing behavior under load later.

**Operational recommendation:** keep `queueMaxAge` comfortably above `queueMaxTimeout` (the defaults already do — 30 s vs. 10 s). This isn't enforced by the constructor, but it's what lets the fast, precise per-task watchdog ([Section 5](#5-the-single-timer-watchdog)) handle the normal timeout case, with the purge sweep acting purely as a backstop for tasks that somehow evaded it — rather than the coarser, janitorial sweep routinely doing the watchdog's job.

---

## 10. Complexity Summary Table

A consolidated reference for every operation discussed above, `n` = number of tasks currently queued, `w` = a small fixed configuration constant (window bucket count), `k`/`s` = the number of tasks actually affected by one call (output-sensitive):

| Operation | Complexity | Source |
|---|---|---|
| `tryAcquire()` / `acquire()`, fast path (permit free, queue empty) | O(1) | §3.2–3.3 |
| `acquire()`, queued path | O(log n) | Heap insert, §4.1 |
| `release()` (the returned closure) | O(1) | Permit arithmetic only; does not itself pop the heap |
| Scheduler dispatch, per task dispatched | O(log n) | Heap pop, §4.1 |
| `tryAcquire()` returning `null` due to a non-empty queue | O(1) | Just checks `queue.size` |
| Heap `insert` / `pop` / `delete(item)` | O(log n) | §4.1, §4.3 |
| Heap `peek` / `has` | O(1) | §4.3 |
| Heap `clear` | O(n) | §4.3 |
| List `pushTail` / `remove(item)` / `peekHead` | O(1) | §4.2, §4.3 |
| List `clear` | O(1) | §4.3 |
| Timeout watchdog arm/clear | O(1) | §5 |
| Timeout watchdog fire | O(k) amortized O(1)/task | §5 |
| Purge sweep, per tick | O(s) | §8.2 |
| Circuit breaker `trackAttempt` / `recordFailure` | O(1) amortized | §6.1 |
| Circuit breaker `evaluateAndTrip` | O(w), w = window bucket count (10 default) | §6.1 |
| Backoff `currentDelay` / `onTimeout` | O(1) | §6.2 |
| `status()` | O(1) live state + O(w), w = 300 default | §7.1 |
| `peekQueue()` | O(n) | Walks the full list once |
| `cancel()` / `reset()` / `shutdown()` | O(n) | §8.3 |
| `_evictQueueOnCircuitOpen()` (internal) | O(n), or O(n log n) on the defensive fallback | §8.3 |

---

## 11. Performance Characteristics

Regulo ships its own reproducible benchmark suite (`benchmarks/`), measuring the semaphore against `p-limit` and `p-queue`, and its circuit breakers against `cockatiel` and `opossum`. The figures below are the project's own documented measurements, reproduced here with attribution rather than re-measured for this report:

- The single shared timeout watchdog ([Section 5](#5-the-single-timer-watchdog)) measurably lifts contended throughput by roughly 15–19% relative to a per-task-timer design.
- The intrusive heap index ([Section 4.1](#41-the-priority-heap)) contributes a further ~25–30% on top of that, with deeper queues benefiting most. With metrics disabled, Regulo's contended throughput then sits alongside `p-limit`'s and `p-queue`'s.
- Current-bucket caching in the metrics and circuit-breaker sliding windows ([Section 6.1](#61-circuit-breaker), [Section 7.1](#71-metrics)) keeps per-event overhead low: uncontended `tryAcquire`+`release` and `use()` round-trips both stay close to an un-instrumented baseline, with contended throughput benefiting by roughly 30–50%.

The fast paths are not entirely free of bookkeeping: with the default `SaturationCircuitBreaker`, every admission reads the clock once (a read shared with the metrics rollup when `metricsEnabled` is on) so the admission can be bucketed into the breaker's sliding failure window ([Section 6.1](#61-circuit-breaker)). Callers who only want bounded concurrency with no load-shedding can inject `NoopCircuitBreaker` instead, which skips this bucketing and restores a clock-free fast path.

This report's own verification, run against the current source on Node v22.16.0 / darwin x64:

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean, no errors |
| `npm test` (vitest) | 261/261 tests passing across 12 files |
| `npm run test:coverage` | Statements 99.7%, Branches 97.54%, Functions 100%, Lines 100% — all above the configured thresholds |
| `npm run lint:package` (`publint` + `attw --pack`) | `publint`: "All good!"; `attw`: 🟢 across node10, node16-from-CJS, node16-from-ESM, and bundler resolution |
| Clean `npm run build` | Succeeds; produces the artifact sizes in [Section 2.2](#22-package-size-measured-not-quoted) |

No throughput re-benchmarking was performed as part of this report beyond the correctness/build checks above; the percentage figures above are the project's own documented measurements.

---

## 12. Summary and Recommendations

Regulo (v1.4.0) is a small, dependency-free, carefully validated concurrency primitive that goes meaningfully beyond a plain "cap N concurrent calls" limiter: a priority-aware wait queue with fairness guarantees, a saturation-driven circuit breaker with a Closed/Open/Probing state machine, wall-clock-decaying backoff, and windowed metrics, all built on data structures chosen and specialized (intrusively indexed) specifically for this workload rather than borrowed off the shelf unmodified. The codebase's own internal comments consistently match its actual behavior — a good sign for a library whose failure modes matter — and every claim in this report that could be independently checked (type-checking, tests, coverage, package size, event/error shapes) was checked directly rather than taken on faith.

Recommendations for production use:

1. **One `Semaphore` per failure domain.** Never multiplex unrelated downstream dependencies through a single instance — see [Section 8.4](#84-single-failure-domain-an-architectural-risk-not-a-bug).
2. **Keep `queueMaxAge` well above `queueMaxTimeout`.** The defaults (30 s vs. 10 s) already do this; preserve that ordering in any custom configuration so the precise per-task watchdog handles the normal case and the purge sweep stays a backstop.
3. **Decide deliberately on `metricsEnabled`.** Leaving it on gives free windowed observability at a small, fixed per-event cost; disabling it is the right call for a workload that has already identified metrics collection as a bottleneck and doesn't need the dashboards.
4. **If you need end-to-end operation latency, time it yourself.** Regulo's built-in latency metric is queue-wait time only ([Section 7.1](#71-metrics)) — it does not and cannot see how long your own wrapped function takes to run.
5. **Poll `status()` freely.** It is safe to call from a high-frequency metrics-scrape path regardless of queue depth ([Section 7.1](#71-metrics)); treat rising `queueAge`, `timeoutRate1m`, and circuit-state transitions as your earliest signals of downstream trouble.
