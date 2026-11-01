// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: CSV report exports
//
// An export request records WHO asked for WHAT (data_exports: requester, project, type, filters,
// row_count). No table stores the file, so the CSV is REGENERATED at download time from the type,
// project and stored filters:
//  - detections_csv and richness_csv use only approved analyses and pass detections;
//  - the requester's access to the project is checked again at download (a user removed from the
//    project since the request gets 404);
//  - the data may have changed since the request: the file is still served, and the response header
//    X-Row-Count carries the number of data rows actually in it (it can differ from the
//    row_count returned at request time);
//  - rows are read in keyset pages of 5000 and streamed, never built as one string;
//  - at most MAX_EXPORT_ROWS rows (422 beyond that, at request and at download).
// Only the requester can download: anyone else, other administrators included, gets the same 404
// as for an unknown export (CONTRACT 10: "requester").
// Column order is fixed below. Files are UTF-8 without BOM, CRLF line ends, no caveat line (a
// leading comment line breaks typical CSV readers; the caveat is for B/D to show beside the link).
import { query, queryOne, withTransaction } from '../db/query.js';
import { AppError, unprocessable } from '../middleware/errorHandler.js';
import { csvLine } from '../utils/csv.js';
import { assertProjectAccess } from './projectAccess.js';
import { queryRichness } from './analytics.service.js';

export const MAX_EXPORT_ROWS = 200000;
const PAGE_SIZE = 5000;

const exportNotFound = () => new AppError(404, 'not_found', 'Export not found');

// Shared range predicate on collected_at; params $3 (from) and $4 (to) of each builder.
const RANGE = `AND ($3::timestamptz IS NULL OR r.collected_at >= $3::timestamptz)
      AND ($4::timestamptz IS NULL OR r.collected_at <= $4::timestamptz)`;

const BUILDERS = {
  samples_csv: {
    columns: [
      'sample_id',
      'sample_code',
      'status',
      'sample_type',
      'event_id',
      'site_id',
      'site_name',
      'project_id',
      'project_title',
      'collected_at',
      'volume_ml',
      'depth_m',
      'storage_location',
    ],
    select: `r.sample_id, r.sample_code, r.status, r.sample_type, r.event_id, r.site_id, r.site_name,
             r.project_id, r.project_title, r.collected_at, r.volume_ml::float8 AS volume_ml,
             r.depth_m::float8 AS depth_m, r.storage_location`,
    key: 'r.sample_id',
    from: `FROM v_sample_registry r
      WHERE r.project_id = $1
        AND ($2::bigint IS NULL OR r.site_id = $2::bigint)
        ${RANGE}
        AND ($5::sample_status IS NULL OR r.status = $5::sample_status)`,
    params: (projectId, f) => [
      projectId,
      f.site_id ?? null,
      f.from ?? null,
      f.to ?? null,
      f.status ?? null,
    ],
  },
  detections_csv: {
    columns: [
      'sample_code',
      'site_name',
      'collected_at',
      'scientific_name',
      'rank',
      'read_count',
      'confidence',
      'qc_flag',
      'analysis_id',
      'marker_name',
      'pipeline_name',
      'pipeline_version',
      'reference_db',
      'reference_db_version',
    ],
    select: `r.sample_code, r.site_name, r.collected_at, r.scientific_name, r.rank, r.read_count,
             r.confidence::float8 AS confidence, r.qc_flag, r.analysis_id, r.marker_name,
             r.pipeline_name, r.pipeline_version, r.reference_db, r.reference_db_version`,
    key: 'r.assignment_id',
    from: `FROM v_approved_detections r
      WHERE r.project_id = $1
        AND ($2::bigint IS NULL OR r.site_id = $2::bigint)
        ${RANGE}
        AND ($5::bigint IS NULL OR r.taxon_id = $5::bigint)`,
    params: (projectId, f) => [
      projectId,
      f.site_id ?? null,
      f.from ?? null,
      f.to ?? null,
      f.taxon_id ?? null,
    ],
  },
};
const RICHNESS_COLUMNS = ['group', 'site_id', 'observed_taxa', 'sample_count'];

const richnessOptions = (projectId, f) => ({
  projectIds: [projectId],
  siteId: f.site_id ?? undefined,
  groupBy: f.group_by ?? 'year',
  from: f.from ?? undefined,
  to: f.to ?? undefined,
});

async function countRows(type, projectId, filters) {
  if (type === 'richness_csv') {
    return (await queryRichness(richnessOptions(projectId, filters))).length;
  }
  const builder = BUILDERS[type];
  const [{ n }] = await query(
    `SELECT count(*)::int AS n ${builder.from}`,
    builder.params(projectId, filters),
  );
  return n;
}

function assertWithinCap(rowCount) {
  if (rowCount > MAX_EXPORT_ROWS) {
    throw unprocessable(
      `The export would have ${rowCount} rows; the limit is ${MAX_EXPORT_ROWS}. Narrow the filters.`,
      [{ field: 'filters', message: `at most ${MAX_EXPORT_ROWS} rows` }],
    );
  }
}

/** Record an export request. `body` is validated by the route (type, project, per-type filters). */
export async function createExport(body, user) {
  await assertProjectAccess(user, body.project_id);
  const filters = body.filters ?? {};
  const rowCount = await countRows(body.export_type, body.project_id, filters);
  assertWithinCap(rowCount);
  return withTransaction(
    (client) =>
      queryOne(
        `INSERT INTO data_exports (requested_by, project_id, export_type, filters, row_count)
         VALUES ($1, $2, $3::export_type, $4::jsonb, $5) RETURNING export_id, row_count`,
        [user.user_id, body.project_id, body.export_type, JSON.stringify(filters), rowCount],
        client,
      ),
    { actorId: user.user_id },
  );
}

async function* generateRows(type, projectId, filters) {
  if (type === 'richness_csv') {
    const rows = await queryRichness(richnessOptions(projectId, filters));
    yield csvLine(RICHNESS_COLUMNS);
    for (const row of rows) {
      yield csvLine([row.group, row.site_id ?? null, row.observed_taxa, row.sample_count]);
    }
    return;
  }
  const builder = BUILDERS[type];
  const params = builder.params(projectId, filters);
  const keyParam = params.length + 1;
  yield csvLine(builder.columns);
  let after = 0;
  for (;;) {
    const page = await query(
      `SELECT ${builder.select}, ${builder.key} AS paging_key ${builder.from}
          AND ${builder.key} > $${keyParam}::bigint
        ORDER BY ${builder.key} LIMIT ${PAGE_SIZE}`,
      [...params, after],
    );
    if (page.length === 0) return;
    let chunk = '';
    for (const row of page) chunk += csvLine(builder.columns.map((name) => row[name]));
    after = page[page.length - 1].paging_key;
    yield chunk;
    if (page.length < PAGE_SIZE) return;
  }
}

/**
 * The file for an export the caller requested: name, the number of data rows now, and an async
 * generator of CSV text. Throws before any byte is produced (404, 422).
 */
export async function openExport(exportId, user) {
  const record = await queryOne(
    `SELECT export_id, project_id, export_type, COALESCE(filters, '{}'::jsonb) AS filters
       FROM data_exports WHERE export_id = $1 AND requested_by = $2`,
    [exportId, user.user_id],
  );
  if (!record) throw exportNotFound();
  await assertProjectAccess(user, record.project_id, { notFound: exportNotFound });
  const rowCount = await countRows(record.export_type, record.project_id, record.filters);
  assertWithinCap(rowCount);
  return {
    filename: `ebiotrack-${record.export_type}-${record.export_id}.csv`,
    rowCount,
    chunks: () => generateRows(record.export_type, record.project_id, record.filters),
  };
}
