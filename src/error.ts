import type { SemaphoreErrorCode } from './types';

export class SemaphoreError extends Error {
  public readonly code: SemaphoreErrorCode;
  constructor(message: string, code: SemaphoreErrorCode) {
    super(message);
    this.name = 'SemaphoreError';
    this.code = code;
  }
}
