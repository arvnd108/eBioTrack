// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: taxa and detection history
//
// Taxa are a shared reference taxonomy: any signed-in user reads them. Detections are the
// approved-and-passing ones only (the v_approved_detections view: analysis status approved AND
// qc_flag pass), limited to the caller's projects.
import { query, queryOne } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import { assertProjectAccess } from './projectAccess.js';

const taxonNotFound = () => new AppError(404, 'not_found', 'Taxon not found');

const COLUMNS = 't.taxon_id, t.scientific_name, t.rank, t.parent_taxon_id, t.external_id';

/** Escape LIKE metacharacters so user text matches literally. */
export const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * `q` matches names that START with it or that have a word starting with it (case-insensitive):
 * "labeo" and "rohita" both find "Labeo rohita". The pattern is always a bind parameter.
 */
export async function listTaxa(filters, { limit, offset, sort }) {
  const q = filters.q === undefined ? null : escapeLike(filters.q);
  const from = `
    FROM taxa t
    WHERE ($1::text IS NULL OR t.scientific_name ILIKE $1 || '%' OR t.scientific_name ILIKE '% ' || $1 || '%')
      AND ($2::taxon_rank IS NULL OR t.rank = $2::taxon_rank)
      AND ($3::bigint IS NULL OR t.parent_taxon_id = $3::bigint)`;
  const params = [q, filters.rank ?? null, filters.parent_taxon_id ?? null];
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const order =
    sort?.field === 'taxon_id'
      ? `t.taxon_id ${direction}`
      : `t.scientific_name ${direction}, t.taxon_id ${direction}`;
  const rows = await query(`SELECT ${COLUMNS} ${from} ORDER BY ${order} LIMIT $4 OFFSET $5`, [
    ...params,
    limit,
    offset,
  ]);
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

/** The taxon plus its ancestors, root first, ending with the taxon itself. */
export async function getTaxon(taxonId) {
  const taxon = await queryOne(`SELECT ${COLUMNS} FROM taxa t WHERE t.taxon_id = $1`, [taxonId]);
  if (!taxon) throw taxonNotFound();
  const lineage = await query(
    `WITH RECURSIVE up AS (
       SELECT taxon_id, scientific_name, rank, parent_taxon_id, 0 AS steps_up, ARRAY[taxon_id] AS path
         FROM taxa WHERE taxon_id = $1
       UNION ALL
       SELECT p.taxon_id, p.scientific_name, p.rank, p.parent_taxon_id, up.steps_up + 1, up.path || p.taxon_id
         FROM up JOIN taxa p ON p.taxon_id = up.parent_taxon_id
        WHERE NOT p.taxon_id = ANY (up.path)
     )
     SELECT taxon_id, scientific_name, rank FROM up ORDER BY steps_up DESC`,
    [taxonId],
  );
  return { ...taxon, lineage };
}

/**
 * Approved, passing detections of one taxon. `from`/`to` are inclusive bounds on collected_at
 * (a date means the whole UTC day). Newest first unless `?sort=collected_at`.
 */
export async function listDetections(user, taxonId, filters, { limit, offset, sort }) {
  if (!(await queryOne('SELECT 1 AS ok FROM taxa WHERE taxon_id = $1', [taxonId]))) {
    throw taxonNotFound();
  }
  if (filters.project_id !== undefined) await assertProjectAccess(user, filters.project_id);
  const visible = await accessibleProjectIds(user);
  const from = `
    FROM v_approved_detections d
    WHERE d.taxon_id = $1
      AND ($2::bigint[] IS NULL OR d.project_id = ANY($2::bigint[]))
      AND ($3::bigint IS NULL OR d.project_id = $3::bigint)
      AND ($4::bigint IS NULL OR d.site_id = $4::bigint)
      AND ($5::timestamptz IS NULL OR d.collected_at >= $5::timestamptz)
      AND ($6::timestamptz IS NULL OR d.collected_at <= $6::timestamptz)`;
  const params = [
    taxonId,
    visible,
    filters.project_id ?? null,
    filters.site_id ?? null,
    filters.from ?? null,
    filters.to ?? null,
  ];
  const rows = await query(
    `SELECT d.site_id, d.site_name, d.sample_id, d.sample_code, d.collected_at, d.analysis_id, d.read_count,
            d.confidence::float8 AS confidence, d.qc_flag
       ${from} ORDER BY d.collected_at ${sort?.direction === 'ASC' ? 'ASC' : 'DESC'}, d.assignment_id LIMIT $7 OFFSET $8`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}
