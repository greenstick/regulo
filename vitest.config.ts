import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      // branches trails lines (currently ~89% overall); the floor catches a
      // branch-coverage regression that a lines-only threshold would miss.
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
