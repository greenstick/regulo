/*
Indexed Binary Heap

A min-heap where each element is addressable by ID, enabling O(log N) deletion
of arbitrary elements (not just the root). Used by the semaphore's priority queue.
*/

import type { Comparator, ID } from './types';

export class IndexedBinaryHeap<T> {
  private heap: T[] = [];
  private indexMap = new Map<ID, number>();
  private readonly compare: Comparator<T>;
  private readonly getId: (item: T) => ID;

  constructor(
    comparator: Comparator<T>,
    getId: (item: T) => ID = (item: any) => item.id
  ) {
    this.compare = comparator;
    this.getId = getId;
  }

  public get size(): number { return this.heap.length; }
  public isEmpty(): boolean { return this.heap.length === 0; }
  public peek(): T | undefined { return this.heap[0]; }
  public toArray(): T[] { return [...this.heap]; }
  public has(id: ID): boolean { return this.indexMap.has(id); }
  public clear(): void { this.heap = []; this.indexMap.clear(); }

  public insert(item: T): void {
    const id = this.getId(item);
    if (this.indexMap.has(id)) throw new Error(`Duplicate ID ${id} in heap`);
    const index = this.heap.length;
    this.heap.push(item);
    this.indexMap.set(id, index);
    this._bubbleUp(index);
  }

  public pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const root = this.heap[0];
    this.indexMap.delete(this.getId(root));
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      this.indexMap.set(this.getId(last), 0);
      this._bubbleDown(0);
    }
    return root;
  }

  public delete(id: ID): T | undefined {
    const index = this.indexMap.get(id);
    if (index === undefined) return undefined;
    const deleted = this.heap[index];
    this.indexMap.delete(id);
    const last = this.heap.pop();
    if (index === this.heap.length || last === undefined) return deleted;
    this.heap[index] = last;
    this.indexMap.set(this.getId(last), index);
    const parent = this.heap[Math.floor((index - 1) / 2)];
    if (index > 0 && parent !== undefined && this.compare(last, parent) < 0) {
      this._bubbleUp(index);
    } else {
      this._bubbleDown(index);
    }
    return deleted;
  }

  private _swap(i: number, j: number): void {
    const a = this.heap[i], b = this.heap[j];
    if (a === undefined || b === undefined) return;
    this.heap[i] = b; this.heap[j] = a;
    this.indexMap.set(this.getId(b), i);
    this.indexMap.set(this.getId(a), j);
  }

  private _bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const cur = this.heap[index], par = this.heap[parent];
      if (cur !== undefined && par !== undefined && this.compare(cur, par) < 0) {
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
      const cur = this.heap[smallest], left = this.heap[l], right = this.heap[r];
      if (l < len && left !== undefined && cur !== undefined && this.compare(left, cur) < 0) smallest = l;
      const sm = this.heap[smallest];
      if (r < len && right !== undefined && sm !== undefined && this.compare(right, sm) < 0) smallest = r;
      if (smallest !== index) { this._swap(index, smallest); index = smallest; }
      else break;
    }
  }
}
