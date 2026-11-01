// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: analysis runs, CSV import, approval
//
// Status changes, the importer-is-not-the-approver rule, the detection count and supersession are
// the database's (import_detections, approve_analysis, reject_analysis, the status trigger); this
// layer checks access, validates the CSV FORMAT, resolves names to ids, calls them and lets the
// SQLSTATE mapping answer (EB001 409, EB002 422, EB003 409).
//
// Visibility. An analysis belongs to a sequencing run that may span projects (T22 rule): it is
// readable when the caller can access at least one project of its run's libraries' samples, and
// writable when they can write to at least one (a project `viewer` never writes). Roles that may
// not read non-approved detections (CONTRACT 9: only administrator, PI and analyst may) see only
// `approved` and `superseded` analyses; any other one is a 404 for them and absent from lists, so
// the existence of unapproved results does not leak. Unknown, hidden and unapproved give the same
// 404 body.
import { callProcedure, query, queryOne, withTransaction } from '../db/query.js';
import { AppError, unprocessable } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import { ROLES } from '../middleware/permissions.js';
import { CsvFormatError, checkHeader, parseCsv, validateDetectionRecords } from '../utils/csv.js';
import { assertAnyProjectAccess, projectIdsOfRun } from './projectAccess.js';

const analysisNotFound = () => new AppError(404, 'not_found', 'Analysis not found');
const runNotFound = () => new AppError(404, 'not_found', 'Sequencing run not found');

/** Most errors listed in one response; the total is always reported. */
export const MAX_REPORTED_ERRORS = 100;

// Every row also names what its ids point to (CONTRACT 1.8), so roles that cannot list users or
// runs can still show them: the run code, the marker name, the importer's and approver's names,
// and for a `rejected` analysis the rejection (the reason is kept only in the audit entry that
// reject_analysis() writes, so it is read back from the latest one; null for any other status).
const COLUMNS = `
  a.analysis_id, a.run_id, a.marker_id, a.pipeline_name, a.pipeline_version, a.reference_db,
  a.reference_db_version, COALESCE(a.parameters, '{}'::jsonb) AS parameters, a.status,
  a.imported_by, a.approved_by, a.approved_at, a.created_at, a.supersedes_analysis_id,
  (SELECT r.run_code FROM sequencing_runs r WHERE r.run_id = a.run_id) AS run_code,
  (SELECT m.marker_name FROM dna_markers m WHERE m.marker_id = a.marker_id) AS marker_name,
  (SELECT u.full_name FROM users u WHERE u.user_id = a.imported_by) AS imported_by_name,
  (SELECT u.full_name FROM users u WHERE u.user_id = a.approved_by) AS approved_by_name,
  CASE WHEN a.status = 'rejected' THEN (
    SELECT jsonb_build_object(
             'reason', al.details ->> 'reason',
             'rejected_by', al.actor_id,
             'rejected_by_name', u.full_name,
             'rejected_at', to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      FROM audit_logs al
      LEFT JOIN users u ON u.user_id = al.actor_id
     WHERE al.entity_type = 'analysis_runs' AND al.entity_id = a.analysis_id
       AND al.action = 'reject'
     ORDER BY al.created_at DESC, al.audit_id DESC
     LIMIT 1) END AS rejection`;
const SORT = { analysis_id: 'a.analysis_id', created_at: 'a.created_at' };

const hasRole = (user, ...names) => names.some((name) => user.roles.includes(name));
const canSeeUnapproved = (user) =>
  hasRole(user, ROLES.ADMINISTRATOR, ROLES.PRINCIPAL_INVESTIGATOR, ROLES.ANALYST);

function readAnalysis(analysisId, executor) {
  return queryOne(
    `SELECT ${COLUMNS} FROM analysis_runs a WHERE a.analysis_id = $1`,
    [analysisId],
    executor,
  );
}

/** The analysis if the caller may see it (and, with `write`, change it); else the shared 404/403. */
export async function authorizeAnalysis(user, analysisId, { write = false } = {}) {
  const analysis = await readAnalysis(analysisId);
  if (!analysis) throw analysisNotFound();
  const projectIds = await projectIdsOfRun(analysis.run_id);
  await assertAnyProjectAccess(user, projectIds, { write, notFound: analysisNotFound });
  if (!canSeeUnapproved(user) && !['approved', 'superseded'].includes(analysis.status)) {
    throw analysisNotFound();
  }
  return analysis;
}

export async function listAnalyses(user, filters, { limit, offset, sort }) {
  const visible = await accessibleProjectIds(user);
  const column = SORT[sort?.field] ?? 'a.analysis_id';
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const from = `
    FROM analysis_runs a
    WHERE ($1::bigint[] IS NULL OR EXISTS (
            SELECT 1 FROM sequencing_libraries l
              JOIN dna_extractions x ON x.extraction_id = l.extraction_id
              JOIN samples s ON s.sample_id = x.sample_id
              JOIN collection_events e ON e.event_id = s.event_id
             WHERE l.run_id = a.run_id AND e.project_id = ANY($1::bigint[])))
      AND ($2::boolean OR a.status IN ('approved', 'superseded'))
      AND ($3::bigint IS NULL OR a.run_id = $3::bigint)
      AND ($4::analysis_status IS NULL OR a.status = $4::analysis_status)
      AND ($5::bigint IS NULL OR a.marker_id = $5::bigint)`;
  const params = [
    visible,
    canSeeUnapproved(user),
    filters.run_id ?? null,
    filters.status ?? null,
    filters.marker_id ?? null,
  ];
  const rows = await query(
    `SELECT ${COLUMNS} ${from} ORDER BY ${column} ${direction}, a.analysis_id ${direction} LIMIT $6 OFFSET $7`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

export async function getAnalysis(user, analysisId) {
  const analysis = await authorizeAnalysis(user, analysisId);
  const counts = await queryOne(
    `SELECT count(*) FILTER (WHERE qc_flag = 'pass')::int AS pass,
            count(*) FILTER (WHERE qc_flag = 'warn')::int AS warn,
            count(*) FILTER (WHERE qc_flag = 'fail')::int AS fail
       FROM taxon_assignments WHERE analysis_id = $1`,
    [analysisId],
  );
  return { ...analysis, assignment_counts: counts };
}

/**
 * New analysis in `draft`. A correction names the approved analysis it replaces in
 * `supersedes_analysis_id` (CONTRACT 1.3); the referenced analysis must be visible to the caller
 * and approved (the procedure re-checks at approval time), a second correction of one analysis is
 * 409 (unique constraint).
 */
export async function createAnalysis(body, user) {
  const projectIds = await projectIdsOfRun(body.run_id);
  if (projectIds === null) throw runNotFound();
  await assertAnyProjectAccess(user, projectIds, { write: true, notFound: runNotFound });
  if (body.supersedes_analysis_id != null) {
    const replaced = await authorizeAnalysis(user, body.supersedes_analysis_id);
    if (replaced.status !== 'approved') {
      throw unprocessable(
        `Analysis ${replaced.analysis_id} is ${replaced.status}; only an approved analysis can be corrected`,
        [{ field: 'supersedes_analysis_id', message: 'must name an approved analysis' }],
        'rule_violation',
      );
    }
  }
  return withTransaction(
    async (client) => {
      const created = await queryOne(
        `INSERT INTO analysis_runs (run_id, marker_id, pipeline_name, pipeline_version, reference_db,
                                    reference_db_version, parameters, supersedes_analysis_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING analysis_id`,
        [
          body.run_id,
          body.marker_id,
          body.pipeline_name,
          body.pipeline_version,
          body.reference_db,
          body.reference_db_version ?? null,
          JSON.stringify(body.parameters ?? {}),
          body.supersedes_analysis_id ?? null,
        ],
        client,
      );
      return readAnalysis(created.analysis_id, client);
    },
    { actorId: user.user_id },
  );
}

export async function approveAnalysis(analysisId, user) {
  await authorizeAnalysis(user, analysisId, { write: true });
  return withTransaction(
    async (client) => {
      await callProcedure('approve_analysis', [analysisId, user.user_id], client);
      return readAnalysis(analysisId, client);
    },
    { actorId: user.user_id },
  );
}

export async function rejectAnalysis(analysisId, reason, user) {
  await authorizeAnalysis(user, analysisId, { write: true });
  return withTransaction(
    async (client) => {
      await callProcedure('reject_analysis', [analysisId, user.user_id, reason], client);
      return readAnalysis(analysisId, client);
    },
    { actorId: user.user_id },
  );
}

// CSV import ------------------------------------------------------------------------------------

const fileProblem = (message) =>
  unprocessable('The file is not a valid CSV', [{ field: 'file', message }]);

/** Decode and parse; throws a 422 for bytes that are not UTF-8 CSV. */
function parseUpload(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw fileProblem('must be UTF-8 text');
  }
  if (text.trim() === '') throw fileProblem('the file is empty');
  try {
    return parseCsv(text);
  } catch (err) {
    if (err instanceof CsvFormatError) throw fileProblem(err.message);
    throw err;
  }
}

/**
 * Names to ids with two queries for the whole file: every distinct (name, rank) pair, and every
 * distinct library code. Adds the row-level errors a format check cannot see: unknown taxon (never
 * created, D16), unknown library or one of another run, and a repeated library + taxon.
 */
async function resolveRows(rows, analysis) {
  const errors = [];
  const pairs = new Map();
  const codes = new Set();
  for (const row of rows) {
    pairs.set(`${row.taxon_rank}\u0000${row.scientific_name}`, row);
    codes.add(row.library_code);
  }
  const taxa = new Map();
  if (pairs.size > 0) {
    const found = await query(
      `SELECT t.taxon_id, t.scientific_name, t.rank::text AS rank
         FROM unnest($1::text[], $2::text[]) AS p(name, rank)
         JOIN taxa t ON t.scientific_name = p.name AND t.rank = p.rank::taxon_rank`,
      [
        [...pairs.values()].map((r) => r.scientific_name),
        [...pairs.values()].map((r) => r.taxon_rank),
      ],
    );
    for (const t of found) taxa.set(`${t.rank}\u0000${t.scientific_name}`, t.taxon_id);
  }
  const libraries = new Map();
  if (codes.size > 0) {
    const found = await query(
      'SELECT library_code, run_id FROM sequencing_libraries WHERE library_code = ANY($1::text[])',
      [[...codes]],
    );
    for (const l of found) libraries.set(l.library_code, l.run_id);
  }
  const resolved = [];
  const firstRow = new Map();
  for (const row of rows) {
    const before = errors.length;
    const taxonId = taxa.get(`${row.taxon_rank}\u0000${row.scientific_name}`);
    if (taxonId === undefined) {
      errors.push({
        row: row.row,
        field: 'scientific_name',
        message: `no taxon "${row.scientific_name}" with rank ${row.taxon_rank} (taxa are never created by an import)`,
      });
    }
    const runId = libraries.get(row.library_code);
    if (runId === undefined) {
      errors.push({
        row: row.row,
        field: 'library_code',
        message: `library ${row.library_code} does not exist`,
      });
    } else if (runId !== analysis.run_id) {
      errors.push({
        row: row.row,
        field: 'library_code',
        message: `library ${row.library_code} belongs to another sequencing run (analysis ${analysis.analysis_id} uses run ${analysis.run_id})`,
      });
    }
    if (errors.length === before) {
      const key = `${row.library_code}\u0000${taxonId}`;
      if (firstRow.has(key)) {
        errors.push({
          row: row.row,
          field: 'library_code',
          message: `library ${row.library_code} with this taxon already appears in row ${firstRow.get(key)}`,
        });
      } else {
        firstRow.set(key, row.row);
        resolved.push({
          row: row.row,
          library_code: row.library_code,
          taxon_id: taxonId,
          read_count: row.read_count,
          confidence: row.confidence,
          qc_flag: row.qc_flag,
        });
      }
    }
  }
  return { resolved, errors };
}

/**
 * A non-draft analysis cannot be imported into. The procedure owns that answer (EB003 for
 * imported/approved, EB001 otherwise), so it is asked with an empty payload, which it refuses
 * only after its status check; for a draft nothing is called.
 */
async function assertImportable(analysis, user) {
  if (analysis.status === 'draft') return;
  await withTransaction(
    (client) =>
      callProcedure('import_detections', [analysis.analysis_id, '[]', user.user_id], client),
    { actorId: user.user_id },
  );
}

/**
 * Validate (dry run) or import a detections CSV into a draft analysis. Format errors, unknown taxa
 * and libraries are collected for the whole file in file order; the procedure re-checks everything
 * and stays the final authority. At most MAX_REPORTED_ERRORS are listed, `total_errors` is exact.
 */
export async function importDetections({ analysisId, buffer, dryRun }, user) {
  const analysis = await authorizeAnalysis(user, analysisId, { write: true });
  await assertImportable(analysis, user);

  const records = parseUpload(buffer);
  const { index, errors: headerErrors } = checkHeader(records[0].fields);
  let errors = headerErrors;
  let rows = [];
  if (headerErrors.length === 0) {
    const data = records.slice(1);
    if (data.length === 0) {
      errors = [{ row: 1, field: 'file', message: 'the file has no data rows' }];
    } else {
      const checked = validateDetectionRecords(data, index);
      const lookups = await resolveRows(checked.rows, analysis);
      rows = lookups.resolved;
      errors = [...checked.errors, ...lookups.errors].sort((a, b) => a.row - b.row);
    }
  }
  const totalErrors = errors.length;
  const listed = errors.slice(0, MAX_REPORTED_ERRORS);

  if (dryRun) return { dryRun: true, valid_rows: rows.length, errors: listed, totalErrors };
  if (totalErrors > 0) {
    const capped = totalErrors > listed.length ? ` (first ${listed.length} shown)` : '';
    throw unprocessable(
      `The file has ${totalErrors} error${totalErrors === 1 ? '' : 's'}${capped}`,
      listed,
    );
  }
  const payload = rows.map(({ row: _row, ...rest }) => rest);
  const inserted = await withTransaction(
    async (client) => {
      const [{ import_detections: count }] = await callProcedure(
        'import_detections',
        [analysisId, JSON.stringify(payload), user.user_id],
        client,
      );
      return count;
    },
    { actorId: user.user_id },
  );
  return { dryRun: false, inserted };
}
