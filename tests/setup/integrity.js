// Owner: C (Testing & QA)
// Purpose: Helpers for the integrity suites (T30): savepoints, violation assertions, row builders
//
// One failing statement aborts a PostgreSQL transaction (25P02), so each negative case runs inside
// a savepoint. All builders take the client of a withRollback() call and return generated ids
// captured with RETURNING (ids >= 1000, D6); nothing here commits.
//
// Usage:
//   await expectViolation(inSavepoint(client, () => insertRow(client, 'projects', row)),
//     '23505', 'uq_projects_title');
import { expect } from 'vitest';
import { expectSqlState } from './testDb.js';

let savepointCounter = 0;
let uniqueCounter = 0;

/** A value that differs on every call within one test run (deterministic, no randomness). */
export const unique = (prefix) => `${prefix}-${++uniqueCounter}`;

/**
 * Run fn inside a savepoint. On error the savepoint is rolled back (the outer transaction stays
 * usable) and the error is rethrown. With { keep: false } the savepoint is always rolled back, so a
 * successful probe leaves no row behind.
 * @template T
 * @param {import('pg').PoolClient} client
 * @param {() => Promise<T>} fn
 * @param {{keep?: boolean}} [options]
 * @returns {Promise<T>}
 */
export async function inSavepoint(client, fn, { keep = true } = {}) {
  const name = `sp_${++savepointCounter}`;
  await client.query(`SAVEPOINT ${name}`);
  let result;
  try {
    result = await fn();
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
  await client.query(keep ? `RELEASE SAVEPOINT ${name}` : `ROLLBACK TO SAVEPOINT ${name}`);
  return result;
}

/**
 * Assert that a promise rejects with `code` and, when given, the constraint name and a fragment of
 * the message. Returns the error so callers can check more fields (err.column, err.detail).
 * @param {Promise<unknown>} promise
 * @param {string} code SQLSTATE, e.g. '23505' or 'EB001'
 * @param {string} [constraint] expected err.constraint
 * @param {string} [messageFragment] text the message must contain
 */
export async function expectViolation(promise, code, constraint, messageFragment) {
  const err = await expectSqlState(promise, code);
  if (constraint !== undefined && err.constraint !== constraint) {
    throw new Error(
      `Expected SQLSTATE ${code} on constraint ${constraint} but the constraint was ${err.constraint ?? 'none'}: ${err.message}`,
      { cause: err },
    );
  }
  if (messageFragment !== undefined) expect(err.message).toContain(messageFragment);
  return err;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw new Error(`Bad identifier in test code: ${name}`);
  return name;
};

/**
 * INSERT one row from a column -> value object and return it. Table and column names are literals
 * from the test code (validated); every value is a bound parameter.
 */
export async function insertRow(client, table, row) {
  const cols = Object.keys(row).map(ident);
  const marks = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${ident(table)} (${cols.join(', ')}) VALUES (${marks.join(', ')}) RETURNING *`;
  return (
    await client.query(
      sql,
      cols.map((c) => row[c]),
    )
  ).rows[0];
}

/** UPDATE the row where keyColumn = keyValue and return it. */
export async function updateRow(client, table, keyColumn, keyValue, changes) {
  const cols = Object.keys(changes).map(ident);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const sql = `UPDATE ${ident(table)} SET ${sets} WHERE ${ident(keyColumn)} = $${cols.length + 1} RETURNING *`;
  return (await client.query(sql, [...cols.map((c) => changes[c]), keyValue])).rows[0];
}

/**
 * Run fn as the application role (no DELETE except link tables, audit_logs append-only). On error
 * the role is not reset here: the failed statement already aborted the transaction, and the
 * enclosing savepoint rollback (inSavepoint) restores the role together with the state.
 */
export async function asAppRole(client, fn) {
  await client.query('SET LOCAL ROLE ebiotrack_app');
  const result = await fn();
  await client.query('RESET ROLE');
  return result;
}

/** [from, to, allowed] for every ordered pair of states (including from === to). */
export function transitionMatrix(states, allowedByState) {
  return states.flatMap((from) =>
    states.map((to) => [from, to, (allowedByState[from] ?? []).includes(to)]),
  );
}

export const enumValues = async (client, typeName) =>
  (
    await client.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [typeName],
    )
  ).rows.map((r) => r.enumlabel);

// ---------------------------------------------------------------------------------------------
// Row builders (valid rows; tests break exactly one thing)
// ---------------------------------------------------------------------------------------------
export const FIXED_TIME = '2026-01-15T10:00:00Z';

export const newUser = (client, over = {}) =>
  insertRow(client, 'users', {
    full_name: 'Integrity User',
    email: `${unique('qa')}@example.test`,
    password_hash: '$2b$12$integrityhashintegrityhashintegrityhashintegrityhash',
    ...over,
  });

export const newProject = (client, over = {}) =>
  insertRow(client, 'projects', { title: unique('Integrity Project'), created_by: 2, ...over });

export const newRegion = (client, over = {}) =>
  insertRow(client, 'regions', { name: unique('Region'), region_type: 'other', ...over });

export const newSite = (client, over = {}) =>
  insertRow(client, 'sampling_sites', {
    region_id: 2,
    name: unique('Site'),
    latitude: 28.6,
    longitude: 77.2,
    habitat_type: 'river',
    created_by: 2,
    ...over,
  });

/** A project with site 1 linked, ready for events. */
export async function newProjectWithSite(client) {
  const project = await newProject(client);
  await insertRow(client, 'project_sites', { project_id: project.project_id, site_id: 1 });
  return project;
}

export const newEvent = (client, over = {}) =>
  insertRow(client, 'collection_events', {
    project_id: 1,
    site_id: 1,
    collector_id: 3,
    collected_at: FIXED_TIME,
    ...over,
  });

export const newSample = (client, over = {}) =>
  insertRow(client, 'samples', {
    event_id: 1,
    sample_type_id: 1,
    sample_code: unique('QA-S'),
    ...over,
  });

export const newLab = (client, over = {}) =>
  insertRow(client, 'laboratories', { name: unique('Lab'), ...over });

export const newBatch = (client, over = {}) =>
  insertRow(client, 'extraction_batches', {
    lab_id: 1,
    operator_id: 4,
    extraction_date: '2026-01-10',
    ...over,
  });

export const newExtraction = async (client, over = {}) => {
  const sampleId = over.sample_id ?? (await newSample(client, { status: 'stored' })).sample_id;
  return insertRow(client, 'dna_extractions', { sample_id: sampleId, batch_id: 1, ...over });
};

export const newRun = (client, over = {}) =>
  insertRow(client, 'sequencing_runs', {
    run_code: unique('RUN'),
    lab_id: 1,
    platform: 'Illumina MiSeq',
    ...over,
  });

export const newLibrary = async (client, over = {}) => {
  const extractionId =
    over.extraction_id ?? (await newExtraction(client, { qc_status: 'pass' })).extraction_id;
  const runId = over.run_id ?? (await newRun(client)).run_id;
  return insertRow(client, 'sequencing_libraries', {
    library_code: unique('LIB'),
    extraction_id: extractionId,
    run_id: runId,
    ...over,
  });
};

/** Analysis run in any status; approved/superseded rows carry approver 2 and a fixed timestamp. */
export const newAnalysis = (client, over = {}) => {
  const status = over.status ?? 'draft';
  const settled = status === 'approved' || status === 'superseded';
  return insertRow(client, 'analysis_runs', {
    run_id: 1,
    marker_id: 1,
    pipeline_name: 'qiime2',
    pipeline_version: '2024.5',
    reference_db: 'SILVA',
    imported_by: 5,
    approved_by: settled ? 2 : null,
    approved_at: settled ? FIXED_TIME : null,
    ...over,
  });
};

export const newTaxon = (client, over = {}) =>
  insertRow(client, 'taxa', { scientific_name: unique('Taxon'), rank: 'species', ...over });

export const newDetection = (client, over = {}) =>
  insertRow(client, 'taxon_assignments', {
    analysis_id: 4,
    library_id: 1,
    taxon_id: 1,
    read_count: 10,
    confidence: 0.9,
    qc_flag: 'pass',
    ...over,
  });
