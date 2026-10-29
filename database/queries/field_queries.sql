-- Owner: D (Docs & Demo)
-- Purpose: 3 complex queries: Field & Samples
-- Owner: D (Docs & Demo)
-- Purpose: 3 complex queries: Field & Samples
-- Task:    T14-D  (branch d/t14-field-queries)
--
-- All queries work against the seed data in database/seeds/020_seed_field.sql
-- Seed IDs are below 1000.  App-generated IDs start at 1000.
--
-- Tables used (all defined in database/migrations/020_field_samples.sql):
--   regions, sampling_sites, collection_events, samples,
--   environmental_measurements, sample_status_history

-- ==========================================================================
-- Q1: Sample count per site
--
-- For every sampling site, count how many samples have been collected there
-- (across all events and statuses).  Also show the region name, habitat
-- type, and a breakdown of samples by current status so reviewers can see
-- at a glance how far samples have progressed.
--
-- Expected seed result (5 rows):
--   site 1 Dakpathar Barrage       river    total 5 (4 analyzed, 1 failed)
--   site 2 Okhla Barrage           river    total 4 analyzed
--   site 3 Sangam Prayagraj        river    total 4 analyzed
--   site 4 Diamond Harbour         estuary  total 2 analyzed
--   site 5 Kakdwip Bay             estuary  total 2 analyzed
-- ==========================================================================

SELECT
    ss.site_id,
    ss.name                                                        AS site_name,
    r.name                                                         AS region_name,
    ss.habitat_type,
    COUNT(sa.sample_id)                                            AS total_samples,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'collected')     AS collected_count,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'stored')        AS stored_count,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'extracted')     AS extracted_count,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'sequenced')     AS sequenced_count,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'analyzed')      AS analyzed_count,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'failed')        AS failed_count,
    COUNT(sa.sample_id) FILTER (WHERE sa.status = 'discarded')     AS discarded_count

FROM sampling_sites     AS ss
JOIN regions            AS r   ON r.region_id  = ss.region_id
LEFT JOIN collection_events AS ce ON ce.site_id = ss.site_id
LEFT JOIN samples       AS sa  ON sa.event_id  = ce.event_id

GROUP BY ss.site_id, ss.name, r.name, ss.habitat_type
ORDER BY ss.site_id;


-- ==========================================================================
-- Q2: Samples per event with latest status
--
-- For every collection event, list every sample together with its current
-- status, the timestamp of the most-recent status change, and the note that
-- accompanied that change.  Uses a window function (RANK) to pick the latest
-- history row per sample without a correlated sub-query.
--
-- Expected seed result (17 rows — one per sample):
--   Samples 1-16 show new_status = 'analyzed'.
--   Sample 17 shows new_status = 'failed'.
-- ==========================================================================

WITH ranked_history AS (
    SELECT
        ssh.sample_id,
        ssh.new_status,
        ssh.changed_at,
        ssh.note,
        RANK() OVER (
            PARTITION BY ssh.sample_id
            ORDER BY ssh.changed_at DESC, ssh.history_id DESC
        ) AS rn
    FROM sample_status_history AS ssh
)
SELECT
    ce.event_id,
    ce.site_id,
    ce.collected_at,
    sa.sample_id,
    sa.sample_code,
    sa.status                   AS current_status,
    rh.new_status               AS latest_history_status,
    rh.changed_at               AS last_status_changed_at,
    rh.note                     AS last_status_note

FROM collection_events  AS ce
JOIN samples            AS sa  ON sa.event_id    = ce.event_id
LEFT JOIN ranked_history AS rh ON rh.sample_id   = sa.sample_id
                               AND rh.rn          = 1

ORDER BY ce.event_id, sa.sample_id;


-- ==========================================================================
-- Q3: Environmental readings per site over time
--
-- For each sampling site and each environmental parameter, show the full
-- time-series of measurements with a running average and deviation.
-- Uses window functions to compute cumulative average per site+parameter.
--
-- Expected seed result (32 rows — 4 parameters x 8 events):
--   E.g. site 1 temperature: 2025-05-15 reading 24.5, running_avg 24.5;
--   2026-03-10 reading 19.5, running_avg 22.0, deviation -2.5.
-- ==========================================================================

SELECT
    ss.site_id,
    ss.name                                                         AS site_name,
    ss.habitat_type,
    em.parameter,
    em.unit,
    ce.collected_at,
    em.value,
    ROUND(
        AVG(em.value) OVER (
            PARTITION BY ss.site_id, em.parameter
            ORDER BY ce.collected_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),
        4
    )                                                               AS running_avg,
    ROUND(
        em.value - AVG(em.value) OVER (
            PARTITION BY ss.site_id, em.parameter
            ORDER BY ce.collected_at
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),
        4
    )                                                               AS deviation_from_avg,
    RANK() OVER (
        PARTITION BY ss.site_id
        ORDER BY ce.collected_at
    )                                                               AS event_rank_at_site

FROM environmental_measurements AS em
JOIN collection_events          AS ce  ON ce.event_id  = em.event_id
JOIN sampling_sites             AS ss  ON ss.site_id   = ce.site_id

ORDER BY ss.site_id, em.parameter, ce.collected_at;
