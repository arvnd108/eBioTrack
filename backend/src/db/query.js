// Owner: A (Backend)
// Purpose: Parameterized query and transaction helpers
import { pool } from './pool.js';

const PLACEHOLDER = /\$\d+/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkQuery(text, params) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('query text must be a non-empty string');
  }
  if (params === undefined && PLACEHOLDER.test(text)) {
    throw new TypeError('query text has placeholders ($1, $2, ...) but params was not provided');
  }
  if (params !== undefined && !Array.isArray(params)) {
    throw new TypeError('params must be an array');
  }
  return params ?? [];
}

/**
 * Run a parameterized query and return its rows. Values go through bind parameters only.
 * @param {string} text SQL with $1, $2, ... placeholders
 * @param {unknown[]} [params]
 * @param {{query: Function}} [executor] a pool or a client from withTransaction (default: the pool)
 * @returns {Promise<any[]>}
 */
export async function query(text, params, executor = pool) {
  const values = checkQuery(text, params);
  const result = await executor.query(text, values);
  return result.rows;
}

/**
 * Run a parameterized query and return the first row, or null if there is none.
 * @param {string} text
 * @param {unknown[]} [params]
 * @param {{query: Function}} [executor]
 * @returns {Promise<any | null>}
 */
export async function queryOne(text, params, executor = pool) {
  const rows = await query(text, params, executor);
  return rows[0] ?? null;
}

/**
 * Run `fn(client)` inside BEGIN/COMMIT. Any error rolls back, the client is always released,
 * and the original error is rethrown unchanged (so `err.code` such as EB001 or 23505 survives).
 * With `actorId`, sets `app.current_user_id` for this transaction only (CONTRACT section 7), which
 * the audit trigger reads. Bind parameters are not allowed in SET LOCAL, hence set_config(..., true).
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{actorId?: number | string | null}} [options]
 * @returns {Promise<T>}
 */
export async function withTransaction(fn, { actorId } = {}) {
  let actor = null;
  if (actorId !== undefined && actorId !== null) {
    actor = String(actorId);
    if (!/^[1-9]\d*$/.test(actor)) throw new TypeError('actorId must be a positive integer');
  }

  const client = await pool.connect();
  let discard; // truthy release argument destroys a client left in an unknown state
  try {
    await client.query('BEGIN');
    if (actor !== null) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [actor]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error(`[db] rollback failed, discarding connection: ${rollbackErr.message}`);
      discard = rollbackErr;
    }
    throw err;
  } finally {
    client.release(discard);
  }
}

/**
 * Call a stored function as `SELECT * FROM name($1, $2, ...)`. The name is checked against a strict
 * identifier whitelist because identifiers cannot be bind parameters; args always are.
 * Pass jsonb arguments as JSON strings (a JS array would be sent as a PostgreSQL array).
 * @param {string} name function name (letters, digits, underscore)
 * @param {unknown[]} [args]
 * @param {{query: Function}} [client] a pool or a client from withTransaction (default: the pool)
 * @returns {Promise<any[]>}
 */
export async function callProcedure(name, args = [], client = pool) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new TypeError(`invalid procedure name: ${JSON.stringify(name)}`);
  }
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const result = await client.query(`SELECT * FROM ${name}(${placeholders})`, args);
  return result.rows;
}
