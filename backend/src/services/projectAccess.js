// Owner: A (Backend)
// Purpose: Project access checks for routes whose project id is not in the request
//
// /events/:id, /samples/:id and POST /samples carry no project id, so the service resolves it from
// the row and checks it here, once, for every field route (T22 reuses it for lab rows).
//   - administrator: always allowed;
//   - everyone else must be a member of the project, otherwise the caller gets the SAME 404 as for
//     an unknown object (`notFound()`), so existence is not leaked;
//   - a project role of `viewer` is read-only: 403 when `write` is true.
// The global role gate (which roles may write at all) stays on the route (`requireRole`).
import { queryOne } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { ROLES } from '../middleware/permissions.js';

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
  { write = false, notFound = projectNotFound } = {},
) {
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
  if (write && member.project_role === 'viewer') {
    throw new AppError(403, 'forbidden', 'You do not have permission to do this');
  }
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
