/*
Indexed Binary Heap

A min-heap where each element is addressable for O(log N) deletion of an
arbitrary element (not just the root). Used by the semaphore's priority queue.

The index is *intrusive*: each element stores its own slot in the backing array
(`heapIndex`, -1 when not in the heap) instead of the heap keeping a separate
`Map<id, index>`. Every sift writes this slot, so on the hot enqueue/dispatch
path that turns a Map set/get/delete (with its hashing and rehash growth) into a
plain property write — the same trick IntrusiveList uses for the enqueue index.
Removal therefore takes the element itself rather than an id.
*/

import { SemaphoreError } from './error';
import type { Comparator } from './types';

export interface HeapNode {
  /**
   * This element's position in the heap's backing array, or -1 when it is not
   * in any heap. Owned and written solely by IndexedBinaryHeap.
   */
  heapIndex: number;
}

export class IndexedBinaryHeap<T extends HeapNode> {
  private heap: T[] = [];
  private readonly compare: Comparator<T>;

  constructor(comparator: Comparator<T>) {
    this.compare = comparator;
  }

  public get size(): number { return this.heap.length; }
  public isEmpty(): boolean { return this.heap.length === 0; }
  public peek(): T | undefined { return this.heap[0]; }

  /** True if `item` is currently in this heap. O(1). */
  public has(item: T): boolean {
    return item.heapIndex >= 0 && this.heap[item.heapIndex] === item;
  }

  public clear(): void {
    for (const item of this.heap) item.heapIndex = -1;
    this.heap = [];
  }

  public insert(item: T): void {
    if (item.heapIndex >= 0) throw new SemaphoreError('Item is already in a heap', 'INVALID_ARGUMENT');
    const index = this.heap.length;
    this.heap.push(item);
    item.heapIndex = index;
    this._bubbleUp(index);
  }

  public pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const root = this.heap[0];
    root.heapIndex = -1;
    const last = this.heap.pop()!;
    if (this.heap.length > 0 && last !== root) {
      this.heap[0] = last;
      last.heapIndex = 0;
      this._bubbleDown(0);
    }
    return root;
  }

  /** Remove a specific element. O(log N). Returns it, or undefined if absent. */
  public delete(item: T): T | undefined {
    const index = item.heapIndex;
    if (index < 0 || this.heap[index] !== item) return undefined;
    item.heapIndex = -1;
    const last = this.heap.pop()!;
    if (index === this.heap.length || last === item) return item; // removed the tail
    this.heap[index] = last;
    last.heapIndex = index;
    const parent = this.heap[(index - 1) >> 1];
    if (index > 0 && this.compare(last, parent) < 0) this._bubbleUp(index);
    else this._bubbleDown(index);
    return item;
  }

  private _swap(i: number, j: number): void {
    const a = this.heap[i], b = this.heap[j];
    this.heap[i] = b; this.heap[j] = a;
    a.heapIndex = j; b.heapIndex = i;
  }

  private _bubbleUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.heap[index], this.heap[parent]) < 0) {
        this._swap(index, parent);
        index = parent;
      } else break;
    }
  }

  private _bubbleDown(index: number): void {
    const len = this.heap.length;
    while (true) {
      let smallest = index;
      const l = 2 * index + 1, r = 2 * index + 2;
      if (l < len && this.compare(this.heap[l], this.heap[smallest]) < 0) smallest = l;
      if (r < len && this.compare(this.heap[r], this.heap[smallest]) < 0) smallest = r;
      if (smallest === index) break;
      this._swap(index, smallest);
      index = smallest;
    }
  }
}
