-- Owner: C (Testing & QA)
-- Purpose: 1 trigger: Access, Projects & Audit
--
-- T17-C. audit_row_change() is the generic audit trigger (CONTRACT 7): an AFTER INSERT OR UPDATE OR
-- DELETE row trigger that writes one audit_logs row per changed row, plus its attachments to this
-- slice's tables. Safe to run more than once (CREATE OR REPLACE FUNCTION / TRIGGER); the runner
-- re-applies it on every run, after the seeds, so seed rows are not audited:
--
--   psql "$DATABASE_URL" -f database/triggers/access_triggers.sql
--
-- FILE ORDER MATTERS. The runner applies triggers alphabetically, and analysis_, field_ and
-- lab_triggers.sql attach audit_row_change(), so this file must sort first. Do not rename it.
--
-- Attach (one line per table; the first argument is the primary key column):
--   CREATE OR REPLACE TRIGGER trg_<table>_audit
--       AFTER INSERT OR UPDATE OR DELETE ON <table>
--       FOR EACH ROW EXECUTE FUNCTION audit_row_change('<pk_column>' [, '<column to leave out>' ...]);
-- Optional extra arguments name columns that are left out of details (for example a noisy
-- timestamp). For a composite key pass the parent id column: entity_id is then the parent and the
-- whole row is in details. password_hash is ALWAYS left out, whatever the arguments. Never attach
-- it to audit_logs, schema_migrations, schema_seeds or sessions.
--
-- What it writes:
--   entity_type  the table name (TG_TABLE_NAME), no schema
--   entity_id    the TG_ARGV[0] column of the row (OLD for DELETE), read from the row's JSON image
--   action       insert, update or delete (approve, reject, login, export are written elsewhere)
--   actor_id     current_setting('app.current_user_id', true): unset/empty -> NULL (system action);
--                digits -> that user (the FK then checks it exists: an unknown id raises 23503 and
--                aborts the business write on purpose); anything else -> NULL plus a WARNING
--   details      always a JSON object:
--                  insert  {"col": {"new": v}, ...}
--                  update  {"col": {"old": v1, "new": v2}, ...}   changed columns only
--                  delete  {"col": {"old": v}, ...}
--                Top-level keys are column names, so "changed fields" are just the keys. An update
--                that changes nothing (after leaving out excluded columns) writes no row.
--
-- Errors: misuse (no TG_ARGV[0], a key column the table does not have, not a row trigger) raises
-- invalid_parameter_value (22023) naming the table; it is a developer error, not an API path.
-- SECURITY INVOKER: the trigger runs as the calling role, which needs INSERT on audit_logs
-- (ebiotrack_app has it, but not UPDATE/DELETE: the log is append-only). No dynamic SQL.

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_row     jsonb;
    v_old     jsonb;
    v_new     jsonb;
    v_skip    text[];
    v_entity  bigint;
    v_actor   bigint;
    v_setting text;
    v_details jsonb;
    v_action  audit_action;
BEGIN
    -- Never audit the audit log itself (recursion guard).
    IF TG_TABLE_NAME = 'audit_logs' THEN
        RETURN NULL;
    END IF;

    IF TG_LEVEL <> 'ROW' OR TG_NARGS < 1 THEN
        RAISE EXCEPTION 'audit_row_change() on table % must be a row trigger with the primary key column as its first argument',
                TG_TABLE_NAME
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_row := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
    IF NOT (v_row ? TG_ARGV[0]) THEN
        RAISE EXCEPTION 'audit_row_change() on table %: key column "%" does not exist', TG_TABLE_NAME, TG_ARGV[0]
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_entity := (v_row ->> TG_ARGV[0])::bigint;

    -- Columns that never reach the log: password_hash always, plus the extra arguments.
    SELECT ARRAY['password_hash'] || COALESCE(array_agg(a), '{}')
      INTO v_skip
      FROM unnest(TG_ARGV) WITH ORDINALITY AS u(a, n)
     WHERE n > 1;

    IF TG_OP = 'INSERT' THEN
        v_action := 'insert';
        v_new := v_row - v_skip;
        SELECT jsonb_object_agg(e.key, jsonb_build_object('new', e.value))
          INTO v_details
          FROM jsonb_each(v_new) AS e;
    ELSIF TG_OP = 'DELETE' THEN
        v_action := 'delete';
        v_old := v_row - v_skip;
        SELECT jsonb_object_agg(e.key, jsonb_build_object('old', e.value))
          INTO v_details
          FROM jsonb_each(v_old) AS e;
    ELSE
        v_action := 'update';
        v_old := to_jsonb(OLD) - v_skip;
        v_new := to_jsonb(NEW) - v_skip;
        SELECT jsonb_object_agg(n.key, jsonb_build_object('old', v_old -> n.key, 'new', n.value))
          INTO v_details
          FROM jsonb_each(v_new) AS n
         WHERE n.value IS DISTINCT FROM (v_old -> n.key);
        IF v_details IS NULL THEN
            RETURN NULL;  -- nothing the log cares about changed
        END IF;
    END IF;

    -- Acting user (CONTRACT 7). A malformed value must not abort the business write.
    v_setting := NULLIF(current_setting('app.current_user_id', true), '');
    IF v_setting IS NULL THEN
        v_actor := NULL;
    ELSIF v_setting ~ '^[0-9]{1,18}$' THEN
        v_actor := v_setting::bigint;
    ELSE
        RAISE WARNING 'audit_row_change(): app.current_user_id "%" is not a user id; logging a system action', v_setting;
        v_actor := NULL;
    END IF;

    INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, details)
    VALUES (v_actor, TG_TABLE_NAME, v_entity, v_action, COALESCE(v_details, '{}'::jsonb));

    RETURN NULL;  -- the return value of an AFTER row trigger is ignored
END;
$$;

COMMENT ON FUNCTION audit_row_change() IS
    'Generic audit trigger: one audit_logs row per changed row. TG_ARGV[0] = primary key column, TG_ARGV[1..] = columns to leave out of details; password_hash is always left out.';

-- --------------------------------------------------------------------------------------------
-- Attachments: this slice's tables (roles is a fixed lookup, audit_logs is the log itself)
-- --------------------------------------------------------------------------------------------

-- last_login_at changes on every login and would flood the log (the login action is written by the app).
CREATE OR REPLACE TRIGGER trg_users_audit
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('user_id', 'last_login_at');

-- Composite-key link tables: entity_id is the parent, the full row is in details.
CREATE OR REPLACE TRIGGER trg_user_roles_audit
    AFTER INSERT OR UPDATE OR DELETE ON user_roles
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('user_id');

CREATE OR REPLACE TRIGGER trg_projects_audit
    AFTER INSERT OR UPDATE OR DELETE ON projects
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('project_id');

CREATE OR REPLACE TRIGGER trg_project_members_audit
    AFTER INSERT OR UPDATE OR DELETE ON project_members
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('project_id');

CREATE OR REPLACE TRIGGER trg_project_sites_audit
    AFTER INSERT OR UPDATE OR DELETE ON project_sites
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('project_id');
