import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyedSemaphore } from '../src/keyed';

describe('KeyedSemaphore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('forKey lazily constructs one Semaphore per key, sharing count/config, and reuses it on repeat', () => {
    const registry = new KeyedSemaphore(4, { queueMaxLength: 10 });
    const a = registry.forKey('a');
    const b = registry.forKey('b');
    expect(a).not.toBe(b);
    expect(a.capacity).toBe(4);
    expect(b.capacity).toBe(4);
    expect(registry.forKey('a')).toBe(a); // same key -> same instance
    registry.shutdown();
  });

  it('has() reports key presence without constructing', () => {
    const registry = new KeyedSemaphore(2);
    expect(registry.has('a')).toBe(false);
    registry.forKey('a');
    expect(registry.has('a')).toBe(true);
    registry.shutdown();
  });

  it('size and keys() reflect constructed pools', () => {
    const registry = new KeyedSemaphore(2);
    registry.forKey('a');
    registry.forKey('b');
    expect(registry.size).toBe(2);
    expect(Array.from(registry.keys())).toEqual(['a', 'b']);
    registry.shutdown();
  });

  it('use() is sugar for forKey(key).use(fn, abortSignal, priority, weight)', async () => {
    const registry = new KeyedSemaphore(3);
    const result = await registry.use('a', async () => 'ok', undefined, 1, 2);
    expect(result).toBe('ok');
    expect(registry.forKey('a').availablePermits).toBe(3); // released after use()
    registry.shutdown();
  });

  it('delete() shuts down and forgets a key, returning false if absent', () => {
    const registry = new KeyedSemaphore(2);
    expect(registry.delete('missing')).toBe(false);
    const a = registry.forKey('a');
    expect(registry.delete('a')).toBe(true);
    expect(registry.has('a')).toBe(false);
    expect(a.isAvailable()).toBe(false); // shut down
    expect(registry.forKey('a')).not.toBe(a); // fresh instance on next access
    registry.shutdown();
  });

  it('shutdown() shuts down every pool and empties the registry', () => {
    const registry = new KeyedSemaphore(2);
    const a = registry.forKey('a');
    const b = registry.forKey('b');
    registry.shutdown('bye');
    expect(a.isAvailable()).toBe(false);
    expect(b.isAvailable()).toBe(false);
    expect(registry.size).toBe(0);
  });
});
