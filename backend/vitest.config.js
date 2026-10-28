// Owner: A (Backend)
// Purpose: Vitest config; DB-backed test files share one database, so run files serially
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15000,
    env: { NODE_ENV: 'test' },
  },
});
