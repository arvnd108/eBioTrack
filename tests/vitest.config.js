// Owner: C (Testing & QA)
// Purpose: Vitest config for tests/; suites share one database, so files run serially
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Anchored to this file so the config works from tests/ or from the repo root.
  root: here,
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    include: ['**/*.test.js'],
    exclude: ['node_modules/**'],
    globalSetup: [path.join(here, 'setup/globalSetup.js')],
    env: { NODE_ENV: 'test' },
    // Suites for T30 to T36 are empty stubs until those tasks land.
    passWithNoTests: true,
  },
});
