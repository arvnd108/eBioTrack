// Owner: C (Testing & QA)
// Purpose: Helpers for the query suites (T31): run the committed query files, normalise results
//
// Prepared statements live in one database session, so every query file gets its own dedicated pool
// client. The file is executed exactly as committed (DEALLOCATE ALL first, so a statement that is
// missing from a file cannot be answered by a leftover one) and each test then runs
// `EXECUTE <name>(<values>)`. PostgreSQL does not accept bind parameters inside EXECUTE (it is a
// utility command, the extended protocol rejects it), so every value goes through the driver's
// escapeLiteral (libpq PQescapeLiteral) as a quoted string and the prepared statement's declared
// parameter types do the casting. The statement name and the view name are the only identifiers
// built into SQL text and both are validated; view queries use real bound parameters.
//
// Usage:
//   const session = await openQuerySession('access');
//   const rows = await session.execute('access_user_projects', [3, null]);
//   await session.rollback(async (db) => { await db.query('UPDATE ...'); ... });  // never committed
//   await session.close();
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getPool } from './testDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const QUERY_DIR = path.resolve(here, '../../database/queries');
export const VIEW_DIR = path.resolve(here, '../../database/views');

export const SLICES = ['access', 'field', 'lab', 'analysis'];

export const VIEW_NAMES = [
  'v_user_project_access',
  'v_project_summary',
  'v_sample_registry',
  'v_site_sample_summary',
  'v_lab_pipeline_status',
  'v_failed_qc',
  'v_approved_detections',
  'v_site_richness',
];

const STATEMENT_NAME = /^[a-z][a-z0-9_]*$/;
const PLAN_MODES = ['auto', 'force_generic_plan', 'force_custom_plan'];

/** Session time zones used for the date-sensitive cases: UTC, a half-hour offset, far east/west. */
export const TIME_ZONES = ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles'];

const OID_DATE = 1082;
const OID_TIMESTAMPTZ = 1184;
const OID_INTERVAL = 1186;

/**
 * pg type parsers for this module only (the global parsers stay untouched). bigint and numeric stay
 * strings, int4 stays a number, `date` stays the literal YYYY-MM-DD text (a JS Date would shift it by
 * the machine's zone), timestamptz becomes an ISO string in UTC whatever the session TimeZone is,
 * interval stays the PostgreSQL text form.
 */
const types = {
  getTypeParser(oid, format) {
    if (oid === OID_DATE) return (value) => value;
    if (oid === OID_INTERVAL) return (value) => value;
    if (oid === OID_TIMESTAMPTZ) {
      const parse = pg.types.getTypeParser(oid, format);
      return (value) => parse(value).toISOString();
    }
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * Convert rows from an ordinary pool.query into the shapes execute() returns: Date -> ISO UTC string
 * (a `date` column must be read with the typed parsers instead, a Date has lost the distinction),
 * bigint-like numbers stay as they are. Plain objects/arrays are copied recursively.
 * @param {Array<Record<string, unknown>>} rows
 */
export function normaliseRows(rows) {
  const convert = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(convert);
    return value;
  };
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, convert(v)])),
  );
}

function assertStatementName(name) {
  if (typeof name !== 'string' || !STATEMENT_NAME.test(name)) {
    throw new Error(`Invalid prepared statement name: ${JSON.stringify(name)}`);
  }
}

function assertViewName(name) {
  if (!VIEW_NAMES.includes(name)) throw new Error(`Not a known view: ${JSON.stringify(name)}`);
}

/** Path of a slice's query file. */
export const queryFilePath = (slice) => {
  if (!SLICES.includes(slice)) throw new Error(`Unknown slice: ${JSON.stringify(slice)}`);
  return path.join(QUERY_DIR, `${slice}_queries.sql`);
};

/** Names of the statements a query file prepares, in file order. */
export function preparedNames(sqlText) {
  return [...sqlText.matchAll(/^\s*PREPARE\s+([a-z][a-z0-9_]*)\s*\(/gim)].map((m) => m[1]);
}

/**
 * Open a session for one slice's query file.
 * @param {'access'|'field'|'lab'|'analysis'} slice
 */
export async function openQuerySession(slice) {
  const sqlText = readFileSync(queryFilePath(slice), 'utf8');
  const client = await getPool().connect();
  const typeNames = new Map();
  try {
    await client.query('DEALLOCATE ALL');
    await client.query(sqlText);
  } catch (err) {
    client.release(true);
    throw err;
  }

  const typeName = async (oid) => {
    if (!typeNames.has(oid)) {
      const { rows } = await client.query('SELECT $1::oid::regtype::text AS name', [oid]);
      typeNames.set(oid, rows[0].name);
    }
    return typeNames.get(oid);
  };

  // Sequential on purpose: one client runs one query at a time.
  const describeFields = async (fields) => {
    const out = [];
    for (const f of fields) out.push({ name: f.name, type: await typeName(f.dataTypeID) });
    return out;
  };

  /**
   * Run `EXECUTE name($1..$n)` with bound parameters.
   * @param {string} name
   * @param {unknown[]} [params]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  const execute = async (name, params = []) => (await executeFull(name, params)).rows;

  const executeFull = async (name, params = []) => {
    assertStatementName(name);
    const literals = params.map((v) =>
      v === null || v === undefined ? 'NULL' : client.escapeLiteral(String(v)),
    );
    return client.query({ text: `EXECUTE ${name}(${literals.join(', ')})`, types });
  };

  /** Column names and PostgreSQL type names of a statement's result, in order. */
  const columns = async (name, params = []) => {
    const result = await executeFull(name, params);
    return describeFields(result.fields);
  };

  /**
   * SELECT * FROM <view> [WHERE ...] [ORDER BY ...]. `where` and `orderBy` are static SQL fragments
   * written in the test (with $n placeholders); values are bound.
   */
  const queryView = async (viewName, { where = '', params = [], orderBy = '' } = {}) => {
    assertViewName(viewName);
    const text = `SELECT * FROM ${viewName}${where ? ` WHERE ${where}` : ''}${
      orderBy ? ` ORDER BY ${orderBy}` : ''
    }`;
    return (await client.query({ text, values: params, types })).rows;
  };

  /** Column names and types of a view's result. */
  const viewColumns = async (viewName) => {
    assertViewName(viewName);
    const result = await client.query({ text: `SELECT * FROM ${viewName} LIMIT 0`, types });
    return describeFields(result.fields);
  };

  /** Plain SQL on the same session (oracle SQL, setup) with the same type handling. */
  const sql = async (text, params = []) =>
    (await client.query({ text, values: params, types })).rows;

  /** Run fn with the session TimeZone set to tz, restoring the previous zone afterwards. */
  const withTimeZone = async (tz, fn) => {
    const previous = (await client.query('SHOW TimeZone')).rows[0].TimeZone;
    await client.query(`SELECT set_config('TimeZone', $1, false)`, [tz]);
    try {
      return await fn();
    } finally {
      await client.query(`SELECT set_config('TimeZone', $1, false)`, [previous]);
    }
  };

  /** Run fn with plan_cache_mode forced to mode ('force_generic_plan' | 'force_custom_plan' | 'auto'). */
  const withPlanMode = async (mode, fn) => {
    if (!PLAN_MODES.includes(mode)) throw new Error(`Unknown plan_cache_mode: ${mode}`);
    const previous = (await client.query('SHOW plan_cache_mode')).rows[0].plan_cache_mode;
    await client.query(`SELECT set_config('plan_cache_mode', $1, false)`, [mode]);
    try {
      return await fn();
    } finally {
      await client.query(`SELECT set_config('plan_cache_mode', $1, false)`, [previous]);
    }
  };

  /**
   * Run fn(client) inside a transaction that is always rolled back. The writes are visible to
   * execute()/queryView() because they run on the same connection as the prepared statements.
   */
  const rollback = async (fn) => {
    await client.query('BEGIN');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  };

  const close = async () => {
    try {
      await client.query('ROLLBACK').catch(() => {});
      await client.query('DEALLOCATE ALL');
      await client.query('RESET ALL');
    } finally {
      client.release();
    }
  };

  return {
    client,
    names: preparedNames(sqlText),
    execute,
    executeFull,
    columns,
    queryView,
    viewColumns,
    sql,
    withTimeZone,
    withPlanMode,
    rollback,
    close,
  };
}

/**
 * Run check(label) once per (time zone, plan mode) combination so a result that depends on the
 * session zone or on the generic/custom plan choice shows up. Zones default to UTC and Asia/Kolkata.
 * @param {Awaited<ReturnType<typeof openQuerySession>>} session
 * @param {(label: string) => Promise<void>} check
 * @param {{zones?: string[], modes?: string[]}} [options]
 */
export async function acrossSettings(
  session,
  check,
  { zones = ['UTC', 'Asia/Kolkata'], modes = ['force_generic_plan', 'force_custom_plan'] } = {},
) {
  for (const zone of zones) {
    for (const mode of modes) {
      await session.withTimeZone(zone, () =>
        session.withPlanMode(mode, () => check(`${zone} / ${mode}`)),
      );
    }
  }
}
