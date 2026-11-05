// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: regions and sampling sites
//
// latitude and longitude are numeric(9,6); they are cast to float8 in the SELECT so the client gets
// JSON numbers. A double holds 6 decimals of a value in [-180, 180] exactly enough to read back the
// same digits (PostgreSQL prints the shortest string that round-trips), so no digits are lost.
import { query, queryOne, withTransaction } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertProjectAccess } from './projectAccess.js';

const SITE_COLUMNS = `
  s.site_id, s.region_id, s.name, s.latitude::float8 AS latitude,
  s.longitude::float8 AS longitude, s.habitat_type, s.description, s.created_by::int AS created_by`;

const siteNotFound = () => new AppError(404, 'not_found', 'Site not found');

const SORT_COLUMNS = { site_id: 's.site_id', name: 's.name' };

/** Regions, ordered by id. A small lookup list: not paginated. */
export async function listRegions({ region_type: regionType }) {
  return query(
    `SELECT region_id, name, region_type, parent_region_id FROM regions
      WHERE ($1::region_type IS NULL OR region_type = $1::region_type)
      ORDER BY region_id`,
    [regionType ?? null],
  );
}

/** A new region; (name, type) is unique (409), an unknown parent is 422. */
export async function createRegion(body, user) {
  return withTransaction(
    async (client) =>
      queryOne(
        `INSERT INTO regions (name, region_type, parent_region_id) VALUES ($1, $2, $3)
         RETURNING region_id, name, region_type, parent_region_id`,
        [body.name, body.region_type, body.parent_region_id ?? null],
        client,
      ),
    { actorId: user.user_id },
  );
}

/**
 * Every signed-in user may read sites (sites belong to no single project). With `project_id` the
 * list narrows to that project's sites, and then the caller needs access to the project.
 */
export async function listSites(user, filters, { limit, offset, sort }) {
  if (filters.project_id !== undefined) await assertProjectAccess(user, filters.project_id);
  const orderColumn = SORT_COLUMNS[sort?.field] ?? 's.site_id';
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const where = `
    WHERE ($1::bigint IS NULL OR EXISTS (
            SELECT 1 FROM project_sites ps WHERE ps.site_id = s.site_id AND ps.project_id = $1::bigint))
      AND ($2::bigint IS NULL OR s.region_id = $2::bigint)
      AND ($3::habitat_type IS NULL OR s.habitat_type = $3::habitat_type)`;
  const params = [
    filters.project_id ?? null,
    filters.region_id ?? null,
    filters.habitat_type ?? null,
  ];
  const rows = await query(
    `SELECT ${SITE_COLUMNS} FROM sampling_sites s ${where}
      ORDER BY ${orderColumn} ${direction}, s.site_id ${direction} LIMIT $4 OFFSET $5`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(
    `SELECT count(*) AS total FROM sampling_sites s ${where}`,
    params,
  );
  return { rows, total };
}

export async function getSite(siteId) {
  const site = await queryOne(`SELECT ${SITE_COLUMNS} FROM sampling_sites s WHERE s.site_id = $1`, [
    siteId,
  ]);
  if (!site) throw siteNotFound();
  return site;
}

/** created_by always comes from the session. Unknown region 422, duplicate name in region 409. */
export async function createSite(body, user) {
  return withTransaction(
    async (client) => {
      const created = await queryOne(
        `INSERT INTO sampling_sites (region_id, name, latitude, longitude, habitat_type, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING site_id`,
        [
          body.region_id,
          body.name,
          body.latitude,
          body.longitude,
          body.habitat_type,
          body.description ?? null,
          user.user_id,
        ],
        client,
      );
      return queryOne(
        `SELECT ${SITE_COLUMNS} FROM sampling_sites s WHERE s.site_id = $1`,
        [created.site_id],
        client,
      );
    },
    { actorId: user.user_id },
  );
}

/**
 * A correction is allowed even when events already use the site (region and coordinates included);
 * created_by is immutable. Static SQL: CASE WHEN $flag THEN $value ELSE column END.
 */
export async function updateSite(siteId, body, user) {
  const has = (key) => body[key] !== undefined;
  return withTransaction(
    async (client) => {
      const updated = await queryOne(
        `UPDATE sampling_sites
            SET region_id    = CASE WHEN $2::boolean  THEN $3::bigint        ELSE region_id    END,
                name         = CASE WHEN $4::boolean  THEN $5::text          ELSE name         END,
                latitude     = CASE WHEN $6::boolean  THEN $7::numeric       ELSE latitude     END,
                longitude    = CASE WHEN $8::boolean  THEN $9::numeric       ELSE longitude    END,
                habitat_type = CASE WHEN $10::boolean THEN $11::habitat_type ELSE habitat_type END,
                description  = CASE WHEN $12::boolean THEN $13::text         ELSE description  END
          WHERE site_id = $1 RETURNING site_id`,
        [
          siteId,
          has('region_id'),
          body.region_id ?? null,
          has('name'),
          body.name ?? null,
          has('latitude'),
          body.latitude ?? null,
          has('longitude'),
          body.longitude ?? null,
          has('habitat_type'),
          body.habitat_type ?? null,
          has('description'),
          body.description ?? null,
        ],
        client,
      );
      if (!updated) throw siteNotFound();
      return queryOne(
        `SELECT ${SITE_COLUMNS} FROM sampling_sites s WHERE s.site_id = $1`,
        [siteId],
        client,
      );
    },
    { actorId: user.user_id },
  );
}
