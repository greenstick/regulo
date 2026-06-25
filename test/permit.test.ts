import { describe, it, expect, vi } from 'vitest';
import { PermitPool } from '../src/permit';

describe('PermitPool', () => {
  it('starts with all permits available', () => {
    const p = new PermitPool(3);
    expect(p.available).toBe(3);
    expect(p.inFlight).toBe(0);
    expect(p.isFull).toBe(false);
    expect(p.capacity).toBe(3);
  });

  it('acquire decrements available and increments inFlight', () => {
    const p = new PermitPool(3);
    p.acquire();
    expect(p.available).toBe(2);
    expect(p.inFlight).toBe(1);
    p.acquire();
    expect(p.available).toBe(1);
    expect(p.inFlight).toBe(2);
  });

  it('isFull when available === 0', () => {
    const p = new PermitPool(1);
    p.acquire();
    expect(p.isFull).toBe(true);
  });

  it('release restores available and decrements inFlight', () => {
    const p = new PermitPool(2);
    p.acquire();
    p.release();
    expect(p.available).toBe(2);
    expect(p.inFlight).toBe(0);
  });

  it('release clamps to capacity (double-release safe)', () => {
    const p = new PermitPool(2);
    p.acquire();
    p.release();
    p.release(); // extra release
    expect(p.available).toBe(2);
    expect(p.inFlight).toBe(0);
  });

  it('inFlight clamps to 0 on excess release', () => {
    const p = new PermitPool(2);
    p.release(); // release without acquire
    expect(p.inFlight).toBe(0);
  });

  it('assertInvariant logs on violation in debug mode', () => {
    const p = new PermitPool(2);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force a violation by acquiring without the guard
    p.acquire();
    // Manually corrupt state to trigger the invariant check
    (p as any)._available = 2; // now inFlight(1) + available(2) = 3 ≠ capacity(2)
    p.assertInvariant(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Invariant violation'));
    spy.mockRestore();
  });

  it('assertInvariant is silent when debug is false', () => {
    const p = new PermitPool(2);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    p.acquire();
    (p as any)._available = 2;
    p.assertInvariant(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reset restores initial state', () => {
    const p = new PermitPool(3);
    p.acquire(); p.acquire();
    p.reset();
    expect(p.available).toBe(3);
    expect(p.inFlight).toBe(0);
  });

  describe('weighted operations', () => {
    it('hasCapacityFor returns true when sufficient permits available', () => {
      const p = new PermitPool(3);
      expect(p.hasCapacityFor(1)).toBe(true);
      expect(p.hasCapacityFor(3)).toBe(true);
      p.acquire(2);
      expect(p.hasCapacityFor(1)).toBe(true);
      expect(p.hasCapacityFor(2)).toBe(false);
    });

    it('acquire(weight) consumes multiple permits', () => {
      const p = new PermitPool(5);
      p.acquire(3);
      expect(p.available).toBe(2);
      expect(p.inFlight).toBe(3);
    });

    it('release(weight) restores multiple permits', () => {
      const p = new PermitPool(5);
      p.acquire(3);
      p.release(3);
      expect(p.available).toBe(5);
      expect(p.inFlight).toBe(0);
    });

    it('release(weight) clamps correctly when weight > inFlight', () => {
      const p = new PermitPool(5);
      p.acquire(2);
      p.release(3); // try to release more than held
      expect(p.available).toBe(5);
      expect(p.inFlight).toBe(0);
    });

    it('release(weight) handles partial double-release correctly', () => {
      const p = new PermitPool(5);
      p.acquire(3);
      p.acquire(1); // inFlight = 4
      p.release(2);  // inFlight = 2
      p.release(2);  // inFlight = 0
      expect(p.available).toBe(5);
      expect(p.inFlight).toBe(0);
    });
  });
});
