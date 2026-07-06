/*
Keyed Semaphore

A lazily-populated registry of one Semaphore per key — the "one Semaphore per
resource" pattern (see README Caveats: a single Semaphore is one failure
domain, so unrelated downstreams shouldn't share one) without hand-rolled Map
bookkeeping. Every key shares the same (count, config); the first forKey(key)
constructs that key's Semaphore, later calls return the same instance.

Construction does not validate `count`/`config` — there is nothing to
construct yet. The first forKey()/use() call constructs the underlying
Semaphore and surfaces any INVALID_ARGUMENT then, same as `new Semaphore(...)`
would.

Intended for a small, known key space (per-downstream, per-shard, per-tenant
from a bounded tenant list) — each key's Semaphore lives until delete() or
shutdown() is called, so a high-cardinality or unbounded key space (e.g. one
key per end user) leaks a Semaphore — and its purge-interval timer — per key
rather than being reclaimed automatically. There is no TTL/eviction by design:
that would add a timer per key on top of the one each Semaphore already runs.
*/

import { Semaphore } from './semaphore';

import type { SemaphoreConfig, ID } from './types';

export class KeyedSemaphore {
  readonly #pools: Map<ID, Semaphore> = new Map();
  readonly #count: number;
  readonly #config: SemaphoreConfig;

  constructor(count: number, config: SemaphoreConfig = {}) {
    this.#count = count;
    this.#config = config;
  }

  /** The Semaphore for `key`, constructing it (with the registry's shared count/config) on first access. */
  public forKey(key: ID): Semaphore {
    let pool = this.#pools.get(key);
    if (pool === undefined) {
      pool = new Semaphore(this.#count, this.#config);
      this.#pools.set(key, pool);
    }
    return pool;
  }

  /** Sugar for `forKey(key).use(fn, abortSignal, priority, weight)`. */
  public use<T>(key: ID, fn: () => Promise<T>, abortSignal?: AbortSignal, priority = 0, weight = 1): Promise<T> {
    return this.forKey(key).use(fn, abortSignal, priority, weight);
  }

  /** True if `key` already has a constructed Semaphore (does not create one). */
  public has(key: ID): boolean {
    return this.#pools.has(key);
  }

  /** Number of keys with a live Semaphore. */
  public get size(): number {
    return this.#pools.size;
  }

  /** Keys with a live Semaphore, in first-access order. */
  public keys(): IterableIterator<ID> {
    return this.#pools.keys();
  }

  /**
   * Shuts down and forgets `key`'s Semaphore, releasing its purge-interval
   * timer. A later forKey(key) constructs a fresh one. Returns false if `key`
   * had no Semaphore.
   */
  public delete(key: ID): boolean {
    const pool = this.#pools.get(key);
    if (pool === undefined) return false;
    pool.shutdown('KeyedSemaphore: key deleted');
    this.#pools.delete(key);
    return true;
  }

  /**
   * Shuts down every key's Semaphore and empties the registry.
   * Terminal — like Semaphore.shutdown(), there is no undo.
   */
  public shutdown(reason = 'KeyedSemaphore shutdown'): void {
    for (const pool of this.#pools.values()) pool.shutdown(reason);
    this.#pools.clear();
  }
}
