// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: authorized audit history
//
// Who sees what (CONTRACT 9: administrator everything, principal_investigator "own", nobody else):
//  - administrator: every entry.
//  - principal_investigator: audit_logs has no project column, so the project of an entry is
//    derived from the entity it is about. The PI sees entries whose entity belongs to a project the
//    PI is a member of, resolved for these entity types:
//      projects, project_members, project_sites  entity_id = the project
//      collection_events                         via collection_events.project_id
//      samples                                   via the sample's event
//    Everything else is administrator-only: entities that belong to no project (users, user_roles,
//    roles, sampling_sites, taxa, ...) and the lab/analysis entities, which would need a longer
//    chain (library -> extraction -> sample -> event -> project) and are NOT covered in this
//    version. Decision for review.
//  - every other role: no access (the route gate answers 403; recentActivity returns []).
// The scope is one fixed parameterized CTE joined to audit_logs on (entity_type, entity_id), so the
// existing index idx_audit_logs_entity_type_entity_id_created_at serves the join. No dynamic SQL.
import { query } from '../db/query.js';
import { ROLES } from '../middleware/permissions.js';

const AUDIT_COLUMNS =
  'a.audit_id, a.actor_id, a.entity_type, a.entity_id, a.action, a.details, a.created_at';

// $1 = the PI's user_id. Rows are (entity_type, entity_id) pairs the PI may see.
const PI_SCOPE = `
  my_projects AS (SELECT project_id FROM project_members WHERE user_id = $1),
  scope AS (
    SELECT t.entity_type, mp.project_id AS entity_id
      FROM my_projects mp CROSS JOIN (VALUES ('projects'), ('project_members'), ('project_sites')) AS t(entity_type)
    UNION
    SELECT 'collection_events', e.event_id
      FROM collection_events e JOIN my_projects mp ON mp.project_id = e.project_id
    UNION
    SELECT 'samples', s.sample_id
      FROM samples s JOIN collection_events e ON e.event_id = s.event_id
      JOIN my_projects mp ON mp.project_id = e.project_id
  )`;

const isAdmin = (user) => user.roles.includes(ROLES.ADMINISTRATOR);
const isPi = (user) => user.roles.includes(ROLES.PRINCIPAL_INVESTIGATOR);

/** Can this user read the audit log at all? */
export const canReadAudit = (user) => isAdmin(user) || isPi(user);

// Filters shared by the list and the count. $2..$6 are entity_type, entity_id, actor_id, from, to.
// `$1::bigint IS NOT NULL` is always true; it only gives $1 a type on the administrator path,
// where the scope CTE (the other user of $1) is absent.
const FILTERS = `
  $1::bigint IS NOT NULL
  AND ($2::text IS NULL OR a.entity_type = $2::text)
  AND ($3::bigint IS NULL OR a.entity_id = $3::bigint)
  AND ($4::bigint IS NULL OR a.actor_id = $4::bigint)
  AND ($5::timestamptz IS NULL OR a.created_at >= $5::timestamptz)
  AND ($6::timestamptz IS NULL OR a.created_at <= $6::timestamptz)`;

function fromClause(user) {
  return isAdmin(user)
    ? { with: '', join: '' }
    : {
        with: `WITH ${PI_SCOPE}`,
        join: 'JOIN scope sc ON sc.entity_type = a.entity_type AND sc.entity_id = a.entity_id',
      };
}

/**
 * Newest first (created_at DESC, audit_id DESC). Callers must have passed the route gate; a role
 * that cannot read the audit log gets an empty page here as a second line of defence.
 */
export async function listAudit(user, filters, { limit, offset }) {
  if (!canReadAudit(user)) return { rows: [], total: 0 };
  const { with: withClause, join } = fromClause(user);
  const params = [
    user.user_id,
    filters.entity_type ?? null,
    filters.entity_id ?? null,
    filters.actor_id ?? null,
    filters.from ?? null,
    filters.to ?? null,
  ];
  const rows = await query(
    `${withClause}
     SELECT ${AUDIT_COLUMNS} FROM audit_logs a ${join}
      WHERE ${FILTERS}
      ORDER BY a.created_at DESC, a.audit_id DESC LIMIT $7 OFFSET $8`,
    [...params, limit, offset],
  );
  const [{ total }] = await query(
    `${withClause} SELECT count(*) AS total FROM audit_logs a ${join} WHERE ${FILTERS}`,
    params,
  );
  return { rows, total };
}

/**
 * The newest audit entries the user may see, for the dashboard (T23). Same item shape as
 * GET /api/audit; an empty array for roles that cannot read the audit log.
 * @param {{ user_id: number, roles: string[] }} user
 * @param {{ limit?: number }} [options]
 */
export async function recentActivity(user, { limit = 5 } = {}) {
  if (!canReadAudit(user)) return [];
  const { rows } = await listAudit(user, {}, { limit, offset: 0 });
  return rows;
}
