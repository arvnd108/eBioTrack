-- Owner: C (Testing & QA)
-- Purpose: 2 views: Access, Projects & Audit
--
-- T15-C. Names are fixed by CONTRACT 7; column lists are documented in docs/slices/access.md.
-- The views are the parameter-free, set-based forms of the T14-C queries in
-- database/queries/access_queries.sql and must not disagree with them. Read-only: nothing writes
-- through a view, no explicit ORDER BY (consumers sort), no password_hash or other secrets.
--
-- NOT applied by backend/src/db/migrate.js (it only reads database/migrations and
-- database/seeds). Interim step, safe to repeat:
--   psql "$DATABASE_URL" -f database/views/access_views.sql
-- CREATE OR REPLACE VIEW cannot drop or rename columns of an existing view; if the column lists
-- change later, DROP VIEW first.

-- ============================================================================================
-- v_user_project_access
-- ============================================================================================
-- Purpose: one row per (user, project) pair the user can access, with how and with what rights.
--          Query 1 (access_user_projects) for all users at once:
--          SELECT ... FROM v_user_project_access WHERE user_id = $1 returns the same rows.
-- Columns: user_id, full_name, email          the user (active users only)
--          project_id, project_title, project_status   the project (Query 1: title, status)
--          access_via     'administrator' (global role) or 'membership'
--          project_role   the user's project_members role, NULL for an administrator with none
--          can_edit       true for administrators and project roles owner/manager (settings and
--                         members); false for contributor and viewer
-- Rules:   inactive users have no rows; an administrator sees every project; everyone else only
--          projects they are a member of; an administrator who is also a member appears ONCE, with
--          access_via 'administrator' and their real project_role. The admin test matches
--          role_name = 'administrator', never a role_id.
-- Used by: GET /api/projects (T20), authorization tests (T31, T33), admin/user screens.
-- Features: CTE, EXISTS over user_roles JOIN roles, multi-join, LEFT JOIN, CASE.
-- Privacy: contains emails. API access must stay behind `authorize` (administrator, or the
--          caller's own user_id); the view does not filter by caller.
-- Why one row per pair: the administrator flag is computed once per user with EXISTS (so a user
--          with several global roles is not duplicated), crossed with all projects, and the
--          membership is a LEFT JOIN on the (project_id, user_id) primary key, so each pair can
--          occur at most once.
-- Expected for the seed: 9 rows. user 1: projects 1, 2 (administrator, project_role NULL,
--          can_edit t); user 2: 1, 2 (membership, owner, t); user 3: 1, 2 (contributor, f);
--          users 4 and 5: project 1 (contributor, f); user 6: project 1 (viewer, f).

CREATE OR REPLACE VIEW v_user_project_access AS
WITH active_users AS (
    SELECT
        u.user_id,
        u.full_name,
        u.email,
        EXISTS (
            SELECT 1
            FROM user_roles ur
            JOIN roles r ON r.role_id = ur.role_id
            WHERE ur.user_id = u.user_id
              AND r.role_name = 'administrator'
        ) AS is_admin
    FROM users u
    WHERE u.active
)
SELECT
    au.user_id,
    au.full_name,
    au.email,
    p.project_id,
    p.title                                                          AS project_title,
    p.status                                                         AS project_status,
    CASE WHEN au.is_admin THEN 'administrator' ELSE 'membership' END AS access_via,
    pm.project_role,
    (au.is_admin OR pm.project_role IN ('owner', 'manager'))         AS can_edit
FROM active_users au
CROSS JOIN projects p
LEFT JOIN project_members pm
       ON pm.project_id = p.project_id
      AND pm.user_id = au.user_id
WHERE au.is_admin OR pm.user_id IS NOT NULL;

-- ============================================================================================
-- v_project_summary
-- ============================================================================================
-- Purpose: one row per project with its owner, membership counts and how much work is attached.
-- Columns: project_id, title, status, start_date, end_date, created_by   projects
--          owner_id, owner_name        the owner (NULL for a project with none)
--          member_count, manager_count, contributor_count, viewer_count   from project_members
--                                      (the owner is counted in member_count only)
--          site_count    project_sites rows
--          event_count   collection_events with this project_id
--          sample_count  samples of those events
--          All counts are bigint and 0, never NULL, for a project with nothing attached.
-- Used by: GET /api/projects/:id, the Projects page and dashboard (T20, T25, T29).
-- Features: several independent pre-aggregations joined by project_id, aggregation with FILTER,
--          LEFT JOIN. Cross-slice read (projects in 010, events/samples in 020) by design.
-- Fan-out: members, sites, events and samples are each aggregated in their own derived table
--          and joined one row per project, so no count is multiplied by another table's rows.
-- Agrees with access_project_members: member_count and the role counts are the same numbers.
-- Expected for the seed: project 1 Yamuna Biodiversity Survey: owner 2 Pranav Investigator,
--          5 members (0 manager, 3 contributor, 1 viewer), 3 sites, 6 events, 13 samples;
--          project 2 Coastal Estuary Pilot: owner 2, 2 members (0, 1, 0), 2 sites, 2 events,
--          4 samples. 13 + 4 = 17 samples.

CREATE OR REPLACE VIEW v_project_summary AS
SELECT
    p.project_id,
    p.title,
    p.status,
    p.start_date,
    p.end_date,
    p.created_by,
    ow.user_id                                  AS owner_id,
    ow.full_name                                AS owner_name,
    COALESCE(m.member_count, 0)                 AS member_count,
    COALESCE(m.manager_count, 0)                AS manager_count,
    COALESCE(m.contributor_count, 0)            AS contributor_count,
    COALESCE(m.viewer_count, 0)                 AS viewer_count,
    COALESCE(s.site_count, 0)                   AS site_count,
    COALESCE(e.event_count, 0)                  AS event_count,
    COALESCE(sm.sample_count, 0)                AS sample_count
FROM projects p
LEFT JOIN (
    SELECT o.project_id, ou.user_id, ou.full_name
    FROM project_members o
    JOIN users ou ON ou.user_id = o.user_id
    WHERE o.project_role = 'owner'
) ow ON ow.project_id = p.project_id
LEFT JOIN (
    SELECT
        pm.project_id,
        COUNT(*)                                                  AS member_count,
        COUNT(*) FILTER (WHERE pm.project_role = 'manager')       AS manager_count,
        COUNT(*) FILTER (WHERE pm.project_role = 'contributor')   AS contributor_count,
        COUNT(*) FILTER (WHERE pm.project_role = 'viewer')        AS viewer_count
    FROM project_members pm
    GROUP BY pm.project_id
) m ON m.project_id = p.project_id
LEFT JOIN (
    SELECT ps.project_id, COUNT(*) AS site_count
    FROM project_sites ps
    GROUP BY ps.project_id
) s ON s.project_id = p.project_id
LEFT JOIN (
    SELECT ce.project_id, COUNT(*) AS event_count
    FROM collection_events ce
    GROUP BY ce.project_id
) e ON e.project_id = p.project_id
LEFT JOIN (
    SELECT ce.project_id, COUNT(*) AS sample_count
    FROM collection_events ce
    JOIN samples sa ON sa.event_id = ce.event_id
    GROUP BY ce.project_id
) sm ON sm.project_id = p.project_id;
