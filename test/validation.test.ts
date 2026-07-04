import { describe, it, expect } from 'vitest';
import { validateNumber } from '../src/validation';

describe('validateNumber', () => {
  it('returns the value when valid', () => {
    expect(validateNumber(5, 'x', 1, 10)).toBe(5);
    expect(validateNumber(0.5, 'x', 0, 1, false, false)).toBe(0.5);
  });

  it('rejects non-numbers and NaN', () => {
    expect(() => validateNumber('5', 'x', 0, 10)).toThrow('x must be a valid number');
    expect(() => validateNumber(NaN, 'x', 0, 10)).toThrow('x must be a valid number');
    expect(() => validateNumber(undefined, 'x', 0, 10)).toThrow('x must be a valid number');
  });

  it('rejects non-integers when mustBeInteger is set', () => {
    expect(() => validateNumber(1.5, 'x', 0, 10, true)).toThrow('x must be an integer');
  });

  it('enforces the inclusive bounds', () => {
    expect(() => validateNumber(0, 'x', 1, 10, true, true)).toThrow('x must be >= 1');
    expect(() => validateNumber(11, 'x', 1, 10, true, true)).toThrow('x must be <= 10');
    expect(validateNumber(1, 'x', 1, 10, true, true)).toBe(1);
    expect(validateNumber(10, 'x', 1, 10, true, true)).toBe(10);
  });

  it('enforces the exclusive bounds', () => {
    expect(() => validateNumber(0, 'x', 0, 1, false, false)).toThrow('x must be > 0');
    expect(() => validateNumber(1, 'x', 0, 1, false, false)).toThrow('x must be < 1');
  });
});
