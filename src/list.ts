/*
Intrusive Linked List

A doubly-linked list that stores its prev/next pointers *on the elements
themselves* rather than in wrapper nodes. That makes append and removal cost
only a few pointer writes — no per-element allocation and no id -> node map to
maintain, which matters because the semaphore pushes and pops this list on every
queued acquire/dispatch (the hot contended path).

The semaphore keeps it alongside the priority heap as a second, independent
index over the same tasks. The heap answers "who dispatches next" (priority
order); the list answers "who has waited longest" (enqueue order). Tasks are
appended to the tail in strictly non-decreasing enqueue time, so the head is
always the oldest queued task. That gives two wins over scanning the heap:
  - status() reads queue age in O(1): Date.now() - head.enqueueTime.
  - The stale-task purge walks from the head and stops at the first task young
    enough to keep, touching only the tasks it actually evicts (O(s)) instead of
    cloning and filtering the whole queue every tick (O(N)).

remove() assumes the element is currently a member: because the pointers live on
the element, a double removal corrupts the head/tail. The semaphore enforces
single removal by deleting from the heap first and only unlinking here on a
confirmed hit (see Semaphore._dequeue), so this list never needs its own
membership map.
*/

export interface IntrusiveNode<T> {
  prev: T | null;
  next: T | null;
}

export class IntrusiveList<T extends IntrusiveNode<T>> {
  private head: T | null = null;
  private tail: T | null = null;
  private _size = 0;

  public get size(): number { return this._size; }
  public isEmpty(): boolean { return this._size === 0; }

  /** Oldest (earliest-appended) element, or undefined when empty. O(1). */
  public peekHead(): T | undefined { return this.head === null ? undefined : this.head; }

  /** Append to the tail, preserving insertion order. O(1). */
  public pushTail(item: T): void {
    item.prev = this.tail;
    item.next = null;
    if (this.tail !== null) this.tail.next = item;
    else this.head = item;
    this.tail = item;
    this._size++;
  }

  /** Unlink a member element. O(1). The caller must guarantee membership. */
  public remove(item: T): void {
    if (item.prev !== null) item.prev.next = item.next;
    else this.head = item.next;
    if (item.next !== null) item.next.prev = item.prev;
    else this.tail = item.prev;
    item.prev = item.next = null;
    this._size--;
  }

  public clear(): void {
    // Detached elements keep stale prev/next, which is harmless: an element is
    // only ever re-touched via pushTail, and that overwrites both pointers.
    this.head = this.tail = null;
    this._size = 0;
  }
}
