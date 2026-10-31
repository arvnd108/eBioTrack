// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: projects and members
//
// Decisions (flagged in the T20 PR):
//  - The caller of POST /api/projects becomes the owner (create_project_with_owner); no owner_id
//    is accepted from the client.
//  - `owner` can never be assigned or removed through the member routes (one owner, set at creation).
//  - A manager may remove themselves; the owner may not be removed by anyone.
//  - Status changes: any valid project_status is accepted (CONTRACT defines the values but no
//    transition table); flagged as an open question.
//  - Removing a site that collection events already use in this project is refused with 409
//    `conflict` before the composite foreign key can; the constraint stays the backstop.
//  - Unknown project and non-member project give the identical 404 body (see authorize.js); for an
//    administrator, who is not looked up in the middleware, the service answers the same body.
// Dates are formatted in SQL (YYYY-MM-DD) so no time-zone conversion can shift them.
import { callProcedure, query, queryOne, withTransaction } from '../db/query.js';
import { AppError, conflict, unprocessable } from '../middleware/errorHandler.js';

const PROJECT_COLUMNS = `
  p.project_id, p.title, p.objectives,
  to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(p.end_date, 'YYYY-MM-DD')   AS end_date,
  p.status, p.created_by`;

// Same body as the middleware's project 404, so the two cannot be told apart.
const projectNotFound = () => new AppError(404, 'not_found', 'Project not found');

const ruleViolation = (message, field) =>
  unprocessable(message, field ? [{ field, message }] : [], 'rule_violation');
const invalidReference = (message, field) =>
  unprocessable(message, [{ field, message }], 'invalid_reference');

// "Sort" keys map to fixed SQL; client text never reaches the query string.
const SORT_COLUMNS = {
  project_id: 'p.project_id',
  title: 'p.title',
  status: 'p.status',
  start_date: 'p.start_date',
};

/** One project as the `Project` shape, with the caller's own project role. Null if missing. */
async function readProject(projectId, userId, executor) {
  return queryOne(
    `SELECT ${PROJECT_COLUMNS},
            (SELECT pm.project_role FROM project_members pm
              WHERE pm.project_id = p.project_id AND pm.user_id = $2) AS your_role
       FROM projects p WHERE p.project_id = $1`,
    [projectId, userId],
    executor,
  );
}

/** Lock the project row for the rest of the transaction; 404 if it does not exist. */
async function lockProject(projectId, executor) {
  const row = await queryOne(
    'SELECT project_id FROM projects WHERE project_id = $1 FOR UPDATE',
    [projectId],
    executor,
  );
  if (!row) throw projectNotFound();
}

const MEMBER_SELECT = `
  SELECT pm.project_id, pm.user_id, u.full_name, u.email, pm.project_role, pm.joined_at
    FROM project_members pm JOIN users u ON u.user_id = pm.user_id`;

export async function listProjects(user, { status }, { limit, offset, sort }) {
  // v_user_project_access: administrators see every project, everyone else only memberships.
  const filter = `
    FROM v_user_project_access v JOIN projects p ON p.project_id = v.project_id
   WHERE v.user_id = $1 AND ($2::project_status IS NULL OR p.status = $2::project_status)`;
  const params = [user.user_id, status ?? null];

  const orderColumn = SORT_COLUMNS[sort?.field] ?? 'p.project_id';
  const direction = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  const rows = await query(
    `SELECT ${PROJECT_COLUMNS}, v.project_role AS your_role ${filter}
      ORDER BY ${orderColumn} ${direction}, p.project_id LIMIT $3 OFFSET $4`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(`SELECT count(*) AS total ${filter}`, params);
  return { rows, total };
}

export async function createProject({ title, objectives, start_date: startDate }, user) {
  return withTransaction(
    async (client) => {
      // Blank/duplicate title and owner rules come back as 23514 / 23505 / EB002 / 23503.
      const [{ create_project_with_owner: projectId }] = await callProcedure(
        'create_project_with_owner',
        [title, objectives ?? null, startDate ?? null, user.user_id],
        client,
      );
      return readProject(projectId, user.user_id, client);
    },
    { actorId: user.user_id },
  );
}

export async function getProject(projectId, user) {
  const project = await readProject(projectId, user.user_id);
  if (!project) throw projectNotFound();
  const members = await query(
    `${MEMBER_SELECT} WHERE pm.project_id = $1
      ORDER BY CASE pm.project_role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2
                                    WHEN 'contributor' THEN 3 ELSE 4 END, u.full_name, pm.user_id`,
    [projectId],
  );
  const sites = await query(
    `SELECT s.site_id, s.region_id, s.name, s.latitude::float8 AS latitude,
            s.longitude::float8 AS longitude, s.habitat_type, s.description
       FROM project_sites ps JOIN sampling_sites s ON s.site_id = ps.site_id
      WHERE ps.project_id = $1 ORDER BY s.site_id`,
    [projectId],
  );
  return { ...project, members, sites };
}

export async function updateProject(projectId, body, user) {
  const has = (key) => body[key] !== undefined;
  return withTransaction(
    async (client) => {
      await lockProject(projectId, client);
      const current = await readProject(projectId, user.user_id, client);

      // Friendly pre-check; ck_projects_dates stays the authority.
      if (has('end_date') && body.end_date !== null && current.start_date !== null) {
        if (body.end_date < current.start_date) {
          throw unprocessable('end_date must not be before start_date', [
            { field: 'end_date', message: `must be on or after ${current.start_date}` },
          ]);
        }
      }
      // Duplicate titles are resolved by uq_projects_title (409), not by a check here.
      await query(
        `UPDATE projects
            SET title      = CASE WHEN $2::boolean THEN $3::text ELSE title END,
                objectives = CASE WHEN $4::boolean THEN $5::text ELSE objectives END,
                status     = CASE WHEN $6::boolean THEN $7::project_status ELSE status END,
                end_date   = CASE WHEN $8::boolean THEN $9::date ELSE end_date END
          WHERE project_id = $1`,
        [
          projectId,
          has('title'),
          body.title ?? null,
          has('objectives'),
          body.objectives ?? null,
          has('status'),
          body.status ?? null,
          has('end_date'),
          body.end_date ?? null,
        ],
        client,
      );
      return readProject(projectId, user.user_id, client);
    },
    { actorId: user.user_id },
  );
}

export async function addMember(projectId, { user_id: memberId, project_role: role }, actor) {
  if (role === 'owner') {
    throw ruleViolation(
      'A project has one owner, set when it is created; owner cannot be assigned here',
      'project_role',
    );
  }
  return withTransaction(
    async (client) => {
      await lockProject(projectId, client);
      const member = await queryOne(
        'SELECT active FROM users WHERE user_id = $1',
        [memberId],
        client,
      );
      if (!member) throw invalidReference(`User ${memberId} does not exist`, 'user_id');
      if (!member.active) throw ruleViolation(`User ${memberId} is deactivated`, 'user_id');
      // pk_project_members decides duplicates (409), no check-then-insert.
      await query(
        'INSERT INTO project_members (project_id, user_id, project_role) VALUES ($1, $2, $3)',
        [projectId, memberId, role],
        client,
      );
      return queryOne(
        `${MEMBER_SELECT} WHERE pm.project_id = $1 AND pm.user_id = $2`,
        [projectId, memberId],
        client,
      );
    },
    { actorId: actor.user_id },
  );
}

export async function removeMember(projectId, memberId, actor) {
  await withTransaction(
    async (client) => {
      await lockProject(projectId, client);
      const member = await queryOne(
        'SELECT project_role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, memberId],
        client,
      );
      if (!member) throw new AppError(404, 'not_found', 'Membership not found');
      if (member.project_role === 'owner') {
        throw ruleViolation('The project owner cannot be removed', 'user_id');
      }
      await query(
        'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, memberId],
        client,
      );
    },
    { actorId: actor.user_id },
  );
}

export async function addSite(projectId, { site_id: siteId }, actor) {
  return withTransaction(
    async (client) => {
      await lockProject(projectId, client);
      const site = await queryOne(
        'SELECT 1 AS found FROM sampling_sites WHERE site_id = $1',
        [siteId],
        client,
      );
      if (!site) throw invalidReference(`Site ${siteId} does not exist`, 'site_id');
      // pk_project_sites decides duplicates (409).
      await query(
        'INSERT INTO project_sites (project_id, site_id) VALUES ($1, $2)',
        [projectId, siteId],
        client,
      );
      return { project_id: projectId, site_id: siteId };
    },
    { actorId: actor.user_id },
  );
}

export async function removeSite(projectId, siteId, actor) {
  await withTransaction(
    async (client) => {
      await lockProject(projectId, client);
      const link = await queryOne(
        'SELECT 1 AS found FROM project_sites WHERE project_id = $1 AND site_id = $2',
        [projectId, siteId],
        client,
      );
      if (!link) throw new AppError(404, 'not_found', 'Site is not linked to this project');
      const used = await queryOne(
        'SELECT 1 AS found FROM collection_events WHERE project_id = $1 AND site_id = $2 LIMIT 1',
        [projectId, siteId],
        client,
      );
      if (used) throw conflict('Site has collection events in this project and cannot be removed');
      await query(
        'DELETE FROM project_sites WHERE project_id = $1 AND site_id = $2',
        [projectId, siteId],
        client,
      );
    },
    { actorId: actor.user_id },
  );
}
