// Owner: C (Testing & QA)
// Purpose: Create, migrate, seed, and tear down the test database
//
// Every function that can drop or alter data calls assertSafeTarget() first, so a bad .env can
// never point a test run at the development database.
//
// Usage:
//   import { resetTestDatabase, withRollback, closeTestPool } from '../setup/testDb.js';
//   beforeAll(() => resetTestDatabase());
//   it('...', () => withRollback(async (client) => { await client.query('...'); }));
//   afterAll(() => closeTestPool());
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must happen before backend/src/config/env.js is loaded (it is imported lazily below), otherwise
// the backend config would resolve to the development database.
process.env.NODE_ENV = 'test';

import dotenv from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const TEST_DB_NAME = 'ebiotrack_test';
// Also allowed: ebiotrack_<something>_test (e.g. a throwaway DB for a destructive suite).
const TEST_DB_PATTERN = /^ebiotrack_[a-z0-9_]*_test$/;
const SCHEMA = 'public';

let pool = null;

const quiet = () => {};
const silent = { log: quiet };

async function loadMigrate() {
  return (await import('../../backend/src/db/migrate.js')).migrate;
}

/**
 * The backend config (loaded lazily so NODE_ENV=test is already set).
 * @returns {Promise<{config: object, maskDatabaseUrl: (url: string) => string}>}
 */
export async function loadBackendConfig() {
  return import('../../backend/src/config/env.js');
}

/**
 * TEST_DATABASE_URL from the environment (or the repo-root .env).
 * @returns {string}
 */
export function getTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env (or set it in the environment).',
    );
  }
  return url;
}

/**
 * Safety guard: throw unless the URL targets the test database. Call before anything destructive.
 * Accepts only the database `ebiotrack_test` (or `ebiotrack_<name>_test`).
 * @param {string} url
 * @returns {string} the database name
 */
export function assertSafeTarget(url) {
  let name;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('Refusing to run: database URL is empty or malformed');
  }
  if (name !== TEST_DB_NAME && !TEST_DB_PATTERN.test(name)) {
    throw new Error(
      `Refusing to run: database "${name}" is not a test database (expected "${TEST_DB_NAME}")`,
    );
  }
  return name;
}

/**
 * Connectivity probe for the test database. Logs why it is unreachable.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function isDatabaseAvailable({ timeoutMs = 2000 } = {}) {
  let client;
  try {
    const url = getTestDatabaseUrl();
    assertSafeTarget(url);
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
    await client.connect();
    return true;
  } catch (err) {
    console.warn(`[testDb] test database not available: ${err.message || err.code}`);
    console.warn('         Start it with `docker compose up -d db` and copy .env.example to .env');
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
}

/**
 * Migrate the test database to the latest schema, optionally loading seeds. Idempotent.
 * @param {{seed?: boolean}} [options]
 */
export async function setupTestDatabase({ seed = true } = {}) {
  const databaseUrl = getTestDatabaseUrl();
  assertSafeTarget(databaseUrl);
  const migrate = await loadMigrate();
  return migrate({ seed, databaseUrl, nodeEnv: 'test', ...silent });
}

/**
 * Drop and recreate the public schema, then migrate (and seed). The "one command" reset (gate G2).
 * @param {{seed?: boolean}} [options]
 */
export async function resetTestDatabase({ seed = true } = {}) {
  const databaseUrl = getTestDatabaseUrl();
  assertSafeTarget(databaseUrl);
  // Open connections hold locks that would block DROP SCHEMA.
  await closeTestPool();
  const migrate = await loadMigrate();
  return migrate({ reset: true, seed, databaseUrl, nodeEnv: 'test', ...silent });
}

/**
 * Restore the fixture world without rebuilding the schema: truncate every table (except the
 * migration tracking tables) with RESTART IDENTITY, forget the applied seeds, and re-run them.
 * Faster than resetTestDatabase() and keeps app-created IDs starting at 1000 (D6), but it assumes
 * the schema is current; use resetTestDatabase() after changing a migration.
 */
export async function reseed() {
  const databaseUrl = getTestDatabaseUrl();
  assertSafeTarget(databaseUrl);
  const db = getPool();
  // Table names come from the catalog and are quoted by format(%I); nothing is user input.
  const { rows } = await db.query(
    `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables
       FROM pg_tables
      WHERE schemaname = $1 AND tablename NOT IN ('schema_migrations', 'schema_seeds')`,
    [SCHEMA],
  );
  if (rows[0].tables) await db.query(`TRUNCATE ${rows[0].tables} RESTART IDENTITY CASCADE`);
  await db.query(`DELETE FROM schema_seeds`);
  const migrate = await loadMigrate();
  return migrate({ seed: true, databaseUrl, nodeEnv: 'test', ...silent });
}

/**
 * Shared pg.Pool bound to the test database (created on first use).
 * @returns {import('pg').Pool}
 */
export function getPool() {
  if (!pool) {
    const url = getTestDatabaseUrl();
    assertSafeTarget(url);
    pool = new pg.Pool({ connectionString: url, max: 5 });
  }
  return pool;
}

/** Close the shared pool. Safe to call repeatedly. */
export async function closeTestPool() {
  const closing = pool;
  pool = null;
  await closing?.end();
}

/**
 * Run fn(client) inside a transaction that is always rolled back, leaving the fixture world as is.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRollback(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Set the acting user for the current transaction, as the backend does (CONTRACT section 7).
 * Must be called inside a transaction (e.g. withRollback) to have any lasting effect.
 * @param {import('pg').PoolClient} client
 * @param {number|string} userId
 */
export async function setActingUser(client, userId) {
  await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(userId)]);
}

/**
 * Assert that a promise rejects with the given SQLSTATE (e.g. '23505', 'EB001').
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
export async function expectSqlState(promise, code) {
  let result;
  try {
    result = await promise;
  } catch (err) {
    if (err?.code !== code) {
      throw new Error(
        `Expected SQLSTATE ${code} but got ${err?.code ?? 'no code'}: ${err?.message}`,
        {
          cause: err,
        },
      );
    }
    return err;
  }
  throw new Error(
    `Expected SQLSTATE ${code} but the statement succeeded (${result?.rowCount ?? '?'} rows)`,
  );
}
