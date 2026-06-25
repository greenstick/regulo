/*
Circuit-breaker comparison — regulo's standalone CircuitBreaker vs opossum vs
cockatiel (circuitBreaker policy).

This measures the overhead a circuit breaker adds on the hot path: a healthy,
closed circuit wrapping a trivial async call. That is the cost you pay on every
request when nothing is wrong, which is the number that matters in steady state.

Caveats on fairness:
  - regulo's CircuitBreaker is a saturation breaker driven by an explicit
    timeout signal, so it is wrapped here exactly as the README documents
    (checkAndTransition → isOpen → trackAttempt → run → settle). opossum and
    cockatiel are fault breakers that auto-classify the promise outcome.
  - opossum is run with `timeout: false`. Its per-call timeout timer is a
    feature the other two do not impose, so disabling it isolates breaker
    overhead rather than timer overhead. All other opossum defaults stand.

Run:  node breakers.js          (table)
      node breakers.js --md      (markdown)
*/

import { CircuitBreaker } from 'regulo';
import Opossum from 'opossum';
import { circuitBreaker, handleAll, SamplingBreaker } from 'cockatiel';
import { measure, report, env } from './harness.js';

const asyncNoop = () => Promise.resolve();

/*
regulo's CircuitBreaker is a primitive, not a function wrapper. This guard
reproduces the documented usage pattern. Implemented with `.then` (no async
wrapper frame) so it is not unfairly penalised relative to the others, which
return their own promise directly.
*/
function makeReguloGuard() {
  const cb = new CircuitBreaker({ threshold: 0.5, window: 10000, cooldown: 5000, minThroughput: 10, minFailures: 5 });
  return (fn) => {
    cb.checkAndTransition();
    if (cb.isOpen) return Promise.reject(new Error('circuit open'));
    cb.trackAttempt();
    return fn().then(
      (r) => { if (cb.isHalfOpen) cb.handleProbeSuccess(); return r; },
      (e) => {
        cb.recordTimeout();
        if (cb.isHalfOpen) cb.handleProbeFailure();
        else cb.evaluateAndTrip();
        throw e;
      }
    );
  };
}

async function main() {
  const e = env();
  console.log(`circuit-breaker benchmarks — node ${e.node}, ${e.platform}`);

  const reguloGuard = makeReguloGuard();

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
  rows.push(await measure('regulo CircuitBreaker', () => reguloGuard(asyncNoop)));
  rows.push(await measure('opossum', () => opossum.fire()));
  rows.push(await measure('cockatiel (circuitBreaker)', () => cockatiel.execute(asyncNoop)));
  report('Circuit-breaker overhead — closed/healthy circuit', rows, 'ops/sec');

  opossum.shutdown?.();
}

main().then(() => process.exit(0));
