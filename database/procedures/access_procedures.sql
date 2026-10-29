-- Owner: C (Testing & QA)
-- Purpose: 1 stored procedure/function: Access, Projects & Audit
--
-- T16-C. Signature from CONTRACT 7:
--   create_project_with_owner(p_title text, p_objectives text, p_start_date date, p_owner_id bigint)
--   RETURNS bigint   -- the new project_id
-- Creates the project AND its owner membership. The partial unique index uq_project_members_owner
-- guarantees AT MOST one owner per project; nothing in the schema forces one to exist, so this
-- function is what guarantees AT LEAST one: every project must be created through it.
-- Safe to run more than once (CREATE OR REPLACE); the runner re-applies it on every run:
--
--   psql "$DATABASE_URL" -f database/procedures/access_procedures.sql
--
-- Errors (CONTRACT 7), checked in this order:
--   23514  title is NULL or blank (same meaning as ck_projects_title_not_blank)
--   23505  title already used (case-sensitive, as uq_projects_title; also the final answer for a
--          concurrent duplicate, see below)
--   EB002  p_owner_id is NULL; the owner is deactivated (users.active = false); the owner holds
--          neither the global role administrator nor principal_investigator
--   23503  p_owner_id is not a user (same meaning as fk_projects_created_by)
--   No other error code is raised on purpose (no 23502, no P0001).
--
-- Role check (interpretation, flagged for review): CONTRACT 9 lets administrator and
-- principal_investigator create projects. The signature has one p_owner_id that becomes both
-- created_by and the owner, so the check is applied to that user. To drop it, delete the
-- "allowed to create projects" block below; A's authorize('create_project') still guards the route.
--
-- All or nothing. The function runs inside the caller's transaction and never COMMITs or ROLLs
-- BACK. If the membership insert fails after the project insert, PostgreSQL aborts the whole
-- transaction on the unhandled error, so the guarantee is: the caller's transaction ends in COMMIT
-- (both rows) or ROLLBACK (neither row). withTransaction does exactly that. No EXCEPTION block is
-- used, so errors are never swallowed and no subtransaction is created per call.
--
-- Concurrency. Two calls with the same title: the second blocks on the uq_projects_title index
-- until the first commits or rolls back, then fails with 23505 (or succeeds if the first rolled
-- back); a second project is never created. The owner row is locked with FOR SHARE so the checks
-- (exists, active, role) and the membership insert see the same user: the user cannot be
-- deactivated or deleted by another transaction in between. No table-level lock is taken.
-- Different titles never interfere.
--
-- Audit. p_owner_id is recorded as the acting user (app.current_user_id, transaction-local) only if
-- the caller has not already set it; once the T17 triggers are attached, the two inserts are
-- audited with that actor. Identity values are consumed even when a call fails, so project ids can
-- have gaps: normal PostgreSQL behaviour, do not "fix" it.
--
-- Usage (the backend passes these as $1 .. $4):
--   SELECT create_project_with_owner('New survey', 'Objectives', DATE '2026-06-01', 2);
--     -> project_id (>= 1000) of a new 'planned' project owned by user 2
--   SELECT create_project_with_owner('New survey', NULL, NULL, 3);
--     -> ERROR EB002: user 3 may not create projects (needs administrator or principal_investigator)

-- --------------------------------------------------------------------------------------------
-- Helper
-- --------------------------------------------------------------------------------------------

-- Records the acting user for the audit trigger when the caller has not already set it.
CREATE OR REPLACE FUNCTION fn_access_set_actor(p_actor_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_actor_id IS NOT NULL AND COALESCE(current_setting('app.current_user_id', true), '') = '' THEN
        PERFORM set_config('app.current_user_id', p_actor_id::text, true);  -- local to the transaction
    END IF;
END;
$$;

-- --------------------------------------------------------------------------------------------
-- create_project_with_owner: new 'planned' project plus the owner membership
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_project_with_owner(
    p_title      text,
    p_objectives text,
    p_start_date date,
    p_owner_id   bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_active     boolean;
    v_may_create boolean;
    v_project_id bigint;
BEGIN
    -- 1. Title. Only the blank test trims; the stored title is exactly what the caller sent.
    IF p_title IS NULL OR btrim(p_title) = '' THEN
        RAISE EXCEPTION 'Project title must not be empty'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'ck_projects_title_not_blank';
    END IF;
    IF EXISTS (SELECT 1 FROM projects WHERE title = p_title) THEN
        RAISE EXCEPTION 'A project titled "%" already exists', p_title
            USING ERRCODE = '23505',
                  DETAIL = 'Project titles are unique.',
                  CONSTRAINT = 'uq_projects_title';
    END IF;

    -- 2. Owner. FOR SHARE keeps the user row stable until the end of the transaction.
    IF p_owner_id IS NULL THEN
        RAISE EXCEPTION 'A project owner is required' USING ERRCODE = 'EB002';
    END IF;
    SELECT u.active INTO v_active
    FROM users u
    WHERE u.user_id = p_owner_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % does not exist', p_owner_id
            USING ERRCODE = '23503',
                  CONSTRAINT = 'fk_projects_created_by';
    END IF;
    IF NOT v_active THEN
        RAISE EXCEPTION 'User % is deactivated and cannot own a project', p_owner_id
            USING ERRCODE = 'EB002';
    END IF;

    -- 3. Allowed to create projects (CONTRACT 9): administrator or principal_investigator.
    SELECT EXISTS (
        SELECT 1
        FROM user_roles ur
        JOIN roles r ON r.role_id = ur.role_id
        WHERE ur.user_id = p_owner_id
          AND r.role_name IN ('administrator', 'principal_investigator')
    ) INTO v_may_create;
    IF NOT v_may_create THEN
        RAISE EXCEPTION 'User % may not create projects (needs the administrator or principal_investigator role)',
                p_owner_id
            USING ERRCODE = 'EB002',
                  DETAIL = 'Allowed roles: administrator, principal_investigator.';
    END IF;

    -- Writes. status stays at its default 'planned'; the ids come from the identity columns.
    PERFORM fn_access_set_actor(p_owner_id);

    INSERT INTO projects (title, objectives, start_date, created_by)
    VALUES (p_title, p_objectives, p_start_date, p_owner_id)
    RETURNING project_id INTO v_project_id;

    INSERT INTO project_members (project_id, user_id, project_role)
    VALUES (v_project_id, p_owner_id, 'owner');

    RETURN v_project_id;
END;
$$;
