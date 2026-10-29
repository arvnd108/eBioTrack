-- Owner: C (Testing & QA)
-- Purpose: Database roles and grants
--
-- Standalone and idempotent (not a numbered migration; migrate.js does not run it). Safe to run
-- repeatedly, and before or after the other slices' tables exist:
--   psql -U ebiotrack -d ebiotrack -f database/roles/grants.sql
--
-- Roles are NOLOGIN group roles; there are no passwords in this repository.
--   ebiotrack_readonly  SELECT only (reporting, read-only demo)
--   ebiotrack_app       what the API would connect as: no DDL, no DELETE except on link tables
--                       (D19), and audit_logs is append-only
--   ebiotrack_admin     migration/maintenance; ALL on public objects. The docker-compose user
--                       `ebiotrack` owns the objects and acts as the superuser-like owner.

DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['ebiotrack_readonly', 'ebiotrack_app', 'ebiotrack_admin'] LOOP
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO ebiotrack_readonly, ebiotrack_app, ebiotrack_admin;

-- Broad grants on what exists now.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ebiotrack_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ebiotrack_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ebiotrack_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ebiotrack_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO ebiotrack_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ebiotrack_admin;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ebiotrack_admin;

-- Objects created later. Default privileges only cover objects created by the role named in FOR
-- ROLE, so this assumes migrations run as `ebiotrack` (docker-compose). Re-run this script after
-- adding tables if migrations run as another role.
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT SELECT ON TABLES TO ebiotrack_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ebiotrack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ebiotrack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ebiotrack_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT ALL ON TABLES TO ebiotrack_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT ALL ON SEQUENCES TO ebiotrack_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack IN SCHEMA public GRANT ALL ON FUNCTIONS TO ebiotrack_admin;

-- Narrowing, applied after the broad grants and guarded so missing tables do not error.
DO $$
DECLARE
    t text;
BEGIN
    IF to_regclass('public.audit_logs') IS NOT NULL THEN
        REVOKE UPDATE, DELETE ON audit_logs FROM ebiotrack_app;
    END IF;
    -- D19: only link rows may be removed.
    FOREACH t IN ARRAY ARRAY['user_roles', 'project_members', 'project_sites'] LOOP
        IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
            EXECUTE format('GRANT DELETE ON %I TO ebiotrack_app', t);
        END IF;
    END LOOP;
END
$$;

-- Views are read-only (T15-C): the table-level grants above also cover views, so take the write
-- privileges back from the app role. Re-run this script after the views are (re)created.
DO $$
DECLARE
    v text;
BEGIN
    FOR v IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM ebiotrack_app', v);
    END LOOP;
END
$$;

-- Login roles are created per environment with a password supplied at run time, never committed:
--   psql -v api_password="'...'" -c "CREATE ROLE ebiotrack_api LOGIN PASSWORD :api_password IN ROLE ebiotrack_app"
-- Hardening idea (out of scope here): REVOKE ALL ON SCHEMA public FROM PUBLIC.

-- Verification (run manually):
--   SELECT has_table_privilege('ebiotrack_app', 'audit_logs', 'INSERT');       -- t
--   SELECT has_table_privilege('ebiotrack_app', 'audit_logs', 'UPDATE');       -- f
--   SELECT has_table_privilege('ebiotrack_app', 'projects', 'DELETE');         -- f
--   SELECT has_table_privilege('ebiotrack_app', 'project_members', 'DELETE');  -- t
--   SELECT has_table_privilege('ebiotrack_readonly', 'users', 'INSERT');       -- f
--   SELECT has_table_privilege('ebiotrack_app', 'v_project_summary', 'INSERT');  -- f (views are read-only)
--   SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
--    WHERE grantee LIKE 'ebiotrack_%' ORDER BY 1, 2, 3;
