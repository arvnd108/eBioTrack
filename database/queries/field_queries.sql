-- Owner: D (Docs & Demo)
-- Purpose: 3 complex queries: Field & Samples
--
-- Issue #20 / T14-D. Each query is a PREPARE with explicit parameter types: the SQL after AS is
-- exactly what the backend sends through `pg` with $1, $2 placeholders (D9), and the EXECUTE line
-- under it runs the documented example. Run the whole file with:
--
--   psql "$DATABASE_URL" -f database/queries/field_queries.sql
--
-- Optional filters take NULL to mean "no filter". Prepared statements last for the session only;
-- no objects are created. Expected results are for the seeded fixture world (seeds 010 to 040;
-- field rows from 020_seed_field.sql) and were worked out by hand from the seed files, then
-- confirmed by running this file. Timestamps are UTC.
--
-- Tables used (database/migrations/020_field_samples.sql): regions, sampling_sites,
-- collection_events, samples, environmental_measurements, sample_status_history.

DEALLOCATE ALL;  -- lets the file run more than once in the same session

-- ============================================================================================
-- Q1. Sample count per site
-- ============================================================================================
-- Question: for each sampling site, how many samples were collected there, and how far have they
--           progressed (counts by current status)?
-- Parameters: $1 region_id (bigint, NULL = all regions; matches the site's own region)
-- DBMS concepts: LEFT OUTER JOIN chain (site -> events -> samples) so a site with no events or
--           samples still appears with 0, GROUP BY with aggregate FILTER clauses (conditional
--           aggregation: one pass instead of one query per status).
-- Note: COUNT(sa.sample_id) counts only matched samples, so the all-NULL row of an empty site
--       gives 0 rather than 1.
--
-- Expected (all regions): 5 rows, ordered by site_id.
--   site_id | site_name         | region_name        | habitat_type | total | analyzed | failed | other statuses
--   1       | Dakpathar Barrage | Yamuna River Basin | river        | 5     | 4        | 1      | 0
--   2       | Okhla Barrage     | Yamuna River Basin | river        | 4     | 4        | 0      | 0
--   3       | Sangam Prayagraj  | Yamuna River Basin | river        | 4     | 4        | 0      | 0
--   4       | Diamond Harbour   | Hooghly Estuary    | estuary      | 2     | 2        | 0      | 0
--   5       | Kakdwip Bay       | Hooghly Estuary    | estuary      | 2     | 2        | 0      | 0
--   (17 samples in total. With $1 = 3 (Hooghly Estuary): sites 4 and 5 only. With $1 = 2: sites 1-3.
--    No seeded site is empty; a site inserted with no events shows 0 in every count column.)

PREPARE field_site_sample_counts(bigint) AS
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
FROM sampling_sites AS ss
JOIN regions AS r                ON r.region_id = ss.region_id
LEFT JOIN collection_events AS ce ON ce.site_id = ss.site_id
LEFT JOIN samples AS sa           ON sa.event_id = ce.event_id
WHERE ($1::bigint IS NULL OR ss.region_id = $1)
GROUP BY ss.site_id, ss.name, r.name, ss.habitat_type
ORDER BY ss.site_id;

EXECUTE field_site_sample_counts(NULL);

-- ============================================================================================
-- Q2. Samples per event with their latest status
-- ============================================================================================
-- Question: for each collection event, which samples does it hold, what is each sample's most
--           recent status-history row (status, when, and the note), and does that agree with the
--           status stored on the sample itself?
-- Parameters: $1 event_id (bigint, NULL = all events)
-- DBMS concepts: CTE plus a window function (ROW_NUMBER() OVER (PARTITION BY sample ORDER BY
--           changed_at DESC, history_id DESC)) to pick the latest row per sample without a
--           correlated subquery; the history_id tie-breaker makes the choice deterministic when
--           two rows share a timestamp.
-- Note: status_matches compares samples.status with the latest history row; a FALSE would flag a
--       sample whose history is out of step with its stored status.
--
-- Expected (all events): 17 rows, ordered by event then sample.
--   event | site | sample_id | sample_code          | current_status | last_status_changed_at (UTC) | status_matches
--   1     | 1    | 1         | EB-20250515-0001-001 | analyzed       | 2026-04-02 11:30             | true
--   1     | 1    | 2         | EB-20250515-0001-002 | analyzed       | 2026-04-02 11:30             | true
--   1     | 1    | 17        | EB-20250515-0001-003 | failed         | 2025-05-20 16:00             | true
--   2     | 2    | 3, 4      | EB-20250518-0002-001/2 | analyzed     | 2026-04-02 11:30             | true
--   3     | 3    | 5, 6      | EB-20250522-0003-001/2 | analyzed     | 2026-04-02 11:30             | true
--   4     | 1    | 7, 8      | EB-20260310-0004-001/2 | analyzed     | 2026-04-02 11:30             | true
--   5     | 2    | 9, 10     | EB-20260312-0005-001/2 | analyzed     | 2026-04-25 14:00             | true
--   6     | 3    | 11, 12    | EB-20260315-0006-001/2 | analyzed     | 2026-04-25 14:00             | true
--   7     | 4    | 13, 14    | EB-20260405-0007-001/2 | analyzed     | 2026-04-25 14:00             | true
--   8     | 5    | 15, 16    | EB-20260408-0008-001/2 | analyzed     | 2026-04-25 14:00             | true
--   Samples 1-16 end at 'analyzed' with the note "Taxonomic assignment approved"; sample 17 ends
--   at 'failed' with "Extraction failed concentration QC check". Event 1 has 3 rows, every other
--   event has 2. With $1 = 1: the 3 rows of event 1.

PREPARE field_event_samples_latest_status(bigint) AS
WITH ranked_history AS (
    SELECT
        h.sample_id,
        h.new_status,
        h.changed_at,
        h.note,
        ROW_NUMBER() OVER (
            PARTITION BY h.sample_id
            ORDER BY h.changed_at DESC, h.history_id DESC
        ) AS rn
    FROM sample_status_history AS h
)
SELECT
    ce.event_id,
    ce.site_id,
    ce.collected_at,
    sa.sample_id,
    sa.sample_code,
    sa.status                           AS current_status,
    rh.new_status                       AS latest_history_status,
    rh.changed_at                       AS last_status_changed_at,
    rh.note                             AS last_status_note,
    (sa.status = rh.new_status)         AS status_matches
FROM collection_events AS ce
JOIN samples AS sa                 ON sa.event_id = ce.event_id
LEFT JOIN ranked_history AS rh     ON rh.sample_id = sa.sample_id AND rh.rn = 1
WHERE ($1::bigint IS NULL OR ce.event_id = $1)
ORDER BY ce.event_id, sa.sample_id;

EXECUTE field_event_samples_latest_status(NULL);

-- ============================================================================================
-- Q3. Environmental readings per site over time, with a moving average
-- ============================================================================================
-- Question: for one environmental parameter, how do the readings at each site change from event
--           to event, and how far is each reading from the recent average?
-- Parameters: $1 parameter  (text, required: 'temperature_c', 'ph', 'dissolved_oxygen_mg_l' or
--                            'turbidity_ntu')
--             $2 site_id    (bigint, NULL = all sites)
--             $3 window     (integer, NULL = 3; number of readings in the moving average,
--                            counting the current one, so 1 gives the reading itself;
--                            values below 1 are treated as 1)
-- DBMS concepts: aggregate window function over a ROWS frame
--           (AVG(value) OVER (PARTITION BY site ORDER BY collected_at
--            ROWS BETWEEN window-1 PRECEDING AND CURRENT ROW)): a moving average whose frame is a
--           bind parameter; COUNT(*) OVER the same frame (readings_in_window) shows how many
--           readings the average used, because the first rows of a site have fewer than the
--           window; ROW_NUMBER() OVER (PARTITION BY site ORDER BY collected_at) numbers the
--           events at each site. One reading per event and parameter is guaranteed by
--           uq_environmental_measurements_event_parameter.
--
-- Expected for ('temperature_c', NULL, NULL), window 3 (8 rows: one per event):
--   site | event_no | collected_at (UTC)  | value | moving_avg | readings_in_window | deviation
--   1    | 1        | 2025-05-15 08:30    | 24.5  | 24.5000    | 1                  |  0.0000
--   1    | 2        | 2026-03-10 08:00    | 19.5  | 22.0000    | 2                  | -2.5000
--   2    | 1        | 2025-05-18 09:15    | 28.2  | 28.2000    | 1                  |  0.0000
--   2    | 2        | 2026-03-12 09:30    | 23.4  | 25.8000    | 2                  | -2.4000
--   3    | 1        | 2025-05-22 07:45    | 26.8  | 26.8000    | 1                  |  0.0000
--   3    | 2        | 2026-03-15 08:15    | 22.1  | 24.4500    | 2                  | -2.3500
--   4    | 1        | 2026-04-05 10:00    | 26.0  | 26.0000    | 1                  |  0.0000
--   5    | 1        | 2026-04-08 11:30    | 27.5  | 27.5000    | 1                  |  0.0000
--   Other parameters, all sites (value at event 1, value at event 2, moving_avg at event 2):
--     ph:        site 1 7.8, 8.1, 7.95 | site 2 7.4, 7.3, 7.35 | site 3 7.6, 7.9, 7.75 | 4: 8.0 | 5: 8.2
--     dissolved_oxygen_mg_l: site 1 6.5, 7.8, 7.15 | site 2 4.2, 5.0, 4.6 | site 3 5.8, 6.9, 6.35 | 4: 6.1 | 5: 5.9
--     turbidity_ntu: site 1 12.0, 8.5, 10.25 | site 2 28.5, 22.0, 25.25 | site 3 18.0, 14.5, 16.25 | 4: 15.0 | 5: 20.0
--   With ('temperature_c', 1, NULL): the 2 rows of site 1. With window 1 the moving_avg equals the
--   value and the deviation is 0. An unknown parameter name returns no rows.

PREPARE field_readings_moving_average(text, bigint, integer) AS
SELECT
    ss.site_id,
    ss.name                                              AS site_name,
    ss.habitat_type,
    em.parameter,
    em.unit,
    ROW_NUMBER() OVER (PARTITION BY ss.site_id ORDER BY ce.collected_at) AS event_no,
    ce.collected_at,
    em.value,
    ROUND(AVG(em.value) OVER w, 4)                       AS moving_avg,
    COUNT(*) OVER w                                      AS readings_in_window,
    ROUND(em.value - AVG(em.value) OVER w, 4)            AS deviation_from_avg
FROM environmental_measurements AS em
JOIN collection_events AS ce ON ce.event_id = em.event_id
JOIN sampling_sites AS ss    ON ss.site_id = ce.site_id
WHERE em.parameter = $1
  AND ($2::bigint IS NULL OR ss.site_id = $2)
WINDOW w AS (
    PARTITION BY ss.site_id
    ORDER BY ce.collected_at
    ROWS BETWEEN (GREATEST(COALESCE($3::integer, 3), 1) - 1) PRECEDING AND CURRENT ROW
)
ORDER BY ss.site_id, ce.collected_at;

EXECUTE field_readings_moving_average('temperature_c', NULL, NULL);
