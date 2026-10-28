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
