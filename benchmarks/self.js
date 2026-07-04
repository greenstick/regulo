/*
regulo self-benchmarks — zero external dependencies.

Measures the cost of regulo's own primitives across the paths that matter in
production: the uncontended fast path, the contended queue+scheduler path,
weighted acquires, and the documented O(N) cost of status().

Run:  node self.js          (table)
      node self.js --md      (markdown, for pasting into docs)
*/

import { Semaphore } from 'regulo';
import { measure, measureSync, report, env } from './harness.js';

const noop = () => {};
const asyncNoop = () => Promise.resolve();

/** Submit `n` tasks concurrently through `submit` and await completion. */
async function batch(submit, n) {
  const ps = new Array(n);
  for (let i = 0; i < n; i++) ps[i] = submit();
  await Promise.all(ps);
}

async function main() {
  const e = env();
  console.log(`regulo self-benchmarks — node ${e.node}, ${e.platform}`);

  /*
  1. Fast path — uncontended. Permits are always free, nothing queues.
  */
  const fastPath = [];
  {
    // tryAcquire is synchronous; this isolates raw permit + bookkeeping cost.
    const sem = new Semaphore(1_000_000);
    fastPath.push(
      measureSync('tryAcquire + release (with metrics)', () => {
        const release = sem.tryAcquire();
        if (release) release();
      })
    );
    // tryAcquire with metrics disabled — shows the cost of observability.
    const semNoMetrics = new Semaphore(1_000_000, { metricsEnabled: false });
    fastPath.push(
      measureSync('tryAcquire + release', () => {
        const release = semNoMetrics.tryAcquire();
        if (release) release();
      })
    );
    // Full async round-trip through use().
    const semUse = new Semaphore(1_000_000);
    fastPath.push(await measure('use() round-trip', () => semUse.use(asyncNoop)));
    const semUseNm = new Semaphore(1_000_000, { metricsEnabled: false });
    fastPath.push(await measure('use() round-trip (no metrics)', () => semUseNm.use(asyncNoop)));
    sem.shutdown(); semNoMetrics.shutdown(); semUse.shutdown(); semUseNm.shutdown();
  }
  report('Fast path (uncontended)', fastPath, 'ops/sec');

  /*
  2. Weighted acquire — uncontended. Weighted permits should add no meaningful
     overhead over weight=1.
  */
  const weighted = [];
  {
    for (const weight of [1, 4, 16]) {
      const sem = new Semaphore(1_000_000);
      weighted.push(await measure(`use() weight=${weight}`, () => sem.use(asyncNoop, undefined, 0, weight)));
      sem.shutdown();
    }
  }
  report('Weighted acquire (uncontended)', weighted, 'ops/sec');

  /*
  3. Contended throughput — more callers than permits, so work queues and flows
     through the binary heap + scheduler. One op = one batch of `BATCH` tasks;
     `scale` converts batches/sec into tasks/sec for display.
  */
  const BATCH = 1000;
  const contended = [];
  {
    for (const concurrency of [4, 16, 64]) {
      const sem = new Semaphore(concurrency);
      contended.push({
        ...(await measure(
          `concurrency=${concurrency}`,
          () => batch(() => sem.use(asyncNoop), BATCH),
          { durationMs: 600 }
        )),
        scale: BATCH,
      });
      sem.shutdown();
    }
    // With random priorities — exercises heap reordering on every insert.
    const semPri = new Semaphore(16);
    contended.push({
      ...(await measure(
        'concurrency=16, random priority',
        () => batch(() => semPri.use(asyncNoop, undefined, (Math.random() * 10) | 0), BATCH),
        { durationMs: 600 }
      )),
      scale: BATCH,
    });
    semPri.shutdown();
  }
  report('Contended throughput (tasks/sec)', contended, 'tasks/sec');

  /*
  4. status() cost vs queue depth — demonstrates the documented O(N) from
     queue.toArray(). We hold the single permit so the queue fills and stays
     full, then time status(). Pending acquires are caught and torn down after.
  */
  const statusRows = [];
  {
    for (const depth of [0, 100, 1000]) {
      const sem = new Semaphore(1, {
        queueMaxTimeout: 600_000,
        queueMaxAge: 600_000,
        queueMaxLength: depth + 10,
      });
      const hold = sem.tryAcquire(); // occupy the only permit
      for (let i = 0; i < depth; i++) sem.acquire(undefined, 0, 1).catch(() => {});
      statusRows.push(measureSync(`status() @ depth ${depth}`, () => sem.status()));
      if (hold) hold();
      sem.shutdown();
    }
  }
  report('status() snapshot cost', statusRows, 'ops/sec');
}

main().then(() => process.exit(0));
