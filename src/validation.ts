/*
Numeric validation methods

All failures throw SemaphoreError with code 'INVALID_ARGUMENT' so that argument
validation is programmatically distinguishable (via `.code`) from runtime
rejections, consistent with the rest of the error model.
*/

import { SemaphoreError } from './error';

export const validateNumber = (
  x: unknown,
  name: string,
  min: number,
  max: number,
  mustBeInteger = true,
  inclusive = true
): number => {
  if (typeof x !== "number" || Number.isNaN(x)) {
    throw new SemaphoreError(`${name} must be a valid number`, 'INVALID_ARGUMENT');
  }

  if (mustBeInteger && !Number.isInteger(x)) {
    throw new SemaphoreError(`${name} must be an integer`, 'INVALID_ARGUMENT');
  }

  const invalidMin = inclusive ? x < min : x <= min;
  if (invalidMin) {
    throw new SemaphoreError(`${name} must be ${inclusive ? '>=' : '>'} ${min}`, 'INVALID_ARGUMENT');
  }

  const invalidMax = inclusive ? x > max : x >= max;
  if (invalidMax) {
    throw new SemaphoreError(`${name} must be ${inclusive ? '<=' : '<'} ${max}`, 'INVALID_ARGUMENT');
  }
  return x;
};
