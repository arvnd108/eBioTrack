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

/** Seeded user emails by role (see tests/fixtures/README.md). */
export const SEED_EMAIL = {
  administrator: 'administrator@ebiotrack.test',
  principal_investigator: 'principal_investigator@ebiotrack.test',
  field_researcher: 'field_researcher@ebiotrack.test',
  lab_technician: 'lab_technician@ebiotrack.test',
  analyst: 'analyst@ebiotrack.test',
  viewer: 'viewer@ebiotrack.test',
};

/**
 * A supertest agent that keeps the session cookie, signed in as `email`.
 * @param {import('express').Express} app
 * @param {string} email
 * @param {string} [password] defaults to the shared dev password
 */
export async function signIn(app, email, password) {
  const { default: request } = await import('supertest');
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ email, password: password ?? (await devPassword()) });
  if (res.status !== 200) throw new Error(`sign-in as ${email} failed: ${res.status}`);
  return agent;
}
