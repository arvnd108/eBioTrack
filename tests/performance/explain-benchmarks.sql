-- Owner: C (Testing & QA)
-- Purpose: EXPLAIN (ANALYZE, BUFFERS) before and after indexes

-- ============================================================================================
-- By-hand version of the benchmark. The repeatable one is `npm run bench` (run-benchmarks.js,
-- same statements and parameter lookups from benchmarks.config.js, median of 5, checksums, write
-- cost with triggers enabled, results in performance/results/). This file prints one plan of every
-- statement in text form, for reading:
--
--   cd tests && npm run volume:load -- --scale medium
--   psql "$TEST_DATABASE_URL" -f performance/explain-benchmarks.sql      (run from tests/)
--
-- Four sections: T19-C Access, T19-D Field, T19-A Analysis, T19-B Laboratory. Order matters: take
-- the "before" plans on the database WITHOUT the final indexes first (the DROP INDEX lines at the
-- end of each database/indexes/*.sql file, then VACUUM (ANALYZE) outside a transaction), apply the
-- index files, VACUUM (ANALYZE) again and run this file again for the "after" plans. For a figure,
-- repeat each statement: one warm-up and the median of 5 (this file prints one run of each).
-- The ids are looked up from the data (hot = most rows), never hard-coded.
--
-- Data preparation (test database only, idempotent): the Field and Analysis sections add rows the
-- volume generator does not create (4 readings per volume event; every 5th volume analysis
-- approved). Both are removed again at the end of this file, so `npm run volume:clean` does not
-- stop on a foreign key; `\set keep_prep 1` before running keeps them (then remove them with
-- `npm run bench -- --cleanup`).
-- ============================================================================================

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
\echo BQ1b (redundancy: members of one project use pk_project_members)
EXPLAIN (ANALYZE, BUFFERS) SELECT user_id FROM project_members WHERE project_id = :hot_project;
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
-- Indexes: idx_collection_events_site_id_collected_at (FQ3a-c, FQ4a), idx_samples_event_id (FQ5b, FQ5d,
-- FQ5a together with the next one), idx_sample_status_history_sample_id (FQ5a, both needed),
-- idx_samples_sample_code_pattern (FQ2a, FQ2b, FQ2d). Expected unchanged: FQ1 (unique index), FQ2c (the
-- prefix matches 88% of the table), FQ3d and FQ4b (leading-column rule, reads every event), FQ5c.
-- To reproduce the "neither / each / both" table of Q2 (FQ5a), drop the follow-up indexes first
-- (the DROP lines are in the rollback comment of database/indexes/field_indexes.sql), take the plans,
-- create them one at a time, VACUUM (ANALYZE) samples, sample_status_history after each, and repeat.
-- The volume generator creates no environmental_measurements, so the T14 time-series query would
-- have nothing to read: this section first adds 4 deterministic readings (temperature_c, ph,
-- dissolved_oxygen_mg_l, turbidity_ntu) to every volume event, once (test database only). Their
-- measurement_id is event_id * 4 + k (4 000 000 and up); they are removed at the end of this file.

SELECT NOT EXISTS (SELECT 1 FROM environmental_measurements WHERE measurement_id >= 1000000)
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

SELECT EXISTS (SELECT 1 FROM environmental_measurements WHERE measurement_id >= 1000000) AS ok \gset
\if :ok
\else
    \echo STOP T19-D: no volume events; run npm run volume:load first.
    \quit
\endif

-- Looked-up parameters (hot = the most rows).
SELECT site_id AS hot_site FROM collection_events WHERE event_id >= 1000000
GROUP BY site_id ORDER BY count(*) DESC, site_id LIMIT 1 \gset
SELECT event_id AS hot_event FROM samples WHERE event_id >= 1000000
GROUP BY event_id ORDER BY count(*) DESC, event_id LIMIT 1 \gset
SELECT sample_code AS some_code FROM samples WHERE sample_id >= 1000000
ORDER BY sample_id OFFSET (SELECT count(*) / 2 FROM samples WHERE sample_id >= 1000000) LIMIT 1 \gset
SELECT date_trunc('year', min(collected_at)) AS y0,
       date_trunc('year', min(collected_at)) + interval '1 year' AS y1,
       date_trunc('month', min(collected_at) + interval '1 month') AS m0,
       date_trunc('month', min(collected_at) + interval '2 months') AS m1
FROM collection_events WHERE site_id = :hot_site \gset
-- Year prefixes of the sample codes: the rarest, the one nearest 12.4% of the table, the largest.
WITH y AS (SELECT substr(sample_code, 1, 7) AS p, count(*) AS n FROM samples GROUP BY 1),
     t AS (SELECT sum(n) AS total FROM y)
SELECT (SELECT p || '%' FROM y ORDER BY n, p LIMIT 1) AS pfx_rare,
       (SELECT p || '%' FROM y, t ORDER BY abs(n - 0.124 * total), p LIMIT 1) AS pfx_mid,
       (SELECT p || '%' FROM y ORDER BY n DESC, p LIMIT 1) AS pfx_big \gset
SELECT regexp_replace(sample_code, '-[0-9]+$', '') || '%' AS pfx_event
FROM samples WHERE event_id = :hot_event ORDER BY sample_id LIMIT 1 \gset
\echo hot site :hot_site, hot event :hot_event, code :some_code, year :y0 to :y1, month :m0 to :m1
\echo prefixes :pfx_rare, :pfx_mid, :pfx_big, :pfx_event

-- Queries 1 to 3 of database/queries/field_queries.sql (PREPARE; their example EXECUTE output is
-- discarded).
\o /dev/null
\i ../database/queries/field_queries.sql
\o

\echo FQ1 (exact code, unique index samples_sample_code_key)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code = :'some_code';
\echo FQ2a (prefix, rarest year)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE :'pfx_rare';
\echo FQ2b (prefix, ~12% of the table)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE :'pfx_mid';
\echo FQ2c (prefix, ~88% of the table)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE :'pfx_big';
\echo FQ2d (prefix, the samples of one event)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE sample_code LIKE :'pfx_event';
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
\echo FQ5a (Q2, one event; needs samples(event_id) AND sample_status_history(sample_id))
EXPLAIN (ANALYZE, BUFFERS) EXECUTE field_event_samples_latest_status(:hot_event);
\echo FQ5b (samples of one event)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE event_id = :hot_event;
\echo FQ5c (Q1, all sites)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE field_site_sample_counts(NULL);
\echo FQ5d (v_site_sample_summary, one site)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_site_sample_summary WHERE site_id = :hot_site;

-- FQ6: write cost with the audit and status-history triggers ENABLED. Real tables, rolled-back
-- transactions, test database only. The triggers must be enabled (tgenabled = 'O'); this lists them.
SELECT tgrelid::regclass AS table_name, tgname, tgenabled FROM pg_trigger
WHERE tgrelid IN ('samples'::regclass, 'sample_status_history'::regclass) AND NOT tgisinternal ORDER BY 1, 2;
-- :fq6_run registers 1 000 samples over 20 volume events with register_sample() (1 000 history rows,
-- 1 000 audit rows), then changes their status collected -> stored (transition trigger, +1 000 history
-- rows, +1 000 audit rows), and prints the two timings in milliseconds. Run it five times (the first is
-- the warm-up) and take the median of the other four, with and without the follow-up indexes.
-- Rolled-back inserts still consume identity values. The audit and history rows are rolled back too.
\set fq6_run 'BEGIN; SET LOCAL app.current_user_id = ''3''; DO $$ DECLARE ev bigint[]; ids bigint[]; t0 timestamptz; t1 timestamptz; t2 timestamptz; BEGIN SELECT array_agg(event_id ORDER BY event_id) INTO ev FROM (SELECT event_id FROM collection_events WHERE event_id >= 1000000 ORDER BY event_id LIMIT 20) e; t0 := clock_timestamp(); SELECT array_agg(register_sample(ev[1 + g % 20], 1, 100, 0.5, NULL, 3)) INTO ids FROM generate_series(1, 1000) g; t1 := clock_timestamp(); UPDATE samples SET status = ''stored'' WHERE sample_id = ANY (ids); t2 := clock_timestamp(); PERFORM set_config(''bench.register_ms'', round(extract(epoch FROM t1 - t0) * 1000, 1)::text, true), set_config(''bench.status_ms'', round(extract(epoch FROM t2 - t1) * 1000, 1)::text, true); END $$; SELECT current_setting(''bench.register_ms'') AS register_1000_ms, current_setting(''bench.status_ms'') AS status_change_1000_ms; ROLLBACK;'
\echo FQ6 register 1000 samples and change their status (run 1 is the warm-up)
:fq6_run
:fq6_run
:fq6_run
:fq6_run
:fq6_run

-- ============================================================================================
-- T19-A: Analysis, Taxonomy & Analytics (results: database/indexes/analysis_indexes.sql)
-- ============================================================================================
-- Indexes: idx_taxon_assignments_taxon_id_qc_flag, idx_taxon_assignments_library_id. Improved: BQ1a-c,
-- BQ3, BQ4b, BQ5a-b, BQ7a. Expected unchanged: BQ2a-b, BQ4a, BQ6 and BQ8 (unique constraint index), BQ7b.
-- The volume generator creates every analysis as `imported`, but all of these queries read approved
-- runs only, so every 5th volume analysis is approved first (test database only, once). The audit
-- trigger is off for that statement, and approved_at is a fixed timestamp so the result is
-- deterministic. Undone at the end of this file (status back to 'imported', approved_by and
-- approved_at NULL, with the immutability and status triggers off for that statement only).

SELECT NOT EXISTS (SELECT 1 FROM analysis_runs WHERE analysis_id >= 1000000 AND status = 'approved')
   AND EXISTS (SELECT 1 FROM analysis_runs WHERE analysis_id >= 1000000) AS need_approval \gset
\if :need_approval
    BEGIN;
    ALTER TABLE analysis_runs DISABLE TRIGGER trg_analysis_runs_audit;
    UPDATE analysis_runs SET status = 'approved', approved_by = 2, approved_at = timestamptz '2026-01-01 00:00:00+00'
     WHERE analysis_id >= 1000000 AND analysis_id % 5 = 0 AND status = 'imported';
    ALTER TABLE analysis_runs ENABLE TRIGGER trg_analysis_runs_audit;
    COMMIT;
    VACUUM (ANALYZE) analysis_runs;
\endif

SELECT EXISTS (SELECT 1 FROM analysis_runs WHERE analysis_id >= 1000000 AND status = 'approved') AS ok \gset
\if :ok
\else
    \echo STOP T19-A: no approved volume analyses; run npm run volume:load first.
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

-- ============================================================================================
-- T19-B: Laboratory & Sequencing (results: database/indexes/lab_indexes.sql)
-- ============================================================================================
-- Indexes: idx_sequencing_libraries_run_id, idx_dna_extractions_batch_id. Improved: BQ1, BQ2a.
-- Expected unchanged: BQ2b (aggregates every batch), BQ3a and BQ3b (the unique index on
-- (sample_id, attempt_number) already serves them).

SELECT EXISTS (SELECT 1 FROM sequencing_libraries WHERE library_id >= 1000000) AS ok \gset
\if :ok
\else
    \echo STOP T19-B: no volume libraries; run npm run volume:load first.
    \quit
\endif

SELECT run_id AS big_run FROM sequencing_libraries GROUP BY run_id ORDER BY count(*) DESC, run_id LIMIT 1 \gset
-- A batch of typical size: the one whose extraction count is nearest the median.
WITH b AS (SELECT batch_id, count(*) AS n FROM dna_extractions GROUP BY 1),
     m AS (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS med FROM b)
SELECT batch_id AS typ_batch FROM b, m ORDER BY abs(n - med), batch_id LIMIT 1 \gset
SELECT lab_id AS busy_lab FROM extraction_batches GROUP BY lab_id ORDER BY count(*) DESC, lab_id LIMIT 1 \gset
SELECT sample_id AS mid_sample FROM dna_extractions WHERE extraction_id >= 1000000
ORDER BY extraction_id OFFSET (SELECT count(*) / 2 FROM dna_extractions WHERE extraction_id >= 1000000) LIMIT 1 \gset
\echo big run :big_run, typical batch :typ_batch, lab :busy_lab, sample :mid_sample

-- Queries Q1 and Q2 of database/queries/lab_queries.sql (PREPARE; their example EXECUTE output is
-- discarded). The file starts with DEALLOCATE ALL, which also drops the sections above.
\o /dev/null
\i ../database/queries/lab_queries.sql
\o

\echo BQ1 (Q2, the run with the most libraries)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q2_run_libraries_with_samples(:big_run);
\echo BQ2a (extractions of one batch)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM dna_extractions WHERE batch_id = :typ_batch;
\echo BQ2b (Q1, one lab: aggregates every batch, not helped)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q1_extraction_qc_by_batch(:busy_lab);
\echo BQ3a (redundancy: extractions of one sample use uq_dna_extractions_sample_attempt)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM dna_extractions WHERE sample_id = :mid_sample;
\echo BQ3b (v_lab_pipeline_status, one sample)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_lab_pipeline_status WHERE sample_id = :mid_sample;

-- ============================================================================================
-- Cleanup of the rows this file added (skipped when `\set keep_prep 1` was given)
-- ============================================================================================
\if :{?keep_prep}
    \echo Keeping the prepared rows (remove with: npm run bench -- --cleanup)
\else
    DELETE FROM environmental_measurements WHERE measurement_id >= 1000000;
    BEGIN;
    ALTER TABLE analysis_runs DISABLE TRIGGER trg_analysis_runs_audit;
    ALTER TABLE analysis_runs DISABLE TRIGGER trg_analysis_runs_immutable;
    ALTER TABLE analysis_runs DISABLE TRIGGER trg_analysis_runs_status;
    UPDATE analysis_runs SET status = 'imported', approved_by = NULL, approved_at = NULL
     WHERE analysis_id >= 1000000 AND status = 'approved' AND approved_by = 2
       AND approved_at = timestamptz '2026-01-01 00:00:00+00';
    ALTER TABLE analysis_runs ENABLE TRIGGER trg_analysis_runs_audit;
    ALTER TABLE analysis_runs ENABLE TRIGGER trg_analysis_runs_immutable;
    ALTER TABLE analysis_runs ENABLE TRIGGER trg_analysis_runs_status;
    COMMIT;
    VACUUM (ANALYZE) environmental_measurements, analysis_runs;
    \echo Removed the prepared measurements and analysis approvals.
\endif
