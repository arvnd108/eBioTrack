-- Owner: C (Testing & QA)
-- Purpose: 1 transaction scenario with rollback case: Access, Projects & Audit
--
-- T18-C. Scenario: project onboarding. Create a project with its owner
-- (create_project_with_owner(), T16-C), add team members and link sampling sites, as ONE
-- transaction that either commits completely or leaves no trace, audit rows included. The
-- rollback cases are a bad step in the middle of that sequence.
--
-- This is a standalone demonstration script, NOT a migration and NOT a test:
-- backend/src/db/migrate.js never runs database/transactions/. Run it by hand with psql (the
-- script fails on purpose, so leave ON_ERROR_STOP off, which is psql's default):
--
--   docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/access_transaction.sql
--   psql "$DATABASE_URL" -f database/transactions/access_transaction.sql
--   psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/access_transaction.sql   (test database only)
--
-- By default every transaction ends in ROLLBACK, so the script leaves the database exactly as
-- it found it and can be run again and again (generated ids move on, because PostgreSQL never
-- hands a consumed identity value back; nothing else differs). With -v keep=1 the one "happy"
-- transaction (Part 1) ends in COMMIT instead, to show durability. Never use keep=1 on the
-- development database; reset the test database afterwards. A second keep=1 run stops in
-- Part 0, because the committed demo project still exists.
--
-- Requires: the dev/test database after `npm run db:reset` (users 1-6, projects 1-2, sites 1-5),
-- create_project_with_owner() (T16-C) and the audit triggers on projects, project_members and
-- project_sites (T17-C). Part 0 checks this and stops if anything is missing.
-- Creates and drops nothing: no DDL, no DELETE, no GRANT. Cleanup is always ROLLBACK.
--
-- Parts, and which property each one shows:
--   0  Preflight and baseline counts (what "unchanged" means for the later checks).
--   1  Commit path: one transaction creates a project with its owner, adds three members and
--      links two sites. Atomicity of a multi-table write; the 7 audit rows carry the acting
--      user (set with SET LOCAL, as the backend does) and the project id; COMMIT is what makes
--      it durable and visible.
--   2  Rollback A: a second owner (constraint violation) after earlier work succeeded. The
--      project, members, site and their audit rows are undone too. The failed transaction
--      refuses further statements (25P02): no code after the error can save half the work.
--   3  Rollback B: consistency rules, each in its own transaction: the procedure's CONTRACT 7
--      errors (EB002, 23505, 23514) and foreign key violations (unknown site, unknown member) that
--      also undo the project created earlier (23503).
--   4  SAVEPOINT variant: recover from one bad member without redoing the whole onboarding.
--   5  Locking: the two-session protocol (comments, copy-paste) for the duplicate-title race,
--      the invisibility of uncommitted work and the FOR SHARE lock on the owner. Isolation
--      under READ COMMITTED.
--
-- Conventions used throughout:
--   * Acting user: SET LOCAL app.current_user_id = '2' (principal investigator) at the start of
--     every transaction, exactly as backend withTransaction does (CONTRACT 7). SET LOCAL lasts
--     until COMMIT or ROLLBACK, so it can never leak into the next transaction on the connection.
--   * Isolation: the default READ COMMITTED, which is also what the backend uses. SERIALIZABLE
--     is not needed here (the unique indexes and the FOR SHARE lock already decide every race)
--     and is not used.
--   * Errors: \set VERBOSITY verbose prints the SQLSTATE with every error, and the script saves
--     psql's LAST_ERROR_SQLSTATE and LAST_ERROR_MESSAGE right after each failing statement, so
--     after the ROLLBACK it can PASS/FAIL the code (and the constraint) it expected.
--   * After any error inside BEGIN ... COMMIT the transaction is ABORTED: PostgreSQL ignores
--     every statement until ROLLBACK (25P02). So every failing statement below is followed by
--     an explicit ROLLBACK (or ROLLBACK TO SAVEPOINT).
--   * Generated ids start at 1000 and are consumed even on failure (project ids 1000, 1001, ...
--     move on with every run). The script never hard-codes them: it captures them with
--     \gset. Audit rows are compared by "audit_id > the baseline maximum", never by absolute
--     counts.
--   * Checks print one line starting with PASS or FAIL; the final section counts them.

\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off

-- Tallies, bumped with ":tally_pass \gset" / ":tally_fail \gset" after each check.
\set n_pass 0
\set n_fail 0
\set tally_pass 'SELECT :n_pass + 1 AS n_pass'
\set tally_fail 'SELECT :n_fail + 1 AS n_fail'

-- The one fixed project title of the scenario (unique, not seeded).
\set demo_title 'T18 onboarding demo project'

\echo
\echo ============================================================================
\echo PART 0: Preflight and baseline
\echo ============================================================================

SELECT current_database() AS database, current_user AS db_user,
       current_setting('transaction_isolation') AS isolation_level;

-- Refuse to run against a database without the fixture world. Two steps, so a missing table
-- cannot raise an error before we get to print the message.
\set fixtures_ok false
\set tables_ok false
SELECT to_regclass('projects') IS NOT NULL
   AND to_regclass('project_members') IS NOT NULL
   AND to_regclass('project_sites') IS NOT NULL
   AND to_regclass('audit_logs') IS NOT NULL
   AND to_regclass('users') IS NOT NULL
   AND to_regclass('sampling_sites') IS NOT NULL
   AND to_regprocedure('create_project_with_owner(text,text,date,bigint)') IS NOT NULL
   AS tables_ok \gset
\if :tables_ok
    SELECT (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_projects_audit',
                'trg_project_members_audit', 'trg_project_sites_audit')) = 3
       AND (SELECT count(*) FROM users WHERE user_id IN (2, 3, 4, 6) AND active) = 4
       AND (SELECT count(*) FROM sampling_sites WHERE site_id IN (1, 4)) = 2
       AND EXISTS (SELECT 1 FROM projects WHERE title = 'Yamuna Biodiversity Survey')
       AS fixtures_ok \gset
\endif
\if :fixtures_ok
    \echo PASS: fixture world present (users, sites, create_project_with_owner, audit triggers).
    :tally_pass \gset
\else
    \echo
    \echo STOP: the fixture world is missing or incomplete. Expected create_project_with_owner(),
    \echo the audit triggers on projects, project_members and project_sites, active users 2, 3,
    \echo 4 and 6, sites 1 and 4 and the seeded project Yamuna Biodiversity Survey.
    \echo Run npm run db:reset in backend/ (development database) and try again.
    \quit
\endif

-- A committed project from an earlier keep=1 run would turn Part 1 into a confusing 23505.
SELECT EXISTS (SELECT 1 FROM projects WHERE title = :'demo_title') AS demo_exists \gset
\if :demo_exists
    \echo
    \echo STOP: a project titled :demo_title already exists. A previous run with keep=1
    \echo committed it. Reset the test database (it must not be kept) and run the script again.
    \quit
\endif

-- Row counts that "unchanged" is measured against. audit_max is the highest audit_id before
-- the script starts, so "audit rows written by a transaction" means audit_id > audit_max.
\set count_all 'SELECT (SELECT count(*) FROM projects) AS projects, (SELECT count(*) FROM project_members) AS members, (SELECT count(*) FROM project_sites) AS sites, (SELECT count(*) FROM audit_logs) AS audit, (SELECT COALESCE(max(audit_id), 0) FROM audit_logs) AS audit_max'
:count_all \gset base_
\echo Baseline: :base_projects projects, :base_members project members, :base_sites project sites, :base_audit audit rows.

-- :assert_baseline expands to a one-row query: every count equals the baseline, as a PASS or
-- FAIL line. After a ROLLBACK there is no trace of the transaction, not even an audit row.
\set assert_baseline 'SELECT CASE WHEN (SELECT count(*) FROM projects) = :base_projects AND (SELECT count(*) FROM project_members) = :base_members AND (SELECT count(*) FROM project_sites) = :base_sites AND (SELECT count(*) FROM audit_logs) = :base_audit AND (SELECT COALESCE(max(audit_id), 0) FROM audit_logs) = :base_audit_max THEN \'PASS: projects, members, sites and audit rows are back at the baseline\' ELSE \'FAIL: the database differs from the baseline\' END AS result'

\echo
\echo ============================================================================
\echo PART 1: Commit path - project onboarding, all or nothing
\echo ============================================================================
\echo User 2 (principal investigator) creates the project, adds users 3 and 4 as contributors
\echo and user 6 as viewer, and links sites 1 and 4.

BEGIN;
SET LOCAL app.current_user_id = '2';

-- Project and owner membership in one call (CONTRACT 7); returns the new project id.
SELECT create_project_with_owner(:'demo_title', 'Demonstration of an all-or-nothing project setup.', current_date, 2) AS new_project_id \gset

INSERT INTO project_members (project_id, user_id, project_role)
SELECT :new_project_id, v.user_id, v.project_role::project_role
FROM (VALUES (3, 'contributor'), (4, 'contributor'), (6, 'viewer')) AS v(user_id, project_role);

INSERT INTO project_sites (project_id, site_id)
SELECT :new_project_id, v.site_id FROM (VALUES (1), (4)) AS v(site_id);

\echo Evidence inside the transaction: the project (planned, created by user 2)
SELECT title, status, created_by FROM projects WHERE project_id = :new_project_id;
\set ok false
SELECT status = 'planned' AND created_by = 2 AS ok FROM projects WHERE project_id = :new_project_id \gset
\if :ok
    \echo PASS: project is planned and created_by is the acting user 2
    :tally_pass \gset
\else
    \echo FAIL: project row is not planned / created_by 2
    :tally_fail \gset
\endif

\echo Evidence: members (exactly one owner)
SELECT user_id, project_role FROM project_members WHERE project_id = :new_project_id ORDER BY user_id;
\set ok false
SELECT count(*) = 4 AND count(*) FILTER (WHERE project_role = 'owner') = 1 AS ok
FROM project_members WHERE project_id = :new_project_id \gset
\if :ok
    \echo PASS: 4 members, exactly one owner
    :tally_pass \gset
\else
    \echo FAIL: member list is not 4 rows with one owner
    :tally_fail \gset
\endif

\echo Evidence: linked sites
SELECT site_id FROM project_sites WHERE project_id = :new_project_id ORDER BY site_id;
\set ok false
SELECT count(*) = 2 AND bool_and(site_id IN (1, 4)) AS ok FROM project_sites WHERE project_id = :new_project_id \gset
\if :ok
    \echo PASS: sites 1 and 4 are linked
    :tally_pass \gset
\else
    \echo FAIL: linked sites are not 1 and 4
    :tally_fail \gset
\endif

\echo Evidence: audit rows written by this transaction (the acting user and the project id)
SELECT entity_type, action, actor_id, count(*) AS rows, bool_and(entity_id = :new_project_id) AS entity_is_project
FROM audit_logs WHERE audit_id > :base_audit_max
GROUP BY entity_type, action, actor_id ORDER BY entity_type, action;
\set ok false
SELECT count(*) = 7
       AND count(*) FILTER (WHERE entity_type = 'projects' AND action = 'insert') = 1
       AND count(*) FILTER (WHERE entity_type = 'project_members' AND action = 'insert') = 4
       AND count(*) FILTER (WHERE entity_type = 'project_sites' AND action = 'insert') = 2
       AND bool_and(actor_id = 2) AND bool_and(entity_id = :new_project_id) AS ok
FROM audit_logs WHERE audit_id > :base_audit_max \gset
\if :ok
    \echo PASS: 7 audit rows (1 project, 4 members, 2 sites), all actor 2, all entity_id = the project
    :tally_pass \gset
\else
    \echo FAIL: the audit rows are not the expected 7 (1 + 4 + 2) with actor 2 and the project id
    :tally_fail \gset
\endif

-- COMMIT makes every statement above visible to other sessions at once and durable: once
-- COMMIT returns, the change survives the end of this session and a restart of the server,
-- because it is in the write-ahead log. ROLLBACK discards all of it, including the audit
-- rows. The default is ROLLBACK so the demonstration leaves the database unchanged.
\if :{?keep}
    \echo keep=1: committing Part 1.
    COMMIT;
\else
    \echo Default: rolling back Part 1 (use -v keep=1 to commit).
    ROLLBACK;
\endif

-- Back in autocommit: the same counts as before, compared with the baseline.
:count_all \gset after1_
\if :{?keep}
    \set ok false
    SELECT :after1_projects = :base_projects + 1 AND :after1_members = :base_members + 4
       AND :after1_sites = :base_sites + 2 AND :after1_audit = :base_audit + 7 AS ok \gset
    \if :ok
        \echo PASS: the committed project, 4 members, 2 sites and 7 audit rows are durable and visible
        :tally_pass \gset
    \else
        \echo FAIL: the committed deltas are not visible
        :tally_fail \gset
    \endif
    \echo The project :demo_title is now committed: every session sees it. Remove it by
    \echo resetting the test database (npm run db:reset against it); do NOT DELETE (D19).
    -- The committed state is the new normal for the rest of the script, and the title is taken.
    :count_all \gset base_
    \set demo_title 'T18 onboarding demo project (after commit)'
\else
    \set result 'FAIL: baseline not evaluated'
    :assert_baseline \gset
    \echo :result
    \set ok false
    SELECT :'result' LIKE 'PASS%' AS ok \gset
    \if :ok
        :tally_pass \gset
    \else
        :tally_fail \gset
    \endif
\endif

\echo
\echo ============================================================================
\echo PART 2: Rollback A - a second owner undoes the whole onboarding
\echo ============================================================================
\echo Expected: 23505 on uq_project_members_owner, then 25P02 for any later statement.

BEGIN;
SET LOCAL app.current_user_id = '2';

SELECT create_project_with_owner(:'demo_title', 'Rollback demo A', current_date, 2) AS new_project_id \gset

INSERT INTO project_members (project_id, user_id, project_role)
SELECT :new_project_id, v.user_id, 'contributor'::project_role FROM (VALUES (3), (4)) AS v(user_id);
INSERT INTO project_sites (project_id, site_id) VALUES (:new_project_id, 1);

\echo Evidence: the work done so far, in this transaction only
SELECT (SELECT count(*) FROM project_members WHERE project_id = :new_project_id) AS members,
       (SELECT count(*) FROM project_sites WHERE project_id = :new_project_id) AS sites,
       (SELECT count(*) FROM audit_logs WHERE audit_id > :base_audit_max) AS audit_rows;

-- User 5 is not a member yet, so the only rule broken is "one owner per project". (Adding user 3,
-- who is already a member, would fail first on the primary key pk_project_members.)
INSERT INTO project_members (project_id, user_id, project_role) VALUES (:new_project_id, 5, 'owner');
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg

-- The transaction is now aborted. Nothing after the failed statement can half-save the work.
SELECT 1;
\set caught_after :LAST_ERROR_SQLSTATE
\echo ^ 25P02 (current transaction is aborted): only ROLLBACK is accepted now.
ROLLBACK;

\set ok false
SELECT :'caught' = '23505' AND position('uq_project_members_owner' IN :'caught_msg') > 0 AS ok \gset
\if :ok
    \echo PASS: second owner raised 23505 on uq_project_members_owner
    :tally_pass \gset
\else
    \echo FAIL: second owner did not raise 23505 on uq_project_members_owner
    :tally_fail \gset
\endif
\set ok false
SELECT :'caught_after' = '25P02' AS ok \gset
\if :ok
    \echo PASS: the aborted transaction refused the next statement with 25P02
    :tally_pass \gset
\else
    \echo FAIL: expected 25P02 for the statement after the error
    :tally_fail \gset
\endif
\echo Project, members, site and every audit row of the failed transaction are gone:
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

\echo
\echo ============================================================================
\echo PART 3: Rollback B - consistency rules, each in its own transaction
\echo ============================================================================
\echo The database refuses states that break its rules; create_project_with_owner() raises
\echo the CONTRACT 7 codes. The last case shows that the project created one statement
\echo earlier disappears with the failure.

-- B1: a viewer cannot own a project.
\echo
\echo B1: user 6 (viewer) as owner. Expected EB002.
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT create_project_with_owner(:'demo_title', NULL, NULL, 6);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set ok false
SELECT :'caught' = 'EB002' AS ok \gset
\if :ok
    \echo PASS: B1 raised EB002
    :tally_pass \gset
\else
    \echo FAIL: B1 did not raise EB002
    :tally_fail \gset
\endif
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

-- B2: a seeded title.
\echo
\echo B2: the title of a seeded project. Expected 23505 (constraint uq_projects_title).
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT create_project_with_owner('Yamuna Biodiversity Survey', NULL, NULL, 2);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set ok false
SELECT :'caught' = '23505' AND position('already exists' IN :'caught_msg') > 0 AS ok \gset
\if :ok
    \echo PASS: B2 raised 23505 (the verbose error above names CONSTRAINT uq_projects_title)
    :tally_pass \gset
\else
    \echo FAIL: B2 did not raise 23505
    :tally_fail \gset
\endif
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

-- B3: a blank title.
\echo
\echo B3: a blank title. Expected 23514.
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT create_project_with_owner('   ', NULL, NULL, 2);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set ok false
SELECT :'caught' = '23514' AS ok \gset
\if :ok
    \echo PASS: B3 raised 23514
    :tally_pass \gset
\else
    \echo FAIL: B3 did not raise 23514
    :tally_fail \gset
\endif
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

-- B4: the project exists inside the transaction, then an unknown site is linked.
\echo
\echo B4: create the project, then link the unknown site 999. Expected 23503 on
\echo fk_project_sites_site_id; the project created one statement earlier is rolled back too.
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT create_project_with_owner(:'demo_title', NULL, NULL, 2) AS new_project_id \gset
\echo Evidence: the project and its owner exist inside the transaction
SELECT p.project_id IS NOT NULL AS project_exists, count(m.user_id) AS members
FROM projects p LEFT JOIN project_members m USING (project_id)
WHERE p.project_id = :new_project_id GROUP BY p.project_id;
INSERT INTO project_sites (project_id, site_id) VALUES (:new_project_id, 999);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set ok false
SELECT :'caught' = '23503' AND position('fk_project_sites_site_id' IN :'caught_msg') > 0 AS ok \gset
\if :ok
    \echo PASS: B4 raised 23503 on fk_project_sites_site_id
    :tally_pass \gset
\else
    \echo FAIL: B4 did not raise 23503 on fk_project_sites_site_id
    :tally_fail \gset
\endif
\set ok false
SELECT NOT EXISTS (SELECT 1 FROM projects WHERE project_id = :new_project_id) AS ok \gset
\if :ok
    \echo PASS: the project created before the failing statement is gone
    :tally_pass \gset
\else
    \echo FAIL: the project survived the rollback
    :tally_fail \gset
\endif
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

-- B5: the issue's scenario 2 - a member id that does not exist, without a savepoint.
\echo
\echo B5: create the project, add user 3, then add the unknown user 999. Expected 23503 on
\echo fk_project_members_user_id; no savepoint, so the whole onboarding is rolled back.
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT create_project_with_owner(:'demo_title', NULL, NULL, 2) AS new_project_id \gset
INSERT INTO project_members (project_id, user_id, project_role) VALUES (:new_project_id, 3, 'contributor');
\echo Evidence: the work done so far (counts before the failing step)
SELECT (SELECT count(*) FROM projects) - :base_projects AS projects_added,
       (SELECT count(*) FROM project_members) - :base_members AS members_added,
       (SELECT count(*) FROM audit_logs WHERE audit_id > :base_audit_max) AS audit_rows;
INSERT INTO project_members (project_id, user_id, project_role) VALUES (:new_project_id, 999, 'contributor');
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set ok false
SELECT :'caught' = '23503' AND position('fk_project_members_user_id' IN :'caught_msg') > 0 AS ok \gset
\if :ok
    \echo PASS: B5 raised 23503 on fk_project_members_user_id
    :tally_pass \gset
\else
    \echo FAIL: B5 did not raise 23503 on fk_project_members_user_id
    :tally_fail \gset
\endif
\set ok false
SELECT NOT EXISTS (SELECT 1 FROM projects WHERE project_id = :new_project_id)
   AND NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = :new_project_id) AS ok \gset
\if :ok
    \echo PASS: no project and no members remain after the unknown member
    :tally_pass \gset
\else
    \echo FAIL: the project or its members survived the rollback
    :tally_fail \gset
\endif
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

\echo
\echo ============================================================================
\echo PART 4: SAVEPOINT variant - partial rollback inside one transaction
\echo ============================================================================
\echo Expected: 23503 on fk_project_members_user_id for the unknown user 999 only; the project
\echo and the other members survive until the transaction ends.

BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT create_project_with_owner(:'demo_title', 'Savepoint demo', current_date, 2) AS new_project_id \gset

SAVEPOINT member_a;
INSERT INTO project_members (project_id, user_id, project_role) VALUES (:new_project_id, 999, 'contributor');
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg

-- Unlike Part 2 the application chooses to recover: undo only the work since the savepoint.
-- The transaction is usable again (no 25P02) and the earlier statements are still pending.
ROLLBACK TO SAVEPOINT member_a;
INSERT INTO project_members (project_id, user_id, project_role) VALUES (:new_project_id, 3, 'contributor');

\echo Evidence: the project exists and its members are the owner and user 3 (no user 999)
SELECT p.title, p.status FROM projects p WHERE p.project_id = :new_project_id;
SELECT user_id, project_role FROM project_members WHERE project_id = :new_project_id ORDER BY user_id;
\set ok false
SELECT count(*) = 2 AND bool_and(user_id IN (2, 3)) AS ok FROM project_members WHERE project_id = :new_project_id \gset
\if :ok
    \echo PASS: members are the owner (2) and user 3, not 999
    :tally_pass \gset
\else
    \echo FAIL: unexpected member list after the savepoint
    :tally_fail \gset
\endif

\echo Evidence: the audit rows so far; the failed insert left none
SELECT entity_type, action, count(*) AS rows FROM audit_logs
WHERE audit_id > :base_audit_max GROUP BY entity_type, action ORDER BY entity_type, action;
\set ok false
SELECT count(*) = 3
       AND count(*) FILTER (WHERE entity_type = 'projects') = 1
       AND count(*) FILTER (WHERE entity_type = 'project_members') = 2
       AND NOT bool_or(details ? 'user_id' AND (details -> 'user_id' ->> 'new') = '999') AS ok
FROM audit_logs WHERE audit_id > :base_audit_max \gset
\if :ok
    \echo PASS: 3 audit rows (1 project, 2 members); nothing for the undone user 999
    :tally_pass \gset
\else
    \echo FAIL: the audit rows do not match the surviving work
    :tally_fail \gset
\endif

-- A savepoint lets the caller recover from one bad step without redoing the whole unit. It is
-- NOT needed for the all-or-nothing guarantee: Part 2 shows that the plain transaction already
-- has it. create_project_with_owner() itself uses no EXCEPTION block, so it creates no
-- subtransaction; the only subtransaction here is the one this script opened on purpose.
-- The backend's withTransaction uses whole-transaction rollback, the simpler default.
\echo Default: rolling back Part 4.
ROLLBACK;
\set ok false
SELECT :'caught' = '23503' AND position('fk_project_members_user_id' IN :'caught_msg') > 0 AS ok \gset
\if :ok
    \echo PASS: unknown member raised 23503 on fk_project_members_user_id
    :tally_pass \gset
\else
    \echo FAIL: unknown member did not raise 23503 on fk_project_members_user_id
    :tally_fail \gset
\endif
\set result 'FAIL: baseline not evaluated'
:assert_baseline \gset
\echo :result
\set ok false
SELECT :'result' LIKE 'PASS%' AS ok \gset
\if :ok
    :tally_pass \gset
\else
    :tally_fail \gset
\endif

\echo
\echo ============================================================================
\echo PART 5: Locking and isolation - two sessions (copy-paste protocol)
\echo ============================================================================
\echo A single psql script cannot run two concurrent sessions, so this part is a documented
\echo copy-paste protocol in the comments of this file. Nothing is executed here.

-- Open three psql tabs against the SAME database (test database recommended): S1, S2 and S3
-- (observer). Replace nothing: the title is fixed, the users are the fixture users.
--
-- 1. Duplicate title race.
--    S1: BEGIN;
--        SET LOCAL app.current_user_id = '2';
--        SELECT create_project_with_owner('T18 onboarding demo project', NULL, NULL, 2);
--    -> returns a new project id (>= 1000). Nothing is committed.
--    S2: BEGIN;
--        SET LOCAL app.current_user_id = '2';
--        SELECT create_project_with_owner('T18 onboarding demo project', NULL, NULL, 2);
--    -> BLOCKS: both calls insert the same title and the unique index uq_projects_title makes
--       S2 wait for S1. S3 shows the wait:
--        SELECT pid, wait_event_type, wait_event, state, left(query, 60) AS query
--        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();
--        -> S2 has wait_event_type = 'Lock' and wait_event = 'transactionid'
--    S1: COMMIT;   -> S2 unblocks and fails: ERROR: 23505: duplicate key value violates
--                     unique constraint "uq_projects_title". S2: ROLLBACK;
--       Variant: S1: ROLLBACK; instead of COMMIT -> S2 unblocks and SUCCEEDS (returns an id).
--       Never two projects with the title. (T34 automates this.)
--
-- 2. Uncommitted work is invisible (READ COMMITTED).
--    Repeat step 1 up to S1's create call, but do not end S1. In S2 (outside any transaction):
--        SELECT project_id, title FROM projects WHERE title = 'T18 onboarding demo project';
--    -> 0 rows: another session never sees S1's uncommitted project. S1: COMMIT; then the same
--       query in S2 returns 1 row. That is Isolation (no dirty reads) and Durability (the row
--       stays visible to every session).
--
-- 3. The owner cannot be deactivated mid-creation.
--    S1: BEGIN;
--        SET LOCAL app.current_user_id = '2';
--        SELECT create_project_with_owner('T18 onboarding demo project', NULL, NULL, 2);
--    -> the function holds a FOR SHARE lock on the owner row (users, user_id = 2).
--    S2: BEGIN;
--        UPDATE users SET active = false WHERE user_id = 2;
--    -> BLOCKS until S1 ends. That is the point of the lock: the owner checks (exists, active,
--       role) and the membership insert in S1 see the same user. S3 shows the wait in
--       pg_stat_activity as in step 1.
--    S1: ROLLBACK;  -> S2's UPDATE now completes.
--    S2: ROLLBACK;  <- IMPORTANT: roll this one back. Do NOT commit; user 2 must stay active.
--
-- 4. Cleanup. Steps 1 and 2 leave a committed project if you used COMMIT in S1. Reset the test
--    database (npm run db:reset against it); do NOT DELETE (D19). Sessions still open:
--    ROLLBACK; in each.
--
-- The permanent automated version of this protocol is the project-creation concurrency case
-- of T34; this part is its specification.

\echo (protocol: see the comments after this line in the script)

\echo
\echo ============================================================================
\echo Final check: nothing left behind
\echo ============================================================================
\if :{?keep}
    \echo keep=1: the committed project from Part 1 remains on purpose. Reset this database.
\else
    \set result 'FAIL: baseline not evaluated'
    :assert_baseline \gset
    \echo :result
    \set ok false
    SELECT :'result' LIKE 'PASS%' AS ok \gset
    \if :ok
        :tally_pass \gset
    \else
        :tally_fail \gset
    \endif
\endif

\echo
\echo Summary: :n_pass checks passed, :n_fail checks failed.
\echo Done.
