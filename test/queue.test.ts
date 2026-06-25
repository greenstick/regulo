import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueuedTask, QueueAgeCache } from '../src/queue';

function makeTask(id = 1, opts: Partial<ConstructorParameters<typeof QueuedTask>[0]> = {}) {
  let _resolve: (r: () => void) => void = () => {};
  let _reject: (e: Error) => void = () => {};
  const promise = new Promise<() => void>((res, rej) => { _resolve = res; _reject = rej; });
  const task = new QueuedTask({ id, priority: 0, enqueueTime: Date.now(), isProbe: false, resolve: _resolve, reject: _reject, ...opts });
  return { task, promise, resolve: _resolve, reject: _reject };
}

describe('QueuedTask', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('dispatch after arm resolves the promise', async () => {
    const { task, promise } = makeTask();
    const release = vi.fn();
    task.arm(1000, vi.fn(), vi.fn());
    task.dispatch(() => release);
    const r = await promise;
    expect(r).toBe(release);
  });

  it('timeout fires onTimeout and subsequent dispatch returns false', async () => {
    const onTimeout = vi.fn();
    const { task } = makeTask();
    task.arm(500, onTimeout, vi.fn());
    vi.advanceTimersByTime(500);
    expect(onTimeout).toHaveBeenCalledOnce();
    const dispatched = task.dispatch(() => vi.fn());
    expect(dispatched).toBe(false);
  });

  it('abort fires onAbort and subsequent dispatch returns false', () => {
    const onAbort = vi.fn();
    const controller = new AbortController();
    const { task } = makeTask(1, { abortSignal: controller.signal });
    task.arm(1000, vi.fn(), onAbort);
    controller.abort();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(task.dispatch(() => vi.fn())).toBe(false);
  });

  it('whichever of timeout/abort fires first wins; second is a no-op', () => {
    const onTimeout = vi.fn();
    const onAbort = vi.fn();
    const controller = new AbortController();
    const { task } = makeTask(1, { abortSignal: controller.signal });
    task.arm(500, onTimeout, onAbort);
    vi.advanceTimersByTime(500); // timeout wins
    controller.abort();           // abort arrives second — no-op
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('discard rejects the promise', async () => {
    const { task, promise } = makeTask();
    task.arm(1000, vi.fn(), vi.fn());
    task.discard(new Error('gone'));
    await expect(promise).rejects.toThrow('gone');
  });

  it('discard returns false if already finalized', () => {
    const { task, promise } = makeTask();
    promise.catch(() => {}); // suppress unhandled rejection
    task.arm(1000, vi.fn(), vi.fn());
    task.discard(new Error('first'));
    expect(task.discard(new Error('second'))).toBe(false);
  });

  it('abort listener is removed after dispatch', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    const { task } = makeTask(1, { abortSignal: controller.signal });
    task.arm(1000, vi.fn(), onAbort);
    task.dispatch(() => vi.fn());
    controller.abort(); // listener already removed
    expect(onAbort).not.toHaveBeenCalled();
  });
});

describe('QueueAgeCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ageMs returns 0 for empty task list', () => {
    expect(new QueueAgeCache().ageMs([])).toBe(0);
  });

  it('ageMs reflects oldest enqueue time', () => {
    const cache = new QueueAgeCache();
    const now = Date.now();
    vi.setSystemTime(now);
    cache.onInsert(now - 500);
    cache.onInsert(now - 200);
    // Cache is warm — pass a dummy non-empty array; cache serves the stored value
    const dummy = [{ enqueueTime: now - 200 }] as any;
    expect(cache.ageMs(dummy)).toBe(500);
  });

  it('invalidate triggers rescan on next ageMs call', () => {
    const cache = new QueueAgeCache();
    const now = Date.now();
    vi.setSystemTime(now);
    const { task: t1 } = makeTask(1, { enqueueTime: now - 1000 });
    const { task: t2 } = makeTask(2, { enqueueTime: now - 500 });
    cache.onInsert(now - 1000);
    cache.invalidate();
    expect(cache.ageMs([t2])).toBe(500); // rescan, only t2 present
  });

  it('reset clears the cache', () => {
    const cache = new QueueAgeCache();
    cache.onInsert(Date.now() - 1000);
    cache.reset();
    expect(cache.ageMs([])).toBe(0);
  });
});
