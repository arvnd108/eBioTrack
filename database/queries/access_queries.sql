-- Owner: C (Testing & QA)
-- Purpose: 3 complex queries: Access, Projects & Audit
--
-- T14-C. Each query is a prepared statement: the SQL between AS and the semicolon is exactly what
-- the backend sends through `pg` with $1, $2 placeholders (D9), and the EXECUTE line under it runs
-- the documented example. Run the whole file with:
--
--   psql "$DATABASE_URL" -f database/queries/access_queries.sql
--
-- Pass NULL for an optional filter to mean "no filter". All three are read-only SELECTs. Expected
-- results are for the seeded fixture world (seeds 010 to 040) and were worked out by hand from
-- 010_seed_access.sql, then confirmed by running this file. No indexes are assumed or created:
-- these statements are the unindexed baselines for T19.

DEALLOCATE ALL;  -- lets the file run more than once in the same session

-- ============================================================================================
-- Q1. Projects a user can access, via global role and membership
-- ============================================================================================
-- Statement: access_user_projects
-- Question: which projects can this user see, how do they have access, and what can they do?
-- Parameters: $1 user_id (bigint, required, example 3)
--             $2 project status (project_status, NULL = any status)
-- Columns: project_id, title, status, start_date, end_date, access_via, project_role, can_edit,
--          owner_name, member_count, site_count
-- Serves: GET /api/projects (T20); this is the parameterised form of v_user_project_access (T15).
-- DBMS concepts: CTE (the user's effective access), EXISTS over user_roles JOIN roles for the
--          global-administrator test, multi-join, LEFT JOIN, correlated subqueries (owner,
--          member_count, site_count), aggregation (count).
--
-- Rules (CONTRACT 9, backend/src/middleware/authorize.js):
--   * A user holding the global role 'administrator' can access EVERY project, member or not.
--     access_via = 'administrator'; project_role is their membership role if they also have one,
--     else NULL.
--   * Everyone else needs a project_members row. access_via = 'membership'.
--   * An administrator who is also a member appears ONCE, with access_via = 'administrator'
--     (the stronger grant wins) and their real project_role.
--   * can_edit (edit project settings, manage members) is true for administrators and the project
--     roles owner/manager; false for contributor (edits project CONTENT, not settings) and viewer
--     (read-only).
--   * An unknown user or one with users.active = false gets ZERO rows. Deliberate safe-by-default
--     choice because this query is the access gate. NOTE FOR ARVIND: authorize.js does not check
--     users.active itself (login does), so an already-open session of a deactivated user still
--     passes the middleware; this query is stricter.
--   * The role test matches role_name = 'administrator', never a hard-coded role_id.
--   * T19 baseline: for a non-administrator the join to project_members filters on
--     project_members.user_id, so an index on (user_id, project_id) has a visible effect.
--
-- Expected for the seed (projects 1 Yamuna Biodiversity Survey and 2 Coastal Estuary Pilot, both
-- active, owner Pranav Investigator; project 1 has 5 members and 3 sites, project 2 has 2 and 2):
--   user 1 (administrator, no membership): projects 1 and 2, administrator, project_role NULL, can_edit t
--   user 2 (owner of both):                projects 1 and 2, membership, owner, can_edit t
--   user 3 (contributor on both):          projects 1 and 2, membership, contributor, can_edit f
--   users 4 and 5 (contributors):          project 1 only, membership, contributor, can_edit f
--   user 6 (viewer):                       project 1 only, membership, viewer, can_edit f
--   user 3 with status 'completed':        zero rows;   user 999 (unknown):  zero rows
--   Every project row: member_count 5 / 2, site_count 3 / 2, owner_name Pranav Investigator.
--   Example below (user 3, any status):
--   project_id | title                      | status | start_date | end_date | access_via | project_role | can_edit | owner_name           | member_count | site_count
--   1          | Yamuna Biodiversity Survey | active | 2025-01-15 |          | membership | contributor  | f        | Pranav Investigator  | 5            | 3
--   2          | Coastal Estuary Pilot      | active | 2026-01-10 |          | membership | contributor  | f        | Pranav Investigator  | 2            | 2

PREPARE access_user_projects(bigint, project_status) AS
WITH me AS (
    -- The caller's effective access. Zero rows for an unknown or inactive user, which makes
    -- every later join empty.
    SELECT
        u.user_id,
        EXISTS (
            SELECT 1
            FROM user_roles ur
            JOIN roles r ON r.role_id = ur.role_id
            WHERE ur.user_id = u.user_id
              AND r.role_name = 'administrator'
        ) AS is_admin
    FROM users u
    WHERE u.user_id = $1::bigint
      AND u.active
)
SELECT
    p.project_id,
    p.title,
    p.status,
    p.start_date,
    p.end_date,
    CASE WHEN me.is_admin THEN 'administrator' ELSE 'membership' END AS access_via,
    pm.project_role,
    (me.is_admin OR pm.project_role IN ('owner', 'manager'))          AS can_edit,
    (
        SELECT ou.full_name
        FROM project_members o
        JOIN users ou ON ou.user_id = o.user_id
        WHERE o.project_id = p.project_id
          AND o.project_role = 'owner'
    )                                                                 AS owner_name,
    (
        SELECT COUNT(*)
        FROM project_members m
        WHERE m.project_id = p.project_id
    )                                                                 AS member_count,
    (
        SELECT COUNT(*)
        FROM project_sites ps
        WHERE ps.project_id = p.project_id
    )                                                                 AS site_count
FROM me
CROSS JOIN projects p
LEFT JOIN project_members pm
       ON pm.project_id = p.project_id
      AND pm.user_id = me.user_id
WHERE (me.is_admin OR pm.user_id IS NOT NULL)
  AND ($2::project_status IS NULL OR p.status = $2::project_status)
ORDER BY p.project_id;

EXECUTE access_user_projects(3, NULL);

-- ============================================================================================
-- Q2. Members per project
-- ============================================================================================
-- Statement: access_project_members
-- Question: for each project, who is on it, in which roles, and is its membership healthy?
-- Parameters: $1 project_id (bigint, NULL = all projects)
-- Columns: project_id, title, status, member_count, owner_count, manager_count,
--          contributor_count, viewer_count, owner_name, inactive_members, members
-- Serves: GET /api/projects/:id (members) (T20) and v_project_summary (T15).
-- DBMS concepts: LEFT JOIN (a project with no members still appears with zero counts and a NULL
--          owner), multi-join (projects, project_members, users), aggregation with FILTER,
--          string_agg with ORDER BY, a pre-aggregated derived table (the global roles) and a
--          correlated subquery (owner_name).
-- Notes:
--   * One row per project. Global roles are aggregated per user in the derived table `gr` BEFORE
--     joining, so a user with several global roles still counts as one member (joining
--     user_roles directly would multiply rows and inflate every count).
--   * members is a deterministic string, 'Full Name (project_role; global_role[/global_role])',
--     ordered owner, manager, contributor, viewer, then name, then user_id.
--   * inactive_members counts members whose users.active = false.
--   * Invariant: exactly one owner per project. At most one is guaranteed by the partial unique
--     index uq_project_members_owner; at least one by create_project_with_owner() (T16).
--     owner_count lets a test or an admin spot a violation (0 or, if the index is gone, 2+).
--   * The seed has no memberless project; verify with a scratch project inside a rolled-back
--     transaction (see the verification notes in the PR).
--
-- Expected (all projects), 2 rows:
--   project_id | title                      | status | member_count | owner_count | manager_count | contributor_count | viewer_count | owner_name           | inactive_members | members
--   1          | Yamuna Biodiversity Survey | active | 5            | 1           | 0             | 3                 | 1            | Pranav Investigator  | 0                | Pranav Investigator (owner; principal_investigator), Anil Analyst (contributor; analyst), Farah Field (contributor; field_researcher), Lakshmi Lab (contributor; lab_technician), Vikram Viewer (viewer; viewer)
--   2          | Coastal Estuary Pilot      | active | 2            | 1           | 0             | 1                 | 0            | Pranav Investigator  | 0                | Pranav Investigator (owner; principal_investigator), Farah Field (contributor; field_researcher)
--   With $1 = 1: only the first row.

PREPARE access_project_members(bigint) AS
SELECT
    p.project_id,
    p.title,
    p.status,
    COUNT(pm.user_id)                                              AS member_count,
    COUNT(pm.user_id) FILTER (WHERE pm.project_role = 'owner')       AS owner_count,
    COUNT(pm.user_id) FILTER (WHERE pm.project_role = 'manager')     AS manager_count,
    COUNT(pm.user_id) FILTER (WHERE pm.project_role = 'contributor') AS contributor_count,
    COUNT(pm.user_id) FILTER (WHERE pm.project_role = 'viewer')      AS viewer_count,
    (
        SELECT ou.full_name
        FROM project_members o
        JOIN users ou ON ou.user_id = o.user_id
        WHERE o.project_id = p.project_id
          AND o.project_role = 'owner'
    )                                                              AS owner_name,
    COUNT(pm.user_id) FILTER (WHERE NOT u.active)                  AS inactive_members,
    string_agg(
        u.full_name || ' (' || pm.project_role || COALESCE('; ' || gr.global_roles, '') || ')',
        ', '
        ORDER BY
            CASE pm.project_role
                WHEN 'owner'       THEN 1
                WHEN 'manager'     THEN 2
                WHEN 'contributor' THEN 3
                ELSE 4
            END,
            u.full_name,
            u.user_id
    )                                                              AS members
FROM projects p
LEFT JOIN project_members pm ON pm.project_id = p.project_id
LEFT JOIN users u            ON u.user_id = pm.user_id
LEFT JOIN (
    SELECT
        ur.user_id,
        string_agg(r.role_name, '/' ORDER BY r.role_name) AS global_roles
    FROM user_roles ur
    JOIN roles r ON r.role_id = ur.role_id
    GROUP BY ur.user_id
) gr ON gr.user_id = u.user_id
WHERE ($1::bigint IS NULL OR p.project_id = $1::bigint)
GROUP BY p.project_id, p.title, p.status
ORDER BY p.project_id;

EXECUTE access_project_members(NULL);

-- ============================================================================================
-- Q3. Audit trail of one entity over time
-- ============================================================================================
-- Statement: access_entity_audit_trail
-- Question: what happened to this record, by whom, in what order, and how long between steps?
-- Parameters: $1 entity_type (text, required, example 'samples')
--             $2 entity_id (bigint, required, example 1)
--             $3 from (timestamptz, NULL = no lower bound, inclusive)
--             $4 to   (timestamptz, NULL = no upper bound, inclusive)
-- Columns: audit_id, created_at, action, actor_id, actor_name, actor_email, step_number,
--          previous_action, since_previous (interval), changed_fields (text[]), details
-- Serves: GET /api/audit (T20) and the entity history views.
-- DBMS concepts: window functions (row_number, lag x2), CTE, LEFT JOIN users (system actions
--          have actor_id NULL and must still appear), jsonb_object_keys, multi-join.
-- Notes:
--   * CORRECTNESS: step_number, previous_action and since_previous are computed over the
--     entity's FULL history in the CTE `trail`, and ONLY THEN is the $3/$4 range applied in the
--     outer query. Filtering first would make the first in-range row lose its real predecessor
--     and restart step_number at 1. See the scratch trail below: with $3 = '2026-01-11' the
--     first returned row is still step 4 with previous_action 'update', not step 1 / NULL.
--   * details is treated as an OPAQUE JSON object (CONTRACT 4.1 only guarantees "an object",
--     the exact shape is decided by audit_row_change() in T17). changed_fields is simply the
--     sorted top-level keys of details; it is the empty array when details is NULL or '{}'.
--     Q3 never reads a specific key.
--   * AUTHORIZATION: this returns an entity's trail UNSCOPED. The CONTRACT 9 rule "principal
--     investigator may read audit (own)" (only entities in their projects) must be applied by
--     the caller (T20); this query deliberately does not decide it.
--   * Ordering: oldest first, by created_at then audit_id (total, so ties are deterministic).
--   * T19 baseline: filters audit_logs on entity_type, entity_id and sorts by created_at, so an
--     index on (entity_type, entity_id, created_at) has a visible effect.
--   * The seed has NO audit rows (CONTRACT 6), so on a freshly seeded database EXECUTE returns
--     zero rows. Use the scratch trail below (explicit IDs 1-7, fixed timestamps, rolled back).
--
-- Scratch trail (run on an EMPTY audit_logs; audit_logs also has a CHECK that details is an
-- object, and ids 1-7 are explicit so no identity sequence is consumed). Copy into psql:
--
--   BEGIN;
--   INSERT INTO audit_logs (audit_id, actor_id, entity_type, entity_id, action, details, created_at) VALUES
--       (1, 3,    'samples',  1, 'insert', '{"status": {"new": "collected"}}',                '2026-01-10 09:00:00+00'),
--       (2, 4,    'samples',  1, 'update', '{"status": {"old": "collected", "new": "stored"}}', '2026-01-10 11:30:00+00'),
--       (3, 3,    'samples',  2, 'insert', '{"status": {"new": "collected"}}',                '2026-01-10 09:00:30+00'),
--       (4, 2,    'projects', 1, 'update', '{}',                                              '2026-01-10 10:00:00+00'),
--       (5, 3,    'samples',  1, 'update', NULL,                                              '2026-01-11 08:00:00+00'),
--       (6, NULL, 'samples',  1, 'update', '{"status": {"old": "stored", "new": "extracted"}, "note": "auto"}', '2026-01-12 00:00:00+00'),
--       (7, NULL, 'samples',  2, 'update', '{"status": {"old": "collected", "new": "stored"}}', '2026-01-13 00:00:00+00');
--   EXECUTE access_entity_audit_trail('samples', 1, NULL, NULL);
--   EXECUTE access_entity_audit_trail('samples', 1, '2026-01-11 00:00:00+00', NULL);
--   ROLLBACK;
--
-- Expected for ('samples', 1, NULL, NULL): 4 rows (ids 3, 4, 7 belong to other entities and do not
-- appear: audit 3 and 7 are samples 2, audit 4 is projects 1, proving the filter on BOTH columns).
--   audit_id | created_at             | action | actor_id | actor_name   | actor_email                     | step | previous_action | since_previous | changed_fields   | details
--   1        | 2026-01-10 09:00:00+00 | insert | 3        | Farah Field  | field_researcher@ebiotrack.test | 1    |                 |                | {status}         | {"status": {"new": "collected"}}
--   2        | 2026-01-10 11:30:00+00 | update | 4        | Lakshmi Lab  | lab_technician@ebiotrack.test   | 2    | insert          | 02:30:00       | {status}         | {"status": {"new": "stored", "old": "collected"}}
--   5        | 2026-01-11 08:00:00+00 | update | 3        | Farah Field  | field_researcher@ebiotrack.test | 3    | update          | 20:30:00       | {}               | (NULL details)
--   6        | 2026-01-12 00:00:00+00 | update | (NULL)   | (NULL)       | (NULL)                          | 4    | update          | 16:00:00       | {note,status}    | {"note": "auto", "status": {"new": "extracted", "old": "stored"}}
--   (jsonb prints object keys shortest first, so "new" appears before "old".)
--   Window correctness, $3 = '2026-01-11 00:00:00+00': rows 5 and 6 only, still step 3 and 4 with
--   previous_action update / update and since_previous 20:30:00 / 16:00:00 (identical to above).
--   ('projects', 1) returns just audit 4 (step 1, changed_fields {}, details {}); ('samples', 2)
--   returns audits 3 and 7 (steps 1 and 2; step 2 is by the NULL system actor, previous_action
--   insert, since_previous 2 days 14:59:30).

PREPARE access_entity_audit_trail(text, bigint, timestamptz, timestamptz) AS
WITH trail AS (
    -- Windows over the entity's WHOLE history; the range filter comes after.
    SELECT
        a.audit_id,
        a.created_at,
        a.action,
        a.actor_id,
        a.details,
        row_number() OVER w                  AS step_number,
        lag(a.action) OVER w                 AS previous_action,
        a.created_at - lag(a.created_at) OVER w AS since_previous
    FROM audit_logs a
    WHERE a.entity_type = $1::text
      AND a.entity_id = $2::bigint
    WINDOW w AS (ORDER BY a.created_at, a.audit_id)
)
SELECT
    t.audit_id,
    t.created_at,
    t.action,
    t.actor_id,
    u.full_name                                                          AS actor_name,
    u.email                                                              AS actor_email,
    t.step_number,
    t.previous_action,
    t.since_previous,
    ARRAY(SELECT jsonb_object_keys(t.details) ORDER BY 1)                AS changed_fields,
    t.details
FROM trail t
LEFT JOIN users u ON u.user_id = t.actor_id
WHERE ($3::timestamptz IS NULL OR t.created_at >= $3::timestamptz)
  AND ($4::timestamptz IS NULL OR t.created_at <= $4::timestamptz)
ORDER BY t.created_at, t.audit_id;

EXECUTE access_entity_audit_trail('samples', 1, NULL, NULL);
