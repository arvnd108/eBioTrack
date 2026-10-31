-- Owner: A (Backend)
-- Purpose: 1 stored procedure/function: Analysis, Taxonomy & Analytics
--
-- T16-A. Signatures from CONTRACT 7 (names, argument order and types are fixed):
--   import_detections(p_analysis_id bigint, p_rows jsonb, p_actor_id bigint)        RETURNS integer
--   approve_analysis(p_analysis_id bigint, p_actor_id bigint)                       RETURNS void
--   reject_analysis(p_analysis_id bigint, p_actor_id bigint, p_reason text)         RETURNS void
-- approve_analysis() is the course's stored procedure. "Insert detections" in its description is
-- done by import_detections(); approval is the controlled status change plus the audit entry.
-- Safe to run more than once (CREATE OR REPLACE); the runner re-applies it on every run:
--
--   psql "$DATABASE_URL" -f database/procedures/analysis_procedures.sql
--
-- Errors (CONTRACT 7). Messages are short sentences; extra detail is in DETAIL. No other code is
-- raised on purpose. Every function checks in this order: analysis exists (lock), actor, status.
--   EB001  illegal status transition (CONTRACT 3): import needs draft (rejected/superseded);
--          approve needs imported (draft/rejected/superseded) and, for a correction, an old run
--          that is still approved; reject needs draft or imported (approved/superseded)
--   EB002  business rule: analysis does not exist (chosen code, see below); actor unknown,
--          inactive or without the role; invalid import rows; importer approving their own
--          analysis; approving an analysis with no detections; blank reject reason
--   EB003  already processed: import on imported/approved, approve on approved, reject on rejected
--
-- Supersession (CONTRACT 1.3). A correction is a new run whose supersedes_analysis_id names the
-- approved run it replaces. approve_analysis() on the correction, in the same transaction and after
-- locking BOTH rows (the correction first, then the old run), updates the correction to 'approved'
-- FIRST and only then moves the old run to 'superseded', because the T17-A status trigger allows
-- approved -> superseded only when an approved correction already exists. If the old run is no
-- longer approved the whole call raises EB001 and nothing changes. Approving an ordinary run
-- (supersedes_analysis_id NULL) is unchanged. UNIQUE on the column means one correction per run.
--
-- Missing analysis: EB002 "Analysis N does not exist" in all three functions (a business-rule
-- failure the API maps to 422, as the task specifies). A 23503 would also be defensible because
-- the id is a foreign reference; flagged for review.
--
-- Acting user and roles (defence in depth; the route's authorize still guards the endpoint, and
-- project-membership checks stay in the middleware, not here). p_actor_id must exist and be active.
--   import:         administrator, principal_investigator or analyst (CONTRACT 9)
--   approve/reject: administrator or principal_investigator (D17)
-- app.current_user_id is set from p_actor_id only if the caller has not already set it (same
-- pattern as fn_access_set_actor / fn_lab_set_actor; own copy so this file stands alone).
--
-- Concurrency. Every function starts with SELECT ... FOR UPDATE on the analysis row. Two
-- simultaneous approve_analysis calls: both reach the lock, one waits; the first commits
-- 'approved'; the second then re-reads the row (READ COMMITTED gives it the new version), sees
-- 'approved' and raises EB003. Exactly one approval, one audit entry, one approved_at. Under
-- REPEATABLE READ the waiting caller would get a serialization failure (40001) instead of EB003
-- when it finally gets the lock, so the default READ COMMITTED is what we want; the backend uses
-- it. Imports and rejections serialise the same way (the loser gets EB003).
--
-- All or nothing. The functions run in the caller's transaction and never COMMIT or ROLLBACK, and
-- no EXCEPTION block is used, so errors are never swallowed: the caller's transaction ends in
-- COMMIT (all effects) or ROLLBACK (none). import_detections inserts every row in ONE statement
-- after validating all of them, so a bad row can never leave a partial import.
--
-- Audit. approve and reject write one audit_logs row each, action 'approve' / 'reject',
-- entity_type 'analysis_runs', actor_id = p_actor_id, details as below. import_detections writes
-- none: imported_by records who imported, and the row-level triggers (T17) will log the inserts.
-- When the generic audit_row_change() trigger is attached to analysis_runs it also logs an
-- 'update' row with the column diff for the same statement. The two do not duplicate: the
-- explicit entry carries the business action and its context (reason, counts, importer), the
-- trigger entry carries the raw column diff. The functions work whether or not it exists.
--   approve details: {"from_status","to_status","detection_count","importer_id"}, plus
--                    "supersedes_analysis_id" when the run is a correction
--   a correction also writes one entry on the old run: action 'update', entity_id = old run,
--                    {"from_status":"approved","to_status":"superseded","superseded_by"}
--   reject details:  {"from_status","to_status","reason"}
--
-- Import validation (see CONTRACT 12). Row numbers in messages are 1-based POSITIONS in the
-- p_rows array; the CSV header is file row 1, so array row i is file row i+1 (DETAIL says which).
-- Structure and types are checked first, row by row in array order with fields in a fixed order
-- (library_code, taxon_id, read_count, confidence, qc_flag), then library and taxon references,
-- then duplicates, each taking the lowest row. So the first failure is deterministic. Only the
-- first failure is raised; the API's dry run (outside the database, no flag here) reports all.
--
-- Usage (the backend passes these as $1 .. $3):
--   SELECT import_detections(4, '[{"library_code":"LIB-0001","taxon_id":8,"read_count":1450,
--          "confidence":0.9731,"qc_flag":"pass"}]'::jsonb, 5);   -> 1; analysis 4 is now imported
--   SELECT approve_analysis(3, 2);   -> void; analysis 3 approved by user 2, species 15 now visible
--   SELECT approve_analysis(3, 5);   -> ERROR EB002: user 5 may not approve analyses
--   SELECT approve_analysis(1, 2);   -> ERROR EB003: Analysis 1 is already approved
--   SELECT reject_analysis(4, 2, 'Wrong reference database');  -> void

-- --------------------------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------------------------

-- Records the acting user for the audit trigger when the caller has not already set it.
CREATE OR REPLACE FUNCTION fn_analysis_set_actor(p_actor_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_actor_id IS NOT NULL AND COALESCE(current_setting('app.current_user_id', true), '') = '' THEN
        PERFORM set_config('app.current_user_id', p_actor_id::text, true);  -- local to the transaction
    END IF;
END;
$$;

-- Locks and returns the analysis row; EB002 if it does not exist. Same lookup in all functions.
CREATE OR REPLACE FUNCTION fn_analysis_lock(p_analysis_id bigint) RETURNS analysis_runs
LANGUAGE plpgsql AS $$
DECLARE
    v_analysis analysis_runs;
BEGIN
    SELECT ar.* INTO v_analysis
    FROM analysis_runs ar
    WHERE ar.analysis_id = p_analysis_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Analysis % does not exist', p_analysis_id USING ERRCODE = 'EB002';
    END IF;
    RETURN v_analysis;
END;
$$;

-- The actor must exist, be active, and hold one of p_roles. p_what completes the message
-- ("user N may not <p_what>"). FOR SHARE keeps the user row stable until the transaction ends.
CREATE OR REPLACE FUNCTION fn_analysis_check_actor(p_actor_id bigint, p_roles text[], p_what text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_active boolean;
BEGIN
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'An acting user is required' USING ERRCODE = 'EB002';
    END IF;
    SELECT u.active INTO v_active FROM users u WHERE u.user_id = p_actor_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % does not exist', p_actor_id USING ERRCODE = 'EB002';
    END IF;
    IF NOT v_active THEN
        RAISE EXCEPTION 'User % is deactivated', p_actor_id USING ERRCODE = 'EB002';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM user_roles ur
        JOIN roles r ON r.role_id = ur.role_id
        WHERE ur.user_id = p_actor_id
          AND r.role_name = ANY (p_roles)
    ) THEN
        RAISE EXCEPTION 'User % may not %', p_actor_id, p_what
            USING ERRCODE = 'EB002',
                  DETAIL = format('Allowed roles: %s.', array_to_string(p_roles, ', '));
    END IF;
END;
$$;

-- Raises EB002 for one import row: names the row (array position, 1-based) and the field.
CREATE OR REPLACE FUNCTION fn_analysis_row_error(p_row integer, p_field text, p_problem text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Row %, field %: %', p_row, p_field, p_problem
        USING ERRCODE = 'EB002',
              DETAIL = format('Row numbers are positions in the array, starting at 1; in the CSV file the header is row 1, so this is file row %s.', p_row + 1);
END;
$$;

-- Structure and types of ONE import row (no table access). Fields are checked in a fixed order.
CREATE OR REPLACE FUNCTION fn_analysis_check_row(p_row integer, p_elem jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_keys  CONSTANT text[] := ARRAY['library_code', 'taxon_id', 'read_count', 'confidence', 'qc_flag'];
    v_key   text;
    v_num   numeric;
BEGIN
    IF jsonb_typeof(p_elem) <> 'object' THEN
        PERFORM fn_analysis_row_error(p_row, 'row', 'must be a JSON object');
    END IF;
    FOREACH v_key IN ARRAY v_keys LOOP
        IF NOT (p_elem ? v_key) THEN
            PERFORM fn_analysis_row_error(p_row, v_key, 'is required');
        END IF;
    END LOOP;
    SELECT k INTO v_key FROM jsonb_object_keys(p_elem) k WHERE k <> ALL (v_keys) ORDER BY k LIMIT 1;
    IF FOUND THEN
        PERFORM fn_analysis_row_error(p_row, v_key, 'is not an allowed field');
    END IF;

    IF jsonb_typeof(p_elem -> 'library_code') <> 'string' OR btrim(p_elem ->> 'library_code') = '' THEN
        PERFORM fn_analysis_row_error(p_row, 'library_code', 'must be a non-blank string');
    END IF;

    IF jsonb_typeof(p_elem -> 'taxon_id') <> 'number' THEN
        PERFORM fn_analysis_row_error(p_row, 'taxon_id', 'must be a number');
    END IF;
    v_num := (p_elem ->> 'taxon_id')::numeric;
    IF v_num <> trunc(v_num) OR v_num < 1 OR v_num > 9223372036854775807 THEN
        PERFORM fn_analysis_row_error(p_row, 'taxon_id', 'must be a whole number id');
    END IF;

    IF jsonb_typeof(p_elem -> 'read_count') <> 'number' THEN
        PERFORM fn_analysis_row_error(p_row, 'read_count', 'must be a number');
    END IF;
    v_num := (p_elem ->> 'read_count')::numeric;
    IF v_num <> trunc(v_num) OR v_num < 0 OR v_num > 2147483647 THEN
        PERFORM fn_analysis_row_error(p_row, 'read_count', 'must be a whole number from 0 to 2147483647');
    END IF;

    IF jsonb_typeof(p_elem -> 'confidence') <> 'number' THEN
        PERFORM fn_analysis_row_error(p_row, 'confidence', 'must be a number');
    END IF;
    v_num := (p_elem ->> 'confidence')::numeric;
    IF v_num < 0 OR v_num > 1 THEN
        PERFORM fn_analysis_row_error(p_row, 'confidence', 'must be from 0 to 1');
    END IF;

    IF jsonb_typeof(p_elem -> 'qc_flag') <> 'string'
       OR (p_elem ->> 'qc_flag') <> ALL (enum_range(NULL::qc_flag)::text[]) THEN
        PERFORM fn_analysis_row_error(p_row, 'qc_flag', 'must be one of pass, warn, fail');
    END IF;
END;
$$;

-- --------------------------------------------------------------------------------------------
-- import_detections: all rows of one CSV into taxon_assignments, draft -> imported
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION import_detections(
    p_analysis_id bigint,
    p_rows        jsonb,
    p_actor_id    bigint
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    v_analysis analysis_runs;
    v_row      integer;
    v_other    integer;
    v_text     text;
    v_tid      text;
    v_elem     jsonb;
    v_count    integer;
BEGIN
    -- 1. Analysis, actor, status.
    v_analysis := fn_analysis_lock(p_analysis_id);
    PERFORM fn_analysis_check_actor(p_actor_id, ARRAY['administrator', 'principal_investigator', 'analyst'],
                                    'import detections');
    IF v_analysis.status IN ('imported', 'approved') THEN
        RAISE EXCEPTION 'Analysis % is already %', p_analysis_id, v_analysis.status
            USING ERRCODE = 'EB003',
                  DETAIL = 'Detections can only be imported into a draft analysis.';
    ELSIF v_analysis.status <> 'draft' THEN
        RAISE EXCEPTION 'Analysis % is %; detections can only be imported into a draft analysis',
                p_analysis_id, v_analysis.status
            USING ERRCODE = 'EB001';
    END IF;

    -- 2. The payload is a non-empty array.
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'The detections must be a JSON array of rows' USING ERRCODE = 'EB002';
    END IF;
    IF jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'The detections array is empty; at least one row is required' USING ERRCODE = 'EB002';
    END IF;

    -- 3. Structure and types, row by row in array order (no table access, so a plain loop is cheap).
    FOR v_row, v_elem IN
        SELECT e.ord::integer, e.elem FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(elem, ord) ORDER BY e.ord
    LOOP
        PERFORM fn_analysis_check_row(v_row, v_elem);
    END LOOP;

    -- 4. Library exists and belongs to the sequencing run of this analysis. Lowest row first.
    SELECT r.ord::integer, r.lc, sl.run_id INTO v_row, v_text, v_other
    FROM (SELECT e.ord, e.elem ->> 'library_code' AS lc
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(elem, ord)) r
    LEFT JOIN sequencing_libraries sl ON sl.library_code = r.lc
    WHERE sl.library_id IS NULL OR sl.run_id <> v_analysis.run_id
    ORDER BY r.ord
    LIMIT 1;
    IF FOUND THEN
        IF v_other IS NULL THEN
            PERFORM fn_analysis_row_error(v_row, 'library_code', format('library %s does not exist', v_text));
        END IF;
        PERFORM fn_analysis_row_error(v_row, 'library_code',
                format('library %s belongs to another sequencing run (analysis %s uses run %s)',
                       v_text, p_analysis_id, v_analysis.run_id));
    END IF;

    -- 5. Taxon exists; unknown taxa are rejected, never created (D16).
    SELECT r.ord::integer, r.tid::text INTO v_row, v_text
    FROM (SELECT e.ord, (e.elem ->> 'taxon_id')::bigint AS tid
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(elem, ord)) r
    LEFT JOIN taxa t ON t.taxon_id = r.tid
    WHERE t.taxon_id IS NULL
    ORDER BY r.ord
    LIMIT 1;
    IF FOUND THEN
        PERFORM fn_analysis_row_error(v_row, 'taxon_id', format('taxon %s does not exist', v_text));
    END IF;

    -- 6. No repeated library_code + taxon_id in the file (names both rows), none already stored.
    SELECT d.second_row, d.first_row, d.lc, d.tid::text INTO v_row, v_other, v_text, v_tid
    FROM (SELECT e.elem ->> 'library_code' AS lc,
                 (e.elem ->> 'taxon_id')::bigint AS tid,
                 e.ord::integer AS second_row,
                 MIN(e.ord) OVER (PARTITION BY e.elem ->> 'library_code', (e.elem ->> 'taxon_id')::bigint)::integer AS first_row
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(elem, ord)) d
    WHERE d.second_row <> d.first_row
    ORDER BY d.second_row
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Row %, field library_code: library % with taxon % already appears in row %',
                v_row, v_text, v_tid, v_other
            USING ERRCODE = 'EB002',
                  DETAIL = format('Rows %s and %s repeat the same library_code and taxon_id. Row numbers are array positions starting at 1; file row = position + 1.', v_other, v_row);
    END IF;

    SELECT r.ord::integer, r.lc, r.tid::text INTO v_row, v_text, v_tid
    FROM (SELECT e.ord, e.elem ->> 'library_code' AS lc, (e.elem ->> 'taxon_id')::bigint AS tid
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(elem, ord)) r
    JOIN sequencing_libraries sl ON sl.library_code = r.lc
    JOIN taxon_assignments ta
      ON ta.analysis_id = p_analysis_id AND ta.library_id = sl.library_id AND ta.taxon_id = r.tid
    ORDER BY r.ord
    LIMIT 1;
    IF FOUND THEN
        PERFORM fn_analysis_row_error(v_row, 'library_code',
                format('analysis %s already has a detection of taxon %s in library %s', p_analysis_id, v_tid, v_text));
    END IF;

    -- 7. Insert every row in one statement.
    PERFORM fn_analysis_set_actor(p_actor_id);

    INSERT INTO taxon_assignments (analysis_id, library_id, taxon_id, read_count, confidence, qc_flag)
    SELECT p_analysis_id,
           sl.library_id,
           (e.elem ->> 'taxon_id')::bigint,
           (e.elem ->> 'read_count')::numeric::integer,
           (e.elem ->> 'confidence')::numeric,
           (e.elem ->> 'qc_flag')::qc_flag
    FROM jsonb_array_elements(p_rows) AS e(elem)
    JOIN sequencing_libraries sl ON sl.library_code = e.elem ->> 'library_code';
    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- 8. draft -> imported. approved_by / approved_at stay NULL.
    UPDATE analysis_runs
    SET status = 'imported',
        imported_by = p_actor_id
    WHERE analysis_id = p_analysis_id;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION import_detections(bigint, jsonb, bigint) IS
    'Inserts all detection rows of one CSV (JSON array) into a draft analysis and moves it to imported; any invalid row raises EB002 and nothing is inserted. EB001 if rejected/superseded, EB003 if already imported/approved, EB002 for actor, payload or row problems.';

-- --------------------------------------------------------------------------------------------
-- approve_analysis: imported -> approved, exactly once, with an audit entry
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_analysis(
    p_analysis_id bigint,
    p_actor_id    bigint
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_analysis analysis_runs;
    v_old      analysis_runs;
    v_count    integer;
BEGIN
    -- 1. Lock first, then decide on the status we read AFTER the lock.
    v_analysis := fn_analysis_lock(p_analysis_id);

    -- 2. Actor (D17): administrator or principal_investigator.
    PERFORM fn_analysis_check_actor(p_actor_id, ARRAY['administrator', 'principal_investigator'],
                                    'approve analyses');

    -- 3. Status.
    IF v_analysis.status = 'approved' THEN
        RAISE EXCEPTION 'Analysis % is already approved', p_analysis_id
            USING ERRCODE = 'EB003',
                  DETAIL = 'An analysis can be approved only once.';
    ELSIF v_analysis.status <> 'imported' THEN
        RAISE EXCEPTION 'Analysis % is %; only an imported analysis can be approved',
                p_analysis_id, v_analysis.status
            USING ERRCODE = 'EB001';
    END IF;

    -- 4. The approver is not the importer (D17). A NULL importer is a data error, never "different".
    IF v_analysis.imported_by IS NULL THEN
        RAISE EXCEPTION 'Analysis % has no recorded importer and cannot be approved', p_analysis_id
            USING ERRCODE = 'EB002';
    END IF;
    IF v_analysis.imported_by = p_actor_id THEN
        RAISE EXCEPTION 'The importer may not approve their own analysis'
            USING ERRCODE = 'EB002',
                  DETAIL = format('User %s imported analysis %s.', p_actor_id, p_analysis_id);
    END IF;

    -- 5. At least one detection. (Whether an analysis whose detections are all qc_flag fail may be
    --    approved is not decided by the contract, so no rule is invented here.)
    SELECT count(*)::integer INTO v_count FROM taxon_assignments ta WHERE ta.analysis_id = p_analysis_id;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'Analysis % has no detections and cannot be approved', p_analysis_id
            USING ERRCODE = 'EB002';
    END IF;

    -- 5b. A correction: lock the approved run it replaces (after our own row, always in this order)
    --     and require it to be approved right now.
    IF v_analysis.supersedes_analysis_id IS NOT NULL THEN
        v_old := fn_analysis_lock(v_analysis.supersedes_analysis_id);
        IF v_old.status <> 'approved' THEN
            RAISE EXCEPTION 'Analysis % cannot be superseded: it is %, not approved',
                    v_old.analysis_id, v_old.status
                USING ERRCODE = 'EB001',
                      DETAIL = format('Analysis %s is a correction of analysis %s, which must still be approved.',
                                      p_analysis_id, v_old.analysis_id);
        END IF;
    END IF;

    -- 6. Approve. Satisfies ck_analysis_runs_approved_fields.
    PERFORM fn_analysis_set_actor(p_actor_id);

    UPDATE analysis_runs
    SET status = 'approved',
        approved_by = p_actor_id,
        approved_at = now()
    WHERE analysis_id = p_analysis_id;

    -- 7. Audit entry with the business context.
    INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, details)
    VALUES (p_actor_id, 'analysis_runs', p_analysis_id, 'approve',
            jsonb_build_object('from_status', 'imported',
                               'to_status', 'approved',
                               'detection_count', v_count,
                               'importer_id', v_analysis.imported_by)
                || CASE WHEN v_analysis.supersedes_analysis_id IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object('supersedes_analysis_id', v_analysis.supersedes_analysis_id) END);

    -- 8. Correction: the old run becomes superseded AFTER the correction is approved (see header).
    IF v_old.analysis_id IS NOT NULL THEN
        UPDATE analysis_runs
        SET status = 'superseded'
        WHERE analysis_id = v_old.analysis_id;

        INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, details)
        VALUES (p_actor_id, 'analysis_runs', v_old.analysis_id, 'update',
                jsonb_build_object('from_status', 'approved',
                                   'to_status', 'superseded',
                                   'superseded_by', p_analysis_id));
    END IF;
END;
$$;

COMMENT ON FUNCTION approve_analysis(bigint, bigint) IS
    'Approves an imported analysis once (row lock, status re-read after the lock): approver must be administrator/principal_investigator and not the importer, analysis must have detections; writes an audit entry. A correction (supersedes_analysis_id set) also moves the approved run it replaces to superseded in the same transaction. EB001 wrong status, EB002 rule violated, EB003 already approved.';

-- --------------------------------------------------------------------------------------------
-- reject_analysis: draft or imported -> rejected; detections are kept (D19)
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_analysis(
    p_analysis_id bigint,
    p_actor_id    bigint,
    p_reason      text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_analysis analysis_runs;
BEGIN
    v_analysis := fn_analysis_lock(p_analysis_id);
    PERFORM fn_analysis_check_actor(p_actor_id, ARRAY['administrator', 'principal_investigator'],
                                    'reject analyses');

    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'A reason is required to reject an analysis' USING ERRCODE = 'EB002';
    END IF;

    IF v_analysis.status = 'rejected' THEN
        RAISE EXCEPTION 'Analysis % is already rejected', p_analysis_id
            USING ERRCODE = 'EB003',
                  DETAIL = 'An analysis can be rejected only once.';
    ELSIF v_analysis.status NOT IN ('draft', 'imported') THEN
        RAISE EXCEPTION 'Analysis % is %; only a draft or imported analysis can be rejected',
                p_analysis_id, v_analysis.status
            USING ERRCODE = 'EB001',
                  DETAIL = 'An approved result is corrected by a new run, never rejected.';
    END IF;

    PERFORM fn_analysis_set_actor(p_actor_id);

    -- Detections stay attached (D19); approved_by / approved_at are untouched.
    UPDATE analysis_runs
    SET status = 'rejected'
    WHERE analysis_id = p_analysis_id;

    INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, details)
    VALUES (p_actor_id, 'analysis_runs', p_analysis_id, 'reject',
            jsonb_build_object('from_status', v_analysis.status,
                               'to_status', 'rejected',
                               'reason', p_reason));
END;
$$;

COMMENT ON FUNCTION reject_analysis(bigint, bigint, text) IS
    'Moves a draft or imported analysis to rejected and records the reason in the audit entry; detections are kept. EB001 if approved/superseded, EB002 for actor, role or blank reason, EB003 if already rejected.';
