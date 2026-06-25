# regulo benchmarks

Performance benchmarks for [`regulo`](../README.md).

This is a **separate, private package** (`regulo-benchmarks`). It is never
published to npm — the root package's `files` allowlist (`dist`, `README.md`,
`CHANGELOG.md`, `LICENSE`) excludes it from the tarball, and this package is
marked `private`. Its dependencies (`p-limit`, `p-queue`) stay out of the
published `regulo` package entirely.

## Running

The benchmarks import the **built artifact** via `"regulo": "file:.."`, so they
measure what actually ships. Build the package first, then install and run:

```bash
# from the repo root
npm run build

# then, in this directory
cd benchmarks
npm install
npm run bench      # regulo self-benchmarks (zero external deps)
npm run compare    # concurrency limiters: regulo vs p-limit vs p-queue vs cockatiel
npm run breakers   # circuit breakers: regulo vs opossum vs cockatiel
npm run all        # all three suites
npm run md         # all three, emitted as markdown tables
```

Add `--md` to any script's command to print markdown instead of a console
table (e.g. `node self.js --md`).

## What's measured

`self.js` — regulo's own primitives, zero external dependencies:

- **Fast path (uncontended)** — `tryAcquire`/`use()` when permits are always
  free, with and without metrics. Isolates per-call overhead.
- **Weighted acquire** — `weight = 1/4/16`, to confirm weighting is ~free.
- **Contended throughput** — concurrency 4/16/64 with batches of 1000 tasks, so
  work queues through the binary heap and scheduler. Reported as tasks/sec.
  Includes a random-priority variant that reorders the heap on every insert.
- **`status()` cost** — at queue depths 0/100/1000, demonstrating the
  documented O(N) `queue.toArray()`.

`compare.js` — concurrency limiters: regulo vs `p-limit` vs `p-queue` vs
`cockatiel` (bulkhead policy), on the one scenario they all support, capping
concurrency. This is **not** like-for-like: regulo does more per call (priority
heap, circuit-breaker accounting, windowed metrics), so it is expected to trade
some raw throughput for that capability. The `no metrics` rows show what
observability costs. `opossum` is absent here — it is a circuit breaker and does
not cap concurrency.

`breakers.js` — circuit breakers: regulo's standalone `CircuitBreaker` vs
`opossum` vs `cockatiel` (circuitBreaker policy). Measures the overhead a
healthy, closed breaker adds per call — the steady-state cost when nothing is
failing. The libraries cited in the README that limit concurrency (`p-limit`,
`p-queue`) are absent here, as they have no breaker. Two fairness notes: regulo's
breaker is a primitive wrapped exactly as the README documents, and opossum runs
with `timeout: false` so the comparison isolates breaker overhead rather than its
per-call timeout timer (a feature the others don't impose).

## Methodology

`harness.js` is a small zero-dependency runner. Each benchmark is warmed up,
then run for several timed rounds; it reports the **median** rate and the
relative standard deviation (`±rsd`) as a noise indicator. Numbers are
machine-, runtime-, and load-dependent — treat them as relative, and re-run
locally rather than trusting any absolute figure. Async benchmarks include real
microtask/promise scheduling, which dominates at these speeds.
