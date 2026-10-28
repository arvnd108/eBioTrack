-- Owner: B (Frontend)
-- Purpose: 1 stored procedure/function: Laboratory & Sequencing
--
-- Issue #26 / T16-B. Signatures from CONTRACT 7; the booking rule from CONTRACT 4.3:
--   an extraction may be in many runs over time, but in only ONE run whose status is
--   'planned' or 'running' at a time.
-- Safe to run more than once (CREATE OR REPLACE):
--
--   psql "$DATABASE_URL" -f database/procedures/lab_procedures.sql
--
-- Errors (CONTRACT 7):
--   EB001  run is not 'planned' (assign_extraction_to_run)
--   EB002  extraction has not passed QC; extraction already booked on an active run;
--          empty or repeated extraction list; called under REPEATABLE READ (see below)
--   23503  lab, run, or extraction does not exist
--
-- Concurrency. Both functions lock the extraction rows with SELECT ... FOR UPDATE before
-- checking the booking rule, always in ascending extraction_id order so two callers can never
-- wait on each other in a cycle (no deadlock). A second caller that wants the same extraction
-- blocks until the first commits or rolls back. Under READ COMMITTED (PostgreSQL's default, and
-- what the backend uses) its next statement then sees the first caller's new library, so the
-- booking check refuses it with EB002: exactly one wins. REPEATABLE READ would keep the old
-- snapshot and miss that library, so the functions refuse to run at that level; SERIALIZABLE is
-- safe (PostgreSQL aborts one of the two with a serialization failure instead).
--
-- Usage (the backend passes these as $1, $2, ...):
--   SELECT create_sequencing_run(1, 'Illumina MiSeq', DATE '2026-06-01', ARRAY[1, 2, 3]::bigint[], 4);
--     -> run_id of a new 'planned' run with code RUN-<run_id> and libraries LIB-<library_id>
--   SELECT assign_extraction_to_run(<run_id>, 4, 4);
--     -> library_id of the new library on that run
--   SELECT create_sequencing_run(1, 'Illumina MiSeq', DATE '2026-06-01', ARRAY[17]::bigint[], 4);
--     -> ERROR EB002: extraction 17 has not passed QC (qc_status fail)

-- --------------------------------------------------------------------------------------------
-- Helpers (shared by both functions)
-- --------------------------------------------------------------------------------------------

-- Builds a code like RUN-001 or LIB-0001: zero-padded to at least p_width digits. (Plain lpad()
-- would cut longer numbers short, turning run 1000 into RUN-100.)
CREATE OR REPLACE FUNCTION fn_lab_code(p_prefix text, p_id bigint, p_width integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_prefix || lpad(p_id::text, greatest(p_width, length(p_id::text)), '0');
$$;

-- Refuses REPEATABLE READ, where the booking check could miss a concurrent caller's library.
CREATE OR REPLACE FUNCTION fn_lab_require_safe_isolation() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
        RAISE EXCEPTION 'Sequencing bookings must run under READ COMMITTED or SERIALIZABLE'
            USING ERRCODE = 'EB002',
                  DETAIL = 'Under REPEATABLE READ the booking check cannot see a booking committed by a concurrent transaction.';
    END IF;
END;
$$;

-- Records the acting user for the audit trigger when the caller has not already set it.
CREATE OR REPLACE FUNCTION fn_lab_set_actor(p_actor_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_actor_id IS NOT NULL AND COALESCE(current_setting('app.current_user_id', true), '') = '' THEN
        PERFORM set_config('app.current_user_id', p_actor_id::text, true);  -- local to the transaction
    END IF;
END;
$$;

-- Checks one extraction that the caller has ALREADY locked FOR UPDATE: it must have passed QC
-- and must not be on any planned or running run.
CREATE OR REPLACE FUNCTION fn_lab_check_bookable(p_extraction dna_extractions) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_run sequencing_runs;
BEGIN
    IF p_extraction.qc_status <> 'pass' THEN
        RAISE EXCEPTION 'Extraction % has not passed QC (qc_status %)',
                p_extraction.extraction_id, p_extraction.qc_status
            USING ERRCODE = 'EB002',
                  DETAIL = 'Only extractions with qc_status pass can be sequenced.';
    END IF;

    SELECT r.* INTO v_run
    FROM sequencing_libraries l
    JOIN sequencing_runs r ON r.run_id = l.run_id
    WHERE l.extraction_id = p_extraction.extraction_id
      AND r.status IN ('planned', 'running')
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'Extraction % is already booked on run % (%)',
                p_extraction.extraction_id, v_run.run_code, v_run.status
            USING ERRCODE = 'EB002',
                  DETAIL = 'An extraction can be in only one planned or running run at a time.';
    END IF;
END;
$$;

-- --------------------------------------------------------------------------------------------
-- create_sequencing_run: new 'planned' run with one library per extraction
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_sequencing_run(
    p_lab_id         bigint,
    p_platform       text,
    p_run_date       date,
    p_extraction_ids bigint[],
    p_actor_id       bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_ids         bigint[];
    v_extraction  dna_extractions;
    v_found       integer := 0;
    v_run_id         bigint;
    v_extraction_id  bigint;
    v_library_id     bigint;
BEGIN
    PERFORM fn_lab_require_safe_isolation();
    PERFORM fn_lab_set_actor(p_actor_id);

    IF p_extraction_ids IS NULL OR cardinality(p_extraction_ids) = 0 THEN
        RAISE EXCEPTION 'A sequencing run needs at least one extraction' USING ERRCODE = 'EB002';
    END IF;

    -- Sorted, de-duplicated list; a repeated ID is a caller mistake, not something to ignore.
    SELECT array_agg(DISTINCT id ORDER BY id) INTO v_ids FROM unnest(p_extraction_ids) AS id;
    IF cardinality(v_ids) <> cardinality(p_extraction_ids) OR array_position(v_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'The extraction list contains a repeated or empty ID' USING ERRCODE = 'EB002';
    END IF;

    -- Lock every extraction in ascending ID order, then check it.
    FOR v_extraction IN
        SELECT * FROM dna_extractions
        WHERE extraction_id = ANY (v_ids)
        ORDER BY extraction_id
        FOR UPDATE
    LOOP
        v_found := v_found + 1;
        PERFORM fn_lab_check_bookable(v_extraction);
    END LOOP;

    IF v_found <> cardinality(v_ids) THEN
        RAISE EXCEPTION 'Extraction % does not exist',
                (SELECT min(id) FROM unnest(v_ids) AS id
                 WHERE NOT EXISTS (SELECT 1 FROM dna_extractions x WHERE x.extraction_id = id))
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Take the ID first so the run code can be written in the same INSERT.
    v_run_id := nextval(pg_get_serial_sequence('sequencing_runs', 'run_id'));
    INSERT INTO sequencing_runs (run_id, run_code, lab_id, platform, run_date, status)
    VALUES (v_run_id, fn_lab_code('RUN-', v_run_id, 3), p_lab_id, p_platform, p_run_date, 'planned');

    FOREACH v_extraction_id IN ARRAY v_ids LOOP
        v_library_id := nextval(pg_get_serial_sequence('sequencing_libraries', 'library_id'));
        INSERT INTO sequencing_libraries (library_id, library_code, extraction_id, run_id)
        VALUES (v_library_id, fn_lab_code('LIB-', v_library_id, 4), v_extraction_id, v_run_id);
    END LOOP;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION create_sequencing_run(bigint, text, date, bigint[], bigint) IS
    'Creates a planned run (RUN-<id>) with one library (LIB-<id>) per extraction. Locks the extractions FOR UPDATE in ID order; EB002 if any has not passed QC or is already on a planned/running run.';

-- --------------------------------------------------------------------------------------------
-- assign_extraction_to_run: add one extraction to an existing 'planned' run
-- --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_extraction_to_run(
    p_run_id        bigint,
    p_extraction_id bigint,
    p_actor_id      bigint
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_run         sequencing_runs;
    v_extraction  dna_extractions;
    v_library_id  bigint;
BEGIN
    PERFORM fn_lab_require_safe_isolation();
    PERFORM fn_lab_set_actor(p_actor_id);

    -- Lock the run first so it cannot start (planned -> running) while we add to it.
    SELECT * INTO v_run FROM sequencing_runs WHERE run_id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sequencing run % does not exist', p_run_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_run.status <> 'planned' THEN
        RAISE EXCEPTION 'Run % is %; libraries can only be added to a planned run', v_run.run_code, v_run.status
            USING ERRCODE = 'EB001';
    END IF;

    SELECT * INTO v_extraction FROM dna_extractions WHERE extraction_id = p_extraction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Extraction % does not exist', p_extraction_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    PERFORM fn_lab_check_bookable(v_extraction);

    v_library_id := nextval(pg_get_serial_sequence('sequencing_libraries', 'library_id'));
    INSERT INTO sequencing_libraries (library_id, library_code, extraction_id, run_id)
    VALUES (v_library_id, fn_lab_code('LIB-', v_library_id, 4), p_extraction_id, p_run_id);

    RETURN v_library_id;
END;
$$;

COMMENT ON FUNCTION assign_extraction_to_run(bigint, bigint, bigint) IS
    'Adds one extraction to a planned run as a new library (LIB-<id>). EB001 if the run is not planned; EB002 if the extraction has not passed QC or is already on a planned/running run.';
