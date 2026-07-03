/*
Breakers

A library of circuit breaker implementations, each composable into a Semaphore
via the `circuitBreaker` config option. All of them (and any breaker you write)
implement the CircuitBreakerStrategy contract defined in ../types — the
semaphore drives every breaker through exactly that surface.

  SaturationCircuitBreaker — the default. A windowed failure-rate breaker; fed
                             queue timeouts by the semaphore, or any signal you
                             choose standalone / via Semaphore.reportFailure().
  NoopCircuitBreaker       — never trips; the semaphore as a pure limiter.
  ManualCircuitBreaker     — an operator kill switch; open()/close() by hand.
*/

export { SaturationCircuitBreaker } from './saturation';
export { NoopCircuitBreaker } from './noop';
export { ManualCircuitBreaker } from './manual';
