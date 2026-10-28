-- Owner: B (Frontend)
-- Purpose: 2 views: Laboratory & Sequencing
--
-- Issue #22 / T15-B. View names are fixed by CONTRACT 7; columns are documented in
-- docs/slices/lab.md. Safe to run more than once (DROP ... IF EXISTS, then CREATE):
--
--   psql "$DATABASE_URL" -f database/views/lab_views.sql
--
-- Both views read only base tables from migrations 010-090, so they can be created any time
-- after the schema exists; they hold no data of their own.

DROP VIEW IF EXISTS v_lab_pipeline_status;
DROP VIEW IF EXISTS v_failed_qc;

-- ============================================================================================
-- v_lab_pipeline_status: one row per sample, showing how far it has got through the lab
-- ============================================================================================
-- Used by: the Lab processing page (T27) and the lab routes (T22) to list samples with their
--          current stage; the dashboard to count samples waiting at each stage.
-- Hides:   the one-to-many history behind each sample. A sample can have several extraction
--          attempts, and an extraction can be sequenced on more than one run over time; the
--          view keeps only the LATEST extraction attempt and, for that extraction, the library
--          on the LATEST run. Earlier attempts and runs stay in the base tables. It also hides
--          the six-table join and the rule that turns these facts into `pipeline_stage`.
-- Every sample appears, including ones with no extraction yet (LEFT JOIN LATERAL).
--
-- pipeline_stage, checked in this order:
--   sample_failed        sample status is 'failed' or 'discarded'
--   not_extracted        no extraction attempt yet
--   extraction_qc_pending  latest extraction's qc_status is 'pending'
--   extraction_failed    latest extraction failed QC (re-extract or discard)
--   awaiting_library     latest extraction passed but has no library on any run
--   run_planned / sequencing / sequenced / run_failed
--                        latest run is 'planned' / 'running' / 'completed' / 'failed'
--
-- Seeded data: 17 rows. Samples 1-16 are 'sequenced' (8 on RUN-001, 8 on RUN-002);
-- sample 17 is 'sample_failed' (its only extraction failed QC, no library).

CREATE VIEW v_lab_pipeline_status AS
SELECT
    s.sample_id,
    s.sample_code,
    e.project_id,
    e.site_id,
    site.name                       AS site_name,
    e.collected_at,
    s.status                        AS sample_status,
    COALESCE(attempts.n, 0)         AS extraction_attempts,
    x.extraction_id                 AS latest_extraction_id,
    x.attempt_number                AS latest_attempt_number,
    x.qc_status                     AS latest_qc_status,
    x.concentration_ng_ul           AS latest_concentration_ng_ul,
    x.purity_a260_280               AS latest_purity_a260_280,
    x.batch_id,
    lab.name                        AS lab_name,
    lib.library_id,
    lib.library_code,
    lib.run_id,
    lib.run_code,
    lib.run_status,
    lib.run_date,
    CASE
        WHEN s.status IN ('failed', 'discarded')  THEN 'sample_failed'
        WHEN x.extraction_id IS NULL             THEN 'not_extracted'
        WHEN x.qc_status = 'pending'             THEN 'extraction_qc_pending'
        WHEN x.qc_status = 'fail'                THEN 'extraction_failed'
        WHEN lib.library_id IS NULL              THEN 'awaiting_library'
        WHEN lib.run_status = 'planned'          THEN 'run_planned'
        WHEN lib.run_status = 'running'          THEN 'sequencing'
        WHEN lib.run_status = 'completed'        THEN 'sequenced'
        ELSE 'run_failed'
    END                             AS pipeline_stage
FROM samples s
JOIN collection_events e ON e.event_id = s.event_id
JOIN sampling_sites site ON site.site_id = e.site_id
-- How many times this sample has been extracted
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n
    FROM dna_extractions xa
    WHERE xa.sample_id = s.sample_id
) attempts ON true
-- The latest extraction attempt
LEFT JOIN LATERAL (
    SELECT xl.*
    FROM dna_extractions xl
    WHERE xl.sample_id = s.sample_id
    ORDER BY xl.attempt_number DESC
    LIMIT 1
) x ON true
LEFT JOIN extraction_batches b ON b.batch_id = x.batch_id
LEFT JOIN laboratories lab     ON lab.lab_id = b.lab_id
-- The library from that extraction on its most recent run
LEFT JOIN LATERAL (
    SELECT l.library_id, l.library_code, r.run_id, r.run_code, r.status AS run_status, r.run_date
    FROM sequencing_libraries l
    JOIN sequencing_runs r ON r.run_id = l.run_id
    WHERE l.extraction_id = x.extraction_id
    ORDER BY r.created_at DESC, r.run_id DESC
    LIMIT 1
) lib ON true;

COMMENT ON VIEW v_lab_pipeline_status IS
    'One row per sample: latest extraction attempt and QC, library and run on the latest run, and the derived pipeline_stage.';

-- ============================================================================================
-- v_failed_qc: one row per QC problem on a sample or extraction
-- ============================================================================================
-- Used by: the Lab processing page's "QC problems" list (T27), QC reporting, and lab routes
--          that need the reason before allowing a library (the T17 trigger blocks libraries
--          from failed extractions; this view explains why to the user).
-- Hides:   that problems come from two tables with different shapes. An extraction whose
--          qc_status is 'fail' and a quality_control_results row with result 'fail' or 'warn'
--          become the same columns (UNION ALL), joined to the sample, project and site.
--          It does not hide anything sensitive.
-- Not included: QC rows linked only to an analysis run (sample_id NULL), because they are not
--          about one sample; passing QC; extractions still 'pending'.
-- History is kept: a failed attempt still appears after a later re-extraction passes; use
-- v_lab_pipeline_status for the sample's current state.
-- One sample can have several rows (one per problem). For one row per sample, group by
-- sample_id (see Q3 in database/queries/lab_queries.sql).
--
-- Seeded data: 4 rows. Sample 17: failed extraction 17, concentration 'fail' (0.35 ng/uL) and
-- contamination_check 'fail'. Sample 12: negative_control 'warn'.

CREATE VIEW v_failed_qc AS
SELECT
    s.sample_id,
    s.sample_code,
    e.project_id,
    site.name               AS site_name,
    p.extraction_id,
    p.source,
    p.qc_type,
    p.severity,
    p.metric_value,
    p.reason,
    p.recorded_by,
    p.recorded_at
FROM (
    -- Extractions that failed QC
    SELECT
        x.sample_id,
        x.extraction_id,
        'extraction'::text                                      AS source,
        NULL::qc_type                                           AS qc_type,
        'fail'::text                                            AS severity,
        x.concentration_ng_ul                                   AS metric_value,
        'Extraction attempt ' || x.attempt_number || ' failed QC'
            || COALESCE(' (' || x.concentration_ng_ul || ' ng/uL, A260/280 '
                        || x.purity_a260_280 || ')', '')        AS reason,
        b.operator_id                                           AS recorded_by,
        x.created_at                                            AS recorded_at
    FROM dna_extractions x
    JOIN extraction_batches b ON b.batch_id = x.batch_id
    WHERE x.qc_status = 'fail'

    UNION ALL

    -- QC results recorded as fail or warn against a sample
    SELECT
        q.sample_id,
        NULL::bigint                                            AS extraction_id,
        'qc_result'::text                                       AS source,
        q.qc_type,
        q.result::text                                          AS severity,
        q.metric_value,
        COALESCE(q.notes, q.qc_type || ' ' || q.result)         AS reason,
        q.recorded_by,
        q.recorded_at
    FROM quality_control_results q
    WHERE q.result IN ('fail', 'warn')
      AND q.sample_id IS NOT NULL
) p
JOIN samples s           ON s.sample_id = p.sample_id
JOIN collection_events e ON e.event_id = s.event_id
JOIN sampling_sites site ON site.site_id = e.site_id;

COMMENT ON VIEW v_failed_qc IS
    'One row per QC problem: failed extractions and fail/warn QC results on samples, with reason, QC type and when recorded.';
