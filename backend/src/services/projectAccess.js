// Owner: A (Backend)
// Purpose: Project access checks for routes whose project id is not in the request
//
// /events/:id, /samples/:id and POST /samples carry no project id, so the service resolves it from
// the row and checks it here, once, for every field route (T22 reuses it for lab rows).
//   - administrator: always allowed;
//   - everyone else must be a member of the project, otherwise the caller gets the SAME 404 as for
//     an unknown object (`notFound()`), so existence is not leaked;
//   - a project role of `viewer` is read-only: 403 when `write` is true.
// With `action` (a key of PERMISSIONS) the caller must also be allowed that action here: by a global
// role, or by their role in THIS project (owner/manager/contributor can write, see permissions.js).
// The route's `requireAction` is only the cheap first gate; this is the per-project decision.
import { query, queryOne } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  PERMISSIONS,
  ROLES,
  globalRoleAllows,
  projectRoleAllows,
} from '../middleware/permissions.js';

const forbiddenError = () =>
  new AppError(403, 'forbidden', 'You do not have permission to do this');

export const projectNotFound = () => new AppError(404, 'not_found', 'Project not found');

const isAdmin = (user) => user.roles.includes(ROLES.ADMINISTRATOR);

/**
 * Throws unless `user` may read (or, with `write`, change) data of `projectId`.
 * @param {{ user_id: number, roles: string[] }} user
 * @param {number} projectId
 * @param {{ write?: boolean, notFound?: () => Error }} [options]
 *   notFound builds the 404 for a project the user cannot see (default: "Project not found").
 */
export async function assertProjectAccess(
  user,
  projectId,
  { write = false, action, notFound = projectNotFound } = {},
) {
  if (action && !PERMISSIONS[action])
    throw new Error(`assertProjectAccess: unknown action ${action}`);
  if (isAdmin(user)) {
    // An explicit unknown project is still a 404 for the administrator (lists, filters).
    if (!(await queryOne('SELECT 1 AS ok FROM projects WHERE project_id = $1', [projectId]))) {
      throw notFound();
    }
    return;
  }
  const member = await queryOne(
    'SELECT project_role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, user.user_id],
  );
  if (!member) throw notFound();
  const mustWrite = write || (action && !PERMISSIONS[action].read);
  if (mustWrite && member.project_role === 'viewer') throw forbiddenError();
  if (
    action &&
    !globalRoleAllows(user, action) &&
    !projectRoleAllows(action, member.project_role)
  ) {
    throw forbiddenError();
  }
}

/** The user's project roles in these projects (empty when a member of none). */
export async function projectRolesIn(user, projectIds, executor) {
  if (projectIds.length === 0) return [];
  const rows = await query(
    'SELECT project_role FROM project_members WHERE user_id = $1 AND project_id = ANY($2::bigint[])',
    [user.user_id, projectIds],
    executor,
  );
  return rows.map((row) => row.project_role);
}

/** The project of an event, or null when the event does not exist. */
export async function projectIdOfEvent(eventId, executor) {
  const row = await queryOne(
    'SELECT project_id FROM collection_events WHERE event_id = $1',
    [eventId],
    executor,
  );
  return row ? row.project_id : null;
}

/** The project of a sample (through its event), or null when the sample does not exist. */
export async function projectIdOfSample(sampleId, executor) {
  const row = await queryOne(
    `SELECT e.project_id FROM samples s JOIN collection_events e ON e.event_id = s.event_id
      WHERE s.sample_id = $1`,
    [sampleId],
    executor,
  );
  return row ? row.project_id : null;
}

/** The project of an extraction (through its sample and event), or null when it does not exist. */
export async function projectIdOfExtraction(extractionId, executor) {
  const row = await queryOne(
    `SELECT e.project_id FROM dna_extractions x
       JOIN samples s ON s.sample_id = x.sample_id
       JOIN collection_events e ON e.event_id = s.event_id
      WHERE x.extraction_id = $1`,
    [extractionId],
    executor,
  );
  return row ? row.project_id : null;
}

/**
 * The projects a run touches (the projects of its libraries' samples). Null when the run does not
 * exist; an empty array for a run without libraries.
 */
export async function projectIdsOfRun(runId, executor) {
  const run = await queryOne(
    'SELECT 1 AS ok FROM sequencing_runs WHERE run_id = $1',
    [runId],
    executor,
  );
  if (!run) return null;
  const rows = await query(
    `SELECT DISTINCT e.project_id
       FROM sequencing_libraries l
       JOIN dna_extractions x ON x.extraction_id = l.extraction_id
       JOIN samples s ON s.sample_id = x.sample_id
       JOIN collection_events e ON e.event_id = s.event_id
      WHERE l.run_id = $1`,
    [runId],
    executor,
  );
  return rows.map((row) => row.project_id);
}

/** The projects of an analysis (those of its run). Null when the analysis does not exist. */
export async function projectIdsOfAnalysis(analysisId, executor) {
  const analysis = await queryOne(
    'SELECT run_id FROM analysis_runs WHERE analysis_id = $1',
    [analysisId],
    executor,
  );
  return analysis ? projectIdsOfRun(analysis.run_id, executor) : null;
}

/**
 * Like assertProjectAccess for an object that spans several projects (a run, an analysis): the
 * caller needs access to AT LEAST ONE of them. For a write, at least one project where the caller
 * is not a `viewer`. The administrator always passes; `notFound` is thrown when none is visible.
 * @param {{ user_id: number, roles: string[] }} user
 * @param {number[]} projectIds
 */
export async function assertAnyProjectAccess(
  user,
  projectIds,
  { write = false, action, notFound = projectNotFound } = {},
) {
  if (isAdmin(user)) return;
  const rows =
    projectIds.length === 0
      ? []
      : await query(
          'SELECT project_role FROM project_members WHERE user_id = $1 AND project_id = ANY($2::bigint[])',
          [user.user_id, projectIds],
        );
  if (rows.length === 0) throw notFound();
  const mustWrite = write || (action && !PERMISSIONS[action].read);
  if (mustWrite && rows.every((row) => row.project_role === 'viewer')) throw forbiddenError();
  if (action && !globalRoleAllows(user, action)) {
    // At least one of the projects must give a role that allows the action.
    if (!rows.some((row) => projectRoleAllows(action, row.project_role))) throw forbiddenError();
  }
}
