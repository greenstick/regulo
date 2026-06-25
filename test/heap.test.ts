import { describe, it, expect } from 'vitest';
import { IndexedBinaryHeap } from '../src/heap';
import { QueuedTask } from '../src/queue';

function makeTask(id = 1, opts: Partial<ConstructorParameters<typeof QueuedTask>[0]> = {}) {
  let _resolve: (r: () => void) => void = () => {};
  let _reject: (e: Error) => void = () => {};
  const promise = new Promise<() => void>((res, rej) => { _resolve = res; _reject = rej; });
  const task = new QueuedTask({ id, priority: 0, enqueueTime: Date.now(), isProbe: false, resolve: _resolve, reject: _reject, ...opts });
  return { task, promise, resolve: _resolve, reject: _reject };
}
describe('IndexedBinaryHeap', () => {
  it('pops items in priority order (min-heap)', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    heap.insert({ id: 1, priority: 5 });
    heap.insert({ id: 2, priority: 1 });
    heap.insert({ id: 3, priority: 3 });
    expect(heap.pop()?.priority).toBe(1);
    expect(heap.pop()?.priority).toBe(3);
    expect(heap.pop()?.priority).toBe(5);
    expect(heap.pop()).toBeUndefined();
  });

  it('has / size / isEmpty / peek', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    expect(heap.isEmpty()).toBe(true);
    heap.insert({ id: 10, priority: 1 });
    expect(heap.size).toBe(1);
    expect(heap.isEmpty()).toBe(false);
    expect(heap.has(10)).toBe(true);
    expect(heap.peek()?.id).toBe(10);
  });

  it('delete removes an arbitrary element', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    heap.insert({ id: 1, priority: 1 });
    heap.insert({ id: 2, priority: 2 });
    heap.insert({ id: 3, priority: 3 });
    heap.delete(2);
    expect(heap.has(2)).toBe(false);
    expect(heap.size).toBe(2);
  });

  it('delete returns undefined for missing id', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    expect(heap.delete(99)).toBeUndefined();
  });

  it('clear empties the heap', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    heap.insert({ id: 1, priority: 1 });
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.has(1)).toBe(false);
  });

  it('throws on duplicate id insert', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    heap.insert({ id: 1, priority: 1 });
    expect(() => heap.insert({ id: 1, priority: 2 })).toThrow();
  });

  it('maintains heap invariant after deleting the root', () => {
    const heap = new IndexedBinaryHeap<{ id: number; priority: number }>((a, b) => a.priority - b.priority);
    [3, 1, 4, 1, 5, 9, 2, 6].forEach((p, i) => heap.insert({ id: i, priority: p }));
    heap.delete(heap.peek()!.id); // delete root
    // Verify remaining items still pop in sorted order
    const results: number[] = [];
    while (!heap.isEmpty()) results.push(heap.pop()!.priority);
    expect(results).toEqual([...results].sort((a, b) => a - b));
  });

  it('bubbles up when a deleted interior node is replaced by a smaller leaf', () => {
    const heap = new IndexedBinaryHeap<{ id: number; val: number }>((a, b) => a.val - b.val);
    // Insert order yields the array [1, 5, 2, 8, 9, 3] by value.
    [1, 5, 2, 8, 9, 3].forEach((val, i) => heap.insert({ id: i, val }));
    // Deleting value 9 (id 4) moves the tail value 3 into its slot; 3 is smaller
    // than its new parent (5), so the replacement must bubble *up*, not down.
    heap.delete(4);
    const results: number[] = [];
    while (!heap.isEmpty()) results.push(heap.pop()!.val);
    expect(results).toEqual([1, 2, 3, 5, 8]); // 9 removed, heap order preserved
  });
});
