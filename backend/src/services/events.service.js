// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: collection events and measurements
//
// POST /api/events is one transaction in the order of database/transactions/field_transaction.sql:
// event, then measurements, then register_sample() once per sample (each call locks the event row
// and numbers the codes). Any failure rolls everything back, audit and history rows included.
import { callProcedure, query, queryOne, withTransaction } from '../db/query.js';
import { AppError, unprocessable } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import { assertProjectAccess, projectIdOfEvent } from './projectAccess.js';
import { SAMPLE_COLUMNS } from './samples.service.js';

const EVENT_COLUMNS = `
  e.event_id, e.project_id, e.site_id, e.collector_id,
  (SELECT u.full_name FROM users u WHERE u.user_id = e.collector_id) AS collector_name,
  e.collected_at, e.notes, e.created_at`;

const eventNotFound = () => new AppError(404, 'not_found', 'Event not found');

const SORT_COLUMNS = { event_id: 'e.event_id', collected_at: 'e.collected_at' };

/**
 * Newest first by default (collected_at DESC, event_id DESC). `from` and `to` are inclusive bounds
 * on collected_at. Rows are limited to the caller's projects; an explicit project_id the caller
 * cannot access is a 404, not an empty list.
 */
export async function listEvents(user, filters, { limit, offset, sort }) {
  if (filters.project_id !== undefined) await assertProjectAccess(user, filters.project_id);
  const visible = await accessibleProjectIds(user);
  const order = sort
    ? `${SORT_COLUMNS[sort.field]} ${sort.direction === 'DESC' ? 'DESC' : 'ASC'}, e.event_id ${
        sort.direction === 'DESC' ? 'DESC' : 'ASC'
      }`
    : 'e.collected_at DESC, e.event_id DESC';
  const from = `
    FROM collection_events e
    WHERE ($1::bigint[] IS NULL OR e.project_id = ANY($1::bigint[]))
      AND ($2::bigint IS NULL OR e.project_id = $2::bigint)
      AND ($3::bigint IS NULL OR e.site_id = $3::bigint)
      AND ($4::timestamptz IS NULL OR e.collected_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR e.collected_at <= $5::timestamptz)`;
  const params = [
    visible,
    filters.project_id ?? null,
    filters.site_id ?? null,
    filters.from ?? null,
    filters.to ?? null,
  ];
  const rows = await query(`SELECT ${EVENT_COLUMNS} ${from} ORDER BY ${order} LIMIT $6 OFFSET $7`, [
    ...params,
    limit,
    offset,
  ]);
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

/** Event fields plus samples and measurements (ordered by id). */
async function readEventDetail(eventId, executor) {
  const event = await queryOne(
    `SELECT ${EVENT_COLUMNS} FROM collection_events e WHERE e.event_id = $1`,
    [eventId],
    executor,
  );
  if (!event) return null;
  const samples = await query(
    `SELECT ${SAMPLE_COLUMNS} FROM samples s WHERE s.event_id = $1 ORDER BY s.sample_id`,
    [eventId],
    executor,
  );
  const measurements = await query(
    `SELECT measurement_id, event_id, parameter, value::float8 AS value, unit
       FROM environmental_measurements WHERE event_id = $1 ORDER BY measurement_id`,
    [eventId],
    executor,
  );
  return { ...event, samples, measurements };
}

export async function getEvent(eventId, user) {
  const projectId = await projectIdOfEvent(eventId);
  if (projectId === null) throw eventNotFound();
  await assertProjectAccess(user, projectId, { notFound: eventNotFound });
  const detail = await readEventDetail(eventId);
  if (!detail) throw eventNotFound();
  return detail;
}

/** The collector is the session user. The (project, site) pair must be attached (422 otherwise). */
export async function createEvent(body, user) {
  return withTransaction(
    async (client) => {
      const link = await queryOne(
        `SELECT EXISTS (SELECT 1 FROM projects WHERE project_id = $1) AS project_exists,
                EXISTS (SELECT 1 FROM project_sites WHERE project_id = $1 AND site_id = $2) AS attached`,
        [body.project_id, body.site_id],
        client,
      );
      if (!link.project_exists) {
        throw unprocessable(
          'Project does not exist',
          [{ field: 'project_id', message: 'does not exist' }],
          'invalid_reference',
        );
      }
      if (!link.attached) {
        throw unprocessable(
          'Site is not attached to this project',
          [{ field: 'site_id', message: 'is not attached to this project' }],
          'invalid_reference',
        );
      }

      const { event_id: eventId } = await queryOne(
        `INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING event_id`,
        [body.project_id, body.site_id, user.user_id, body.collected_at, body.notes ?? null],
        client,
      );
      for (const m of body.measurements ?? []) {
        await query(
          `INSERT INTO environmental_measurements (event_id, parameter, value, unit)
           VALUES ($1, $2, $3, $4)`,
          [eventId, m.parameter, m.value, m.unit],
          client,
        );
      }
      for (const s of body.samples ?? []) {
        await callProcedure(
          'register_sample',
          [
            eventId,
            s.sample_type_id,
            s.volume_ml ?? null,
            s.depth_m ?? null,
            s.storage_location ?? null,
            user.user_id,
          ],
          client,
        );
      }
      return readEventDetail(eventId, client);
    },
    { actorId: user.user_id },
  );
}
