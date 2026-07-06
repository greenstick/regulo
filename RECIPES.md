# Recipes

Practical patterns for **Regulo**, grouped by the part of the library they exercise. Within each section, recipes go from most common/simple to less common/complex.

- [Semaphore (bounded concurrency)](#semaphore-bounded-concurrency)
- [Priority & weighted queue](#priority--weighted-queue)
- [Circuit breaker](#circuit-breaker)
- [Backoff & metrics](#backoff--metrics)
- [Lifecycle & shutdown](#lifecycle--shutdown)

---

## Semaphore (bounded concurrency)

### Batch file processing

```ts
import fs from 'node:fs/promises';
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(5);

const files = await fs.readdir('uploads');

const results = await Promise.all(
  files.map(file => semaphore.use(async () => {
    const content = await fs.readFile(`uploads/${file}`, 'utf8');
    return JSON.parse(content);
  })),
);
```

### Fetch multiple URLs

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(3);

const urls = [
  'https://api.example.com/users/1',
  'https://api.example.com/users/2',
  'https://api.example.com/users/3',
];

const results = await Promise.all(
  urls.map(url => semaphore.use(async () => {
    const response = await fetch(url);
    return response.json();
  })),
);
```

### Error handling with partial results

`use()` always releases the permit, so a failing task never leaks capacity — `Promise.allSettled` just needs to see the rejection:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(3);

const urls = [
  'https://api.example.com/users/1',
  'https://api.example.com/users/2',
  'https://api.example.com/users/3',
];

const results = await Promise.allSettled(
  urls.map(url => semaphore.use(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status} for ${url}`);
    }
    return response.json();
  })),
);

for (const result of results) {
  if (result.status === 'fulfilled') {
    console.log(result.value);
  } else {
    console.error(result.reason);
  }
}
```

### Non-blocking capacity check

Use `tryAcquire()` when a caller should skip the work entirely rather than wait for a permit — e.g. an optional cache-warming pass that shouldn't compete with real traffic. It never queues, so it also respects head-of-line fairness (it returns `null` if anyone is already waiting, even with permits free):

```ts
import { Semaphore } from 'regulo';

const warmup = new Semaphore(4);

function tryWarm(key: string) {
  const release = warmup.tryAcquire();
  if (!release) return; // busy or someone's already queued — skip, don't wait
  warmCache(key).finally(release);
}
```

### Per-request timeout via `AbortSignal`

`acquire()`/`use()` accept an `AbortSignal` as their first argument, so a caller can give up on waiting for a permit independently of `queueMaxTimeout`:

```ts
import { Semaphore, SemaphoreError } from 'regulo';

const semaphore = new Semaphore(10);

async function handleRequest(req: Request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    return await semaphore.use(() => callDownstream(req), controller.signal);
  } catch (error) {
    if (error instanceof SemaphoreError && error.code === 'ABORTED') {
      return respondTimeout();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

### Express middleware: shed load with a 503

Cap concurrent handling of an expensive route and translate every **Regulo** rejection — `CIRCUIT_OPEN`, `QUEUE_FULL`, `TIMEOUT` — into the same client-facing "come back later":

```ts
import { Semaphore, SemaphoreError } from 'regulo';
import type { RequestHandler } from 'express';

function limit(semaphore: Semaphore): RequestHandler {
  return async (req, res, next) => {
    let release: (() => void) | undefined;
    try {
      release = await semaphore.acquire();
    } catch (error) {
      if (error instanceof SemaphoreError) {
        res.setHeader('Retry-After', '5').sendStatus(503);
        return;
      }
      return next(error);
    }
    res.once('close', release); // idempotent — safe even if already released
    next();
  };
}

const reports = new Semaphore(20, { queueMaxLength: 100, queueMaxTimeout: 2000 });
app.get('/report', limit(reports), async (req, res) => {
  res.json(await buildExpensiveReport(req.query));
});
```

### One `Semaphore` per resource, shared context provider

A single `Semaphore` is one failure domain (see [Caveats](./README.md#caveats)) — don't multiplex unrelated downstreams through one instance. Give each its own pool, and thread shared state (a client, a connection) through the wrapped function rather than a global:

```ts
import { Semaphore } from 'regulo';
import { S3 } from '@aws-sdk/client-s3';

const s3Limit = new Semaphore(4);
const dbLimit = new Semaphore(20);
const client = new S3({});

const fetchFromBucket = (fileKey: string) =>
  s3Limit.use(() => client.getObject({ Bucket: 'someBucket', Key: fileKey }));

const results = await Promise.all([
  fetchFromBucket('someFileKey1'),
  fetchFromBucket('someFileKey2'),
  fetchFromBucket('someFileKey3'),
]);
```

### One `Semaphore` per resource, without the bookkeeping (`KeyedSemaphore`)

When the set of resources isn't a fixed handful of named constants but a dynamic (though bounded) key — one pool per S3 bucket, per tenant, per shard — `KeyedSemaphore` lazily creates and caches one `Semaphore` per key instead of hand-rolling a `Map`:

```ts
import { KeyedSemaphore } from 'regulo';
import { S3 } from '@aws-sdk/client-s3';

const buckets = new KeyedSemaphore(4); // 4 permits per bucket
const client = new S3({});

const fetchFromBucket = (bucket: string, key: string) =>
  buckets.use(bucket, () => client.getObject({ Bucket: bucket, Key: key }));

await Promise.all([
  fetchFromBucket('bucket-a', 'file-1'),
  fetchFromBucket('bucket-a', 'file-2'),
  fetchFromBucket('bucket-b', 'file-1'), // its own pool and breaker — bucket-a's saturation can't trip it
]);
```

Each key is its own failure domain, same as if you'd constructed each `Semaphore` by hand (see [Caveats](./README.md#caveats)). There's no eviction, so this fits a small, bounded key space — not one key per end user.

---

## Priority & weighted queue

### Priority lanes for mixed traffic

Route interactive requests ahead of background jobs through the *same* pool by giving each caller a `priority` (lower dispatches first). Head-of-line fairness means a background job that's already queued is never jumped by a later interactive one that arrives after it — priority only decides order among tasks not yet dispatched:

```ts
import { Semaphore } from 'regulo';

const pool = new Semaphore(10);

const PRIORITY = { interactive: 0, background: 10 } as const;

app.get('/api/search', (req, res) => {
  pool.use(() => runSearch(req.query), undefined, PRIORITY.interactive).then(r => res.json(r));
});

async function runNightlyReindex(job: Job) {
  return pool.use(() => reindex(job), undefined, PRIORITY.background);
}
```

### Weighted permits for uneven work

Give heavier operations proportionally more of the pool instead of running a second limiter alongside the first. A batch of 10 costs 10x a single item, out of a 20-permit pool:

```ts
import { Semaphore } from 'regulo';

const renders = new Semaphore(20); // 20 "render slots"

async function renderPage(page: Page) {
  return renders.use(() => render(page), undefined, 0, 1); // weight 1
}

async function renderBatch(pages: Page[]) {
  return renders.use(() => renderAll(pages), undefined, 0, pages.length); // weight = batch size
}
```

### Choosing a queue ordering

`queueOrder` swaps the dispatch preset without writing a comparator. Use `'lifo'` for a job queue where the most recently submitted item is the most likely to still be relevant (e.g. speculative prefetches, where older ones are increasingly likely to be stale):

```ts
import { Semaphore } from 'regulo';

const prefetch = new Semaphore(4, { queueOrder: 'lifo' });
```

### Custom comparator: lightest-first to avoid head-of-line stalls

Under mixed weights, the scheduler never dispatches past a head that doesn't fit — a heavy task at the head can stall lighter ones behind it even with capacity to run them. If throughput matters more than strict priority order, break ties by weight so light work drains first:

```ts
import { Semaphore } from 'regulo';

const pool = new Semaphore(8, {
  comparator: (a, b) => (a.priority - b.priority) || (a.weight - b.weight) || (a.id - b.id),
});
```

### Composing a preset with `QUEUE_ORDERINGS`

Start from a built-in preset and layer one extra rule on top, rather than reimplementing the whole ordering:

```ts
import { Semaphore, QUEUE_ORDERINGS } from 'regulo';

const pool = new Semaphore(8, {
  comparator: (a, b) => {
    // Starving prevention: anything queued > 5s jumps to the very front.
    const aStarved = Date.now() - a.enqueueTime > 5000;
    const bStarved = Date.now() - b.enqueueTime > 5000;
    if (aStarved !== bStarved) return aStarved ? -1 : 1;
    return QUEUE_ORDERINGS.fifoWithPriority(a, b);
  },
});
```

---

## Circuit breaker

### Reading breaker state for a health check

`status().status.circuitOpen` / `circuitProbing` are `O(1)` reads, safe on a health-check or metrics path:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10);

app.get('/healthz', (_req, res) => {
  const { status } = semaphore.status();
  res.status(status.circuitOpen ? 503 : 200).json({ circuitOpen: status.circuitOpen });
});
```

### Syncing breaker state to a dashboard with one handler

`CIRCUITOPEN`/`CIRCUITPROBING`/`CIRCUITCLOSE` carry different, event-specific payloads (`timeoutRate`, `reason`, …) — useful for logging, but more than you need for a dashboard that just wants the current state. `CIRCUITSTATECHANGE` fires alongside all three with a uniform `{ from, to }`:

```ts
import { Semaphore, SemaphoreEvents } from 'regulo';

const semaphore = new Semaphore(10);

semaphore.on(SemaphoreEvents.CIRCUITSTATECHANGE, ({ from, to }) => {
  dashboard.setBreakerState('reports', to);
  logger.info(`reports breaker: ${from} -> ${to}`);
});
```

### Feeding downstream errors with `reportFailure()`

The default breaker trips on queue-*saturation* timeouts, not on your function's errors. Report the failures you actually care about (e.g. 5xx only, not 4xx) to also trip on error rate:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10, { circuitBreakerThreshold: 0.3 });

await semaphore.use(async () => {
  try {
    return await callDownstream();
  } catch (error) {
    if (isServerError(error)) semaphore.reportFailure();
    throw error;
  }
});
```

### Declarative fault-aware breaker with `circuitBreakerFailurePredicate`

The same idea as above, but automated for `use()` — and it goes further: a probe whose *operation* fails (matching the predicate) re-opens the circuit immediately, instead of closing it on a technically-successful acquire/release:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10, {
  circuitBreakerFailurePredicate: (error) => isServerError(error),
});

await semaphore.use(() => callDownstream());
```

### Operator kill switch with `ManualCircuitBreaker`

Give an ops/admin endpoint a deliberate, no-cooldown way to shed load — useful during a known incident where you don't want the breaker auto-probing back to life:

```ts
import { Semaphore, ManualCircuitBreaker } from 'regulo';

const kill = new ManualCircuitBreaker();
const reports = new Semaphore(20, { circuitBreaker: kill });

app.post('/admin/reports/pause', (_req, res) => { kill.open(); res.sendStatus(204); });
app.post('/admin/reports/resume', (_req, res) => { kill.close(); res.sendStatus(204); });
```

### Pure limiter with `NoopCircuitBreaker`

When you want bounded concurrency and priority, but no load-shedding at all — e.g. a CPU-bound worker pool where "slow" is normal and shouldn't trip anything:

```ts
import { Semaphore, NoopCircuitBreaker } from 'regulo';

const workers = new Semaphore(os.cpus().length, { circuitBreaker: new NoopCircuitBreaker() });
```

### Standalone breaker wrapping an HTTP client

`SaturationCircuitBreaker` doesn't require a `Semaphore` at all — use it directly in front of any client where you decide what counts as a failure:

```ts
import { SaturationCircuitBreaker } from 'regulo';

const breaker = new SaturationCircuitBreaker({
  threshold: 0.5,
  window: 10000,
  cooldown: 5000,
  minThroughput: 10,
  minFailures: 5,
});

async function fetchGuarded(url: string) {
  if (breaker.checkAndTransition()) console.log('circuit entering probing');
  if (breaker.isOpen) throw new Error(`circuit open, retry in ${breaker.cooldownRemaining}ms`);

  breaker.trackAttempt();
  try {
    const result = await httpClient.get(url);
    if (breaker.isProbing) breaker.handleProbeSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    if (breaker.isProbing) breaker.handleProbeFailure();
    else breaker.evaluateAndTrip();
    throw error;
  }
}
```

### Writing a custom `CircuitBreakerStrategy`

For a breaker driven by something outside **Regulo** entirely — say, a feature flag or an upstream health signal — implement the interface and inject it. The essentials: `checkAndTransition()` returns `true` exactly once per open → probing transition, `evaluateAndTrip()` reports closed → open trips, and methods must not throw:

```ts
import { Semaphore, type CircuitBreakerStrategy } from 'regulo';

class FlagDrivenBreaker implements CircuitBreakerStrategy {
  constructor(private readonly flags: FeatureFlags) {}
  get isOpen() { return this.flags.get('shed-load'); }
  get isProbing() { return false; }
  get cooldownRemaining() { return 0; }
  checkAndTransition() { return false; }
  trackAttempt() {}
  recordFailure() {}
  evaluateAndTrip() { return { tripped: false } as const; }
  handleProbeSuccess() {}
  handleProbeFailure() {}
}

const semaphore = new Semaphore(10, { circuitBreaker: new FlagDrivenBreaker(flags) });
```

---

## Backoff & metrics

### Exposing metrics to a scrape endpoint

`status()` is `O(1)` in queue depth — safe to call from a Prometheus-style scrape handler regardless of how backed up the queue is:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(20);
app.get('/metrics/semaphore', (_req, res) => res.json(semaphore.status()));
```

### Per-operation latency and SLO tracking with `onSettle`

`status().metrics` tracks queue-*wait* latency, not how long your operation itself took. Pass `onSettle` to `use()` to feed a histogram or SLO tracker with the operation's own duration and outcome, without hand-timing every call site:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10);

await semaphore.use(
  () => callDownstream(),
  undefined, 0, 1,
  (durationMs, outcome) => {
    histogram.observe({ outcome }, durationMs);
    if (outcome === 'success' && durationMs > sloThresholdMs) logger.warn(`SLO breach: ${durationMs}ms`);
  },
);
```

### Weighted-pool utilization dashboard from `TASKRELEASE`

Counting `TASKRELEASE` events naively undercounts freed capacity once any task uses `weight > 1` — one event might free 4 of 20 burners, not 1. The payload's `weight` field reports exactly how many permits that release returned, so summing it (not the event count) gives an accurate released-capacity reading for a weighted pool:

```ts
import { Semaphore, SemaphoreEvents } from 'regulo';

const burners = new Semaphore(20); // 20 burner permits; jobs claim 1-4 at a time by size

burners.on(SemaphoreEvents.TASKRELEASE, ({ weight, running }) => {
  metrics.gauge('burners.occupied', running); // equivalent to status().status.running, pushed instead of polled
  metrics.increment('burners.permits_released', weight);
});
```

### Alerting on circuit state changes and backoff pressure

Events fire once per state change for the whole limiter — the right place for logging/alerting, never for responding to an individual request:

```ts
import { Semaphore, SemaphoreEvents } from 'regulo';

const semaphore = new Semaphore(20);

semaphore.on(SemaphoreEvents.CIRCUITOPEN, ({ timeoutRate, reason }) =>
  logger.warn(`limiter shedding load (timeout rate ${(timeoutRate * 100).toFixed(0)}%, reason: ${reason ?? 'saturation'})`));
semaphore.on(SemaphoreEvents.CIRCUITCLOSE, () => logger.info('limiter recovered'));
semaphore.on(SemaphoreEvents.TASKTIMEOUT, ({ backoffDelay }) => {
  if (backoffDelay > 500) logger.warn(`dispatch easing off, backoff at ${backoffDelay}ms`);
});
```

### Live progress reporting

`activeCount`/`pendingCount`-style visibility comes from `status().status.running` / `.queued` — poll it while a large batch is in flight:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(5);
const urls = getUrls();

const progressInterval = setInterval(() => {
  const { running, queued } = semaphore.status().status;
  console.log(`running: ${running}, queued: ${queued}`);
}, 250);

try {
  await Promise.all(urls.map(url => semaphore.use(() => fetch(url))));
} finally {
  clearInterval(progressInterval);
}
```

### Custom metrics horizons

Override the default 1m/5m/1h/24h windows when your dashboards care about different horizons — e.g. a 10-second window for a low-traffic internal tool where the default 1-minute floor is too coarse:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10, {
  metricsWindows: [
    { size: 10, stepMs: 1000 },   // 10s
    { size: 60, stepMs: 5000 },   // 5min
  ],
});
```

### Diagnosing dispatch stalls with `peekQueue()`

For an admin debug endpoint, inspect exactly what's waiting — including whether the head is a live circuit-breaker probe — without affecting dispatch. For a very deep queue, page through it with `offset`/`limit` instead of always materializing the whole thing:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10);

app.get('/admin/semaphore/queue', (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  const limit = Number(req.query.limit ?? 50);
  res.json(semaphore.peekQueue({ offset, limit }).map(t => ({
    id: t.id,
    priority: t.priority,
    weight: t.weight,
    waitingMs: Date.now() - t.enqueueTime,
    isProbe: t.isProbe,
  })));
});
```

---

## Lifecycle & shutdown

### Reusable limited function

Wrap a single async function in its own `Semaphore` when the concurrency limit belongs to that operation, not to a call site:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(3);

const fetchUrl = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed with ${response.status} for ${url}`);
  return response.json();
};

const limitedFetchUrl = (url: string) => semaphore.use(() => fetchUrl(url));

const results = await Promise.all(urls.map(limitedFetchUrl));
```

### Draining before a deploy

Wait for in-flight work to finish (with a deadline) before letting a process exit — `drain()` without a timeout can hang forever if a permit is never released, so always pass one on a shutdown path:

```ts
import { Semaphore, SemaphoreError } from 'regulo';

const semaphore = new Semaphore(10);

async function gracefulShutdown() {
  try {
    await semaphore.drain(5000);
  } catch (error) {
    if (error instanceof SemaphoreError && error.code === 'TIMEOUT') {
      logger.warn('semaphore did not drain in time, shutting down anyway');
    }
  } finally {
    semaphore.shutdown('deploy');
  }
}

process.once('SIGTERM', gracefulShutdown);
```

### Discarding queued work, keeping in-flight work

Use `cancel()` (not `shutdown()`) when the semaphore should stay usable afterward — e.g. clearing a stale batch of queued jobs on a config reload, while requests already running finish normally:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(10);

function onConfigReload() {
  semaphore.cancel(); // queued tasks reject CANCELLED; in-flight tasks are untouched
}
```

### Resetting for test isolation

`reset()` restores a `Semaphore` to its constructed state — permits, breaker, backoff, lifetime counters — without tearing down event listeners, which is useful between test cases sharing one instance:

```ts
import { Semaphore } from 'regulo';

const semaphore = new Semaphore(5, { circuitBreakerThreshold: 0.3 });

afterEach(() => {
  semaphore.reset(); // listeners preserved; pass { clearListeners: true } to drop them too
});
```

### Fault-injection test harness with `ManualCircuitBreaker`

Deterministically force the open/probing states in a test, rather than trying to manufacture real queue timeouts:

```ts
import { Semaphore, ManualCircuitBreaker, SemaphoreError } from 'regulo';

test('rejects with CIRCUIT_OPEN while breaker is open', async () => {
  const breaker = new ManualCircuitBreaker();
  const semaphore = new Semaphore(5, { circuitBreaker: breaker });

  breaker.open();
  await expect(semaphore.acquire()).rejects.toMatchObject(
    new SemaphoreError('circuit open', 'CIRCUIT_OPEN'),
  );

  breaker.close();
  await expect(semaphore.acquire()).resolves.toBeInstanceOf(Function);
});
```
