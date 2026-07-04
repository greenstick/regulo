import { describe, it, expect } from 'vitest';
import { IntrusiveList, type IntrusiveNode } from '../src/list';

// Minimal intrusive node: carries its own prev/next plus an id for assertions.
class Node implements IntrusiveNode<Node> {
  prev: Node | null = null;
  next: Node | null = null;
  constructor(public id: number) {}
}

const ids = (list: IntrusiveList<Node>): number[] => {
  const out: number[] = [];
  // Walk from the head via peekHead + next pointers (the access pattern the
  // semaphore's purge sweep uses).
  let n = list.peekHead() ?? null;
  while (n !== null) { out.push(n.id); n = n.next; }
  return out;
};

describe('IntrusiveList', () => {
  it('starts empty', () => {
    const list = new IntrusiveList<Node>();
    expect(list.size).toBe(0);
    expect(list.isEmpty()).toBe(true);
    expect(list.peekHead()).toBeUndefined();
  });

  it('pushTail preserves insertion order, oldest at the head', () => {
    const list = new IntrusiveList<Node>();
    [10, 20, 30].forEach(id => list.pushTail(new Node(id)));
    expect(list.size).toBe(3);
    expect(list.peekHead()?.id).toBe(10);
    expect(ids(list)).toEqual([10, 20, 30]);
  });

  it('removing the head advances to the next-oldest', () => {
    const list = new IntrusiveList<Node>();
    const nodes = [1, 2, 3].map(id => new Node(id));
    nodes.forEach(n => list.pushTail(n));
    list.remove(nodes[0]);
    expect(list.peekHead()?.id).toBe(2);
    list.remove(nodes[1]);
    expect(list.peekHead()?.id).toBe(3);
    expect(list.size).toBe(1);
  });

  it('removing the tail lets new appends land after the remaining head', () => {
    const list = new IntrusiveList<Node>();
    const nodes = [1, 2, 3].map(id => new Node(id));
    nodes.forEach(n => list.pushTail(n));
    list.remove(nodes[2]); // remove tail
    expect(ids(list)).toEqual([1, 2]);
    const four = new Node(4);
    list.pushTail(four);
    expect(ids(list)).toEqual([1, 2, 4]);
  });

  it('removing a middle node relinks both neighbors', () => {
    const list = new IntrusiveList<Node>();
    const nodes = [1, 2, 3, 4].map(id => new Node(id));
    nodes.forEach(n => list.pushTail(n));
    list.remove(nodes[1]); // middle
    list.remove(nodes[2]); // middle
    expect(ids(list)).toEqual([1, 4]);
    expect(list.size).toBe(2);
  });

  it('clears prev/next on a removed node so it can be re-pushed cleanly', () => {
    const list = new IntrusiveList<Node>();
    const a = new Node(1);
    const b = new Node(2);
    list.pushTail(a);
    list.pushTail(b);
    list.remove(a);
    expect(a.prev).toBeNull();
    expect(a.next).toBeNull();
    // Re-push the detached node onto a fresh list — must not drag old links.
    const other = new IntrusiveList<Node>();
    other.pushTail(a);
    expect(ids(other)).toEqual([1]);
  });

  it('draining to empty resets head/tail so the next append becomes the head', () => {
    const list = new IntrusiveList<Node>();
    const only = new Node(1);
    list.pushTail(only);
    list.remove(only);
    expect(list.peekHead()).toBeUndefined();
    expect(list.isEmpty()).toBe(true);
    const next = new Node(2);
    list.pushTail(next);
    expect(list.peekHead()?.id).toBe(2);
    expect(list.size).toBe(1);
  });

  it('clear() drops everything and stays reusable', () => {
    const list = new IntrusiveList<Node>();
    [1, 2, 3].forEach(id => list.pushTail(new Node(id)));
    list.clear();
    expect(list.size).toBe(0);
    expect(list.peekHead()).toBeUndefined();
    list.pushTail(new Node(9));
    expect(list.peekHead()?.id).toBe(9);
    expect(list.size).toBe(1);
  });
});

describe('IntrusiveList.peekHead', () => {
  it('returns undefined on an empty list and the head otherwise', () => {
    const list = new IntrusiveList<Node>();
    expect(list.peekHead()).toBeUndefined();
    const a = new Node(1);
    list.pushTail(a);
    expect(list.peekHead()).toBe(a);
    list.remove(a);
    expect(list.peekHead()).toBeUndefined();
  });
});
