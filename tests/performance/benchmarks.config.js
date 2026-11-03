// Owner: C (Testing & QA)
// Purpose: One source of truth for the performance benchmarks (statements, parameters, data preparation, index control), shared by run-benchmarks.js and plan-shape.test.js
//
// Every statement has an id that is also its label in database/indexes/*.sql (BQ1, FQ2a, ...).
// Index names and definitions are read from the index files, never typed here, so a later merge
// of another index file needs no edit (only a statement that serves it, see the coverage guard).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeTarget, getTestDatabaseUrl } from '../setup/testDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');
export const VOLUME_BASE = 1_000_000;

/** The session settings of the index authors (the numbers must stay comparable). No enable_* switch. */
export const SETTINGS = [
  ['max_parallel_workers_per_gather', '0'],
  ['jit', 'off'],
  ['plan_cache_mode', 'force_custom_plan'],
  // Not a planner setting: pins the text form of looked-up timestamps, so parameters are stable.
  ['TimeZone', 'UTC'],
];

// ---------------------------------------------------------------------------------------------
// Database session
// ---------------------------------------------------------------------------------------------

/** One connection to the test database with the agreed settings applied. */
export async function openSession() {
  const url = getTestDatabaseUrl();
  assertSafeTarget(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const [name, value] of SETTINGS)
    await client.query(`SELECT set_config($1, $2, false)`, [name, value]);
  return client;
}

/** Literal for a looked-up value (digits stay numbers, everything else is a quoted string). */
export function literal(value) {
  const text = String(value);
  if (/^-?\d+$/.test(text)) return text;
  if (text.includes('\\') || text.includes('\0'))
    throw new Error(`Unsupported parameter value ${text}`);
  return `'${text.replaceAll("'", "''")}'`;
}

/** Replace {name} placeholders with the looked-up parameter literals. */
export function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in params)) throw new Error(`Parameter ${name} was not looked up`);
    return literal(params[name]);
  });
}

// ---------------------------------------------------------------------------------------------
// Index control: the final set comes from database/indexes/*.sql
// ---------------------------------------------------------------------------------------------

/**
 * Parse the index files. Returns `{ files: [{ file, sql, names }], indexes: [{ name, table, columns, file }] }`.
 * The commented DROP INDEX lines of a file must name exactly the indexes it creates.
 */
export function readIndexSet(dir = path.join(REPO_ROOT, 'database/indexes')) {
  const files = [];
  const indexes = [];
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const created = [
      ...sql.matchAll(/^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \(([^)]*)\)/gm),
    ].map((m) => ({ name: m[1], table: m[2], columns: m[3].trim(), file }));
    const dropped = [...sql.matchAll(/^--\s+DROP INDEX IF EXISTS (\w+);/gm)].map((m) => m[1]);
    const a = created
      .map((i) => i.name)
      .sort()
      .join(',');
    const b = [...dropped].sort().join(',');
    if (a !== b) {
      throw new Error(`${file}: CREATE INDEX names (${a}) differ from its DROP INDEX lines (${b})`);
    }
    files.push({ file, sql, names: created.map((i) => i.name) });
    indexes.push(...created);
  }
  return { files, indexes };
}

/** Names of the indexes of the final set that exist (valid) in the database. */
export async function presentIndexes(client, names) {
  const { rows } = await client.query(
    `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY 1`,
    [names],
  );
  return rows;
}

/** Baseline state: drop every index of the final set (names from the files, quoted as identifiers). */
export async function dropFinalIndexes(client, set) {
  for (const { name } of set.indexes) await client.query(`DROP INDEX IF EXISTS "${name}"`);
}

/** Indexed state: run the index files as they are (CREATE INDEX IF NOT EXISTS). */
export async function createFinalIndexes(client, set) {
  for (const { sql } of set.files) await client.query(sql);
}

/** Throw unless exactly the expected state holds: 'baseline' (none present) or 'indexed' (all present and valid). */
export async function assertIndexState(client, set, state) {
  const names = set.indexes.map((i) => i.name);
  const present = await presentIndexes(client, names);
  if (state === 'baseline' && present.length > 0) {
    throw new Error(`Baseline is dirty: ${present.map((p) => p.name).join(', ')} exist`);
  }
  if (state === 'indexed') {
    const missing = names.filter((n) => !present.some((p) => p.name === n && p.valid));
    if (missing.length > 0)
      throw new Error(`Indexed state is incomplete: ${missing.join(', ')} missing or invalid`);
  }
}

/** ANALYZE outside any transaction, after waiting until no other client session is active. */
export async function analyzeAll(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend' AND state <> 'idle'`,
  );
  if (rows[0].n > 0)
    throw new Error(`${rows[0].n} other session(s) are active; stop them before benchmarking`);
  await client.query('VACUUM (ANALYZE)');
}

// ---------------------------------------------------------------------------------------------
// Volume checks and data preparation (test database only, idempotent, undone by undoPrepare)
// ---------------------------------------------------------------------------------------------

/** Row counts of the volume data and whether they reach the scale (message names the load command). */
export async function checkVolume(client, scale, scales) {
  const want = scales[scale];
  if (!want) throw new Error(`Unknown scale ${scale}`);
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM samples WHERE sample_id >= $1)::int AS samples,
            (SELECT count(*) FROM taxon_assignments WHERE assignment_id >= $1)::int AS assignments,
            (SELECT count(*) FROM audit_logs)::int AS audit`,
    [VOLUME_BASE],
  );
  const have = rows[0];
  if (
    have.samples < want.samples * 0.99 ||
    have.assignments < want.assignments * 0.99 ||
    have.audit < want.audit
  ) {
    throw new Error(
      `Volume data for scale "${scale}" is missing (samples ${have.samples}/${want.samples}, ` +
        `assignments ${have.assignments}/${want.assignments}, audit_logs ${have.audit}/${want.audit}). ` +
        `Run: cd tests && npm run volume:clean; npm run volume:load -- --scale ${scale}`,
    );
  }
  return have;
}

const APPROVED_AT = "timestamptz '2026-01-01 00:00:00+00'";

/**
 * Add what the queries need and the generator does not create: 4 readings per volume event
 * (measurement_id = event_id * 4 + k) and approved volume analyses (every 5th). Idempotent.
 * Returns what was added.
 */
export async function prepareData(client) {
  const added = { measurements: 0, approvals: 0 };
  const m = await client.query(
    `INSERT INTO environmental_measurements (measurement_id, event_id, parameter, value, unit)
     SELECT ce.event_id * 4 + p.k, ce.event_id, p.parameter,
            round((p.base + ((ce.event_id * 7919 + p.k * 104729) % 1000) / 1000.0 * p.span)::numeric, 3), p.unit
       FROM collection_events AS ce
      CROSS JOIN (VALUES (0, 'temperature_c', 'degC', 5.0, 25.0),
                         (1, 'ph', 'pH', 6.5, 2.5),
                         (2, 'dissolved_oxygen_mg_l', 'mg/L', 3.0, 8.0),
                         (3, 'turbidity_ntu', 'NTU', 2.0, 40.0)) AS p(k, parameter, unit, base, span)
      WHERE ce.event_id >= $1
        AND NOT EXISTS (SELECT 1 FROM environmental_measurements WHERE measurement_id >= $1)`,
    [VOLUME_BASE],
  );
  added.measurements = m.rowCount;
  await client.query('BEGIN');
  try {
    await client.query('ALTER TABLE analysis_runs DISABLE TRIGGER trg_analysis_runs_audit');
    const a = await client.query(
      `UPDATE analysis_runs SET status = 'approved', approved_by = 2, approved_at = ${APPROVED_AT}
        WHERE analysis_id >= $1 AND analysis_id % 5 = 0 AND status = 'imported'`,
      [VOLUME_BASE],
    );
    added.approvals = a.rowCount;
    await client.query('ALTER TABLE analysis_runs ENABLE TRIGGER trg_analysis_runs_audit');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  await client.query('VACUUM (ANALYZE) environmental_measurements, analysis_runs');
  return added;
}

/** Remove exactly what prepareData added, so `npm run volume:clean` does not stop on a foreign key. */
export async function undoPrepare(client) {
  const removed = { measurements: 0, approvals: 0 };
  removed.measurements = (
    await client.query('DELETE FROM environmental_measurements WHERE measurement_id >= $1', [
      VOLUME_BASE,
    ])
  ).rowCount;
  await client.query('BEGIN');
  try {
    // The status and immutability triggers refuse to reopen an approved run: off for this statement only.
    for (const t of [
      'trg_analysis_runs_audit',
      'trg_analysis_runs_immutable',
      'trg_analysis_runs_status',
    ]) {
      await client.query(`ALTER TABLE analysis_runs DISABLE TRIGGER ${t}`);
    }
    removed.approvals = (
      await client.query(
        `UPDATE analysis_runs SET status = 'imported', approved_by = NULL, approved_at = NULL
          WHERE analysis_id >= $1 AND status = 'approved' AND approved_by = 2 AND approved_at = ${APPROVED_AT}`,
        [VOLUME_BASE],
      )
    ).rowCount;
    for (const t of [
      'trg_analysis_runs_audit',
      'trg_analysis_runs_immutable',
      'trg_analysis_runs_status',
    ]) {
      await client.query(`ALTER TABLE analysis_runs ENABLE TRIGGER ${t}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  await client.query('VACUUM (ANALYZE) environmental_measurements, analysis_runs');
  return removed;
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------
// Fields of a statement:
//   id, label, sql        {name} placeholders are filled from the slice lookups
//   expect                'improve' (serves[] must be used and the plan gets cheaper) or
//                         'unchanged' (relatesTo[]: indexes this statement must not be changed by)
//   serves                final-set indexes this statement is supposed to improve
//   relatesTo             final-set indexes a not-helped / redundancy statement documents
//   mustImprove           the benchmark fails when buffers are not at least 10% lower
//   rel                   the relation whose scan is shown in the tables (default: table of the related index)
//   keepsIndex            index of a constraint that must serve it in both phases (redundancy check)
//   selectivity           'selective' | 'unselective' (the share of the table read)
//   reason                why an 'unchanged' statement is expected to stay unchanged
//   documented            figures the index file gives: { rel, baseline: {node, buffers}, indexed: {...} };
//                         node is null where the file gives buffers only
//   smallOk               the index wins already at scale small (plan-shape guard); default false

const IDX = {
  pm: 'idx_project_members_user_id_project_id',
  audit: 'idx_audit_logs_entity_type_entity_id_created_at',
  ce: 'idx_collection_events_site_id_collected_at',
  taxon: 'idx_taxon_assignments_taxon_id_qc_flag',
  lib: 'idx_taxon_assignments_library_id',
  run: 'idx_sequencing_libraries_run_id',
  batch: 'idx_dna_extractions_batch_id',
};
const NO_FINAL_INDEX =
  'no index of the final set covers it (the T19-D follow-up candidates are not merged); the plan must not change';

export const SLICES = [
  {
    id: 'access',
    ticket: 'T19-C',
    title: 'Access, Projects & Audit',
    queryFile: 'access_queries.sql',
    lookups: [
      `SELECT user_id::text AS hot_user FROM project_members GROUP BY user_id ORDER BY count(*) DESC, user_id DESC LIMIT 1`,
      `SELECT entity_id::text AS hot_sample FROM audit_logs WHERE entity_type = 'samples'
        GROUP BY entity_id ORDER BY count(*) DESC, entity_id LIMIT 1`,
      `SELECT entity_id::text AS cold_sample FROM audit_logs WHERE entity_type = 'samples'
        GROUP BY entity_id HAVING count(*) = 3 ORDER BY entity_id LIMIT 1`,
      `SELECT entity_id::text AS hot_project FROM audit_logs WHERE entity_type = 'projects'
        GROUP BY entity_id ORDER BY count(*) DESC, entity_id LIMIT 1`,
      `SELECT entity_id::text AS small_project FROM audit_logs WHERE entity_type = 'projects'
        GROUP BY entity_id ORDER BY count(*), entity_id LIMIT 1`,
      `SELECT date_trunc('month', min(created_at) + interval '5 months')::text AS from_ts,
              date_trunc('month', min(created_at) + interval '6 months')::text AS to_ts
         FROM audit_logs WHERE entity_type = 'samples' AND entity_id = {hot_sample}`,
    ],
    statements: [
      {
        id: 'BQ1',
        label: 'memberships of one user (authorize.js)',
        sql: 'SELECT project_id FROM project_members WHERE user_id = {hot_user}',
        expect: 'improve',
        serves: [IDX.pm],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'project_members',
          baseline: { node: 'Seq Scan', buffers: 148 },
          indexed: { node: 'Index Only Scan', buffers: 3 },
        },
      },
      {
        id: 'BQ1b',
        rel: 'project_members',
        label: 'members of one project (redundancy: primary key leads with project_id)',
        sql: 'SELECT user_id FROM project_members WHERE project_id = {hot_project}',
        expect: 'unchanged',
        relatesTo: [IDX.pm],
        keepsIndex: 'pk_project_members',
        selectivity: 'selective',
        reason:
          'project_id is the leading column of pk_project_members; the new index starts with user_id',
      },
      {
        id: 'BQ2',
        label: 'Q1 access_user_projects, one user',
        sql: 'EXECUTE access_user_projects({hot_user}, NULL)',
        expect: 'improve',
        serves: [IDX.pm],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'project_members',
          baseline: { node: 'Seq Scan', buffers: 488 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 375 },
        },
      },
      {
        id: 'BQ3a',
        label: 'Q3 audit trail, hot sample',
        sql: "EXECUTE access_entity_audit_trail('samples', {hot_sample}, NULL, NULL)",
        expect: 'improve',
        serves: [IDX.audit],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'audit_logs',
          baseline: { node: 'Seq Scan', buffers: 10094 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 5279 },
        },
      },
      {
        id: 'BQ3b',
        label: 'Q3 audit trail, cold sample (3 rows)',
        sql: "EXECUTE access_entity_audit_trail('samples', {cold_sample}, NULL, NULL)",
        expect: 'improve',
        serves: [IDX.audit],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'audit_logs',
          baseline: { node: 'Seq Scan', buffers: 6677 },
          indexed: { node: 'Index Scan', buffers: 15 },
        },
      },
      {
        id: 'BQ3c',
        label: 'Q3 audit trail, hot sample, one month',
        sql: "EXECUTE access_entity_audit_trail('samples', {hot_sample}, {from_ts}, {to_ts})",
        expect: 'improve',
        serves: [IDX.audit],
        mustImprove: true,
        selectivity: 'selective',
        documented: {
          rel: 'audit_logs',
          baseline: { node: null, buffers: 6698 },
          indexed: { node: null, buffers: 1883 },
        },
      },
      {
        id: 'BQ4a',
        label: 'GET /api/audit, largest project trail (~4% of the table)',
        sql: "SELECT * FROM audit_logs WHERE entity_type = 'projects' AND entity_id = {hot_project} ORDER BY created_at, audit_id",
        expect: 'improve',
        serves: [IDX.audit],
        mustImprove: false,
        selectivity: 'unselective',
        reason:
          'rows of one entity are spread over almost every page: the gain is the avoided filter, not buffers',
        documented: {
          rel: 'audit_logs',
          baseline: { node: null, buffers: 6668 },
          indexed: { node: null, buffers: 6785 },
        },
      },
      {
        id: 'BQ4b',
        label: 'GET /api/audit, small project trail',
        sql: "SELECT * FROM audit_logs WHERE entity_type = 'projects' AND entity_id = {small_project} ORDER BY created_at, audit_id",
        expect: 'improve',
        serves: [IDX.audit],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'audit_logs',
          baseline: { node: 'Seq Scan', buffers: 6668 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 312 },
        },
      },
      {
        id: 'BQ5',
        label: 'audit rows of one actor (actor_id is not indexed)',
        sql: 'SELECT * FROM audit_logs WHERE actor_id = {hot_user} ORDER BY created_at DESC, audit_id DESC LIMIT 50',
        expect: 'unchanged',
        relatesTo: [IDX.audit],
        selectivity: 'selective',
        reason: 'filters on actor_id, which is not a column of the new index',
      },
      {
        id: 'BQ6',
        label: 'dashboard: newest 5 audit rows (created_at is not leading)',
        sql: 'SELECT audit_id, entity_type, entity_id, action, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5',
        expect: 'unchanged',
        relatesTo: [IDX.audit],
        selectivity: 'unselective',
        reason:
          'no filter on entity_type / entity_id, so created_at is not usable as a leading column',
      },
    ],
  },
  {
    id: 'field',
    ticket: 'T19-D',
    title: 'Field & Samples',
    queryFile: 'field_queries.sql',
    lookups: [
      `SELECT site_id::text AS hot_site FROM collection_events WHERE event_id >= 1000000
        GROUP BY site_id ORDER BY count(*) DESC, site_id LIMIT 1`,
      `SELECT event_id::text AS hot_event FROM samples WHERE event_id >= 1000000
        GROUP BY event_id ORDER BY count(*) DESC, event_id LIMIT 1`,
      `SELECT sample_code AS some_code FROM samples WHERE sample_id >= 1000000
        ORDER BY sample_id OFFSET (SELECT count(*) / 2 FROM samples WHERE sample_id >= 1000000) LIMIT 1`,
      `SELECT date_trunc('year', min(collected_at))::text AS y0,
              (date_trunc('year', min(collected_at)) + interval '1 year')::text AS y1,
              date_trunc('month', min(collected_at) + interval '1 month')::text AS m0,
              date_trunc('month', min(collected_at) + interval '2 months')::text AS m1
         FROM collection_events WHERE site_id = {hot_site}`,
      // Year prefixes of the sample codes: the rarest, the one nearest 12.4% of the table, the largest.
      `WITH y AS (SELECT substr(sample_code, 1, 7) AS p, count(*) AS n FROM samples GROUP BY 1),
            t AS (SELECT sum(n) AS total FROM y)
       SELECT (SELECT p || '%' FROM y ORDER BY n, p LIMIT 1) AS pfx_rare,
              (SELECT p || '%' FROM y, t ORDER BY abs(n - 0.124 * total), p LIMIT 1) AS pfx_mid,
              (SELECT p || '%' FROM y ORDER BY n DESC, p LIMIT 1) AS pfx_big`,
      `SELECT regexp_replace(sample_code, '-[0-9]+$', '') || '%' AS pfx_event
         FROM samples WHERE event_id = {hot_event} ORDER BY sample_id LIMIT 1`,
    ],
    statements: [
      {
        id: 'FQ1',
        rel: 'samples',
        label: 'sample by exact code (unique index)',
        sql: 'SELECT * FROM samples WHERE sample_code = {some_code}',
        expect: 'unchanged',
        relatesTo: [],
        keepsIndex: 'samples_sample_code_key',
        selectivity: 'selective',
        smallOk: true,
        reason: 'served by the unique constraint index in both phases',
      },
      {
        id: 'FQ2a',
        rel: 'samples',
        label: 'prefix search, rarest year',
        sql: 'SELECT * FROM samples WHERE sample_code LIKE {pfx_rare}',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'selective',
        reason:
          'plain btree cannot answer LIKE under en_US.utf8; the text_pattern_ops candidate is not merged',
      },
      {
        id: 'FQ2b',
        rel: 'samples',
        label: 'prefix search, ~12% of the table',
        sql: 'SELECT * FROM samples WHERE sample_code LIKE {pfx_mid}',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'unselective',
        reason: 'as FQ2a',
      },
      {
        id: 'FQ2c',
        rel: 'samples',
        label: 'prefix search, largest year (~88%)',
        sql: 'SELECT * FROM samples WHERE sample_code LIKE {pfx_big}',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'unselective',
        reason:
          'as FQ2a; and a prefix matching most of the table is correctly a sequential scan anyway',
      },
      {
        id: 'FQ2d',
        rel: 'samples',
        label: 'prefix search, the samples of one event',
        sql: 'SELECT * FROM samples WHERE sample_code LIKE {pfx_event}',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'selective',
        reason: 'as FQ2a',
      },
      {
        id: 'FQ3a',
        label: 'events of one site in one year',
        sql: 'SELECT event_id, site_id, collected_at FROM collection_events WHERE site_id = {hot_site} AND collected_at >= {y0} AND collected_at < {y1} ORDER BY collected_at',
        expect: 'improve',
        serves: [IDX.ce],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'collection_events',
          baseline: { node: 'Seq Scan', buffers: 188 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 71 },
        },
      },
      {
        id: 'FQ3b',
        label: 'events of one site in one month',
        sql: 'SELECT event_id, site_id, collected_at FROM collection_events WHERE site_id = {hot_site} AND collected_at >= {m0} AND collected_at < {m1} ORDER BY collected_at',
        expect: 'improve',
        serves: [IDX.ce],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'collection_events',
          baseline: { node: null, buffers: 188 },
          indexed: { node: null, buffers: 10 },
        },
      },
      {
        id: 'FQ3c',
        label: 'all events of one site, ordered',
        sql: 'SELECT event_id, site_id, collected_at FROM collection_events WHERE site_id = {hot_site} ORDER BY collected_at',
        expect: 'improve',
        serves: [IDX.ce],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'collection_events',
          baseline: { node: null, buffers: 188 },
          indexed: { node: null, buffers: 71 },
        },
      },
      {
        id: 'FQ3d',
        label: 'one month, all sites (leading-column rule)',
        sql: 'SELECT event_id, site_id, collected_at FROM collection_events WHERE collected_at >= {m0} AND collected_at < {m1} ORDER BY collected_at',
        expect: 'unchanged',
        relatesTo: [IDX.ce],
        selectivity: 'selective',
        reason: 'no site_id filter, so the composite index cannot be used (leading column)',
        documented: {
          rel: 'collection_events',
          baseline: { node: 'Seq Scan', buffers: 188 },
          indexed: { node: 'Seq Scan', buffers: 188 },
        },
      },
      {
        id: 'FQ4a',
        label: 'T14 Q3 moving average, one site',
        sql: "EXECUTE field_readings_moving_average('temperature_c', {hot_site}, NULL)",
        expect: 'improve',
        serves: [IDX.ce],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'collection_events',
          baseline: { node: 'Seq Scan', buffers: 440 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 323 },
        },
      },
      {
        id: 'FQ4b',
        label: 'T14 Q3 moving average, all sites',
        sql: "EXECUTE field_readings_moving_average('temperature_c', NULL, NULL)",
        expect: 'unchanged',
        relatesTo: [IDX.ce],
        selectivity: 'unselective',
        reason: 'reads every event, no index can help',
        documented: {
          rel: 'collection_events',
          baseline: { node: 'Seq Scan', buffers: 1021 },
          indexed: { node: 'Seq Scan', buffers: 1021 },
        },
      },
      {
        id: 'FQ5a',
        rel: 'samples',
        label: 'Q2 latest status of the samples of one event',
        sql: 'EXECUTE field_event_samples_latest_status({hot_event})',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'selective',
        reason: NO_FINAL_INDEX,
      },
      {
        id: 'FQ5b',
        rel: 'samples',
        label: 'samples of one event',
        sql: 'SELECT * FROM samples WHERE event_id = {hot_event}',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'selective',
        reason: NO_FINAL_INDEX,
      },
      {
        id: 'FQ5c',
        label: 'Q1 sample counts, all sites',
        sql: 'EXECUTE field_site_sample_counts(NULL)',
        expect: 'unchanged',
        relatesTo: [IDX.ce],
        selectivity: 'unselective',
        reason: 'reads every sample, no index can help',
      },
      {
        id: 'FQ5d',
        rel: 'samples',
        label: 'v_site_sample_summary, one site',
        sql: 'SELECT * FROM v_site_sample_summary WHERE site_id = {hot_site}',
        expect: 'unchanged',
        relatesTo: [],
        selectivity: 'selective',
        reason: NO_FINAL_INDEX,
      },
    ],
  },
  {
    id: 'analysis',
    ticket: 'T19-A',
    title: 'Analysis, Taxonomy & Analytics',
    queryFile: 'analysis_queries.sql',
    lookups: [
      `SELECT taxon_id::text AS hot_taxon FROM taxon_assignments GROUP BY taxon_id ORDER BY count(*) DESC, taxon_id LIMIT 1`,
      `SELECT taxon_id::text AS cold_taxon FROM taxon_assignments WHERE taxon_id >= 1000000
        GROUP BY taxon_id ORDER BY count(*), taxon_id LIMIT 1`,
      `SELECT parent_taxon_id::text AS big_genus FROM taxa WHERE parent_taxon_id IS NOT NULL
        GROUP BY parent_taxon_id ORDER BY count(*) DESC, parent_taxon_id LIMIT 1`,
      `SELECT site_id::text AS busy_site FROM v_approved_detections GROUP BY site_id ORDER BY count(*) DESC, site_id LIMIT 1`,
      `SELECT analysis_id::text AS big_analysis FROM taxon_assignments GROUP BY analysis_id ORDER BY count(*) DESC, analysis_id LIMIT 1`,
      `SELECT library_id::text AS hot_library FROM taxon_assignments GROUP BY library_id ORDER BY count(*) DESC, library_id LIMIT 1`,
      `SELECT taxon_id::text AS hot_approved_taxon FROM v_approved_detections GROUP BY taxon_id ORDER BY count(*) DESC, taxon_id LIMIT 1`,
    ],
    statements: [
      {
        id: 'BQ1a',
        label: 'detections of the hot taxon',
        sql: 'SELECT assignment_id, analysis_id, library_id, read_count, confidence, qc_flag FROM taxon_assignments WHERE taxon_id = {hot_taxon}',
        expect: 'improve',
        serves: [IDX.taxon],
        mustImprove: false,
        selectivity: 'unselective',
        reason: 'fetching ~2.7% of the rows scattered over the heap limits the gain',
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: 'Seq Scan', buffers: 5156 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 4864 },
        },
      },
      {
        id: 'BQ1b',
        label: 'detections of the cold taxon',
        sql: 'SELECT assignment_id, analysis_id, library_id, read_count, confidence, qc_flag FROM taxon_assignments WHERE taxon_id = {cold_taxon}',
        expect: 'improve',
        serves: [IDX.taxon],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: 'Seq Scan', buffers: 5156 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 64 },
        },
      },
      {
        id: 'BQ1c',
        label: 'passing detections of the hot taxon',
        sql: "SELECT assignment_id, analysis_id, library_id, read_count, confidence, qc_flag FROM taxon_assignments WHERE taxon_id = {hot_taxon} AND qc_flag = 'pass'",
        expect: 'improve',
        serves: [IDX.taxon],
        mustImprove: true,
        selectivity: 'selective',
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: 'Seq Scan', buffers: 5156 },
          indexed: { node: 'Bitmap Heap Scan', buffers: 2029 },
        },
      },
      {
        id: 'BQ2a',
        label: 'detection history, genus subtree',
        sql: 'EXECUTE analysis_taxon_detection_history({big_genus}, NULL, NULL, NULL)',
        expect: 'unchanged',
        relatesTo: [IDX.taxon],
        selectivity: 'unselective',
        reason:
          'the plan hash-joins all assignments of the approved runs; no per-taxon index changes it',
      },
      {
        id: 'BQ2b',
        label: 'detection history, hot taxon',
        sql: 'EXECUTE analysis_taxon_detection_history({hot_approved_taxon}, NULL, NULL, NULL)',
        expect: 'unchanged',
        relatesTo: [IDX.taxon],
        selectivity: 'unselective',
        reason: 'as BQ2a',
      },
      {
        id: 'BQ3',
        label: 'taxa at the busiest site',
        sql: 'EXECUTE analysis_taxa_at_site({busy_site}, NULL, NULL, NULL)',
        expect: 'improve',
        serves: [IDX.taxon, IDX.lib],
        mustImprove: true,
        selectivity: 'selective',
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: null, buffers: 17996 },
          indexed: { node: null, buffers: 7543 },
        },
      },
      {
        id: 'BQ4a',
        label: 'richness by site and year, all sites',
        sql: 'EXECUTE analysis_richness_by_site_year(NULL, NULL, NULL, NULL)',
        expect: 'unchanged',
        relatesTo: [IDX.lib],
        selectivity: 'unselective',
        reason: 'must read every approved detection; an index cannot help',
      },
      {
        id: 'BQ4b',
        label: 'richness by site and year, one site',
        sql: 'EXECUTE analysis_richness_by_site_year(NULL, {busy_site}, NULL, NULL)',
        expect: 'improve',
        serves: [IDX.lib],
        mustImprove: true,
        selectivity: 'selective',
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: null, buffers: 10882 },
          indexed: { node: null, buffers: 5928 },
        },
      },
      {
        id: 'BQ5a',
        label: 'v_approved_detections, hot taxon',
        sql: 'SELECT * FROM v_approved_detections WHERE taxon_id = {hot_approved_taxon}',
        expect: 'improve',
        serves: [IDX.taxon],
        mustImprove: false,
        selectivity: 'unselective',
        reason: 'a modest gain (17% fewer buffers documented)',
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: null, buffers: 9876 },
          indexed: { node: null, buffers: 8247 },
        },
      },
      {
        id: 'BQ5b',
        label: 'v_approved_detections, busiest site',
        sql: 'SELECT * FROM v_approved_detections WHERE site_id = {busy_site}',
        expect: 'improve',
        serves: [IDX.lib],
        mustImprove: true,
        selectivity: 'selective',
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: null, buffers: 9337 },
          indexed: { node: null, buffers: 4383 },
        },
      },
      {
        id: 'BQ6',
        label: 'assignments of one analysis (redundancy: unique constraint index)',
        sql: 'SELECT assignment_id, library_id, taxon_id, read_count, qc_flag FROM taxon_assignments WHERE analysis_id = {big_analysis}',
        expect: 'unchanged',
        relatesTo: [IDX.taxon, IDX.lib],
        keepsIndex: 'uq_taxon_assignments_analysis_library_taxon',
        selectivity: 'selective',
        reason: 'analysis_id leads uq_taxon_assignments_analysis_library_taxon',
      },
      {
        id: 'BQ7a',
        label: 'detections of one library',
        sql: 'SELECT assignment_id, analysis_id, taxon_id, read_count, qc_flag FROM taxon_assignments WHERE library_id = {hot_library}',
        expect: 'improve',
        serves: [IDX.lib],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'taxon_assignments',
          baseline: { node: 'Seq Scan', buffers: 5156 },
          indexed: { node: 'Index Scan', buffers: 4 },
        },
      },
      {
        id: 'BQ7b',
        label: 'approved and pass counts per taxon',
        sql: "SELECT ta.taxon_id, count(*) FROM taxon_assignments ta JOIN analysis_runs ar USING (analysis_id) WHERE ar.status = 'approved' AND ta.qc_flag = 'pass' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5",
        expect: 'unchanged',
        relatesTo: [IDX.taxon],
        selectivity: 'unselective',
        reason: 'scans the table for approved + pass counts of every taxon',
      },
      {
        id: 'BQ8',
        label: 'count for one analysis (redundancy: unique constraint index)',
        sql: 'SELECT count(*) FROM taxon_assignments WHERE analysis_id = {big_analysis}',
        expect: 'unchanged',
        relatesTo: [IDX.lib],
        keepsIndex: 'uq_taxon_assignments_analysis_library_taxon',
        selectivity: 'selective',
        smallOk: true,
        reason: 'analysis_id leads uq_taxon_assignments_analysis_library_taxon',
      },
    ],
  },
  {
    id: 'lab',
    ticket: 'T19-B',
    title: 'Laboratory & Sequencing',
    queryFile: 'lab_queries.sql',
    lookups: [
      `SELECT run_id::text AS big_run FROM sequencing_libraries GROUP BY run_id ORDER BY count(*) DESC, run_id LIMIT 1`,
      // A batch of typical size: the one whose extraction count is nearest the median.
      `WITH b AS (SELECT batch_id, count(*) AS n FROM dna_extractions GROUP BY 1),
            m AS (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS med FROM b)
       SELECT batch_id::text AS typ_batch FROM b, m ORDER BY abs(n - med), batch_id LIMIT 1`,
      `SELECT lab_id::text AS busy_lab FROM extraction_batches GROUP BY lab_id ORDER BY count(*) DESC, lab_id LIMIT 1`,
      `SELECT sample_id::text AS mid_sample FROM dna_extractions WHERE extraction_id >= 1000000
        ORDER BY extraction_id OFFSET (SELECT count(*) / 2 FROM dna_extractions WHERE extraction_id >= 1000000) LIMIT 1`,
    ],
    statements: [
      {
        id: 'BQ1',
        label: 'Q2 libraries of the biggest run with their samples',
        sql: 'EXECUTE q2_run_libraries_with_samples({big_run})',
        expect: 'improve',
        serves: [IDX.run],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'sequencing_libraries',
          baseline: { node: 'Seq Scan', buffers: 2138 },
          indexed: { node: 'Index Scan', buffers: 1207 },
        },
      },
      {
        id: 'BQ2a',
        label: 'extractions of one batch (GET /api/extractions?batch_id=)',
        sql: 'SELECT * FROM dna_extractions WHERE batch_id = {typ_batch}',
        expect: 'improve',
        serves: [IDX.batch],
        mustImprove: true,
        selectivity: 'selective',
        smallOk: true,
        documented: {
          rel: 'dna_extractions',
          baseline: { node: 'Seq Scan', buffers: 1032 },
          indexed: { node: 'Index Scan', buffers: 3 },
        },
      },
      {
        id: 'BQ2b',
        label: 'Q1 extraction QC by batch, one lab (aggregates every batch)',
        sql: 'EXECUTE q1_extraction_qc_by_batch({busy_lab})',
        expect: 'unchanged',
        relatesTo: [IDX.batch],
        selectivity: 'unselective',
        reason: 'aggregates every batch of the lab, so reading all extractions is the right plan',
        documented: {
          rel: 'dna_extractions',
          baseline: { node: 'Seq Scan', buffers: 1050 },
          indexed: { node: 'Seq Scan', buffers: 1050 },
        },
      },
      {
        id: 'BQ3a',
        label: 'extractions of one sample (redundancy: unique constraint index)',
        sql: 'SELECT * FROM dna_extractions WHERE sample_id = {mid_sample}',
        expect: 'unchanged',
        relatesTo: [IDX.batch],
        keepsIndex: 'uq_dna_extractions_sample_attempt',
        selectivity: 'selective',
        smallOk: true,
        reason: 'sample_id leads uq_dna_extractions_sample_attempt',
        documented: {
          rel: 'dna_extractions',
          baseline: { node: 'Index Scan', buffers: 3 },
          indexed: { node: 'Index Scan', buffers: 3 },
        },
      },
      {
        id: 'BQ3b',
        label: 'v_lab_pipeline_status, one sample (redundancy)',
        sql: 'SELECT * FROM v_lab_pipeline_status WHERE sample_id = {mid_sample}',
        expect: 'unchanged',
        relatesTo: [IDX.batch, IDX.run],
        keepsIndex: 'uq_dna_extractions_sample_attempt',
        selectivity: 'selective',
        smallOk: true,
        reason:
          'uses the unique indexes on dna_extractions and sequencing_libraries in both phases',
        documented: {
          rel: 'dna_extractions',
          baseline: { node: 'Index Only Scan', buffers: 27 },
          indexed: { node: 'Index Only Scan', buffers: 27 },
        },
      },
    ],
  },
];

/** All statements with their slice, in file order. */
export function allStatements() {
  return SLICES.flatMap((slice) => slice.statements.map((s) => ({ ...s, slice: slice.id })));
}

/** Run a slice's lookups (in order; a lookup may use {name} of an earlier one). */
export async function lookupParams(client, slice) {
  const params = {};
  for (const sql of slice.lookups) {
    const { rows } = await client.query(fill(sql, params));
    if (rows.length !== 1)
      throw new Error(`Parameter lookup returned no row for ${slice.id}: ${sql}`);
    Object.assign(params, rows[0]);
  }
  return params;
}

/**
 * PREPARE the slice's statements by running its query file (their example EXECUTE output is
 * discarded). Some query files start with DEALLOCATE ALL, so only the last slice prepared is
 * available: call this right before executing that slice's statements.
 */
export async function prepareQueries(client, slice) {
  await client.query('DEALLOCATE ALL');
  const file = path.join(REPO_ROOT, 'database/queries', slice.queryFile);
  await client.query(fs.readFileSync(file, 'utf8'));
}

/** Row count and md5 of the sorted rows (independent of the order; volatile columns do not occur). */
export async function resultChecksum(client, sql) {
  const { rows } = await client.query(sql);
  const lines = rows.map((r) => JSON.stringify(r)).sort();
  return {
    rows: rows.length,
    checksum: crypto.createHash('md5').update(lines.join('\n')).digest('hex'),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan reading
// ---------------------------------------------------------------------------------------------

/** Walk a plan tree (JSON from EXPLAIN FORMAT JSON) depth first. */
export function* planNodes(node) {
  yield node;
  for (const child of node.Plans ?? []) yield* planNodes(child);
}

/**
 * The comparable facts of one plan: top node, scan nodes by relation, indexes used, rows, buffers.
 * Bitmap Index Scan nodes carry no relation; their index is attributed to the Bitmap Heap Scan.
 */
export function describePlan(root) {
  const scansByRelation = {};
  const indexes = new Set();
  let removedByFilter = 0;
  for (const node of planNodes(root)) {
    if (node['Index Name']) indexes.add(node['Index Name']);
    if (node['Relation Name']) {
      (scansByRelation[node['Relation Name']] ??= []).push(node['Node Type']);
    }
    removedByFilter += node['Rows Removed by Filter'] ?? 0;
  }
  for (const list of Object.values(scansByRelation)) list.sort();
  return {
    topNode: root['Node Type'],
    scansByRelation,
    indexesUsed: [...indexes].sort(),
    rows: root['Actual Rows'] ?? null,
    buffersHit: root['Shared Hit Blocks'] ?? 0,
    buffersRead: root['Shared Read Blocks'] ?? 0,
    rowsRemovedByFilter: removedByFilter,
  };
}

/** EXPLAIN without ANALYZE (shape only): the index names the planner would use. */
export async function planShape(client, sql) {
  const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
  const root = rows[0]['QUERY PLAN'][0].Plan;
  return describePlan(root);
}
