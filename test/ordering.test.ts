import { describe, it, expect } from 'vitest';
import { QUEUE_ORDERINGS, resolveComparator, buildComparator } from '../src/ordering';
import type { QueuedTaskView } from '../src/types';

type Task = { id: number; priority: number; enqueueTime: number; weight: number; isProbe: boolean };

const task = (over: Partial<Task> = {}): Task => ({
  id: 1, priority: 0, enqueueTime: 0, weight: 1, isProbe: false, ...over,
});

describe('QUEUE_ORDERINGS', () => {
  it('fifo: orders by id ascending, priority disregarded', () => {
    const cmp = QUEUE_ORDERINGS.fifo;
    // lower priority does NOT win when it was enqueued later
    expect(cmp(task({ id: 1, priority: 9 }), task({ id: 2, priority: 0 }))).toBeLessThan(0);
    expect(cmp(task({ id: 2 }), task({ id: 1 }))).toBeGreaterThan(0);
  });

  it('lifo: orders by id descending, priority disregarded', () => {
    const cmp = QUEUE_ORDERINGS.lifo;
    // higher priority does NOT win when it was enqueued earlier
    expect(cmp(task({ id: 2, priority: 9 }), task({ id: 1, priority: 0 }))).toBeLessThan(0);
    expect(cmp(task({ id: 1 }), task({ id: 2 }))).toBeGreaterThan(0);
  });

  it('fifoWithPriority: priority primary, earliest id first on ties', () => {
    const cmp = QUEUE_ORDERINGS.fifoWithPriority;
    expect(cmp(task({ priority: 1 }), task({ priority: 2 }))).toBeLessThan(0);
    expect(cmp(task({ id: 1 }), task({ id: 2 }))).toBeLessThan(0); // earlier first
  });

  it('lifoWithPriority: priority primary, latest id first on ties', () => {
    const cmp = QUEUE_ORDERINGS.lifoWithPriority;
    expect(cmp(task({ priority: 1 }), task({ priority: 2 }))).toBeLessThan(0);
    expect(cmp(task({ id: 1 }), task({ id: 2 }))).toBeGreaterThan(0); // later first
  });
});

describe('resolveComparator', () => {
  it('defaults to fifoWithPriority', () => {
    expect(resolveComparator({})).toBe(QUEUE_ORDERINGS.fifoWithPriority);
  });

  it('selects the named preset', () => {
    expect(resolveComparator({ queueOrder: 'lifo' })).toBe(QUEUE_ORDERINGS.lifo);
  });

  it('a custom comparator overrides queueOrder', () => {
    const custom = (a: QueuedTaskView, b: QueuedTaskView) => a.id - b.id;
    expect(resolveComparator({ queueOrder: 'lifo', comparator: custom })).toBe(custom);
  });

  it('throws on an unknown preset', () => {
    // @ts-expect-error invalid
    expect(() => resolveComparator({ queueOrder: 'nope' })).toThrow(/queueOrder must be one of/);
  });

  it('throws on a non-function comparator', () => {
    // @ts-expect-error invalid
    expect(() => resolveComparator({ comparator: {} })).toThrow(/comparator must be a function/);
  });
});

describe('buildComparator probe-first invariant', () => {
  it('sorts a probe ahead of a non-probe even when the ordering would not', () => {
    // lifo would order by id desc; a probe with a *smaller* id must still win.
    const cmp = buildComparator<Task>({ queueOrder: 'lifo' });
    expect(cmp(task({ id: 1, isProbe: true }), task({ id: 99, isProbe: false }))).toBeLessThan(0);
    expect(cmp(task({ id: 99, isProbe: false }), task({ id: 1, isProbe: true }))).toBeGreaterThan(0);
  });

  it('keeps probe-first under the priority-less presets (which drop priority)', () => {
    // These presets ignore priority, so the probe's MIN_SAFE_INTEGER priority is
    // no help — the wrapper is the only thing keeping it at the head.
    for (const order of ['fifo', 'lifo'] as const) {
      const cmp = buildComparator<Task>({ queueOrder: order });
      expect(cmp(task({ id: 50, isProbe: true }), task({ id: 1, isProbe: false }))).toBeLessThan(0);
      expect(cmp(task({ id: 1, isProbe: false }), task({ id: 50, isProbe: true }))).toBeGreaterThan(0);
    }
  });

  it('forces probe-first even against an adversarial custom comparator', () => {
    // This comparator would put everything ahead of the probe; the wrapper overrides it.
    const cmp = buildComparator<Task>({ comparator: () => 1 });
    expect(cmp(task({ isProbe: true }), task({ isProbe: false }))).toBeLessThan(0);
  });

  it('delegates to the ordering when probe flags match', () => {
    const cmp = buildComparator<Task>({ queueOrder: 'fifo' });
    expect(cmp(task({ id: 1 }), task({ id: 2 }))).toBeLessThan(0);
  });
});
