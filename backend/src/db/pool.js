// Owner: A (Backend)
// Purpose: PostgreSQL connection pool
import pg from 'pg';
import { config } from '../config/env.js';

const DEFAULT_POOL_MAX = 10;
const INT8_OID = 20;

// BIGINT ids and counts come back from pg as strings; the API contract (section 8) says IDs are
// numbers. Parse to Number when safe, otherwise leave the string so no precision is lost.
pg.types.setTypeParser(INT8_OID, (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

/** The single shared pool for this process. */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax ?? DEFAULT_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle client erroring (for example the server restarting) must be visible, not silent.
pool.on('error', (err) => {
  console.error(`[db] idle client error: ${err.message}`);
});

let closing = null;

/** Close the pool. Safe to call more than once. */
export function closePool() {
  closing ??= pool.end();
  return closing;
}
