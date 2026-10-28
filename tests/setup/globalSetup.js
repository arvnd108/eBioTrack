// Owner: C (Testing & QA)
// Purpose: Vitest globalSetup: probe the test DB, migrate and seed once per run, expose availability
import {
  assertSafeTarget,
  getTestDatabaseUrl,
  isDatabaseAvailable,
  setupTestDatabase,
} from './testDb.js';

/**
 * Suites read the flag with `inject('dbAvailable')` from 'vitest' and skip when it is false.
 * In CI an unreachable database is an error, so a skipped suite can never look green.
 */
export default async function setup(project) {
  const inCi = process.env.CI === 'true';
  let available = false;
  try {
    assertSafeTarget(getTestDatabaseUrl());
    available = await isDatabaseAvailable();
  } catch (err) {
    if (inCi) {
      err.stack = `Error: ${err.message}`;
      throw err;
    }
    console.warn(`[globalSetup] ${err.message}`);
  }

  if (!available) {
    if (inCi) {
      // Plain stack: Vitest's source-map printer crashes on stack traces from globalSetup.
      const err = new Error('CI=true but the test database is unreachable; failing the run.');
      err.stack = `Error: ${err.message}`;
      throw err;
    }
    console.warn('[globalSetup] database suites will be SKIPPED (not running in CI).');
  } else {
    await setupTestDatabase({ seed: true });
  }
  project.provide('dbAvailable', available);
}
