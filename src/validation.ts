/*
Numeric validation methods
*/

export const validateNumber = (
  x: unknown,
  name: string,
  min: number,
  max: number,
  mustBeInteger = true,
  inclusive = true
): number => {
  if (typeof x !== "number" || Number.isNaN(x)) {
    throw new Error(`${name} must be a valid number`);
  }

  if (mustBeInteger && !Number.isInteger(x)) {
    throw new Error(`${name} must be an integer`);
  }

  const invalidMin = inclusive ? x < min : x <= min;
  if (invalidMin) {
    throw new Error(`${name} must be ${inclusive ? '>=' : '>'} ${min}`);
  }

  const invalidMax = inclusive ? x > max : x >= max;
  if (invalidMax) {
    throw new Error(`${name} must be ${inclusive ? '<=' : '<'} ${max}`);
  }
  return x;
};
