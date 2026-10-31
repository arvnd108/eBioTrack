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
