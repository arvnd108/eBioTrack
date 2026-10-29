-- Owner: B (Frontend)
-- Purpose: 1 trigger: Laboratory & Sequencing
--
-- Issue #30 / T17-B. Rules from CONTRACT 3 (run status transitions) and 4.3. Safe to run more
-- than once (CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS):
--
--   psql "$DATABASE_URL" -f database/triggers/lab_triggers.sql
--
-- These triggers fire on INSERT/UPDATE only, so they can be created before or after the seeds:
-- every seeded library comes from a passing extraction, and seeded runs are inserted, not updated.
--
-- 1. trg_sequencing_libraries_qc_pass (BEFORE INSERT OR UPDATE OF extraction_id)
--    A library may only be built from an extraction whose qc_status is 'pass' (EB002). This
--    holds even for SQL that bypasses create_sequencing_run() / assign_extraction_to_run().
-- 2. trg_sequencing_runs_status (BEFORE UPDATE OF status)
--    Allowed: planned -> running, running -> completed, running -> failed, planned -> failed.
--    Anything else raises EB001. Updating other columns without changing status is allowed.
-- 3. Audit (CONTRACT 7): Dhruve's audit_row_change() attached AFTER INSERT OR UPDATE OR DELETE
--    to dna_extractions, sequencing_libraries, sequencing_runs and quality_control_results.
--    Until T17-C (#31) creates that function, this block skips with a NOTICE; run this file
--    again once it exists and the four triggers are attached.

-- --------------------------------------------------------------------------------------------
-- 1. Only extractions that passed QC can become libraries
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sequencing_libraries_qc_pass() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_qc_status qc_status;
BEGIN
    SELECT qc_status INTO v_qc_status FROM dna_extractions WHERE extraction_id = NEW.extraction_id;

    -- A missing extraction is left to fk_sequencing_libraries_extraction_id (23503).
    IF FOUND AND v_qc_status <> 'pass' THEN
        RAISE EXCEPTION 'Extraction % has not passed QC (qc_status %); it cannot be sequenced',
                NEW.extraction_id, v_qc_status
            USING ERRCODE = 'EB002',
                  DETAIL = 'Only extractions with qc_status pass can become sequencing libraries.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sequencing_libraries_qc_pass ON sequencing_libraries;
CREATE TRIGGER trg_sequencing_libraries_qc_pass
    BEFORE INSERT OR UPDATE OF extraction_id ON sequencing_libraries
    FOR EACH ROW EXECUTE FUNCTION fn_sequencing_libraries_qc_pass();

-- --------------------------------------------------------------------------------------------
-- 2. Sequencing run status transitions
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sequencing_runs_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'planned' AND NEW.status IN ('running', 'failed'))
        OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'Run % cannot move from % to %', OLD.run_code, OLD.status, NEW.status
            USING ERRCODE = 'EB001',
                  DETAIL = 'Allowed: planned -> running, running -> completed or failed, planned -> failed.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sequencing_runs_status ON sequencing_runs;
CREATE TRIGGER trg_sequencing_runs_status
    BEFORE UPDATE OF status ON sequencing_runs
    FOR EACH ROW EXECUTE FUNCTION fn_sequencing_runs_status();

-- --------------------------------------------------------------------------------------------
-- 3. Audit triggers (need audit_row_change() from T17-C)
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
    t record;
BEGIN
    IF to_regprocedure('audit_row_change()') IS NULL THEN
        RAISE NOTICE 'audit_row_change() does not exist yet (T17-C); lab audit triggers not attached. Run this file again after it lands.';
        RETURN;
    END IF;

    FOR t IN
        SELECT * FROM (VALUES
            ('dna_extractions',         'extraction_id'),
            ('sequencing_libraries',    'library_id'),
            ('sequencing_runs',         'run_id'),
            ('quality_control_results', 'qc_id')
        ) AS v(table_name, pk_column)
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || t.table_name || '_audit', t.table_name);
        EXECUTE format(
            'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION audit_row_change(%L)',
            'trg_' || t.table_name || '_audit', t.table_name, t.pk_column
        );
    END LOOP;
END;
$$;
