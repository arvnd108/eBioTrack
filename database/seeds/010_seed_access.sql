-- Owner: C (Testing & QA)
-- Purpose: Seed rows: Access, Projects & Audit
--
-- Fixture world (CONTRACT 6). SYNTHETIC data, development and test only. Explicit IDs below 1000,
-- fixed literal timestamps (UTC), no now()/random(), so every rebuild is identical.
--
-- Designed answers:
--   users / roles / user_roles ............ 6 / 6 / 6 (user n has role n)
--   projects .............................. 2, both 'active'
--   project_members ....................... 7 rows; owner of projects 1 and 2 is user 2
--   members of project 1 / project 2 ...... 5 / 2
--   user 3 belongs to projects 1 and 2; users 4, 5, 6 to project 1 only
--   user 1 (administrator) is a member of nothing: access comes from the global role
--   project_sites ......................... 5 rows (project 1 -> sites 1-3, project 2 -> sites 4-5),
--                                           inserted by 020_seed_field.sql, see below
--   audit_logs, data_exports .............. not seeded (0 rows)
--
-- project_sites is NOT inserted here. fk_project_sites_site_id (090) needs sampling_sites, which
-- 020 seeds after this file, and fk_collection_events_project_site needs project_sites before
-- collection_events, also in 020. So this block must sit in 020_seed_field.sql, after
-- sampling_sites and before collection_events:
--
--   INSERT INTO project_sites (project_id, site_id) VALUES
--       (1, 1), (1, 2), (1, 3),
--       (2, 4), (2, 5);
--
-- All six users share one development-only password (see tests/fixtures/README.md); only its
-- bcrypt hash (cost 12) is stored.

-- roles: names match CONTRACT 3 exactly; the API compares against these strings.
INSERT INTO roles (role_id, role_name, description) VALUES
    (1, 'administrator',          'Manages users, roles, and all projects'),
    (2, 'principal_investigator', 'Leads projects; approves analyses'),
    (3, 'field_researcher',       'Collects field samples'),
    (4, 'lab_technician',         'Processes samples in the lab'),
    (5, 'analyst',                'Imports and reviews detections'),
    (6, 'viewer',                 'Read-only access');

-- users: one per role, in role order. last_login_at stays NULL until someone signs in.
INSERT INTO users (user_id, full_name, email, password_hash, active, last_login_at, created_at) VALUES
    (1, 'Asha Admin',      'administrator@ebiotrack.test',          '$2b$12$U4ywjpZu9W7R/x7H6fLXSOcOHTM6WebAcQrqmPLSmRrDpYLn.Uamm', true, NULL, '2025-01-01 00:00:00+00'),
    (2, 'Pranav Investigator', 'principal_investigator@ebiotrack.test', '$2b$12$U4ywjpZu9W7R/x7H6fLXSOcOHTM6WebAcQrqmPLSmRrDpYLn.Uamm', true, NULL, '2025-01-01 00:00:00+00'),
    (3, 'Farah Field',     'field_researcher@ebiotrack.test',       '$2b$12$U4ywjpZu9W7R/x7H6fLXSOcOHTM6WebAcQrqmPLSmRrDpYLn.Uamm', true, NULL, '2025-01-01 00:00:00+00'),
    (4, 'Lakshmi Lab',     'lab_technician@ebiotrack.test',         '$2b$12$U4ywjpZu9W7R/x7H6fLXSOcOHTM6WebAcQrqmPLSmRrDpYLn.Uamm', true, NULL, '2025-01-01 00:00:00+00'),
    (5, 'Anil Analyst',    'analyst@ebiotrack.test',                '$2b$12$U4ywjpZu9W7R/x7H6fLXSOcOHTM6WebAcQrqmPLSmRrDpYLn.Uamm', true, NULL, '2025-01-01 00:00:00+00'),
    (6, 'Vikram Viewer',   'viewer@ebiotrack.test',                 '$2b$12$U4ywjpZu9W7R/x7H6fLXSOcOHTM6WebAcQrqmPLSmRrDpYLn.Uamm', true, NULL, '2025-01-01 00:00:00+00');

-- user_roles: (user n, role n)
INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES
    (1, 1, '2025-01-01 00:00:00+00'),
    (2, 2, '2025-01-01 00:00:00+00'),
    (3, 3, '2025-01-01 00:00:00+00'),
    (4, 4, '2025-01-01 00:00:00+00'),
    (5, 5, '2025-01-01 00:00:00+00'),
    (6, 6, '2025-01-01 00:00:00+00');

-- projects: titles are fixed by CONTRACT 6. Start years precede the earliest events (project 1 in
-- 2025, project 2 in 2026); end dates are open.
INSERT INTO projects (project_id, title, objectives, start_date, end_date, status, created_by, created_at) VALUES
    (1, 'Yamuna Biodiversity Survey',
        'Track fish and invertebrate biodiversity along the Yamuna using eDNA from three river sites, sampled once a year.',
        '2025-01-15', NULL, 'active', 2, '2025-01-10 09:00:00+00'),
    (2, 'Coastal Estuary Pilot',
        'Pilot eDNA sampling at two estuary sites to test the protocol before scaling up.',
        '2026-01-10', NULL, 'active', 2, '2025-12-01 09:00:00+00');

-- project_members: exactly one owner per project (uq_project_members_owner). User 1 has no row on
-- purpose (admin access is by global role); users 4-6 are not on project 2 so access checks have
-- known negative answers.
INSERT INTO project_members (project_id, user_id, project_role, joined_at) VALUES
    (1, 2, 'owner',       '2025-01-10 09:30:00+00'),
    (1, 3, 'contributor', '2025-01-10 10:00:00+00'),
    (1, 4, 'contributor', '2025-01-10 10:00:00+00'),
    (1, 5, 'contributor', '2025-01-10 10:00:00+00'),
    (1, 6, 'viewer',      '2025-01-10 10:00:00+00'),
    (2, 2, 'owner',       '2025-12-01 09:30:00+00'),
    (2, 3, 'contributor', '2025-12-01 10:00:00+00');
