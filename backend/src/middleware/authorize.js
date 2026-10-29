// Owner: A (Backend)
// Purpose: Role and project-level permission checks
//
// Use after `auth`. Three ways in, from most to least convenient:
//   router.post('/', auth, authorize('create_project'), ...)                       // matrix action
//   router.patch('/:id', auth, authorize('edit_project'), ...)                     // project from :id
//   router.post('/', auth, authorize('create_event_sample', { source: 'body.project_id' }), ...)
//   router.get('/', auth, requireRole('analyst', 'principal_investigator'), ...)   // ad hoc role gate
//   router.get('/:id', auth, requireProjectAccess({ projectRoles: ['owner'] }), ...)
//
// Rules (CONTRACT sections 8 and 9):
//  - administrator passes every check, project-scoped ones included;
//  - a missing role is 403 `forbidden`;
//  - a project the user is not a member of, or that does not exist, is 404 `not_found` with the
//    same body, so existence is not leaked;
//  - a project role of `viewer` is read-only: 403 on any non-GET/HEAD/OPTIONS request;
//  - `projectRoles` (for example owner/manager) not held is 403;
//  - anything unexpected denies: a lookup error goes to the error handler and never to next().
import { query } from '../db/query.js';
import { AppError } from './errorHandler.js';
import { PERMISSIONS, ROLES } from './permissions.js';

const KNOWN_ROLES = new Set(Object.values(ROLES));
const PROJECT_ROLES = new Set(['owner', 'manager', 'contributor', 'viewer']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const unauthenticated = () => new AppError(401, 'unauthenticated', 'Authentication required');
const forbidden = () => new AppError(403, 'forbidden', 'You do not have permission to do this');
const projectNotFound = () => new AppError(404, 'not_found', 'Project not found');

const isAdmin = (user) => user.roles.includes(ROLES.ADMINISTRATOR);

/**
 * Global role gate: the user must hold ANY of the listed roles (administrator always passes).
 * An unknown role name is a programming error and throws when the route is defined.
 * @param {...string} roleNames
 */
export function requireRole(...roleNames) {
  const unknown = roleNames.filter((name) => !KNOWN_ROLES.has(name));
  if (unknown.length > 0) throw new Error(`requireRole: unknown role(s) ${unknown.join(', ')}`);

  return (req, _res, next) => {
    const user = req.user;
    if (!user?.roles) return next(unauthenticated());
    if (isAdmin(user) || roleNames.some((name) => user.roles.includes(name))) return next();
    return next(forbidden());
  };
}

/** Read `params.id`, `body.project_id` and so on from the request, or undefined. */
function resolveProjectId(req, source) {
  const [bucket, name] = source.split('.');
  const raw = req[bucket]?.[name];
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Project-level check. On success sets `req.projectId` and `req.projectRole` (null for an
 * administrator, who is not looked up).
 * @param {{ source?: string, projectRoles?: string[] }} [options]
 *   source: where the project id lives, as `params.id` (default), `params.projectId`,
 *   `body.project_id` or `query.project_id`. Explicit on purpose, never guessed.
 *   projectRoles: project roles allowed; omit for any member (viewers still read-only).
 */
export function requireProjectAccess({ source = 'params.id', projectRoles } = {}) {
  if (!/^(params|body|query)\.\w+$/.test(source)) {
    throw new Error(`requireProjectAccess: bad source "${source}"`);
  }
  const badRole = (projectRoles ?? []).find((role) => !PROJECT_ROLES.has(role));
  if (badRole) throw new Error(`requireProjectAccess: unknown project role "${badRole}"`);

  return async (req, _res, next) => {
    try {
      const user = req.user;
      if (!user?.roles) throw unauthenticated();

      const projectId = resolveProjectId(req, source);
      if (isAdmin(user)) {
        req.projectId = projectId;
        req.projectRole = null;
        return next();
      }
      if (projectId === undefined) throw projectNotFound();

      const rows = await query(
        `SELECT pm.project_role
           FROM projects p
           JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = $2
          WHERE p.project_id = $1`,
        [projectId, user.user_id],
      );
      if (rows.length === 0) throw projectNotFound();

      const projectRole = rows[0].project_role;
      if (projectRole === 'viewer' && !READ_METHODS.has(req.method)) throw forbidden();
      if (projectRoles && !projectRoles.includes(projectRole)) throw forbidden();

      req.projectId = projectId;
      req.projectRole = projectRole;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Enforce one row of the permission matrix by name: global role gate, then the project check when
 * the action is project-scoped.
 * @param {keyof typeof PERMISSIONS} action
 * @param {{ source?: string }} [options] where the project id lives (see requireProjectAccess)
 */
export function authorize(action, { source } = {}) {
  const rule = PERMISSIONS[action];
  if (!rule) throw new Error(`authorize: unknown action "${action}"`);

  const gates = [requireRole(...rule.roles)];
  if (rule.project) {
    gates.push(requireProjectAccess({ source, projectRoles: rule.projectRoles }));
  }
  return (req, res, next) => {
    let index = 0;
    const step = (err) => {
      if (err) return next(err);
      const gate = gates[index++];
      return gate ? gate(req, res, step) : next();
    };
    step();
  };
}

/**
 * For list endpoints. Returns the ids of projects the user may access, or null for an
 * administrator (no filter). Use as `WHERE project_id = ANY($n)` and skip the filter on null.
 * @param {{ user_id: number, roles: string[] }} user
 * @returns {Promise<number[] | null>}
 */
export async function accessibleProjectIds(user) {
  if (isAdmin(user)) return null;
  const rows = await query('SELECT project_id FROM project_members WHERE user_id = $1', [
    user.user_id,
  ]);
  return rows.map((row) => row.project_id);
}
