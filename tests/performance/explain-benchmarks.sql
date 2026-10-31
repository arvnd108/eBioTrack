-- Owner: C (Testing & QA)
-- Purpose: EXPLAIN (ANALYZE, BUFFERS) before and after indexes

-- ============================================================================================
-- T19-C: Access, Projects & Audit (results: database/indexes/access_indexes.sql)
-- ============================================================================================
-- Runnable: re-run the EXPLAINs of issue #39 with
--
--   cd tests && npm run volume:load -- --scale medium
--   psql "$TEST_DATABASE_URL" -f performance/explain-benchmarks.sql      (from tests/, or adjust the \i path)
--
-- Order matters: take the "before" plans on the unindexed database FIRST, then apply
-- database/indexes/access_indexes.sql, run VACUUM (ANALYZE) project_members, audit_logs (outside
-- a transaction), and run this file again for the "after" plans. For a figure, repeat each
-- statement: one warm-up and the median of 5 (the file prints one run of each). Clean up with
-- `npm run volume:clean` and the DROP INDEX lines at the end of access_indexes.sql.
-- The ids are looked up from the data (hot = most rows, cold = 3 rows), never hard-coded.

\set ON_ERROR_STOP on
\pset pager off

SELECT current_database() = 'ebiotrack_test'
   AND (SELECT count(*) FROM audit_logs) >= 100000 AS ok \gset
\if :ok
\else
    \echo STOP: run this on ebiotrack_test after npm run volume:load (audit_logs needs 100 000+ rows).
    \quit
\endif

SET max_parallel_workers_per_gather = 0;
SET jit = off;
SET plan_cache_mode = force_custom_plan;

-- Looked-up parameters.
SELECT user_id AS hot_user FROM project_members GROUP BY user_id ORDER BY count(*) DESC, user_id DESC LIMIT 1 \gset
SELECT entity_id AS hot_sample FROM audit_logs WHERE entity_type = 'samples'
GROUP BY entity_id ORDER BY count(*) DESC, entity_id LIMIT 1 \gset
SELECT entity_id AS cold_sample FROM audit_logs WHERE entity_type = 'samples'
GROUP BY entity_id HAVING count(*) = 3 ORDER BY entity_id LIMIT 1 \gset
SELECT entity_id AS hot_project FROM audit_logs WHERE entity_type = 'projects'
GROUP BY entity_id ORDER BY count(*) DESC, entity_id LIMIT 1 \gset
SELECT entity_id AS small_project FROM audit_logs WHERE entity_type = 'projects'
GROUP BY entity_id ORDER BY count(*), entity_id LIMIT 1 \gset
SELECT date_trunc('month', min(created_at) + interval '5 months') AS from_ts,
       date_trunc('month', min(created_at) + interval '6 months') AS to_ts
FROM audit_logs WHERE entity_type = 'samples' AND entity_id = :hot_sample \gset
\echo hot user :hot_user, hot sample :hot_sample, cold sample :cold_sample, hot project :hot_project, small project :small_project

-- Queries 1 and 3 (PREPARE; their example EXECUTE output is discarded).
\o /dev/null
\i ../database/queries/access_queries.sql
\o

\echo BQ1
EXPLAIN (ANALYZE, BUFFERS) SELECT project_id FROM project_members WHERE user_id = :hot_user;
\echo BQ2
EXPLAIN (ANALYZE, BUFFERS) EXECUTE access_user_projects(:hot_user, NULL);
\echo BQ3a
EXPLAIN (ANALYZE, BUFFERS) EXECUTE access_entity_audit_trail('samples', :hot_sample, NULL, NULL);
\echo BQ3b
EXPLAIN (ANALYZE, BUFFERS) EXECUTE access_entity_audit_trail('samples', :cold_sample, NULL, NULL);
\echo BQ3c
EXPLAIN (ANALYZE, BUFFERS) EXECUTE access_entity_audit_trail('samples', :hot_sample, :'from_ts', :'to_ts');
\echo BQ4a
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_logs WHERE entity_type = 'projects' AND entity_id = :hot_project ORDER BY created_at, audit_id;
\echo BQ4b
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_logs WHERE entity_type = 'projects' AND entity_id = :small_project ORDER BY created_at, audit_id;
\echo BQ5 (actor_id filter, not indexed)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM audit_logs WHERE actor_id = :hot_user ORDER BY created_at DESC, audit_id DESC LIMIT 50;
\echo BQ6 (dashboard, newest 5, not indexed)
EXPLAIN (ANALYZE, BUFFERS) SELECT audit_id, entity_type, entity_id, action, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5;

-- ============================================================================================
-- T19-D: Field & Samples (results: database/indexes/field_indexes.sql)
-- ============================================================================================
-- Same volume load as above. The volume generator creates no environmental_measurements, so
-- the T14 time-series query would have nothing to read: this section first adds 4 deterministic
-- readings (temperature_c, ph, dissolved_oxygen_mg_l, turbidity_ntu) to every volume event, once.
-- Their measurement_id is event_id * 4 + k (4 000 000 and up). `npm run volume:clean` does not
-- know these rows and would stop on the foreign key, so remove them FIRST:
--   DELETE FROM environmental_measurements WHERE measurement_id >= 1000000;
-- Order: take the "before" plans FIRST, then apply database/indexes/field_indexes.sql, run
-- VACUUM (ANALYZE) collection_events (outside a transaction) and run this section again for the
-- "after" plans. For a figure, repeat each statement: one warm-up and the median of 5. The
-- experimental indexes (text_pattern_ops, samples(event_id), sample_status_history(sample_id))
-- are listed in field_indexes.sql; create and drop them by hand around the FQ2 and FQ5 plans.

SELECT (SELECT count(*) FROM environmental_measurements) < 10000
   AND EXISTS (SELECT 1 FROM collection_events WHERE event_id >= 1000000) AS need_measurements \gset
\if :need_measurements
    INSERT INTO environmental_measurements (measurement_id, event_id, parameter, value, unit)
    SELECT ce.event_id * 4 + p.k, ce.event_id, p.parameter,
           round((p.base + ((ce.event_id * 7919 + p.k * 104729) % 1000) / 1000.0 * p.span)::numeric, 3), p.unit
    FROM collection_events AS ce
    CROSS JOIN (VALUES (0, 'temperature_c', 'degC', 5.0, 25.0),
                       (1, 'ph', 'pH', 6.5, 2.5),
                       (2, 'dissolved_oxygen_mg_l', 'mg/L', 3.0, 8.0),
                       (3, 'turbidity_ntu', 'NTU', 2.0, 40.0)) AS p(k, parameter, unit, base, span)
    WHERE ce.event_id >= 1000000;
    VACUUM (ANALYZE) environmental_measurements;
\endif

-- Looked-up parameters (hot = the most rows).
SELECT site_id AS hot_site FROM collection_events WHERE event_id >= 1000000
GROUP BY site_id ORDER BY count(*) DESC, site_id LIMIT 1 \gset
SELECT event_id AS hot_event FROM samples WHERE event_id >= 1000000
GROUP BY event_id ORDER BY count(*) DESC, event_id LIMIT 1 \gset
SELECT sample_code AS some_code FROM samples WHERE sample_id >= 1000000 ORDER BY sample_id OFFSET 50000 LIMIT 1 \gset
SELECT date_trunc('year', min(collected_at)) AS y0,
       date_trunc('year', min(collected_at)) + interval '1 year' AS y1,
       date_trunc('month', min(collected_at) + interval '1 month') AS m0,
       date_trunc('month', min(collected_at) + interval '2 months') AS m1
FROM collection_events WHERE site_id = :hot_site \gset
\echo hot site :hot_site, hot event :hot_event, code :some_code, year :y0 to :y1, month :m0 to :m1

-- Queries 1 to 3 of database/queries/field_queries.sql (PREPARE; their example EXECUTE output is
-- discarded).
\o /dev/null
\i ../database/queries/field_queries.sql
\o

\echo FQ1 (exact code, unique index samples_sample_code_key)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code = :'some_code';
\echo FQ2a (prefix, 10 rows)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE 'EB-2026%';
\echo FQ2b (prefix, 12.4% of the table)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE 'EB-2020%';
\echo FQ2c (prefix, 87.6% of the table)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE 'EB-2019%';
\echo FQ2d (prefix, the samples of one event)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE 'EB-20190101-1000000%';
\echo FQ3a (site and one year)
EXPLAIN (ANALYZE, BUFFERS) SELECT event_id, site_id, collected_at FROM collection_events
WHERE site_id = :hot_site AND collected_at >= :'y0' AND collected_at < :'y1' ORDER BY collected_at;
\echo FQ3b (site and one month)
EXPLAIN (ANALYZE, BUFFERS) SELECT event_id, site_id, collected_at FROM collection_events
WHERE site_id = :hot_site AND collected_at >= :'m0' AND collected_at < :'m1' ORDER BY collected_at;
\echo FQ3c (site, no date range)
EXPLAIN (ANALYZE, BUFFERS) SELECT event_id, site_id, collected_at FROM collection_events
WHERE site_id = :hot_site ORDER BY collected_at;
\echo FQ3d (one month, all sites: the composite index cannot be used)
EXPLAIN (ANALYZE, BUFFERS) SELECT event_id, site_id, collected_at FROM collection_events
WHERE collected_at >= :'m0' AND collected_at < :'m1' ORDER BY collected_at;
\echo FQ4a (T14 Q3, one site)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE field_readings_moving_average('temperature_c', :hot_site, NULL);
\echo FQ4b (T14 Q3, all sites)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE field_readings_moving_average('temperature_c', NULL, NULL);
\echo FQ5a (Q2, one event; not indexed)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE field_event_samples_latest_status(:hot_event);
\echo FQ5b (samples of one event; not indexed)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE event_id = :hot_event;
\echo FQ5c (Q1, all sites)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE field_site_sample_counts(NULL);
\echo FQ5d (v_site_sample_summary, one site; not indexed)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_site_sample_summary WHERE site_id = :hot_site;

-- ============================================================================================
-- T19-A: Analysis, Taxonomy & Analytics (results: database/indexes/analysis_indexes.sql)
-- ============================================================================================
-- Same order as above: take the "before" plans on the unindexed database FIRST, apply
-- database/indexes/analysis_indexes.sql, run VACUUM (ANALYZE) taxon_assignments (outside a
-- transaction), and run this section again. For a figure: one warm-up, then the median of 5.
-- The volume generator creates every analysis as `imported`, but all of these queries read
-- approved runs only, so before measuring, approve some (test database only), e.g.
--   ALTER TABLE analysis_runs DISABLE TRIGGER trg_analysis_runs_audit;
--   UPDATE analysis_runs SET status = 'approved', approved_by = 2, approved_at = now()
--    WHERE analysis_id >= 1000000 AND analysis_id % 5 = 0;
--   ALTER TABLE analysis_runs ENABLE TRIGGER trg_analysis_runs_audit;
-- and undo it before `npm run volume:clean` (set status back to 'imported', approved_by and
-- approved_at to NULL, with the immutability triggers disabled for that statement).

SELECT count(*) > 0 AS ok FROM v_approved_detections \gset
\if :ok
\else
    \echo STOP T19-A: no approved detections; approve some volume analyses first (see above).
    \quit
\endif

SELECT taxon_id AS hot_taxon FROM taxon_assignments GROUP BY taxon_id ORDER BY count(*) DESC, taxon_id LIMIT 1 \gset
SELECT taxon_id AS cold_taxon FROM taxon_assignments WHERE taxon_id >= 1000000
GROUP BY taxon_id ORDER BY count(*), taxon_id LIMIT 1 \gset
SELECT parent_taxon_id AS big_genus FROM taxa WHERE parent_taxon_id IS NOT NULL
GROUP BY parent_taxon_id ORDER BY count(*) DESC, parent_taxon_id LIMIT 1 \gset
SELECT site_id AS busy_site FROM v_approved_detections GROUP BY site_id ORDER BY count(*) DESC, site_id LIMIT 1 \gset
SELECT analysis_id AS big_analysis FROM taxon_assignments GROUP BY analysis_id ORDER BY count(*) DESC, analysis_id LIMIT 1 \gset
SELECT library_id AS hot_library FROM taxon_assignments GROUP BY library_id ORDER BY count(*) DESC, library_id LIMIT 1 \gset
SELECT taxon_id AS hot_approved_taxon FROM v_approved_detections GROUP BY taxon_id ORDER BY count(*) DESC, taxon_id LIMIT 1 \gset
\echo hot taxon :hot_taxon, cold taxon :cold_taxon, genus :big_genus, busy site :busy_site, big analysis :big_analysis, hot library :hot_library

\o /dev/null
\i ../database/queries/analysis_queries.sql
\o

\echo BQ1a (taxon lookup, hot taxon)
EXPLAIN (ANALYZE, BUFFERS) SELECT assignment_id, analysis_id, library_id, read_count, confidence, qc_flag FROM taxon_assignments WHERE taxon_id = :hot_taxon;
\echo BQ1b (taxon lookup, cold taxon)
EXPLAIN (ANALYZE, BUFFERS) SELECT assignment_id, analysis_id, library_id, read_count, confidence, qc_flag FROM taxon_assignments WHERE taxon_id = :cold_taxon;
\echo BQ1c (hot taxon, passing detections only)
EXPLAIN (ANALYZE, BUFFERS) SELECT assignment_id, analysis_id, library_id, read_count, confidence, qc_flag FROM taxon_assignments WHERE taxon_id = :hot_taxon AND qc_flag = 'pass';
\echo BQ2a (taxon detection history, genus subtree)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE analysis_taxon_detection_history(:big_genus, NULL, NULL, NULL);
\echo BQ2b (taxon detection history, hot taxon)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE analysis_taxon_detection_history(:hot_approved_taxon, NULL, NULL, NULL);
\echo BQ3 (taxa at a site)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE analysis_taxa_at_site(:busy_site, NULL, NULL, NULL);
\echo BQ4a (richness, all sites)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE analysis_richness_by_site_year(NULL, NULL, NULL, NULL);
\echo BQ4b (richness, one site)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE analysis_richness_by_site_year(NULL, :busy_site, NULL, NULL);
\echo BQ5a (v_approved_detections, hot taxon)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_approved_detections WHERE taxon_id = :hot_approved_taxon;
\echo BQ5b (v_approved_detections, one site)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_approved_detections WHERE site_id = :busy_site;
\echo BQ6 (redundancy check: analysis_id lookup must use the unique constraint index)
EXPLAIN (ANALYZE, BUFFERS) SELECT assignment_id, library_id, taxon_id, read_count, qc_flag FROM taxon_assignments WHERE analysis_id = :big_analysis;
\echo BQ7a (library lookup)
EXPLAIN (ANALYZE, BUFFERS) SELECT assignment_id, analysis_id, taxon_id, read_count, qc_flag FROM taxon_assignments WHERE library_id = :hot_library;
\echo BQ7b (approved and pass counts per taxon; not helped)
EXPLAIN (ANALYZE, BUFFERS) SELECT ta.taxon_id, count(*) FROM taxon_assignments ta JOIN analysis_runs ar USING (analysis_id)
WHERE ar.status = 'approved' AND ta.qc_flag = 'pass' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5;
\echo BQ8 (redundancy check: count for one analysis)
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM taxon_assignments WHERE analysis_id = :big_analysis;
