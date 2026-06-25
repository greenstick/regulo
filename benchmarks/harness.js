/*
Zero-dependency micro-benchmark harness.

Each benchmark is run for several timed rounds. Within a round we call the
target in a tight loop until `durationMs` elapses and record the achieved rate
(ops/sec). Across rounds we report the median rate and the relative standard
deviation (rsd) as a stability indicator — a high rsd means the number is noisy
and should be read with suspicion.

Two runners:
  measure      — async target (`await fn()` per op). Captures the real cost of
                 awaiting a Semaphore round-trip, including microtask scheduling.
  measureSync  — synchronous target. No await, so it isolates raw data-structure
                 cost (e.g. tryAcquire/release, status()).
*/

const DEFAULTS = { warmupMs: 150, durationMs: 400, rounds: 7 };

function summarize(rates) {
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
  const rsd = mean === 0 ? 0 : Math.sqrt(variance) / mean;
  return { hz: median, rsd };
}

export async function measure(name, fn, opts = {}) {
  const { warmupMs, durationMs, rounds } = { ...DEFAULTS, ...opts };

  let w = performance.now();
  while (performance.now() - w < warmupMs) await fn();

  const rates = [];
  for (let r = 0; r < rounds; r++) {
    let iters = 0;
    const start = performance.now();
    let elapsed = 0;
    while ((elapsed = performance.now() - start) < durationMs) {
      await fn();
      iters++;
    }
    rates.push(iters / (elapsed / 1000));
  }
  return { name, ...summarize(rates), ...(opts.scale ? { scale: opts.scale } : {}) };
}

export function measureSync(name, fn, opts = {}) {
  const { warmupMs, durationMs, rounds } = { ...DEFAULTS, ...opts };

  let w = performance.now();
  while (performance.now() - w < warmupMs) fn();

  const rates = [];
  for (let r = 0; r < rounds; r++) {
    let iters = 0;
    const start = performance.now();
    let elapsed = 0;
    while ((elapsed = performance.now() - start) < durationMs) {
      fn();
      iters++;
    }
    rates.push(iters / (elapsed / 1000));
  }
  return { name, ...summarize(rates), ...(opts.scale ? { scale: opts.scale } : {}) };
}

/*
Reporting
*/

function fmtHz(hz) {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)}M`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)}k`;
  return hz.toFixed(0);
}

/** A result's display rate. `scale` converts batch ops/sec into item ops/sec. */
function displayHz(row) {
  return row.hz * (row.scale ?? 1);
}

export function printTable(title, rows, unit = 'ops/sec') {
  const fastest = Math.max(...rows.map(displayHz));
  const nameW = Math.max(...rows.map(r => r.name.length), 'benchmark'.length);
  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);

  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
  console.log(`${pad('benchmark', nameW)}  ${padL(unit, 12)}  ${padL('±rsd', 7)}  relative`);
  for (const row of rows) {
    const hz = displayHz(row);
    const rel = hz === fastest ? 'fastest' : `${(fastest / hz).toFixed(2)}x slower`;
    console.log(
      `${pad(row.name, nameW)}  ${padL(fmtHz(hz), 12)}  ${padL((row.rsd * 100).toFixed(1) + '%', 7)}  ${rel}`
    );
  }
}

export function printMarkdown(title, rows, unit = 'ops/sec') {
  const fastest = Math.max(...rows.map(displayHz));
  console.log(`\n**${title}**\n`);
  console.log(`| Benchmark | ${unit} | ±rsd | Relative |`);
  console.log(`|---|--:|--:|---|`);
  for (const row of rows) {
    const hz = displayHz(row);
    const rel = hz === fastest ? '**fastest**' : `${(fastest / hz).toFixed(2)}× slower`;
    console.log(`| ${row.name} | ${fmtHz(hz)} | ${(row.rsd * 100).toFixed(1)}% | ${rel} |`);
  }
}

export function report(title, rows, unit) {
  if (process.argv.includes('--md')) printMarkdown(title, rows, unit);
  else printTable(title, rows, unit);
}

export function env() {
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
}
