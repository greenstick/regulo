import { describe, it, expect } from 'vitest';
import { IndexedBinaryHeap, type HeapNode } from '../src/heap';

// The heap is intrusive: elements carry their own `heapIndex` slot (-1 when not
// in the heap) and are removed by reference, not by id.
type Node = { id: number; priority: number; heapIndex: number };
const node = (id: number, priority: number): Node => ({ id, priority, heapIndex: -1 });

const byPriority = (a: HeapNode & { priority: number }, b: HeapNode & { priority: number }) =>
  a.priority - b.priority;

describe('IndexedBinaryHeap', () => {
  it('pops items in priority order (min-heap)', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    heap.insert(node(1, 5));
    heap.insert(node(2, 1));
    heap.insert(node(3, 3));
    expect(heap.pop()?.priority).toBe(1);
    expect(heap.pop()?.priority).toBe(3);
    expect(heap.pop()?.priority).toBe(5);
    expect(heap.pop()).toBeUndefined();
  });

  it('has / size / isEmpty / peek', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    const a = node(10, 1);
    expect(heap.isEmpty()).toBe(true);
    heap.insert(a);
    expect(heap.size).toBe(1);
    expect(heap.isEmpty()).toBe(false);
    expect(heap.has(a)).toBe(true);
    expect(heap.peek()?.id).toBe(10);
  });

  it('clears heapIndex on pop so popped items report as absent', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    const a = node(1, 1);
    heap.insert(a);
    expect(a.heapIndex).toBeGreaterThanOrEqual(0);
    heap.pop();
    expect(a.heapIndex).toBe(-1);
    expect(heap.has(a)).toBe(false);
  });

  it('delete removes an arbitrary element', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    const a = node(1, 1), b = node(2, 2), c = node(3, 3);
    [a, b, c].forEach(n => heap.insert(n));
    expect(heap.delete(b)).toBe(b);
    expect(heap.has(b)).toBe(false);
    expect(b.heapIndex).toBe(-1);
    expect(heap.size).toBe(2);
  });

  it('delete returns undefined for an element not in the heap', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    const stray = node(99, 9);
    expect(heap.delete(stray)).toBeUndefined();
    heap.insert(node(1, 1));
    expect(heap.delete(stray)).toBeUndefined(); // still absent
  });

  it('clear empties the heap and resets element slots', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    const a = node(1, 1);
    heap.insert(a);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.has(a)).toBe(false);
    expect(a.heapIndex).toBe(-1);
  });

  it('throws when inserting the same element twice', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    const a = node(1, 1);
    heap.insert(a);
    expect(() => heap.insert(a)).toThrow(/already in a heap/);
  });

  it('maintains heap invariant after deleting the root', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    [3, 1, 4, 1, 5, 9, 2, 6].forEach((p, i) => heap.insert(node(i, p)));
    heap.delete(heap.peek()!); // delete root
    const results: number[] = [];
    while (!heap.isEmpty()) results.push(heap.pop()!.priority);
    expect(results).toEqual([...results].sort((a, b) => a - b));
  });

  it('bubbles up when a deleted interior node is replaced by a smaller leaf', () => {
    const heap = new IndexedBinaryHeap<Node>(byPriority);
    // Insert order yields the array [1, 5, 2, 8, 9, 3] by value.
    const nodes = [1, 5, 2, 8, 9, 3].map((priority, id) => node(id, priority));
    nodes.forEach(n => heap.insert(n));
    // Deleting value 9 moves the tail value 3 into its slot; 3 is smaller than
    // its new parent (5), so the replacement must bubble *up*, not down.
    heap.delete(nodes[4]); // the node with value 9
    const results: number[] = [];
    while (!heap.isEmpty()) results.push(heap.pop()!.priority);
    expect(results).toEqual([1, 2, 3, 5, 8]);
  });
});

describe('IndexedBinaryHeap.has', () => {
  it('reports membership before and after removal', () => {
    const h = new IndexedBinaryHeap<Node>(byPriority);
    const a = node(1, 1);
    const b = node(2, 2);
    expect(h.has(a)).toBe(false);
    h.insert(a);
    h.insert(b);
    expect(h.has(a)).toBe(true);
    expect(h.has(b)).toBe(true);
    h.pop();
    expect(h.has(a)).toBe(false);
    expect(h.has(b)).toBe(true);
    h.delete(b);
    expect(h.has(b)).toBe(false);
  });
});
