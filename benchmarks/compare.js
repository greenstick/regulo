/*
Concurrency-limiter comparison — regulo vs p-limit vs p-queue vs cockatiel
(bulkhead).

These libraries do not have identical feature sets (see the "How it compares"
table in the README), so this is not a like-for-like contest: regulo is doing
more per call (priority heap, circuit-breaker accounting, windowed metrics).
The point is to show what regulo's added capability costs in the one scenario
they all support — capping concurrency — and to quantify the built-in metrics
overhead (the `metricsEnabled: false` rows). opossum is intentionally absent: it
is a circuit breaker and does not cap concurrency, so it is benchmarked in
breakers.js instead.

Run:  node compare.js          (table)
      node compare.js --md      (markdown)
*/

import { Semaphore } from 'regulo';
import pLimit from 'p-limit';
import PQueue from 'p-queue';
import { bulkhead } from 'cockatiel';
import { measure, report, env } from './harness.js';

const asyncNoop = () => Promise.resolve();

async function batch(submit, n) {
  const ps = new Array(n);
  for (let i = 0; i < n; i++) ps[i] = submit();
  await Promise.all(ps);
}

async function main() {
  const e = env();
  console.log(`comparison benchmarks — node ${e.node}, ${e.platform}`);

  const CONCURRENCY = 16;
  const BATCH = 1000;

  /*
  1. Uncontended round-trip — concurrency far exceeds demand, so every call
     takes the fast path. Measures pure per-call overhead.
  */
  const uncontended = [];
  {
    const sem = new Semaphore(1_000_000);
    const semNm = new Semaphore(1_000_000, { metricsEnabled: false });
    const limit = pLimit(1_000_000);
    const queue = new PQueue({ concurrency: 1_000_000 });
    const ckBulk = bulkhead(1_000_000);

    uncontended.push(await measure('regulo', () => sem.use(asyncNoop)));
    uncontended.push(await measure('regulo (no metrics)', () => semNm.use(asyncNoop)));
    uncontended.push(await measure('p-limit', () => limit(asyncNoop)));
    uncontended.push(await measure('p-queue', () => queue.add(asyncNoop)));
    uncontended.push(await measure('cockatiel (bulkhead)', () => ckBulk.execute(asyncNoop)));
    sem.shutdown(); semNm.shutdown();
  }
  report('Uncontended round-trip', uncontended, 'ops/sec');

  /*
  2. Contended throughput — concurrency cap of 16, batches of 1000 tasks, so
     ~984 tasks queue on each batch. One op = one batch; `scale` reports
     tasks/sec.
  */
  const contended = [];
  {
    // One instance per library, reused across batches — each batch fully drains
    // before the next, so every limiter starts each batch idle. Keeps the
    // comparison free of per-batch construction noise.
    const withScale = (r) => ({ ...r, scale: BATCH });
    const sem = new Semaphore(CONCURRENCY);
    const semNm = new Semaphore(CONCURRENCY, { metricsEnabled: false });
    const limit = pLimit(CONCURRENCY);
    const queue = new PQueue({ concurrency: CONCURRENCY });
    // queue must be deep enough to hold a full batch rather than reject it.
    const ckBulk = bulkhead(CONCURRENCY, BATCH * 2);

    contended.push(withScale(await measure('regulo', () => batch(() => sem.use(asyncNoop), BATCH), { durationMs: 600 })));
    contended.push(withScale(await measure('regulo (no metrics)', () => batch(() => semNm.use(asyncNoop), BATCH), { durationMs: 600 })));
    contended.push(withScale(await measure('p-limit', () => batch(() => limit(asyncNoop), BATCH), { durationMs: 600 })));
    contended.push(withScale(await measure('p-queue', () => batch(() => queue.add(asyncNoop), BATCH), { durationMs: 600 })));
    contended.push(withScale(await measure('cockatiel (bulkhead)', () => batch(() => ckBulk.execute(asyncNoop), BATCH), { durationMs: 600 })));
    sem.shutdown(); semNm.shutdown();
  }
  report(`Contended throughput @ concurrency=${CONCURRENCY} (tasks/sec)`, contended, 'tasks/sec');
}

main().then(() => process.exit(0));
