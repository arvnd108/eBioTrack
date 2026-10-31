-- Owner: A (Backend)
-- Purpose: 1 trigger: Analysis, Taxonomy & Analytics
--
-- T17-A. Rules from CONTRACT 3 (analysis_runs status transitions, supersession), 4.4, 7 and D19:
-- approved results are the scientific record and are never edited in place; a correction is a new
-- run. Safe to run more than once (CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS):
--
--   psql "$DATABASE_URL" -f database/triggers/analysis_triggers.sql
--
-- INSTALL ORDER. The runner applies triggers after the seeds, alphabetically by file; this file
-- sorts after access_triggers.sql, which creates audit_row_change(). Do not rename either file.
-- Because triggers load after the seeds, seed rows fire nothing and are not audited.
--
-- 1. trg_analysis_runs_status (BEFORE UPDATE OF status, row)      fn_analysis_runs_status()
--    Allowed (CONTRACT 3): draft -> imported | rejected; imported -> approved | rejected;
--    approved -> superseded; rejected -> draft; superseded -> nothing. Any other change of status
--    raises EB001. Extra rules (EB002 unless noted):
--      imported -> approved needs imported_by and approved_by set and approved_by <> imported_by
--        (D17, defence in depth; approve_analysis() and the CHECK also enforce parts of this)
--      approved -> superseded needs a correction that is ALREADY approved:
--        EXISTS (analysis_runs c WHERE c.supersedes_analysis_id = OLD.analysis_id AND c.status =
--        'approved'), otherwise EB001. approve_analysis() updates the correction to 'approved'
--        first and the old run to 'superseded' second, so the check sees the correction.
--    Updates that do not change status pass. The trigger takes no lock: the caller holds the row.
-- 2. trg_analysis_runs_immutable (BEFORE UPDATE OR DELETE, row)   fn_analysis_runs_immutable()
--    For rows whose OLD.status is approved or superseded: DELETE is always EB002 (D19). UPDATE of
--    an approved row may change ONLY status, and only to superseded; any other column change
--    (parameters, pipeline fields, approved_by, approved_at, run_id, marker_id, supersedes_...)
--    raises EB002 naming the first changed column (alphabetically). UPDATE of a superseded row may
--    change nothing: a changed column is EB002, a status change EB001. A status change of an
--    approved row to anything but superseded raises EB001 here too, so the trigger is correct
--    without trigger 1 (neither relies on the other's order; they fire alphabetically, this one
--    first). Columns are compared through to_jsonb(NEW) - 'status' against to_jsonb(OLD), so a
--    column added later is protected without editing this file. Rows in draft, imported and
--    rejected can still be edited (the import workflow needs it), with one exception: a run that
--    has left draft/rejected cannot change supersedes_analysis_id (EB002), so the supersession
--    link cannot be re-pointed after import.
--    DELETE of draft, imported or rejected analyses stays allowed (decision for review: D19 is
--    about approved results; tests and the volume generator delete drafts).
-- 3. trg_taxon_assignments_immutable (BEFORE INSERT OR UPDATE OR DELETE, row)
--                                                                 fn_taxon_assignments_immutable()
--    INSERT into, UPDATE from or into, and DELETE from an approved or superseded analysis raise
--    EB002 (an assignment cannot be moved into an approved analysis by changing analysis_id).
--    Assignments of draft, imported and rejected analyses can change (a rejected analysis that is
--    reopened as draft is re-imported). A missing parent is left to fk_taxon_assignments_analysis_id
--    (23503): the SELECT finding nothing returns NEW/OLD untouched.
--    RACE AGAINST APPROVAL. approve_analysis() holds FOR UPDATE on the analysis row. A plain
--    SELECT of the parent's status could still read the old 'imported' value, and the writer would
--    commit after the approval and silently change an approved result. So the trigger reads the
--    parent with SELECT ... FOR SHARE: it conflicts with the approver's FOR UPDATE, the writer
--    waits for the approval to commit, then (READ COMMITTED re-reads the locked row) sees
--    'approved' and is refused. Conversely an open writer's FOR SHARE makes approve_analysis wait
--    for it, so the approval always includes every committed row. import_detections() holds
--    FOR UPDATE and then inserts: taking FOR SHARE on a row the same transaction already holds
--    FOR UPDATE on never conflicts with itself, so there is no deadlock. When an UPDATE touches two
--    analyses, the parents are locked in ascending analysis_id order. A writer waiting on a
--    correction's approval that also needs the run being superseded could in theory deadlock;
--    PostgreSQL would abort one side with 40P01 (never a lost update).
-- 4. Audit (CONTRACT 7): audit_row_change() AFTER INSERT OR UPDATE OR DELETE on analysis_runs,
--    taxa, dna_markers and data_exports. taxon_assignments is deliberately NOT audited row by row:
--    measured on a bulk insert, the row trigger made it about 3x slower (1 000 rows 10 -> 35 ms,
--    10 000 rows 94 -> 298 ms, 50 000 rows 554 -> 1 690 ms) and added about 470 bytes of audit_logs
--    per row (23 MB for 50 000 rows). The detections of a run are immutable once approved and
--    import_detections() already writes one summary audit entry with the row counts.
--
-- Why EB002 and not EB001 for a forbidden edit: EB001 is reserved for illegal STATUS transitions
-- (CONTRACT 7, 409); an edit of an approved result is a business rule violation (422). Flagged for
-- review.
-- Limit: a superuser or the table owner can ALTER TABLE ... DISABLE TRIGGER; this protects every
-- ordinary role (including ebiotrack_app) but not someone who may change the schema.
--
-- Interaction with the procedures (T16-A). import_detections() inserts into a draft analysis and
-- then moves it to imported; approve_analysis() moves imported -> approved (and a correction's old
-- run approved -> superseded after the correction); reject_analysis() moves draft or imported ->
-- rejected. All of these are allowed above. Audit: each procedure writes its explicit entry
-- (approve, reject, and an update on the superseded run) and the audit trigger adds the row-level
-- entries on analysis_runs (update with the column diff).

-- --------------------------------------------------------------------------------------------
-- 1. analysis_runs status transitions
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_analysis_runs_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT (
           (OLD.status = 'draft'    AND NEW.status IN ('imported', 'rejected'))
        OR (OLD.status = 'imported' AND NEW.status IN ('approved', 'rejected'))
        OR (OLD.status = 'approved' AND NEW.status = 'superseded')
        OR (OLD.status = 'rejected' AND NEW.status = 'draft')
    ) THEN
        RAISE EXCEPTION 'Analysis % cannot move from % to %', OLD.analysis_id, OLD.status, NEW.status
            USING ERRCODE = 'EB001',
                  DETAIL = 'Allowed: draft -> imported or rejected, imported -> approved or rejected, approved -> superseded, rejected -> draft.';
    END IF;

    IF OLD.status = 'imported' AND NEW.status = 'approved' THEN
        IF NEW.imported_by IS NULL OR NEW.approved_by IS NULL OR NEW.approved_by = NEW.imported_by THEN
            RAISE EXCEPTION 'Analysis % cannot be approved without a different approver than the importer', OLD.analysis_id
                USING ERRCODE = 'EB002',
                      DETAIL = format('imported_by %s, approved_by %s (D17).', NEW.imported_by, NEW.approved_by);
        END IF;
    ELSIF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
        IF NOT EXISTS (
            SELECT 1 FROM analysis_runs c
            WHERE c.supersedes_analysis_id = OLD.analysis_id AND c.status = 'approved'
        ) THEN
            RAISE EXCEPTION 'Analysis % can only be superseded by an approved correction', OLD.analysis_id
                USING ERRCODE = 'EB001',
                      DETAIL = 'No analysis with supersedes_analysis_id = this one is approved yet.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_analysis_runs_status() IS
    'Enforces the analysis_runs status transition table (EB001), the approver-not-importer rule and that a run is superseded only by an approved correction.';

DROP TRIGGER IF EXISTS trg_analysis_runs_status ON analysis_runs;
CREATE TRIGGER trg_analysis_runs_status
    BEFORE UPDATE OF status ON analysis_runs
    FOR EACH ROW EXECUTE FUNCTION fn_analysis_runs_status();

-- --------------------------------------------------------------------------------------------
-- 2. approved and superseded analysis_runs are read-only
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_analysis_runs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_column text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('approved', 'superseded') THEN
            RAISE EXCEPTION 'Analysis % is % and cannot be deleted', OLD.analysis_id, OLD.status
                USING ERRCODE = 'EB002',
                      DETAIL = 'Scientific records are never hard-deleted (D19); correct an approved result with a new run.';
        END IF;
        RETURN OLD;
    END IF;

    -- UPDATE. The first changed column other than status, alphabetically (no hand-written list).
    SELECT n.key INTO v_column
    FROM jsonb_each(to_jsonb(NEW) - 'status') AS n
    WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
    ORDER BY n.key
    LIMIT 1;

    IF OLD.status IN ('approved', 'superseded') THEN
        IF v_column IS NOT NULL THEN
            RAISE EXCEPTION 'Analysis % is % and column % cannot be changed', OLD.analysis_id, OLD.status, v_column
                USING ERRCODE = 'EB002',
                      DETAIL = 'Approved results are never edited in place; a correction is a new analysis run.';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status
           AND NOT (OLD.status = 'approved' AND NEW.status = 'superseded') THEN
            RAISE EXCEPTION 'Analysis % cannot move from % to %', OLD.analysis_id, OLD.status, NEW.status
                USING ERRCODE = 'EB001',
                      DETAIL = 'An approved analysis can only become superseded; a superseded one never changes.';
        END IF;
    ELSIF OLD.status NOT IN ('draft', 'rejected')
          AND NEW.supersedes_analysis_id IS DISTINCT FROM OLD.supersedes_analysis_id THEN
        RAISE EXCEPTION 'Analysis % has left draft and column supersedes_analysis_id cannot be changed', OLD.analysis_id
            USING ERRCODE = 'EB002',
                  DETAIL = 'The supersession link is fixed once a run has been imported.';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_analysis_runs_immutable() IS
    'Approved and superseded analysis_runs are read-only (EB002): no delete, no column edits; an approved run may only become superseded. supersedes_analysis_id is fixed once a run has left draft/rejected.';

DROP TRIGGER IF EXISTS trg_analysis_runs_immutable ON analysis_runs;
CREATE TRIGGER trg_analysis_runs_immutable
    BEFORE UPDATE OR DELETE ON analysis_runs
    FOR EACH ROW EXECUTE FUNCTION fn_analysis_runs_immutable();

-- --------------------------------------------------------------------------------------------
-- 3. detections of approved and superseded analyses are read-only
-- --------------------------------------------------------------------------------------------
-- Locks one parent analysis FOR SHARE (see the race argument above) and refuses if it is
-- approved or superseded. A missing parent returns quietly: the foreign key reports it.
CREATE OR REPLACE FUNCTION fn_taxon_assignments_check_parent(p_analysis_id bigint, p_op text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_status analysis_status;
BEGIN
    SELECT ar.status INTO v_status
    FROM analysis_runs ar
    WHERE ar.analysis_id = p_analysis_id
    FOR SHARE;
    IF FOUND AND v_status IN ('approved', 'superseded') THEN
        RAISE EXCEPTION 'Analysis % is % and its detections cannot be %', p_analysis_id, v_status, p_op
            USING ERRCODE = 'EB002',
                  DETAIL = 'Approved results are never edited in place; a correction is a new analysis run.';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fn_taxon_assignments_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_taxon_assignments_check_parent(NEW.analysis_id, 'added to');
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM fn_taxon_assignments_check_parent(OLD.analysis_id, 'deleted');
        RETURN OLD;
    END IF;

    -- UPDATE: old and new parent, in ascending id order so two writers never lock in a cycle.
    IF OLD.analysis_id <= NEW.analysis_id THEN
        PERFORM fn_taxon_assignments_check_parent(OLD.analysis_id, 'changed');
        IF NEW.analysis_id <> OLD.analysis_id THEN
            PERFORM fn_taxon_assignments_check_parent(NEW.analysis_id, 'added to');
        END IF;
    ELSE
        PERFORM fn_taxon_assignments_check_parent(NEW.analysis_id, 'added to');
        PERFORM fn_taxon_assignments_check_parent(OLD.analysis_id, 'changed');
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_taxon_assignments_immutable() IS
    'Detections of approved or superseded analyses cannot be inserted, updated, moved or deleted (EB002). The parent is read FOR SHARE so a concurrent approval cannot be overtaken.';

DROP TRIGGER IF EXISTS trg_taxon_assignments_immutable ON taxon_assignments;
CREATE TRIGGER trg_taxon_assignments_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON taxon_assignments
    FOR EACH ROW EXECUTE FUNCTION fn_taxon_assignments_immutable();

-- --------------------------------------------------------------------------------------------
-- 4. Audit triggers (need audit_row_change() from T17-C)
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
    t record;
BEGIN
    IF to_regprocedure('audit_row_change()') IS NULL THEN
        RAISE NOTICE 'audit_row_change() does not exist; analysis audit triggers not attached. Run this file again after it lands.';
        RETURN;
    END IF;

    -- Not audited row by row (see header); also removes the trigger from an earlier version.
    DROP TRIGGER IF EXISTS trg_taxon_assignments_audit ON taxon_assignments;

    FOR t IN
        SELECT * FROM (VALUES
            ('analysis_runs',     'analysis_id'),
            ('taxa',              'taxon_id'),
            ('dna_markers',       'marker_id'),
            ('data_exports',      'export_id')
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
