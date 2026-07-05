/*
Backoff Tracker

Tracks an exponential backoff delay across timeout bursts. The delay is applied
to scheduler wake-ups (see Semaphore.schedule) so that sustained timeouts slow
the rate at which queued work is dispatched, and reported in status() and
TASKTIMEOUT payloads for observability.

Decay is wall-clock based, not event based: currentDelay decays continuously by
decayFactor-per-second from the last timeout. This is what lets the delay return
to zero on its own once the burst subsides — relying on a future timeout to
decay (the older model) would leave the delay pinned high after the last
timeout and permanently slow dispatch.

Each timeout grows the delay from its current (already-decayed) level: rapid
bursts compound (little decay between them); spaced-out timeouts barely move it.
*/

import { validateNumber } from "./validation";
import { SemaphoreError } from './error';

import type { BackoffConfig } from './types';

export class BackoffTracker {

  private delay = 0;
  private lastTimestamp = 0;

  private readonly initialTimeout: number;
  private readonly maxTimeout: number;
  private readonly decayFactor: number;

  constructor(config: BackoffConfig = {}) {

    // >= 0
    this.initialTimeout = validateNumber(config.initialTimeout ?? 50, "BackoffTracker initialTimeout", 0, Number.MAX_SAFE_INTEGER, true, true);
    // >= 0
    this.maxTimeout     = validateNumber(config.maxTimeout ?? 2000, "BackoffTracker maxTimeout", 0, Number.MAX_SAFE_INTEGER, true, true);
    // (0, 1)
    this.decayFactor    = validateNumber(config.decayFactor ?? 0.5, "BackoffTracker decayFactor", 0, 1, false, false);

    // Integrated Cross-Checks
    if (this.maxTimeout < this.initialTimeout) {
      throw new SemaphoreError("BackoffTracker maxTimeout must be >= initialTimeout", 'INVALID_ARGUMENT');
    }

  }

  /** Delay in ms, decayed to the present moment. Floors to 0 below 1ms. */
  public get currentDelay(): number {
    return this._decayedDelay(Date.now());
  }

  // Shared decay math, parameterized on `now` so onTimeout() can reuse a
  // caller-supplied timestamp instead of reading the clock a second time.
  private _decayedDelay(now: number): number {
    if (this.delay === 0) return 0;
    const elapsedSec = (now - this.lastTimestamp) / 1000;
    if (elapsedSec <= 0) return this.delay;
    const decayed = this.delay * Math.pow(this.decayFactor, elapsedSec);
    return decayed < 1 ? 0 : decayed;
  }

  /**
   * Record a timeout, growing the delay. Accepts an optional caller-supplied
   * timestamp so a caller that already read the clock for this event (the
   * semaphore's shared timeout watchdog) doesn't pay a second Date.now().
   */
  public onTimeout(now = Date.now()): void {
    const current = this._decayedDelay(now);
    const grown = current > 0 ? current * 2 : this.initialTimeout;
    this.delay = Math.min(grown, this.maxTimeout);
    this.lastTimestamp = now;
  }

  public reset(): void {
    this.delay = 0;
    this.lastTimestamp = 0;
  }
}
