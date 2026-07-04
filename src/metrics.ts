/*
Semaphore Metrics

Collects two kinds of data for external observability:
  Windowed rollups  — counts (acquired/released/timeouts), inflight and queue-depth
                      gauges (avg/max), and acquire-wait latency (avg), across
                      1m/5m/15m/1h/24h horizons.
  Lifetime counters — monotonically increasing totals since construction or reset.

Aborts are counted in the lifetime total only. They are intentional client
disconnects and must not enter the windowed timeout count, which would inflate
the timeout rate seen by dashboards and circuit-breaker consumers.

Performance
  A single CombinedWindow holds every series for one horizon in flat typed
  arrays sharing one bucket clock. The hot path therefore computes the current
  bucket once per horizon and updates counts and gauges together, instead of
  walking four independent windows (each recomputing Date.now() and its own
  bucket). The semaphore drives this through the `on*` methods, passing a single
  `now` captured per operation. The granular `mark*`/`sample*` methods are
  retained for fine-grained unit testing and compute their own `now`.
*/

import { SemaphoreError } from './error';
import { validateNumber } from './validation';

import type {
  WindowOptions,
  SemaphoreMetricsSnapshot,
  SemaphoreMetricsWindowSnapshot,
} from './types';

/*
Combined Window

One horizon's worth of every metric series, stored in parallel typed arrays
indexed by bucket. All series share `timestamps`, so a bucket is resolved once
and reused across the counts and gauges touched by a single event.
*/

class CombinedWindow {
  private readonly size: number;
  private readonly stepMs: number;
  private readonly timestamps: Float64Array;

  // Current-bucket cache: [cachedUntil - stepMs, cachedUntil) maps to
  // cachedIndex. Hot-path bucket resolution is then two comparisons instead of
  // a float division + modulo + timestamp check per event; the full
  // computation runs only on rollover into a new step (or a backwards clock
  // jump, which falls through to the exact path).
  private cachedIndex = -1;
  private cachedUntil = 0;

  // counts
  private readonly acquired: Int32Array;
  private readonly released: Int32Array;
  private readonly timeouts: Int32Array;
  // inflight gauge
  private readonly ifSum: Float64Array;
  private readonly ifCount: Int32Array;
  private readonly ifMax: Float64Array;
  // queue-depth gauge
  private readonly qSum: Float64Array;
  private readonly qCount: Int32Array;
  private readonly qMax: Float64Array;
  // acquire-wait latency
  private readonly latSum: Float64Array;
  private readonly latCount: Int32Array;

  constructor(size: number, stepMs: number) {
    this.size = validateNumber(size, 'CombinedWindow size', 1, Number.MAX_SAFE_INTEGER, true, true);
    this.stepMs = validateNumber(stepMs, 'CombinedWindow stepMs', 1, Number.MAX_SAFE_INTEGER, true, true);
    this.timestamps = new Float64Array(size);
    this.acquired = new Int32Array(size);
    this.released = new Int32Array(size);
    this.timeouts = new Int32Array(size);
    this.ifSum = new Float64Array(size);
    this.ifCount = new Int32Array(size);
    this.ifMax = new Float64Array(size);
    this.qSum = new Float64Array(size);
    this.qCount = new Int32Array(size);
    this.qMax = new Float64Array(size);
    this.latSum = new Float64Array(size);
    this.latCount = new Int32Array(size);
  }

  /** Resolve the bucket for `now`, clearing it on rollover into a new step. */
  private bucket(now: number): number {
    if (now < this.cachedUntil && now >= this.cachedUntil - this.stepMs) return this.cachedIndex;
    const epoch = Math.floor(now / this.stepMs);
    const ts = epoch * this.stepMs;
    const i = epoch % this.size;
    if (this.timestamps[i] !== ts) {
      this.timestamps[i] = ts;
      this.acquired[i] = 0; this.released[i] = 0; this.timeouts[i] = 0;
      this.ifSum[i] = 0; this.ifCount[i] = 0; this.ifMax[i] = 0;
      this.qSum[i] = 0; this.qCount[i] = 0; this.qMax[i] = 0;
      this.latSum[i] = 0; this.latCount[i] = 0;
    }
    this.cachedIndex = i;
    this.cachedUntil = ts + this.stepMs;
    return i;
  }

  private addInflight(i: number, v: number): void {
    this.ifSum[i] += v; this.ifCount[i]++;
    if (v > this.ifMax[i]) this.ifMax[i] = v;
  }
  private addQueue(i: number, v: number): void {
    this.qSum[i] += v; this.qCount[i]++;
    if (v > this.qMax[i]) this.qMax[i] = v;
  }

  // Combined hot-path operations — bucket resolved once, all series updated.
  public recordAcquire(now: number, inflight: number, queueDepth: number): void {
    const i = this.bucket(now);
    this.acquired[i]++;
    this.addInflight(i, inflight);
    this.addQueue(i, queueDepth);
  }
  public recordAcquireQueued(now: number, waitMs: number, inflight: number, queueDepth: number): void {
    const i = this.bucket(now);
    this.acquired[i]++;
    this.latSum[i] += waitMs; this.latCount[i]++;
    this.addInflight(i, inflight);
    this.addQueue(i, queueDepth);
  }
  public recordRelease(now: number, inflight: number, queueDepth: number): void {
    const i = this.bucket(now);
    this.released[i]++;
    this.addInflight(i, inflight);
    this.addQueue(i, queueDepth);
  }
  public recordTimeoutQueue(now: number, queueDepth: number): void {
    const i = this.bucket(now);
    this.timeouts[i]++;
    this.addQueue(i, queueDepth);
  }
  public sampleBoth(now: number, inflight: number, queueDepth: number): void {
    const i = this.bucket(now);
    this.addInflight(i, inflight);
    this.addQueue(i, queueDepth);
  }

  // Granular operations — used by unit tests and the lifetime-only abort path.
  public addAcquired(now: number): void { this.acquired[this.bucket(now)]++; }
  public addReleased(now: number): void { this.released[this.bucket(now)]++; }
  public addTimeout(now: number): void  { this.timeouts[this.bucket(now)]++; }
  public addLatency(now: number, v: number): void {
    const i = this.bucket(now);
    this.latSum[i] += v; this.latCount[i]++;
  }
  public sampleInflight(now: number, v: number): void { this.addInflight(this.bucket(now), v); }
  public sampleQueue(now: number, v: number): void { this.addQueue(this.bucket(now), v); }

  public snapshot(now: number): SemaphoreMetricsWindowSnapshot {
    const windowStart = Math.floor(now / this.stepMs) * this.stepMs - (this.size - 1) * this.stepMs;
    let acq = 0, rel = 0, to = 0;
    let ifSum = 0, ifCount = 0, ifMax = 0;
    let qSum = 0, qCount = 0, qMax = 0;
    let latSum = 0, latCount = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.timestamps[i]! < windowStart) continue;
      acq += this.acquired[i]!; rel += this.released[i]!; to += this.timeouts[i]!;
      ifSum += this.ifSum[i]!; ifCount += this.ifCount[i]!;
      if (this.ifMax[i]! > ifMax) ifMax = this.ifMax[i]!;
      qSum += this.qSum[i]!; qCount += this.qCount[i]!;
      if (this.qMax[i]! > qMax) qMax = this.qMax[i]!;
      latSum += this.latSum[i]!; latCount += this.latCount[i]!;
    }
    return {
      counts:   { acquired: acq, released: rel, timeouts: to },
      inflight: { avg: ifCount === 0 ? 0 : ifSum / ifCount, max: ifMax, samples: ifCount },
      queue:    { avg: qCount === 0 ? 0 : qSum / qCount, max: qMax, samples: qCount },
      latency:  { avg: latCount === 0 ? 0 : latSum / latCount, count: latCount, total: latSum },
    };
  }

  public reset(): void {
    this.cachedIndex = -1;
    this.cachedUntil = 0;
    this.timestamps.fill(0);
    this.acquired.fill(0); this.released.fill(0); this.timeouts.fill(0);
    this.ifSum.fill(0); this.ifCount.fill(0); this.ifMax.fill(0);
    this.qSum.fill(0); this.qCount.fill(0); this.qMax.fill(0);
    this.latSum.fill(0); this.latCount.fill(0);
  }
}

/*
Window Defaults
*/

export const DEFAULT_WINDOW_OPTIONS: WindowOptions[] = [
  { size: 60, stepMs: 1000  },   // 1m
  { size: 60, stepMs: 5000  },   // 5m
  { size: 60, stepMs: 15000 },   // 15m
  { size: 60, stepMs: 60000 },   // 1h
  { size: 60, stepMs: 1440000 }, // 24h
];

/*
Semaphore Metrics
*/

export class SemaphoreMetrics {
  private readonly windows: CombinedWindow[];
  private readonly windowLabels: string[];

  // The shortest configured horizon — the basis for the point-in-time rate
  // fields in Semaphore.status() (requestsPerSecond, timeoutRate). With the
  // default windows this is the 1m window.
  public readonly primaryLabel: string;
  public readonly primaryWindowMs: number;

  private _totalAcquiredFast    = 0;
  private _totalAcquiredQueued  = 0;
  private _totalReleased        = 0;
  private _totalTimeouts        = 0;
  private _totalPurged          = 0;
  private _totalAborts          = 0;
  private _capacity             = 0;
  private _circuitOpen          = false;
  private _circuitHalfOpen      = false;

  constructor(options: WindowOptions[] = DEFAULT_WINDOW_OPTIONS) {
    if (options.length === 0) throw new SemaphoreError("SemaphoreMetrics requires at least one WindowOptions", "INVALID_ARGUMENT");
    this.windows = options.map(({ size, stepMs }) => new CombinedWindow(size, stepMs));
    this.windowLabels = options.map(({ size, stepMs }) => {
      const ms = size * stepMs;
      if (ms >= 3600000 && ms % 3600000 === 0) return `${ms / 3600000}h`;
      if (ms >= 60000   && ms % 60000   === 0) return `${ms / 60000}m`;
      if (ms >= 1000    && ms % 1000    === 0) return `${ms / 1000}s`;
      return `${ms}ms`;
    });

    // Labels key the snapshot record — two windows with the same horizon would
    // silently overwrite each other there, so reject the config outright.
    const seen = new Set<string>();
    for (const label of this.windowLabels) {
      if (seen.has(label)) {
        throw new SemaphoreError(`SemaphoreMetrics windows produce duplicate label "${label}" (two windows cover the same horizon)`, 'INVALID_ARGUMENT');
      }
      seen.add(label);
    }

    let primary = 0;
    for (let i = 1; i < options.length; i++) {
      if (options[i]!.size * options[i]!.stepMs < options[primary]!.size * options[primary]!.stepMs) primary = i;
    }
    this.primaryLabel = this.windowLabels[primary]!;
    this.primaryWindowMs = options[primary]!.size * options[primary]!.stepMs;
  }

  /*
  Combined hot-path entry points — driven by the semaphore with one `now` per
  operation, updating counts and gauges in a single bucket resolution.
  */
  public onAcquireFast(now: number, inflight: number, queueDepth: number): void {
    this._totalAcquiredFast++;
    for (const w of this.windows) w.recordAcquire(now, inflight, queueDepth);
  }
  public onAcquireQueued(now: number, waitMs: number, inflight: number, queueDepth: number): void {
    this._totalAcquiredQueued++;
    for (const w of this.windows) w.recordAcquireQueued(now, waitMs, inflight, queueDepth);
  }
  public onRelease(now: number, inflight: number, queueDepth: number): void {
    this._totalReleased++;
    for (const w of this.windows) w.recordRelease(now, inflight, queueDepth);
  }
  public onTimeout(now: number, queueDepth: number): void {
    this._totalTimeouts++;
    for (const w of this.windows) w.recordTimeoutQueue(now, queueDepth);
  }
  /** Lifetime counter plus a queue-depth sample — aborts never enter the timeout count. */
  public onAbort(now: number, queueDepth: number): void {
    this._totalAborts++;
    for (const w of this.windows) w.sampleQueue(now, queueDepth);
  }
  /** Lifetime counter plus a queue-depth sample — purges, like aborts, never enter the timeout count. */
  public onPurge(now: number, queueDepth: number): void {
    this._totalPurged++;
    for (const w of this.windows) w.sampleQueue(now, queueDepth);
  }
  public sampleGauges(now: number, inflight: number, queueDepth: number): void {
    for (const w of this.windows) w.sampleBoth(now, inflight, queueDepth);
  }
  public sampleQueueDepthAt(now: number, queueDepth: number): void {
    for (const w of this.windows) w.sampleQueue(now, queueDepth);
  }

  /*
  Granular entry points — retained for unit tests. Each captures its own `now`.
  */
  public markAcquireFast(): void { this._totalAcquiredFast++; const now = Date.now(); for (const w of this.windows) w.addAcquired(now); }
  public markAcquireQueued(waitMs: number): void {
    this._totalAcquiredQueued++;
    const now = Date.now();
    for (const w of this.windows) { w.addAcquired(now); w.addLatency(now, waitMs); }
  }
  public markReleased(): void { this._totalReleased++; const now = Date.now(); for (const w of this.windows) w.addReleased(now); }
  public markTimeout(): void  { this._totalTimeouts++; const now = Date.now(); for (const w of this.windows) w.addTimeout(now); }
  /** Lifetime counter only — aborts must not enter the windowed timeout rate. */
  public markAbort(): void { this._totalAborts++; }
  public sampleInFlight(v: number): void  { const now = Date.now(); for (const w of this.windows) w.sampleInflight(now, v); }
  public sampleQueueDepth(v: number): void { const now = Date.now(); for (const w of this.windows) w.sampleQueue(now, v); }

  public markCapacityChange(n: number): void { this._capacity = n; }
  public markCircuitOpen(): void          { this._circuitOpen = true;  this._circuitHalfOpen = false; }
  public markCircuitHalfOpen(): void      { this._circuitOpen = false; this._circuitHalfOpen = true; }
  public markCircuitClose(): void         { this._circuitOpen = false; this._circuitHalfOpen = false; }

  public getSnapshot(): SemaphoreMetricsSnapshot {
    const now = Date.now();
    const windows: Record<string, SemaphoreMetricsWindowSnapshot> = {};
    let firstInflightAvg = 0, firstQueueAvg = 0;
    for (let i = 0; i < this.windowLabels.length; i++) {
      const snap = this.windows[i]!.snapshot(now);
      windows[this.windowLabels[i]!] = snap;
      if (i === 0) { firstInflightAvg = snap.inflight.avg; firstQueueAvg = snap.queue.avg; }
    }
    return {
      windows,
      meta: {
        inFlightLastMinute:   Math.round(firstInflightAvg),
        queueDepthLastMinute: Math.round(firstQueueAvg),
        totalAcquiredFast:    this._totalAcquiredFast,
        totalAcquiredQueued:  this._totalAcquiredQueued,
        totalReleased:        this._totalReleased,
        totalTimeouts:        this._totalTimeouts,
        totalPurged:          this._totalPurged,
        totalAborts:          this._totalAborts,
        capacity:             this._capacity,
        circuitOpen:          this._circuitOpen,
        circuitHalfOpen:      this._circuitHalfOpen,
      },
    };
  }

  public reset(): void {
    for (const w of this.windows) w.reset();
    this._totalAcquiredFast = 0; this._totalAcquiredQueued = 0; this._totalReleased = 0;
    this._totalTimeouts = 0; this._totalPurged = 0; this._totalAborts = 0; this._capacity = 0;
    this._circuitOpen = false; this._circuitHalfOpen = false;
  }

  public destroy(): void { this.reset(); }
}
