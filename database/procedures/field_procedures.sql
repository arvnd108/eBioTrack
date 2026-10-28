-- Owner: D (Docs & Demo)
-- Purpose: 1 stored procedure/function: Field & Samples
-- Register a sample and generate its sample code.
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
    v_sequence INTEGER;
    v_sample_code TEXT;
BEGIN
    -- Lock the event to prevent duplicate sequence numbers.
    SELECT collected_at
    INTO v_collected_at
    FROM collection_events
    WHERE event_id = p_event_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Collection event % does not exist', p_event_id;
    END IF;

    -- Find the next sequence number for this event.
    SELECT COUNT(*) + 1
    INTO v_sequence
    FROM samples
    WHERE event_id = p_event_id;

    -- Generate the required sample code.
    v_sample_code :=
        'EB-' ||
        TO_CHAR(v_collected_at AT TIME ZONE 'UTC', 'YYYYMMDD') ||
        '-' ||
        LPAD(p_event_id::TEXT, GREATEST(4, LENGTH(p_event_id::TEXT)), '0') ||
        '-' ||
        LPAD(v_sequence::TEXT, GREATEST(3, LENGTH(v_sequence::TEXT)), '0');
    -- Insert the sample.
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

    -- Record the initial status in the history table.
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
