// Owner: A (Backend)
// Purpose: Shared helpers for backend tests that need a live PostgreSQL test database
import pg from 'pg';

/**
 * True when the test database (TEST_DATABASE_URL) accepts connections. Logs why not, so a skipped
 * suite is explained instead of failing opaquely.
 */
export async function probeDatabase() {
  try {
    const { config } = await import('../src/config/env.js');
    if (!config.isTest) throw new Error('NODE_ENV is not "test"; refusing to touch a non-test DB');
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    await client.end();
    return true;
  } catch (err) {
    console.warn(`[skip] test database not available: ${err.message}`);
    console.warn('       Start it with `docker compose up -d db` and copy .env.example to .env');
    return false;
  }
}

/**
 * The shared development password for the seeded users. Read from the fixtures README (where the
 * project documents it) so it is not copied into more files.
 */
export async function devPassword() {
  const { readFile } = await import('node:fs/promises');
  const readme = await readFile(new URL('../../tests/fixtures/README.md', import.meta.url), 'utf8');
  const match =
    /shares? one password: `([^`]+)`/i.exec(readme) ?? /password: `([^`]+)`/.exec(readme);
  if (!match) throw new Error('dev password not found in tests/fixtures/README.md');
  return match[1];
}

/**
 * Rebuild the test database from the real migrations and seeds. Other suites (the migration
 * runner tests) wipe the shared test database, so suites that need the fixture world call this.
 */
export async function resetAndSeedDatabase() {
  const { migrate } = await import('../src/db/migrate.js');
  await migrate({ reset: true, seed: true, log: () => {} });
}
