/*
Circuit-breaker comparison — regulo's breakers module (SaturationCircuitBreaker,
NoopCircuitBreaker, ManualCircuitBreaker) vs opossum vs cockatiel
(circuitBreaker policy).

This measures the overhead a circuit breaker adds on the hot path: a healthy,
closed circuit wrapping a trivial async call. That is the cost you pay on every
request when nothing is wrong, which is the number that matters in steady state.

Caveats on fairness:
  - regulo's breakers are primitives driven by an explicit failure signal, so
    each is wrapped here exactly as the README documents (checkAndTransition →
    isOpen → trackAttempt → run → settle). opossum and cockatiel are fault
    breakers that auto-classify the promise outcome.
  - Every regulo breaker gets its own guard function literal (not a shared
    factory): a shared guard body would accumulate polymorphic inline caches
    across the three breaker shapes and penalise whichever runs later.
  - opossum is run with `timeout: false`. Its per-call timeout timer is a
    feature the others do not impose, so disabling it isolates breaker
    overhead rather than timer overhead. All other opossum defaults stand.

Run:  node breakers.js          (table)
      node breakers.js --md      (markdown)
*/

import { SaturationCircuitBreaker, NoopCircuitBreaker, ManualCircuitBreaker } from 'regulo';
import Opossum from 'opossum';
import { circuitBreaker, handleAll, SamplingBreaker } from 'cockatiel';
import { measure, report, env } from './harness.js';

const asyncNoop = () => Promise.resolve();

/*
regulo's breakers are primitives, not function wrappers. These guards reproduce
the documented usage pattern. Implemented with `.then` (no async wrapper frame)
so they are not unfairly penalised relative to the others, which return their
own promise directly. One literal per breaker — see fairness caveats above.
*/
function makeSaturationGuard() {
  const cb = new SaturationCircuitBreaker({ threshold: 0.5, window: 10000, cooldown: 5000, minThroughput: 10, minFailures: 5 });
  return (fn) => {
    cb.checkAndTransition();
    if (cb.isOpen) return Promise.reject(new Error('circuit open'));
    cb.trackAttempt();
    return fn().then(
      (r) => { if (cb.isProbing) cb.handleProbeSuccess(); return r; },
      (e) => {
        cb.recordFailure();
        if (cb.isProbing) cb.handleProbeFailure();
        else cb.evaluateAndTrip();
        throw e;
      }
    );
  };
}

function makeNoopGuard() {
  const cb = new NoopCircuitBreaker();
  return (fn) => {
    cb.checkAndTransition();
    if (cb.isOpen) return Promise.reject(new Error('circuit open'));
    cb.trackAttempt();
    return fn().then(
      (r) => { if (cb.isProbing) cb.handleProbeSuccess(); return r; },
      (e) => {
        cb.recordFailure();
        if (cb.isProbing) cb.handleProbeFailure();
        else cb.evaluateAndTrip();
        throw e;
      }
    );
  };
}

function makeManualGuard() {
  const cb = new ManualCircuitBreaker();
  return (fn) => {
    cb.checkAndTransition();
    if (cb.isOpen) return Promise.reject(new Error('circuit open'));
    cb.trackAttempt();
    return fn().then(
      (r) => { if (cb.isProbing) cb.handleProbeSuccess(); return r; },
      (e) => {
        cb.recordFailure();
        if (cb.isProbing) cb.handleProbeFailure();
        else cb.evaluateAndTrip();
        throw e;
      }
    );
  };
}

async function main() {
  const e = env();
  console.log(`circuit-breaker benchmarks — node ${e.node}, ${e.platform}`);

  const saturationGuard = makeSaturationGuard();
  const noopGuard = makeNoopGuard();
  const manualGuard = makeManualGuard();

  const opossum = new Opossum(asyncNoop, {
    timeout: false,                  // isolate breaker overhead, not the timer
    errorThresholdPercentage: 50,
    resetTimeout: 5000,
    rollingCountTimeout: 10000,
  });

  const cockatiel = circuitBreaker(handleAll, {
    halfOpenAfter: 5000,
    breaker: new SamplingBreaker({ threshold: 0.5, duration: 10000, minimumRps: 1 }),
  });

  const rows = [];
  rows.push(await measure('regulo SaturationCircuitBreaker', () => saturationGuard(asyncNoop)));
  rows.push(await measure('regulo NoopCircuitBreaker', () => noopGuard(asyncNoop)));
  rows.push(await measure('regulo ManualCircuitBreaker', () => manualGuard(asyncNoop)));
  rows.push(await measure('opossum', () => opossum.fire()));
  rows.push(await measure('cockatiel (circuitBreaker)', () => cockatiel.execute(asyncNoop)));
  report('Circuit-breaker overhead — closed/healthy circuit', rows, 'ops/sec');

  opossum.shutdown?.();
}

main().then(() => process.exit(0));
