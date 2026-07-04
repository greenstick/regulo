import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      // Lines and functions are at 100%; branches sit at ~97.8% because the
      // remainder are defensive arms unreachable through the public API
      // (e.g. Semaphore._dequeue miss, _fireTimeout shutdown guard). The
      // floors lock in the current baseline against regression.
      thresholds: { lines: 100, functions: 100, branches: 97 },
    },
  },
});
