// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: sequencing libraries and runs
//
// Booking, QC-pass and run-status rules live in the database (create_sequencing_run,
// assign_extraction_to_run, the library and run triggers); this layer only checks project access,
// calls them and maps their errors (EB001 -> 409, EB002 -> 422, 23503 -> 422).
// A run has no project of its own: it is visible to a non-administrator when at least one of its
// libraries belongs to a sample in one of their projects (a run with no libraries is invisible to
// them), and its libraries are listed only for the projects they can see. Each library names its
// sample and project (CONTRACT 1.7), so the page can tell where the caller may write.
import { callProcedure, query, queryOne, withTransaction } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import {
  assertAnyProjectAccess,
  assertProjectAccess,
  projectIdOfExtraction,
  projectIdsOfRun,
} from './projectAccess.js';

const runNotFound = () => new AppError(404, 'not_found', 'Sequencing run not found');
const extractionNotFound = () => new AppError(404, 'not_found', 'Extraction not found');

const RUN_COLUMNS = `
  r.run_id, r.run_code, r.lab_id, r.platform, to_char(r.run_date, 'YYYY-MM-DD') AS run_date,
  r.status, r.created_at`;
const RUN_SORT = { run_id: 'r.run_id', created_at: 'r.created_at' };

const VISIBLE_LIBRARY = `
  EXISTS (SELECT 1 FROM dna_extractions x
            JOIN samples s ON s.sample_id = x.sample_id
            JOIN collection_events e ON e.event_id = s.event_id
           WHERE x.extraction_id = l.extraction_id AND e.project_id = ANY($2::bigint[]))`;

async function readRun(runId, visible, executor) {
  const run = await queryOne(
    `SELECT ${RUN_COLUMNS} FROM sequencing_runs r WHERE r.run_id = $1`,
    [runId],
    executor,
  );
  if (!run) return null;
  const libraries = await query(
    `SELECT l.library_id, l.library_code, l.extraction_id, l.run_id, l.created_at,
            x.sample_id, s.sample_code, ev.project_id
       FROM sequencing_libraries l
       JOIN dna_extractions x ON x.extraction_id = l.extraction_id
       JOIN samples s ON s.sample_id = x.sample_id
       JOIN collection_events ev ON ev.event_id = s.event_id
      WHERE l.run_id = $1 AND ($2::bigint[] IS NULL OR ${VISIBLE_LIBRARY})
      ORDER BY l.library_id`,
    [runId, visible],
    executor,
  );
  return { ...run, libraries };
}

async function readLibrary(libraryId, executor) {
  return queryOne(
    `SELECT library_id, library_code, extraction_id, run_id, created_at
       FROM sequencing_libraries WHERE library_id = $1`,
    [libraryId],
    executor,
  );
}

export async function listRuns(user, filters, { limit, offset, sort }) {
  const visible = await accessibleProjectIds(user);
  const column = RUN_SORT[sort?.field] ?? 'r.run_id';
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const from = `
    FROM sequencing_runs r
    WHERE ($1::bigint[] IS NULL OR EXISTS (
            SELECT 1 FROM sequencing_libraries l
              JOIN dna_extractions x ON x.extraction_id = l.extraction_id
              JOIN samples s ON s.sample_id = x.sample_id
              JOIN collection_events e ON e.event_id = s.event_id
             WHERE l.run_id = r.run_id AND e.project_id = ANY($1::bigint[])))
      AND ($2::bigint IS NULL OR r.lab_id = $2::bigint)
      AND ($3::run_status IS NULL OR r.status = $3::run_status)`;
  const params = [visible, filters.lab_id ?? null, filters.status ?? null];
  const rows = await query(
    `SELECT ${RUN_COLUMNS} ${from} ORDER BY ${column} ${direction}, r.run_id ${direction} LIMIT $4 OFFSET $5`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total ${from}`, params);
  return { rows, total };
}

export async function getRun(user, runId) {
  const projectIds = await projectIdsOfRun(runId);
  if (projectIds === null) throw runNotFound();
  await assertAnyProjectAccess(user, projectIds, { notFound: runNotFound });
  const visible = await accessibleProjectIds(user);
  return readRun(runId, visible, undefined);
}

/** Every extraction must sit in a project where the caller may write; the database does the rest. */
async function assertExtractionWritable(user, extractionId) {
  const projectId = await projectIdOfExtraction(extractionId);
  if (projectId === null) throw extractionNotFound();
  await assertProjectAccess(user, projectId, { write: true, notFound: extractionNotFound });
}

export async function createRun(body, user) {
  for (const extractionId of body.extraction_ids) {
    await assertExtractionWritable(user, extractionId);
  }
  const visible = await accessibleProjectIds(user);
  return withTransaction(
    async (client) => {
      const [{ create_sequencing_run: runId }] = await callProcedure(
        'create_sequencing_run',
        [body.lab_id, body.platform, body.run_date, body.extraction_ids, user.user_id],
        client,
      );
      return readRun(runId, visible, client);
    },
    { actorId: user.user_id },
  );
}

export async function addLibrary(runId, body, user) {
  const projectIds = await projectIdsOfRun(runId);
  if (projectIds === null) throw runNotFound();
  await assertExtractionWritable(user, body.extraction_id);
  // A run that has libraries only in other projects is not the caller's to extend (404 like a read);
  // a still-empty run is open to any writer who can book their own extraction.
  if (projectIds.length > 0) {
    await assertAnyProjectAccess(user, projectIds, { write: true, notFound: runNotFound });
  }
  return withTransaction(
    async (client) => {
      const [{ assign_extraction_to_run: libraryId }] = await callProcedure(
        'assign_extraction_to_run',
        [runId, body.extraction_id, user.user_id],
        client,
      );
      return readLibrary(libraryId, client);
    },
    { actorId: user.user_id },
  );
}

/**
 * Move a run's status. The trigger owns the transition table (planned -> running | failed,
 * running -> completed | failed); the row is locked first so concurrent requests serialize, and a
 * request for the status it already has is a 409 rather than a silent no-op.
 */
export async function updateRunStatus(runId, body, user) {
  const projectIds = await projectIdsOfRun(runId);
  if (projectIds === null) throw runNotFound();
  await assertAnyProjectAccess(user, projectIds, { write: true, notFound: runNotFound });
  return withTransaction(
    async (client) => {
      const run = await queryOne(
        'SELECT status FROM sequencing_runs WHERE run_id = $1 FOR UPDATE',
        [runId],
        client,
      );
      if (!run) throw runNotFound();
      if (run.status === body.status) {
        throw new AppError(409, 'invalid_transition', `Run is already ${run.status}`);
      }
      await query(
        'UPDATE sequencing_runs SET status = $2::run_status WHERE run_id = $1',
        [runId, body.status],
        client,
      );
      return queryOne(
        `SELECT ${RUN_COLUMNS} FROM sequencing_runs r WHERE r.run_id = $1`,
        [runId],
        client,
      );
    },
    { actorId: user.user_id },
  );
}
