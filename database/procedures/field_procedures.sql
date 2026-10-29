-- Owner: D (Docs & Demo)
-- Purpose: 1 stored procedure/function: Field & Samples
-- Issue #28 / T16-D. Contract 7 fixes the function signature.
--
-- Register one sample and generate its unique sample_code in one transaction.
-- The event row is locked FOR UPDATE before choosing the next sequence number, so two
-- concurrent calls for the same event cannot choose the same sequence.
--
-- Installed by backend/src/db/migrate.js after migrations, on every run. To apply by hand:
--   psql "$DATABASE_URL" -f database/procedures/field_procedures.sql
--
-- Usage example (run deliberately in a seeded database; this INSERTS a new sample):
--   SELECT register_sample(1, 1, 250.00, 0.75, 'Freezer D-1', 3) AS new_sample_id;
-- Then inspect the returned ID:
--   SELECT sample_id, sample_code, status FROM samples WHERE sample_id = <new_sample_id>;
--   SELECT sample_id, old_status, new_status, changed_by, changed_at
--   FROM sample_status_history WHERE sample_id = <new_sample_id>;
-- The example is commented out so loading this file does not create test data.

CREATE OR REPLACE FUNCTION register_sample(
    p_event_id BIGINT,
    p_sample_type_id BIGINT,
    p_volume_ml NUMERIC,
    p_depth_m NUMERIC,
    p_storage_location TEXT,
    p_actor_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_sample_id BIGINT;
    v_collected_at TIMESTAMPTZ;
    v_sequence BIGINT;
    v_sample_code TEXT;
BEGIN
    -- Validate the event and lock it. The lock serializes sequence allocation per event.
    SELECT ce.collected_at
    INTO v_collected_at
    FROM collection_events AS ce
    WHERE ce.event_id = p_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Collection event % does not exist', p_event_id
            USING ERRCODE = '23503';
    END IF;

    -- Validate the sample type explicitly, so the caller gets a clear error.
    PERFORM 1
    FROM sample_types AS st
    WHERE st.sample_type_id = p_sample_type_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sample type % does not exist', p_sample_type_id
            USING ERRCODE = '23503';
    END IF;

    -- Volume and depth are optional (CONTRACT 10: volume_ml?, depth_m?), but when given volume must be
    -- positive and depth cannot be negative.
    IF p_volume_ml IS NOT NULL AND p_volume_ml <= 0 THEN
        RAISE EXCEPTION 'Sample volume must be greater than zero'
            USING ERRCODE = '23514';
    END IF;

    IF p_depth_m IS NOT NULL AND p_depth_m < 0 THEN
        RAISE EXCEPTION 'Sample depth cannot be negative'
            USING ERRCODE = '23514';
    END IF;

    -- The event lock means another call for this event must wait until this transaction ends.
    -- D19 says scientific records are not hard-deleted, so COUNT(*) + 1 gives the next sequence.
    SELECT COUNT(*) + 1
    INTO v_sequence
    FROM samples AS s
    WHERE s.event_id = p_event_id;

    -- Use the UTC collection date. GREATEST keeps IDs longer than four digits intact.
    v_sample_code :=
        'EB-' ||
        TO_CHAR(v_collected_at AT TIME ZONE 'UTC', 'YYYYMMDD') ||
        '-' ||
        LPAD(p_event_id::TEXT, GREATEST(4, LENGTH(p_event_id::TEXT)), '0') ||
        '-' ||
        LPAD(v_sequence::TEXT, GREATEST(3, LENGTH(v_sequence::TEXT)), '0');

    -- The database default supplies created_at; new samples always start as collected.
    INSERT INTO samples (
        event_id,
        sample_type_id,
        sample_code,
        volume_ml,
        depth_m,
        storage_location,
        status
    )
    VALUES (
        p_event_id,
        p_sample_type_id,
        v_sample_code,
        p_volume_ml,
        p_depth_m,
        p_storage_location,
        'collected'
    )
    RETURNING sample_id INTO v_sample_id;

    -- Write exactly one initial history row here. The field trigger must not duplicate it.
    INSERT INTO sample_status_history (
        sample_id,
        old_status,
        new_status,
        changed_by
    )
    VALUES (
        v_sample_id,
        NULL,
        'collected',
        p_actor_id
    );

    RETURN v_sample_id;
END;
$$;

COMMENT ON FUNCTION register_sample(BIGINT, BIGINT, NUMERIC, NUMERIC, TEXT, BIGINT) IS
    'Registers one collected sample, serializes sample-code sequence allocation per event, and writes the initial sample_status_history row.';
