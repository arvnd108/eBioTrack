// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: sample types, samples, detail and status
//
// Sample codes, the first history row and the status transition rules live in the database
// (register_sample(), the status triggers); nothing here duplicates them.
// volume_ml and depth_m are numeric; they are cast to float8 so the client gets JSON numbers.
// Access: the project of a sample comes from its event; see projectAccess.js.
import { callProcedure, query, queryOne, withTransaction } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import { assertProjectAccess, projectIdOfEvent, projectIdOfSample } from './projectAccess.js';

export const SAMPLE_COLUMNS = `
  s.sample_id, s.event_id, s.sample_type_id, s.sample_code, s.volume_ml::float8 AS volume_ml,
  s.depth_m::float8 AS depth_m, s.storage_location, s.status, s.created_at`;

const sampleNotFound = () => new AppError(404, 'not_found', 'Sample not found');
const eventNotFound = () => new AppError(404, 'not_found', 'Event not found');

const SORT_COLUMNS = {
  sample_id: 's.sample_id',
  sample_code: 's.sample_code',
  created_at: 's.created_at',
};

/** Sample types, ordered by id. A small lookup list: not paginated. */
export async function listSampleTypes() {
  return query('SELECT sample_type_id, type_name FROM sample_types ORDER BY sample_type_id');
}

/** `q` is a case-insensitive prefix of the sample code; `%`, `_` and `\` in it are literal. */
const likePrefix = (q) => q.replace(/[\\%_]/g, '\\$&').toUpperCase();

export async function listSamples(user, filters, { limit, offset, sort }) {
  if (filters.project_id !== undefined) await assertProjectAccess(user, filters.project_id);
  const visible = await accessibleProjectIds(user);
  const orderColumn = SORT_COLUMNS[sort?.field] ?? 's.sample_id';
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const from = `
    FROM samples s JOIN collection_events e ON e.event_id = s.event_id
    WHERE ($1::bigint[] IS NULL OR e.project_id = ANY($1::bigint[]))
      AND ($2::bigint IS NULL OR e.project_id = $2::bigint)
      AND ($3::bigint IS NULL OR e.site_id = $3::bigint)
      AND ($4::bigint IS NULL OR s.event_id = $4::bigint)
      AND ($5::sample_status IS NULL OR s.status = $5::sample_status)
      AND ($6::text IS NULL OR s.sample_code LIKE $6::text || '%' ESCAPE '\\')`;
  const params = [
    visible,
    filters.project_id ?? null,
    filters.site_id ?? null,
    filters.event_id ?? null,
    filters.status ?? null,
    filters.q === undefined ? null : likePrefix(filters.q),
  ];
  const rows = await query(
    `SELECT ${SAMPLE_COLUMNS} ${from}
      ORDER BY ${orderColumn} ${direction}, s.sample_id ${direction} LIMIT $7 OFFSET $8`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

export async function readSample(sampleId, executor) {
  return queryOne(
    `SELECT ${SAMPLE_COLUMNS} FROM samples s WHERE s.sample_id = $1`,
    [sampleId],
    executor,
  );
}

export async function getSample(sampleId, user) {
  const projectId = await projectIdOfSample(sampleId);
  if (projectId === null) throw sampleNotFound();
  await assertProjectAccess(user, projectId, { notFound: sampleNotFound });

  const detail = await queryOne(
    `SELECT s.sample_id, s.sample_code, s.status, t.type_name AS sample_type,
            s.volume_ml::float8 AS volume_ml, s.depth_m::float8 AS depth_m,
            e.event_id, e.collected_at, e.project_id, g.site_id, g.name AS site_name
       FROM samples s
       JOIN sample_types t ON t.sample_type_id = s.sample_type_id
       JOIN collection_events e ON e.event_id = s.event_id
       JOIN sampling_sites g ON g.site_id = e.site_id
      WHERE s.sample_id = $1`,
    [sampleId],
  );
  if (!detail) throw sampleNotFound();
  const extractions = await query(
    `SELECT extraction_id, attempt_number, qc_status FROM dna_extractions
      WHERE sample_id = $1 ORDER BY attempt_number, extraction_id`,
    [sampleId],
  );
  const history = await query(
    `SELECT h.old_status, h.new_status, h.changed_at, h.changed_by, u.full_name AS changed_by_name,
            h.note
       FROM sample_status_history h
       LEFT JOIN users u ON u.user_id = h.changed_by
      WHERE h.sample_id = $1 ORDER BY h.changed_at, h.history_id`,
    [sampleId],
  );
  return {
    sample_id: detail.sample_id,
    sample_code: detail.sample_code,
    status: detail.status,
    sample_type: detail.sample_type,
    volume_ml: detail.volume_ml,
    depth_m: detail.depth_m,
    event: {
      event_id: detail.event_id,
      collected_at: detail.collected_at,
      project_id: detail.project_id,
    },
    site: { site_id: detail.site_id, name: detail.site_name },
    extractions,
    status_history: history,
  };
}

/** Register one sample through register_sample(); the project comes from the event in the body. */
export async function createSample(body, user) {
  const projectId = await projectIdOfEvent(body.event_id);
  if (projectId === null) throw eventNotFound();
  await assertProjectAccess(user, projectId, { write: true, notFound: eventNotFound });

  return withTransaction(
    async (client) => {
      const [{ register_sample: sampleId }] = await callProcedure(
        'register_sample',
        [
          body.event_id,
          body.sample_type_id,
          body.volume_ml ?? null,
          body.depth_m ?? null,
          body.storage_location ?? null,
          user.user_id,
        ],
        client,
      );
      return readSample(sampleId, client);
    },
    { actorId: user.user_id },
  );
}

/**
 * Plain UPDATE: the BEFORE trigger enforces the transition table (EB001 -> 409) and the AFTER
 * trigger writes the history row with changed_by = the session user. The row is locked first so
 * two concurrent changes are decided one after the other.
 * Setting the status the sample already has is refused with 409 invalid_transition (the trigger
 * treats it as "not a transition", but a client asking for it has stale data).
 * `note` (optional, up to 1000 characters) is passed to the trigger through the transaction-local
 * setting app.status_note and stored on the history row; no note stores NULL.
 */
export async function changeSampleStatus(sampleId, { new_status: newStatus, note }, user) {
  const projectId = await projectIdOfSample(sampleId);
  if (projectId === null) throw sampleNotFound();
  await assertProjectAccess(user, projectId, { write: true, notFound: sampleNotFound });

  return withTransaction(
    async (client) => {
      const current = await queryOne(
        'SELECT status FROM samples WHERE sample_id = $1 FOR UPDATE',
        [sampleId],
        client,
      );
      if (!current) throw sampleNotFound();
      if (current.status === newStatus) {
        throw new AppError(409, 'invalid_transition', `Sample is already ${newStatus}`);
      }
      await query("SELECT set_config('app.status_note', $1, true)", [note ?? ''], client);
      await query(
        'UPDATE samples SET status = $2 WHERE sample_id = $1',
        [sampleId, newStatus],
        client,
      );
      return readSample(sampleId, client);
    },
    { actorId: user.user_id },
  );
}
