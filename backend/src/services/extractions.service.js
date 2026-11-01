// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: labs, markers, extraction batches, extractions, QC results
//
// Project rules (see projectAccess.js): an extraction belongs to the project of its sample's event;
// a QC row belongs to its sample's project, or, when it names only an analysis, is visible and
// writable to anyone who can access AT LEAST ONE project of that analysis (the projects of the
// samples in its run). Batches, labs and markers carry no project.
// numeric columns are cast to float8 so the client gets JSON numbers; `date` is formatted in SQL
// as YYYY-MM-DD so no time-zone conversion can shift it.
// The attempt number is the one lab rule computed here (no SQL object owns it): inside the
// transaction that holds the sample row lock.
import { query, queryOne, withTransaction } from '../db/query.js';
import { AppError, unprocessable } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import {
  assertAnyProjectAccess,
  assertProjectAccess,
  projectIdOfSample,
  projectIdsOfAnalysis,
  projectIdOfExtraction,
} from './projectAccess.js';

const sampleNotFound = () => new AppError(404, 'not_found', 'Sample not found');
const extractionNotFound = () => new AppError(404, 'not_found', 'Extraction not found');
const analysisNotFound = () => new AppError(404, 'not_found', 'Analysis not found');

const BATCH_COLUMNS = `
  b.batch_id, b.lab_id, b.operator_id, to_char(b.extraction_date, 'YYYY-MM-DD') AS extraction_date,
  b.kit_name, b.notes, b.created_at`;
const EXTRACTION_COLUMNS = `
  x.extraction_id, x.sample_id, x.batch_id, x.attempt_number,
  x.concentration_ng_ul::float8 AS concentration_ng_ul, x.purity_a260_280::float8 AS purity_a260_280,
  x.qc_status, x.created_at`;
const QC_COLUMNS = `
  q.qc_id, q.sample_id, q.analysis_id, q.qc_type, q.result, q.metric_value::float8 AS metric_value,
  q.notes, q.recorded_by, q.recorded_at`;

const BATCH_SORT = { batch_id: 'b.batch_id', extraction_date: 'b.extraction_date' };
const EXTRACTION_SORT = { extraction_id: 'x.extraction_id', created_at: 'x.created_at' };
const QC_SORT = { qc_id: 'q.qc_id', recorded_at: 'q.recorded_at' };

const dir = (sort) => (sort?.direction === 'DESC' ? 'DESC' : 'ASC');

/** Reference lists: small, not paginated. */
export async function listLabs() {
  return query('SELECT lab_id, name, location FROM laboratories ORDER BY lab_id');
}
export async function listMarkers() {
  return query('SELECT marker_id, marker_name, target_region FROM dna_markers ORDER BY marker_id');
}

// Batches ---------------------------------------------------------------------------------------

export async function listBatches(filters, { limit, offset, sort }) {
  const column = BATCH_SORT[sort?.field] ?? 'b.batch_id';
  const where = 'WHERE ($1::bigint IS NULL OR b.lab_id = $1::bigint)';
  const params = [filters.lab_id ?? null];
  const rows = await query(
    `SELECT ${BATCH_COLUMNS} FROM extraction_batches b ${where}
      ORDER BY ${column} ${dir(sort)}, b.batch_id ${dir(sort)} LIMIT $2 OFFSET $3`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(
    `SELECT count(*) AS total FROM extraction_batches b ${where}`,
    params,
  );
  return { rows, total };
}

/** operator_id is the session user. An unknown lab is a 422 invalid_reference (foreign key). */
export async function createBatch(body, user) {
  return withTransaction(
    async (client) => {
      const created = await queryOne(
        `INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
         VALUES ($1, $2, $3::date, $4, $5) RETURNING batch_id`,
        [
          body.lab_id,
          user.user_id,
          body.extraction_date,
          body.kit_name ?? null,
          body.notes ?? null,
        ],
        client,
      );
      return queryOne(
        `SELECT ${BATCH_COLUMNS} FROM extraction_batches b WHERE b.batch_id = $1`,
        [created.batch_id],
        client,
      );
    },
    { actorId: user.user_id },
  );
}

// Extractions -----------------------------------------------------------------------------------

async function readExtraction(extractionId, executor) {
  return queryOne(
    `SELECT ${EXTRACTION_COLUMNS} FROM dna_extractions x WHERE x.extraction_id = $1`,
    [extractionId],
    executor,
  );
}

export async function listExtractions(user, filters, { limit, offset, sort }) {
  if (filters.sample_id !== undefined) {
    const projectId = await projectIdOfSample(filters.sample_id);
    if (projectId === null) throw sampleNotFound();
    await assertProjectAccess(user, projectId, { notFound: sampleNotFound });
  }
  const visible = await accessibleProjectIds(user);
  const column = EXTRACTION_SORT[sort?.field] ?? 'x.extraction_id';
  const from = `
    FROM dna_extractions x
    JOIN samples s ON s.sample_id = x.sample_id
    JOIN collection_events e ON e.event_id = s.event_id
    WHERE ($1::bigint[] IS NULL OR e.project_id = ANY($1::bigint[]))
      AND ($2::bigint IS NULL OR x.sample_id = $2::bigint)
      AND ($3::bigint IS NULL OR x.batch_id = $3::bigint)
      AND ($4::qc_status IS NULL OR x.qc_status = $4::qc_status)`;
  const params = [
    visible,
    filters.sample_id ?? null,
    filters.batch_id ?? null,
    filters.qc_status ?? null,
  ];
  const rows = await query(
    `SELECT ${EXTRACTION_COLUMNS} ${from}
      ORDER BY ${column} ${dir(sort)}, x.extraction_id ${dir(sort)} LIMIT $5 OFFSET $6`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

/**
 * Record an extraction. Backend rules (not in the contract): the sample row is locked first, so two
 * simultaneous requests for one sample serialize and get attempts n and n+1; a sample that is
 * `failed` or `discarded` cannot be extracted (422 rule_violation). A `stored` sample becomes
 * `extracted` through the dna_extractions insert trigger.
 */
export async function createExtraction(body, user) {
  const projectId = await projectIdOfSample(body.sample_id);
  if (projectId === null) throw sampleNotFound();
  await assertProjectAccess(user, projectId, { write: true, notFound: sampleNotFound });

  return withTransaction(
    async (client) => {
      const sample = await queryOne(
        'SELECT status FROM samples WHERE sample_id = $1 FOR UPDATE',
        [body.sample_id],
        client,
      );
      if (!sample) throw sampleNotFound();
      if (sample.status === 'failed' || sample.status === 'discarded') {
        throw unprocessable(
          `Sample is ${sample.status}; it cannot be extracted`,
          [{ field: 'sample_id', message: `sample is ${sample.status}` }],
          'rule_violation',
        );
      }
      const { attempt } = await queryOne(
        'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt FROM dna_extractions WHERE sample_id = $1',
        [body.sample_id],
        client,
      );
      const created = await queryOne(
        `INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
         VALUES ($1, $2, $3, $4, $5) RETURNING extraction_id`,
        [
          body.sample_id,
          body.batch_id,
          attempt,
          body.concentration_ng_ul ?? null,
          body.purity_a260_280 ?? null,
        ],
        client,
      );
      return readExtraction(created.extraction_id, client);
    },
    { actorId: user.user_id },
  );
}

/**
 * The QC verdict is final (trigger: pending -> pass | fail only, else 409 invalid_transition), so a
 * booked extraction can never be marked fail. Measurements stay editable.
 */
export async function updateExtraction(extractionId, body, user) {
  const projectId = await projectIdOfExtraction(extractionId);
  if (projectId === null) throw extractionNotFound();
  await assertProjectAccess(user, projectId, { write: true, notFound: extractionNotFound });

  const has = (key) => body[key] !== undefined;
  return withTransaction(
    async (client) => {
      const updated = await queryOne(
        `UPDATE dna_extractions
            SET qc_status           = CASE WHEN $2::boolean THEN $3::qc_status ELSE qc_status END,
                concentration_ng_ul = CASE WHEN $4::boolean THEN $5::numeric   ELSE concentration_ng_ul END,
                purity_a260_280     = CASE WHEN $6::boolean THEN $7::numeric   ELSE purity_a260_280 END
          WHERE extraction_id = $1 RETURNING extraction_id`,
        [
          extractionId,
          has('qc_status'),
          body.qc_status ?? null,
          has('concentration_ng_ul'),
          body.concentration_ng_ul ?? null,
          has('purity_a260_280'),
          body.purity_a260_280 ?? null,
        ],
        client,
      );
      if (!updated) throw extractionNotFound();
      return readExtraction(extractionId, client);
    },
    { actorId: user.user_id },
  );
}

// QC results ------------------------------------------------------------------------------------

// A row is visible when its sample is in one of $1's projects; a row naming only an analysis is
// visible when any sample of the analysis's run is.
const QC_VISIBLE = `
  ($1::bigint[] IS NULL OR (
    (q.sample_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM samples s JOIN collection_events e ON e.event_id = s.event_id
        WHERE s.sample_id = q.sample_id AND e.project_id = ANY($1::bigint[])))
    OR (q.sample_id IS NULL AND EXISTS (
       SELECT 1 FROM analysis_runs a
         JOIN sequencing_libraries l ON l.run_id = a.run_id
         JOIN dna_extractions x ON x.extraction_id = l.extraction_id
         JOIN samples s ON s.sample_id = x.sample_id
         JOIN collection_events e ON e.event_id = s.event_id
        WHERE a.analysis_id = q.analysis_id AND e.project_id = ANY($1::bigint[])))))`;

export async function listQcResults(user, filters, { limit, offset, sort }) {
  if (filters.sample_id !== undefined) {
    const projectId = await projectIdOfSample(filters.sample_id);
    if (projectId === null) throw sampleNotFound();
    await assertProjectAccess(user, projectId, { notFound: sampleNotFound });
  }
  if (filters.analysis_id !== undefined) {
    const projectIds = await projectIdsOfAnalysis(filters.analysis_id);
    if (projectIds === null) throw analysisNotFound();
    await assertAnyProjectAccess(user, projectIds, { notFound: analysisNotFound });
  }
  const visible = await accessibleProjectIds(user);
  const order = sort
    ? `${QC_SORT[sort.field]} ${dir(sort)}, q.qc_id ${dir(sort)}`
    : 'q.recorded_at DESC, q.qc_id DESC';
  const from = `
    FROM quality_control_results q
    WHERE ${QC_VISIBLE}
      AND ($2::bigint IS NULL OR q.sample_id = $2::bigint)
      AND ($3::bigint IS NULL OR q.analysis_id = $3::bigint)
      AND ($4::qc_result IS NULL OR q.result = $4::qc_result)`;
  const params = [
    visible,
    filters.sample_id ?? null,
    filters.analysis_id ?? null,
    filters.result ?? null,
  ];
  const rows = await query(`SELECT ${QC_COLUMNS} ${from} ORDER BY ${order} LIMIT $5 OFFSET $6`, [
    ...params,
    limit,
    offset,
  ]);
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

/** recorded_by is the session user. Needs write access to the sample's project and/or the analysis. */
export async function createQcResult(body, user) {
  if (body.sample_id !== undefined && body.sample_id !== null) {
    const projectId = await projectIdOfSample(body.sample_id);
    if (projectId === null) throw sampleNotFound();
    await assertProjectAccess(user, projectId, { write: true, notFound: sampleNotFound });
  }
  if (body.analysis_id !== undefined && body.analysis_id !== null) {
    const projectIds = await projectIdsOfAnalysis(body.analysis_id);
    if (projectIds === null) throw analysisNotFound();
    await assertAnyProjectAccess(user, projectIds, { write: true, notFound: analysisNotFound });
  }
  return withTransaction(
    async (client) => {
      const created = await queryOne(
        `INSERT INTO quality_control_results
                (sample_id, analysis_id, qc_type, result, metric_value, notes, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING qc_id`,
        [
          body.sample_id ?? null,
          body.analysis_id ?? null,
          body.qc_type,
          body.result,
          body.metric_value ?? null,
          body.notes ?? null,
          user.user_id,
        ],
        client,
      );
      return queryOne(
        `SELECT ${QC_COLUMNS} FROM quality_control_results q WHERE q.qc_id = $1`,
        [created.qc_id],
        client,
      );
    },
    { actorId: user.user_id },
  );
}
