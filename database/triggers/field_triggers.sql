-- Owner: D (Docs & Demo)
-- Purpose: Enforce sample status transitions and keep sample_status_history in sync.
-- Issue #32 / T17-D. Allowed transitions are defined in planning/CONTRACT.md section 3.
--
-- Installed by backend/src/db/migrate.js after migrations, on every run. To apply by hand:
--   psql "$DATABASE_URL" -f database/triggers/field_triggers.sql
--
-- register_sample() (T16-D) writes the first history row when a sample is inserted.
-- These triggers therefore handle UPDATEs only and do not duplicate that initial row.
--
-- Audit integration: attach audit_row_change() to samples, collection_events and sampling_sites
-- once T17-C's audit function has been merged and is available on the target branch. It is not
-- defined by this file, so referencing it before T17-C lands would make a clean install fail.

-- Re-running this file replaces the trigger functions and recreates the triggers safely.
DROP TRIGGER IF EXISTS trg_samples_status_transition ON samples;
DROP TRIGGER IF EXISTS trg_samples_status_history ON samples;

-- BEFORE trigger: reject any status change that is not in the contract transition table.
CREATE OR REPLACE FUNCTION enforce_sample_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- A normal update that does not change status is not a transition.
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (OLD.status = 'collected' AND NEW.status IN ('stored', 'failed', 'discarded'))
        OR (OLD.status = 'stored' AND NEW.status IN ('extracted', 'failed', 'discarded'))
        OR (OLD.status = 'extracted' AND NEW.status IN ('sequenced', 'failed', 'discarded'))
        OR (OLD.status = 'sequenced' AND NEW.status IN ('analyzed', 'failed'))
        OR (OLD.status = 'failed' AND NEW.status = 'discarded')
    ) THEN
        RAISE EXCEPTION 'Invalid sample status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'EB001';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_samples_status_transition
BEFORE UPDATE OF status ON samples
FOR EACH ROW
EXECUTE FUNCTION enforce_sample_status_transition();

-- AFTER trigger: record every successful status change in the history table.
CREATE OR REPLACE FUNCTION record_sample_status_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_actor_id BIGINT;
BEGIN
    -- The backend sets this transaction-local value for requests that write. It may be NULL
    -- for a maintenance/manual SQL operation, so preserve NULL instead of raising a cast error.
    v_actor_id := NULLIF(current_setting('app.current_user_id', true), '')::BIGINT;

    INSERT INTO sample_status_history (
        sample_id,
        old_status,
        new_status,
        changed_by,
        note
    )
    VALUES (
        NEW.sample_id,
        OLD.status,
        NEW.status,
        v_actor_id,
        NULL
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_samples_status_history
AFTER UPDATE OF status ON samples
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION record_sample_status_history();

COMMENT ON FUNCTION enforce_sample_status_transition() IS
    'Rejects sample status changes not permitted by CONTRACT 3 using SQLSTATE EB001.';
COMMENT ON FUNCTION record_sample_status_history() IS
    'Writes one history row after each successful sample status change, using app.current_user_id as changed_by.';

-- Audit triggers: T17-C owns audit_row_change(). This conditional block keeps a fresh
-- install working before T17-C is merged; re-running this file after T17-C lands
-- attaches the audit triggers automatically (same pattern as the lab trigger slice).
DO $$
BEGIN
    IF to_regprocedure('audit_row_change()') IS NULL THEN
        RAISE NOTICE 'audit_row_change() is not installed yet; skipping Field & Samples audit triggers';
    ELSE
        EXECUTE 'DROP TRIGGER IF EXISTS trg_samples_audit ON samples';
        EXECUTE 'CREATE TRIGGER trg_samples_audit
                 AFTER INSERT OR UPDATE OR DELETE ON samples
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(''sample_id'')';

        EXECUTE 'DROP TRIGGER IF EXISTS trg_collection_events_audit ON collection_events';
        EXECUTE 'CREATE TRIGGER trg_collection_events_audit
                 AFTER INSERT OR UPDATE OR DELETE ON collection_events
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(''event_id'')';

        EXECUTE 'DROP TRIGGER IF EXISTS trg_sampling_sites_audit ON sampling_sites';
        EXECUTE 'CREATE TRIGGER trg_sampling_sites_audit
                 AFTER INSERT OR UPDATE OR DELETE ON sampling_sites
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(''site_id'')';
    END IF;
END;
$$;
