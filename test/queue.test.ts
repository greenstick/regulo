import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueuedTask } from '../src/queue';

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

  // arm() now wires only the abort listener; the queue-wait timeout is driven by
  // the semaphore's shared watchdog (covered in semaphore.test.ts), not per task.

  it('dispatch after arm resolves the promise', async () => {
    const { task, promise } = makeTask();
    const release = vi.fn();
    task.arm(vi.fn());
    task.dispatch(() => release);
    const r = await promise;
    expect(r).toBe(release);
  });

  it('abort fires onAbort and subsequent dispatch returns false', () => {
    const onAbort = vi.fn();
    const controller = new AbortController();
    const { task } = makeTask(1, { abortSignal: controller.signal });
    task.arm(onAbort);
    controller.abort();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(task.dispatch(() => vi.fn())).toBe(false);
  });

  it('claim() then reject() finalizes the task (the shared-timeout path)', async () => {
    const { task, promise } = makeTask();
    task.arm(vi.fn());
    expect(task.claim()).toBe(true);
    task.reject(new Error('timed out'));
    await expect(promise).rejects.toThrow('timed out');
    expect(task.dispatch(() => vi.fn())).toBe(false); // already claimed
  });

  it('claim() wins the race; a later abort is a no-op', () => {
    const onAbort = vi.fn();
    const controller = new AbortController();
    const { task } = makeTask(1, { abortSignal: controller.signal });
    task.arm(onAbort);
    expect(task.claim()).toBe(true); // e.g. the shared watchdog claims it first
    controller.abort();              // arrives second
    expect(onAbort).not.toHaveBeenCalled();
    expect(task.claim()).toBe(false); // second claim loses
  });

  it('discard rejects the promise', async () => {
    const { task, promise } = makeTask();
    task.arm(vi.fn());
    task.discard(new Error('gone'));
    await expect(promise).rejects.toThrow('gone');
  });

  it('discard returns false if already finalized', () => {
    const { task, promise } = makeTask();
    promise.catch(() => {}); // suppress unhandled rejection
    task.arm(vi.fn());
    task.discard(new Error('first'));
    expect(task.discard(new Error('second'))).toBe(false);
  });

  it('abort listener is removed after dispatch', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    const { task } = makeTask(1, { abortSignal: controller.signal });
    task.arm(onAbort);
    task.dispatch(() => vi.fn());
    controller.abort(); // listener already removed
    expect(onAbort).not.toHaveBeenCalled();
  });
});
