// Owner: C (Testing & QA)
// Purpose: Helpers for the transaction suites (T32): real commits, a second connection, snapshots
//
// T30 and T31 roll everything back. The transaction suites must COMMIT for real (that is what
// durability and cross-connection visibility are), so they need their own clients, an observer
// connection that never joins a transaction, and an explicit cleanup: a test that commits calls
// committed(), and restoreIfCommitted() (afterEach / afterAll) reseeds the fixture world.
//
// runTransaction mirrors backend/src/db/query.js withTransaction line by line:
//   backend withTransaction                              runTransaction
//   actorId validated /^[1-9]\d*$/ -> TypeError          same check, same message
//   client = pool.connect()                              client = getPool().connect()
//   BEGIN                                                BEGIN
//   actor -> set_config('app.current_user_id',$1,true)   same statement, transaction-local
//   result = fn(client); COMMIT; return result           same
//   catch: ROLLBACK, rethrow the ORIGINAL error          same (no wrapping, `toBe` identity holds)
//   ROLLBACK itself fails -> discard the connection      same (client.release(error))
//   finally client.release()                             same
//
// Usage:
//   const id = await runTransaction((db) => callIt(db), { actorId: 2 });
//   const watcher = await observer();   // autocommit connection, lock_timeout 5s
//   committed();                        // this test commits: reseed afterwards
//   await restoreIfCommitted();
import { readFileSync } from 'node:fs';
import { getPool, reseed } from './testDb.js';

export const SEEDED_COUNTS = Object.freeze({ projects: 2, samples: 17, detections: 43, audit: 0 });

let dirty = false;

/** Mark the current test as one that commits; restoreIfCommitted() will reseed. */
export function committed() {
  dirty = true;
}

/** Reseed the fixture world if anything was committed since the last restore. */
export async function restoreIfCommitted() {
  if (!dirty) return false;
  dirty = false;
  await reseed();
  return true;
}

/**
 * Apply database/roles/grants.sql (idempotent). Neither migrate.js nor CI runs it, and
 * harness.smoke recreates the schema, so a test that needs the ebiotrack_app role applies it itself.
 */
export async function applyGrants() {
  const sql = readFileSync(new URL('../../database/roles/grants.sql', import.meta.url), 'utf8');
  await getPool().query(sql);
}

/**
 * Run fn(client) in BEGIN ... COMMIT with the acting user set for the transaction (see the table
 * at the top for the correspondence with the backend).
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{actorId?: number | string | null}} [options]
 * @returns {Promise<T>}
 */
export async function runTransaction(fn, { actorId } = {}) {
  let actor = null;
  if (actorId !== undefined && actorId !== null) {
    actor = String(actorId);
    if (!/^[1-9]\d*$/.test(actor)) throw new TypeError('actorId must be a positive integer');
  }

  const client = await getPool().connect();
  let discard;
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
      discard = rollbackErr;
    }
    throw err;
  } finally {
    client.release(discard);
  }
}

/**
 * Run fn and return the error it rejects with (fails the test if it does not reject).
 * @param {() => Promise<unknown>} fn
 */
export async function caught(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('Expected the transaction to fail but it succeeded');
}

/**
 * A second connection that never joins a transaction: autocommit, READ COMMITTED, lock_timeout 5s
 * so a leaked lock is a clear failure instead of a hang. Release it with `release()`.
 * @returns {Promise<import('pg').PoolClient & {release: () => void}>}
 */
export async function observer() {
  const client = await getPool().connect();
  try {
    await client.query(`SET lock_timeout = '5s'`);
    const { rows } = await client.query('SHOW transaction_isolation');
    if (rows[0].transaction_isolation !== 'read committed') {
      throw new Error(`observer must run at READ COMMITTED, got ${rows[0].transaction_isolation}`);
    }
  } catch (err) {
    client.release(err);
    throw err;
  }
  return client;
}

// ---- snapshots ---------------------------------------------------------------------------------

/** Tables a snapshot counts: every public table except migration tracking and the session store. */
async function snapshotTables(client) {
  const { rows } = await client.query(
    `SELECT t.tablename AS name,
            (SELECT a.attname FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
              WHERE i.indrelid = format('%I.%I', t.schemaname, t.tablename)::regclass
                AND i.indisprimary AND i.indnatts = 1) AS pk
       FROM pg_tables t
      WHERE t.schemaname = 'public'
        AND t.tablename NOT LIKE 'schema\\_%' AND t.tablename <> 'session'
      ORDER BY t.tablename`,
  );
  return rows;
}

/**
 * Row counts of every table, the highest primary key and an md5 fingerprint (rows as text, ordered
 * by primary key) of each table in `fingerprint`. "Nothing happened" is snapshot-before equals
 * snapshot-after. Table names come from the catalog, never from the caller's text.
 * @param {import('pg').ClientBase} client
 * @param {string[]} [fingerprint] tables to fingerprint (default: the tables the scenarios touch)
 */
export async function snapshot(client, fingerprint = DEFAULT_FINGERPRINT) {
  const tables = await snapshotTables(client);
  const known = new Map(tables.map((t) => [t.name, t]));
  const counts = {};
  const maxIds = {};
  const fingerprints = {};
  for (const { name, pk } of tables) {
    const q = `SELECT count(*) AS n${pk ? `, max("${pk}")::text AS max_id` : ''} FROM "${name}"`;
    const { rows } = await client.query(q);
    counts[name] = Number(rows[0].n);
    if (pk) maxIds[name] = rows[0].max_id;
  }
  for (const name of fingerprint) {
    const t = known.get(name);
    if (!t) throw new Error(`snapshot: unknown table ${name}`);
    const order = t.pk ? `"${t.pk}"` : 't::text';
    const { rows } = await client.query(
      `SELECT md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY ${order}), '')) AS fp FROM "${name}" t`,
    );
    fingerprints[name] = rows[0].fp;
  }
  return { counts, maxIds, fingerprints };
}

export const DEFAULT_FINGERPRINT = [
  'users',
  'projects',
  'project_members',
  'project_sites',
  'collection_events',
  'samples',
  'sample_status_history',
  'environmental_measurements',
  'dna_extractions',
  'sequencing_runs',
  'sequencing_libraries',
  'analysis_runs',
  'taxon_assignments',
  'audit_logs',
];

// ---- invariants --------------------------------------------------------------------------------

/**
 * Cheap read-only checks that must hold after every test, committed or not. Throws with the
 * offending ids; call it in afterEach on the observer (committed state) of each file.
 * @param {import('pg').ClientBase} client
 */
export async function assertGlobalInvariants(client) {
  const checks = [
    [
      'every project has exactly one owner',
      `SELECT p.project_id FROM projects p
        WHERE (SELECT count(*) FROM project_members m
                WHERE m.project_id = p.project_id AND m.project_role = 'owner') <> 1`,
    ],
    [
      'every approved analysis has approved_by and approved_at',
      `SELECT analysis_id FROM analysis_runs
        WHERE status = 'approved' AND (approved_by IS NULL OR approved_at IS NULL)`,
    ],
    [
      // The status trigger only lets a rejected run return to draft; no test does that, so a draft
      // with detections would be a half-finished import.
      'every draft analysis has no detections',
      `SELECT ar.analysis_id FROM analysis_runs ar
        WHERE ar.status = 'draft'
          AND EXISTS (SELECT 1 FROM taxon_assignments ta WHERE ta.analysis_id = ar.analysis_id)`,
    ],
    [
      "every sample's newest status-history row equals its status",
      `SELECT s.sample_id FROM samples s
        WHERE s.status IS DISTINCT FROM
              (SELECT h.new_status FROM sample_status_history h
                WHERE h.sample_id = s.sample_id ORDER BY h.history_id DESC LIMIT 1)`,
    ],
    [
      'audit_logs.details is an object or NULL',
      `SELECT audit_id FROM audit_logs
        WHERE details IS NOT NULL AND jsonb_typeof(details) <> 'object'`,
    ],
  ];
  const failures = [];
  for (const [label, sql] of checks) {
    const { rows } = await client.query(sql);
    if (rows.length) failures.push(`${label}: ${JSON.stringify(rows.slice(0, 5))}`);
  }
  if (failures.length) throw new Error(`Global invariants violated:\n  ${failures.join('\n  ')}`);
}

/** The seeded counts the suites must leave behind. */
export async function seededCounts(client) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM projects)::int AS projects,
            (SELECT count(*) FROM samples)::int AS samples,
            (SELECT count(*) FROM taxon_assignments)::int AS detections,
            (SELECT count(*) FROM audit_logs)::int AS audit`,
  );
  return rows[0];
}

// ---- CSV -> payload ----------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'library_code',
  'scientific_name',
  'taxon_rank',
  'read_count',
  'confidence',
  'qc_flag',
];

/** Split fixture CSV text into header + records (the fixtures have no quoted fields). */
export function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',').map((c) => c.trim());
  if (header.join(',') !== CSV_COLUMNS.join(',')) {
    throw new Error(`Unexpected CSV header: ${header.join(',')}`);
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== CSV_COLUMNS.length) throw new Error(`Bad CSV line: ${line}`);
    return Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, cells[i]]));
  });
}

/**
 * Build the import payload the backend service builds from a CSV: library_code, taxon_id (resolved
 * from name and rank), read_count and confidence as numbers, qc_flag.
 * @param {string} csvText
 * @param {import('pg').ClientBase} client
 */
export async function csvToRows(csvText, client) {
  const records = parseCsv(csvText);
  const rows = [];
  for (const r of records) {
    const { rows: found } = await client.query(
      `SELECT taxon_id FROM taxa WHERE scientific_name = $1 AND rank = $2::taxon_rank`,
      [r.scientific_name, r.taxon_rank],
    );
    if (found.length !== 1)
      throw new Error(`Unknown taxon in CSV: ${r.scientific_name} (${r.taxon_rank})`);
    rows.push({
      library_code: r.library_code,
      taxon_id: Number(found[0].taxon_id),
      read_count: Number(r.read_count),
      confidence: Number(r.confidence),
      qc_flag: r.qc_flag,
    });
  }
  return rows;
}

/** Read a fixture file from tests/fixtures. */
export function readFixture(name) {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}
