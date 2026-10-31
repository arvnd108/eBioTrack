-- Owner: A (Backend)
-- Purpose: 1 transaction scenario with rollback case: Analysis, Taxonomy & Analytics
--
-- T18-A. Scenario: importing and approving a detection file. A CSV of detections is imported into
-- a draft analysis (import_detections(), T16-A) and a second person approves it
-- (approve_analysis(), T16-A). The rollback cases are a bad row in the file (the whole import
-- disappears), a refused approval, a correction that replaces an approved run, and attempts to
-- change an approved result with plain SQL (the T17-A triggers).
--
-- This is a standalone demonstration script, NOT a migration and NOT a test:
-- backend/src/db/migrate.js never runs database/transactions/. Run it by hand with psql (the
-- script fails on purpose, so leave ON_ERROR_STOP off, which is psql's default):
--
--   docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/analysis_transaction.sql
--   psql "$DATABASE_URL" -f database/transactions/analysis_transaction.sql
--   psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/analysis_transaction.sql   (test database only)
--
-- By default every transaction ends in ROLLBACK, so the script leaves the database exactly as
-- it found it and can be run again and again (generated ids move on, because PostgreSQL never
-- hands a consumed identity value back; nothing else differs). With -v keep=1 the one "happy"
-- transaction (Part 1) ends in COMMIT instead, to show durability. It creates its OWN analysis
-- (marked {"demo":"T18-A"}) and never touches the seeded analyses 1 to 4. Never use keep=1 on
-- the development database; reset the test database afterwards. A second keep=1 run stops in
-- Part 0, because the committed demo analysis still exists.
--
-- Requires: the dev/test database after `npm run db:reset` (analyses 1 and 2 approved, 3
-- imported, 4 draft; users 1-6), the T16-A procedures, migration 096 (supersession) and the
-- T17-A triggers. Part 0 checks this and stops if anything is missing. Creates and drops
-- nothing: no DDL, no DELETE, no GRANT. Cleanup is always ROLLBACK (D19).
--
-- ACID, and where each property is shown:
--   Atomicity    Parts 1, 2, 4, 5   a multi-statement unit commits completely or leaves no trace;
--                                   a bad row in a file undoes the whole import
--   Consistency  Part 3, Part 5     constraints, triggers and procedures refuse illegal states,
--                                   whatever statement tries to create them
--   Isolation    Part 6             two sessions: the second approval waits and then loses;
--                                   uncommitted work is invisible; insert versus approval
--   Durability   Part 1 (keep=1)    after COMMIT the rows survive the end of the session
--
-- Parts, and which property each one shows:
--   0  Preflight and baseline (what "unchanged" means for the later checks).
--   1  Commit path: create a draft analysis, import 14 detections as user 5 (analyst), approve
--      as user 2 (principal investigator). The acting user, the audit rows and the effect on
--      v_approved_detections (only the 10 qc "pass" rows count).
--   2  Rollback A: a bad row undoes the whole import (a draft created in the transaction, and
--      then the seeded draft analysis 4), and 25P02 after the error. Also: work done by an
--      earlier statement of the same transaction disappears when a later one fails.
--   3  Rollback B: one rule per transaction, from the procedures, the T17 triggers and the
--      constraints (defence in depth).
--   4  SAVEPOINT variant: recover from a bad batch and re-import in the same transaction.
--   5  Supersession is atomic: a correction replaces an approved run, or nothing changes.
--   6  Double approval and locking: the two-session protocol (comments, copy-paste).
--
-- Conventions used throughout:
--   * Acting user: SET LOCAL app.current_user_id = '<id>' at the start of every transaction,
--     exactly as backend withTransaction does (CONTRACT 7). SET LOCAL lasts until COMMIT or
--     ROLLBACK, so it never leaks into the next transaction on the connection. The procedures
--     take the actor as an argument as well and set the setting themselves.
--   * Isolation: the default READ COMMITTED, which is also what the backend uses.
--   * Errors: \set VERBOSITY verbose prints the SQLSTATE with every error, and the script saves
--     psql's LAST_ERROR_SQLSTATE and LAST_ERROR_MESSAGE right after each failing statement.
--     Every error printed below is an expected, asserted one.
--   * After any error inside BEGIN ... COMMIT the transaction is ABORTED: PostgreSQL ignores
--     every statement until ROLLBACK (25P02). So every failing statement is followed by an
--     explicit ROLLBACK (or ROLLBACK TO SAVEPOINT).
--   * Generated ids start at 1000 and are consumed even on failure. The script never hard-codes
--     them: it captures them with \gset. Audit rows are compared by "audit_id > the baseline
--     maximum", never by absolute counts.
--   * Error codes (CONTRACT 7): EB001 illegal status transition, EB002 business rule,
--     EB003 already processed (the loser of a race). Each check says whether the code comes
--     from a PROCEDURE, a TRIGGER or a CONSTRAINT.
--   * Checks print one line starting with PASS or FAIL; the final section counts them.
--   * Production note: in the API, import and approval are separate requests by different
--     users (D17). The script switches the acting user inside ONE transaction only to show both
--     steps and their audit trail in one place.
--   * An automated version of Part 6.1 is tests/concurrency/double-approval.test.js (20
--     simultaneous attempts: 1 success, the rest EB003); Parts 2 and 3 are mirrored by
--     tests/transactions/import-rollback.test.js.

\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off

-- Tallies. ":check \gset" / ":judge \gset" / ":assert_baseline \gset" print nothing themselves:
-- they set `line` (the PASS/FAIL text, shown with \echo :line), n_pass and n_fail.
\set n_pass 0
\set n_fail 0

-- :check needs the psql variables ok ('t'/'f') and label.
\set check 'SELECT CASE WHEN :\'ok\' = \'t\' THEN \'PASS: \' ELSE \'FAIL: \' END || :\'label\' AS line, :n_pass + (:\'ok\' = \'t\')::int AS n_pass, :n_fail + (:\'ok\' <> \'t\')::int AS n_fail'

-- :judge needs caught (the SQLSTATE seen), want (the one expected) and label.
\set judge 'SELECT CASE WHEN :\'caught\' = :\'want\' THEN \'PASS: \' ELSE \'FAIL: \' END || :\'label\' || \' -> \' || :\'caught\' || CASE WHEN :\'caught\' = :\'want\' THEN \'\' ELSE \' (expected \' || :\'want\' || \')\' END AS line, :n_pass + (:\'caught\' = :\'want\')::int AS n_pass, :n_fail + (:\'caught\' <> :\'want\')::int AS n_fail'

-- The one fixed marker of the scenario: every analysis the script creates carries it.
\set demo_marker '{"demo":"T18-A"}'

-- A new draft analysis on sequencing run 1 (libraries LIB-0001 to LIB-0008), marker 12S.
-- ":new_draft \gset d_" captures d_analysis_id. ":new_correction" is the same with
-- supersedes_analysis_id = 1 (CONTRACT 1.3, migration 096).
\set new_draft 'INSERT INTO analysis_runs (run_id, marker_id, pipeline_name, pipeline_version, reference_db, parameters) VALUES (1, 1, \'T18-A demo pipeline\', \'1.0\', \'MitoFish\', :\'demo_marker\'::jsonb) RETURNING analysis_id'
\set new_correction 'INSERT INTO analysis_runs (run_id, marker_id, pipeline_name, pipeline_version, reference_db, parameters, supersedes_analysis_id) VALUES (1, 1, \'T18-A demo correction\', \'1.1\', \'MitoFish\', :\'demo_marker\'::jsonb, 1) RETURNING analysis_id'

\echo
\echo ============================================================================
\echo PART 0: Preflight and baseline
\echo ============================================================================

SELECT current_database() AS database, current_user AS db_user,
       current_setting('transaction_isolation') AS isolation_level;

-- Refuse to run against a database without the fixture world. Two steps, so a missing object
-- cannot raise an error before we get to print the message.
\set tables_ok false
\set fixtures_ok false
SELECT to_regclass('analysis_runs') IS NOT NULL
   AND to_regclass('taxon_assignments') IS NOT NULL
   AND to_regclass('taxa') IS NOT NULL
   AND to_regclass('sequencing_libraries') IS NOT NULL
   AND to_regclass('audit_logs') IS NOT NULL
   AND to_regclass('v_approved_detections') IS NOT NULL
   AND to_regprocedure('import_detections(bigint,jsonb,bigint)') IS NOT NULL
   AND to_regprocedure('approve_analysis(bigint,bigint)') IS NOT NULL
   AND to_regprocedure('reject_analysis(bigint,bigint,text)') IS NOT NULL
   AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'analysis_runs' AND column_name = 'supersedes_analysis_id')
   AS tables_ok \gset
\if :tables_ok
    -- The 14 valid rows of tests/fixtures/detections_valid.csv, names resolved to taxon_id.
    SELECT jsonb_agg(jsonb_build_object('library_code', v.lc, 'taxon_id', t.taxon_id, 'read_count', v.rc,
                                        'confidence', v.conf, 'qc_flag', v.qc) ORDER BY v.ord) AS valid_batch
    FROM (VALUES (1, 'LIB-0001', 'Labeo rohita', 'species', 14250, 0.9712, 'pass'),
                 (2, 'LIB-0001', 'Labeo calbasu', 'species', 1450, 0.9731, 'pass'),
                 (3, 'LIB-0002', 'Labeo rohita', 'species', 12980, 0.9654, 'pass'),
                 (4, 'LIB-0003', 'Labeo rohita', 'species', 9840, 0.9588, 'pass'),
                 (5, 'LIB-0003', 'Cirrhinus mrigala', 'species', 5210, 0.9120, 'pass'),
                 (6, 'LIB-0004', 'Cirrhinus mrigala', 'species', 4390, 0.8940, 'pass'),
                 (7, 'LIB-0005', 'Cyprinus carpio', 'species', 3060, 0.9015, 'pass'),
                 (8, 'LIB-0005', 'Labeo', 'genus', 720, 0.7410, 'warn'),
                 (9, 'LIB-0006', 'Gambusia affinis', 'species', 0, 0.0000, 'fail'),
                 (10, 'LIB-0007', 'Labeo rohita', 'species', 20310, 1.0000, 'pass'),
                 (11, 'LIB-0007', 'Cirrhinus mrigala', 'species', 88, 0.5120, 'warn'),
                 (12, 'LIB-0007', 'Cyprinus carpio', 'species', 1975, 0.8830, 'pass'),
                 (13, 'LIB-0008', 'Labeo calbasu', 'species', 2210, 0.9390, 'pass'),
                 (14, 'LIB-0008', 'Cirrhinus mrigala', 'species', 35, 0.4010, 'fail'))
         AS v(ord, lc, name, rank, rc, conf, qc)
    JOIN taxa t ON t.scientific_name = v.name AND t.rank::text = v.rank \gset
    -- The same file with row 7 pointing at LIB-0009, which belongs to sequencing run 2
    -- (detections_invalid_row.csv: 6 valid rows before the bad one, 7 after).
    SELECT jsonb_agg(CASE WHEN o.ord = 7 THEN jsonb_set(o.elem, '{library_code}', '"LIB-0009"') ELSE o.elem END
                     ORDER BY o.ord) AS invalid_batch
    FROM jsonb_array_elements(:'valid_batch'::jsonb) WITH ORDINALITY AS o(elem, ord) \gset
    -- A large file: every library of run 1 (8) with every taxon (15) = 120 rows, the LAST one bad.
    -- (library_code + taxon_id must be unique in a file, so 120 is the most run 1 allows.)
    SELECT jsonb_agg(jsonb_build_object('library_code', CASE WHEN x.rn = 120 THEN 'LIB-0009' ELSE x.lc END,
                                        'taxon_id', x.tid, 'read_count', 100, 'confidence', 0.9,
                                        'qc_flag', 'pass') ORDER BY x.rn) AS bulk_bad_batch
    FROM (SELECT row_number() OVER (ORDER BY l, t) AS rn, format('LIB-%s', lpad(l::text, 4, '0')) AS lc, t AS tid
          FROM generate_series(1, 8) AS l, generate_series(1, 15) AS t) x \gset
    SELECT jsonb_array_length(:'valid_batch'::jsonb) = 14
       AND (SELECT string_agg(analysis_id || ':' || status, ',' ORDER BY analysis_id)
              FROM analysis_runs WHERE analysis_id < 1000) = '1:approved,2:approved,3:imported,4:draft'
       AND (SELECT count(*) FROM users WHERE user_id IN (2, 5) AND active) = 2
       AND (SELECT count(*) FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
             WHERE (ur.user_id, r.role_name) IN ((2, 'principal_investigator'), (5, 'analyst'), (6, 'viewer'))) = 3
       AND (SELECT count(*) FROM sequencing_libraries WHERE run_id = 1
               AND library_code IN ('LIB-0001','LIB-0002','LIB-0003','LIB-0004','LIB-0005','LIB-0006','LIB-0007','LIB-0008')) = 8
       AND (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN
              ('trg_analysis_runs_status', 'trg_analysis_runs_immutable', 'trg_taxon_assignments_immutable',
               'trg_analysis_runs_audit')) = 4
       AS fixtures_ok \gset
\endif
\if :fixtures_ok
    \echo PASS: fixture world present (analyses 1-4, users 2/5/6, libraries 1-8, procedures, T17 triggers enabled).
    \set n_pass 1
\else
    \echo
    \echo STOP: the fixture world is missing or incomplete. Expected import_detections(),
    \echo approve_analysis(), reject_analysis(), migration 096, the T17-A triggers
    \echo (trg_analysis_runs_status, trg_analysis_runs_immutable, trg_taxon_assignments_immutable,
    \echo trg_analysis_runs_audit, all enabled), analyses 1-4 as approved/approved/imported/draft,
    \echo users 2 (principal investigator), 5 (analyst), 6 (viewer) and libraries LIB-0001 to
    \echo LIB-0008 on run 1. Run npm run db:reset in backend/ and try again.
    \quit
\endif

-- A committed demo analysis from an earlier keep=1 run would confuse the baseline.
SELECT EXISTS (SELECT 1 FROM analysis_runs WHERE parameters @> :'demo_marker'::jsonb) AS demo_exists \gset
\if :demo_exists
    \echo
    \echo STOP: a demo analysis (parameters {"demo":"T18-A"}) already exists. A previous run with
    \echo keep=1 committed it. Reset the test database (it must not be kept) and run again.
    \quit
\endif

-- Row counts that "unchanged" is measured against. state lists every analysis with its status,
-- its approver and its number of detections.
\set count_all 'SELECT (SELECT count(*) FROM analysis_runs) AS analyses, (SELECT count(*) FROM taxon_assignments) AS detections, (SELECT count(*) FROM audit_logs) AS audit, (SELECT COALESCE(max(audit_id), 0) FROM audit_logs) AS audit_max, (SELECT count(*) FROM v_approved_detections) AS approved, (SELECT string_agg(ar.analysis_id::text || \':\' || ar.status || \':\' || COALESCE(ar.approved_by, 0)::text || \':\' || (SELECT count(*) FROM taxon_assignments ta WHERE ta.analysis_id = ar.analysis_id)::text, \',\' ORDER BY ar.analysis_id) FROM analysis_runs ar) AS state'
:count_all \gset base_
\echo Baseline: :base_analyses analyses, :base_detections detections, :base_approved rows in v_approved_detections, :base_audit audit rows.
\echo State (analysis:status:approver:detections): :base_state

-- :assert_baseline needs label. After a ROLLBACK there is no trace of the transaction.
\set assert_baseline 'WITH c AS (SELECT (SELECT count(*) FROM analysis_runs) = :base_analyses AND (SELECT count(*) FROM taxon_assignments) = :base_detections AND (SELECT count(*) FROM audit_logs) = :base_audit AND (SELECT COALESCE(max(audit_id), 0) FROM audit_logs) = :base_audit_max AND (SELECT count(*) FROM v_approved_detections) = :base_approved AND (SELECT string_agg(ar.analysis_id::text || \':\' || ar.status || \':\' || COALESCE(ar.approved_by, 0)::text || \':\' || (SELECT count(*) FROM taxon_assignments ta WHERE ta.analysis_id = ar.analysis_id)::text, \',\' ORDER BY ar.analysis_id) FROM analysis_runs ar) = :\'base_state\' AS ok) SELECT CASE WHEN ok THEN \'PASS: \' ELSE \'FAIL: \' END || :\'label\' AS line, :n_pass + ok::int AS n_pass, :n_fail + (NOT ok)::int AS n_fail FROM c'

\echo
\echo ============================================================================
\echo PART 1: Commit path - import then approval, with the acting user and the audit trail
\echo ============================================================================
\echo User 5 (analyst) imports 14 detections into a new draft analysis; user 2 (principal
\echo investigator) approves it. Everything happens in ONE transaction.

-- Richness BEFORE (site 1): v_site_richness counts DISTINCT qc-pass species of approved analyses.
SELECT site_id, year, observed_taxa FROM v_site_richness WHERE site_id = 1 ORDER BY year;

BEGIN;
SET LOCAL app.current_user_id = '5';
:new_draft \gset d_
\echo The new draft analysis is :d_analysis_id (captured, never hard-coded).

SELECT import_detections(:d_analysis_id, :'valid_batch'::jsonb, 5) AS rows_imported \gset
\echo Evidence: the import (status, importer, flag counts, total reads)
SELECT ar.status, ar.imported_by, ar.approved_by,
       count(*) FILTER (WHERE ta.qc_flag = 'pass') AS pass, count(*) FILTER (WHERE ta.qc_flag = 'warn') AS warn,
       count(*) FILTER (WHERE ta.qc_flag = 'fail') AS fail, sum(ta.read_count) AS reads
FROM analysis_runs ar JOIN taxon_assignments ta USING (analysis_id)
WHERE ar.analysis_id = :d_analysis_id GROUP BY ar.status, ar.imported_by, ar.approved_by;
\set label 'import_detections returned 14; analysis imported by 5 with 10 pass / 2 warn / 2 fail and 76518 reads'
SELECT :rows_imported = 14 AND ar.status = 'imported' AND ar.imported_by = 5
       AND count(*) FILTER (WHERE ta.qc_flag = 'pass') = 10 AND count(*) FILTER (WHERE ta.qc_flag = 'warn') = 2
       AND count(*) FILTER (WHERE ta.qc_flag = 'fail') = 2 AND sum(ta.read_count) = 76518 AS ok
FROM analysis_runs ar JOIN taxon_assignments ta USING (analysis_id)
WHERE ar.analysis_id = :d_analysis_id GROUP BY ar.status, ar.imported_by \gset
:check \gset
\echo :line

-- Approval is a different person (D17): the acting user changes to 2.
SET LOCAL app.current_user_id = '2';
SELECT approve_analysis(:d_analysis_id, 2);
\echo Evidence: approved by a different user, with a timestamp
SELECT status, imported_by, approved_by, approved_at IS NOT NULL AS has_approved_at
FROM analysis_runs WHERE analysis_id = :d_analysis_id;
\set label 'analysis approved by user 2 (importer 5 is a different person) with approved_at set'
SELECT status = 'approved' AND approved_by = 2 AND imported_by = 5 AND approved_at IS NOT NULL AS ok
FROM analysis_runs WHERE analysis_id = :d_analysis_id \gset
:check \gset
\echo :line

\echo Evidence: the audit rows written by this transaction (acting user and entity)
SELECT entity_type, action, actor_id, details ->> 'detection_count' AS detection_count
FROM audit_logs WHERE audit_id > :base_audit_max ORDER BY audit_id;
\set label '4 audit rows on the analysis: insert (actor 5), update draft-to-imported (5), update to approved (2), one approve entry with detection_count 14 (2)'
SELECT count(*) = 4 AND bool_and(entity_type = 'analysis_runs' AND entity_id = :d_analysis_id)
       AND count(*) FILTER (WHERE action = 'insert' AND actor_id = 5) = 1
       AND count(*) FILTER (WHERE action = 'update' AND actor_id = 5 AND details -> 'status' ->> 'new' = 'imported') = 1
       AND count(*) FILTER (WHERE action = 'update' AND actor_id = 2 AND details -> 'status' ->> 'new' = 'approved') = 1
       AND count(*) FILTER (WHERE action = 'approve' AND actor_id = 2 AND details ->> 'detection_count' = '14') = 1 AS ok
FROM audit_logs WHERE audit_id > :base_audit_max \gset
:check \gset
\echo :line
-- The 14 detection rows are deliberately NOT audited row by row (T17-A, measured: about 3x slower
-- and 470 bytes per row); the analysis rows carry the audit trail.

\echo Evidence: only the 10 qc-pass detections of the approved analysis are visible to queries
SELECT count(*) AS rows_in_view, count(*) FILTER (WHERE qc_flag = 'pass') AS pass_rows
FROM v_approved_detections WHERE analysis_id = :d_analysis_id;
\set label 'v_approved_detections gained exactly the 10 pass rows (the 2 warn and 2 fail rows stay out)'
SELECT (SELECT count(*) FROM v_approved_detections) = :base_approved + 10
       AND (SELECT count(*) FROM v_approved_detections WHERE analysis_id = :d_analysis_id AND qc_flag = 'pass') = 10 AS ok \gset
:check \gset
\echo :line
\echo Richness AFTER (site 1): counts DISTINCT qc-pass species, so the approved analysis can only add species it newly detects
SELECT site_id, year, observed_taxa FROM v_site_richness WHERE site_id = 1 ORDER BY year;

-- COMMIT makes every statement above visible to other sessions at once and durable: once
-- COMMIT returns, the change survives the end of this session and a restart of the server,
-- because it is in the write-ahead log. ROLLBACK discards all of it, including the audit rows.
-- The default is ROLLBACK so the demonstration leaves the database unchanged.
\if :{?keep}
    \echo keep=1: committing Part 1.
    COMMIT;
\else
    \echo Default: rolling back Part 1 (use -v keep=1 to commit).
    ROLLBACK;
\endif

\if :{?keep}
    -- Back in autocommit, a fresh statement sees the committed rows.
    \echo Evidence from a fresh statement after COMMIT:
    SELECT ar.analysis_id, ar.status, ar.approved_by, (SELECT count(*) FROM taxon_assignments WHERE analysis_id = ar.analysis_id) AS detections
    FROM analysis_runs ar WHERE ar.parameters @> :'demo_marker'::jsonb;
    \set label 'the committed analysis, its 14 detections and its audit rows are durable and visible; the seeded analyses are untouched'
    SELECT (SELECT status FROM analysis_runs WHERE analysis_id = :d_analysis_id) = 'approved'
           AND (SELECT count(*) FROM taxon_assignments WHERE analysis_id = :d_analysis_id) = 14
           AND (SELECT count(*) FROM audit_logs) = :base_audit + 4
           AND (SELECT string_agg(analysis_id::text || ':' || status, ',' ORDER BY analysis_id)
                  FROM analysis_runs WHERE analysis_id < 1000) = '1:approved,2:approved,3:imported,4:draft' AS ok \gset
    :check \gset
    \echo :line
    \echo The analysis :d_analysis_id is now committed: every session sees it. Remove it by
    \echo resetting the test database (npm run db:reset against it); do NOT DELETE (D19).
    -- The committed state is the new normal for the rest of the script.
    :count_all \gset base_
\else
    \set label 'rolled back: analyses, detections, audit rows, view rows and statuses are back at the baseline'
    :assert_baseline \gset
    \echo :line
\endif

\echo
\echo ============================================================================
\echo PART 2: Rollback A - a bad row undoes the whole import
\echo ============================================================================
\echo Expected: EB002 naming the row and the field, then 25P02 for any later statement.

-- A1: a new draft analysis and a 120-row file whose LAST row is bad.
\echo
\echo A1: 120 rows (8 libraries x 15 taxa), row 120 uses LIB-0009 (a library of run 2). Expected EB002.
BEGIN;
SET LOCAL app.current_user_id = '5';
:new_draft \gset a_
\echo Evidence: the draft analysis exists inside the transaction
SELECT analysis_id, status FROM analysis_runs WHERE analysis_id = :a_analysis_id;
SELECT import_detections(:a_analysis_id, :'bulk_bad_batch'::jsonb, 5);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
-- The transaction is now aborted. Nothing after the failed statement can half-save the work.
SELECT 1;
\set caught_after :LAST_ERROR_SQLSTATE
\echo ^ 25P02 (current transaction is aborted): only ROLLBACK is accepted now.
ROLLBACK;
\set want EB002
\set label 'A1 bad row 120 of 120 [procedure]'
:judge \gset
\echo :line
\set label 'A1 the message names row 120 and the field library_code'
SELECT position('Row 120, field library_code' IN :'caught_msg') > 0 AS ok \gset
:check \gset
\echo :line
\set caught :caught_after
\set want 25P02
\set label 'A1 the aborted transaction refused the next statement'
:judge \gset
\echo :line
\set label 'A1 the draft analysis is gone with the import, no detections or audit rows remain'
SELECT NOT EXISTS (SELECT 1 FROM analysis_runs WHERE analysis_id = :a_analysis_id)
       AND NOT EXISTS (SELECT 1 FROM taxon_assignments WHERE analysis_id = :a_analysis_id) AS ok \gset
:check \gset
\echo :line
\set label 'A1 back at the baseline'
:assert_baseline \gset
\echo :line

-- A2: the import SUCCEEDS inside the transaction, then a later statement fails. Because the
-- procedure validates the whole file before it inserts anything (A1 never inserts a row), this is
-- the case that shows rows already stored being undone.
\echo
\echo A2: import 14 valid rows (succeeds), then approve as the analyst (user 5). Expected EB002.
BEGIN;
SET LOCAL app.current_user_id = '5';
:new_draft \gset a_
SELECT import_detections(:a_analysis_id, :'valid_batch'::jsonb, 5) AS rows_imported \gset
\echo Evidence: 14 detections are stored inside the transaction
SELECT count(*) AS detections_so_far FROM taxon_assignments WHERE analysis_id = :a_analysis_id;
SELECT approve_analysis(:a_analysis_id, 5);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set want EB002
\set label 'A2 approval by the analyst refused after a successful import [procedure]'
:judge \gset
\echo :line
\set label 'A2 the 14 stored detections were undone too (atomicity across statements)'
:assert_baseline \gset
\echo :line

-- A3: the same bad file against the seeded draft analysis 4 (the case of detections_invalid_row.csv).
\echo
\echo A3: seeded analysis 4 (draft), 14 rows with row 7 on LIB-0009: 6 valid before and 7 after
\echo the bad one. Expected EB002; none of the 14 may land.
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(4, :'invalid_batch'::jsonb, 5);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :LAST_ERROR_MESSAGE
\echo Caught SQLSTATE :caught :caught_msg
ROLLBACK;
\set want EB002
\set label 'A3 bad row 7 of 14 [procedure]'
:judge \gset
\echo :line
\echo Evidence: analysis 4 after the rollback
SELECT analysis_id, status, imported_by, (SELECT count(*) FROM taxon_assignments WHERE analysis_id = 4) AS detections
FROM analysis_runs WHERE analysis_id = 4;
\set label 'A3 analysis 4 is still a draft with 0 of the 14 rows stored'
SELECT status = 'draft' AND imported_by IS NULL AND (SELECT count(*) FROM taxon_assignments WHERE analysis_id = 4) = 0
       AND position('Row 7, field library_code' IN :'caught_msg') > 0 AS ok
FROM analysis_runs WHERE analysis_id = 4 \gset
:check \gset
\echo :line
\set label 'A3 back at the baseline'
:assert_baseline \gset
\echo :line

\echo
\echo ============================================================================
\echo PART 3: Rollback B - one rule per transaction, three layers of defence
\echo ============================================================================
\echo Each case is its own BEGIN ... ROLLBACK with the acting user set. [procedure] errors come
\echo from import_detections / approve_analysis / reject_analysis, [trigger] errors from the
\echo T17-A triggers (plain SQL cannot bypass them), [constraint] errors from the table keys.
\echo The baseline is asserted at the end of the part.

\echo
\echo B1: import row with an unknown taxon_id (D16: never created on the fly)
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(4, jsonb_set(:'valid_batch'::jsonb, '{2,taxon_id}', '999'), 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B1 unknown taxon [procedure]'
:judge \gset
\echo :line

\echo
\echo B2: the same library_code and taxon_id twice in one file
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(4, :'valid_batch'::jsonb || ((:'valid_batch'::jsonb) -> 0), 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B2 duplicate library and taxon in the file [procedure]'
:judge \gset
\echo :line

\echo
\echo B3a: confidence 1.5
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(4, jsonb_set(:'valid_batch'::jsonb, '{0,confidence}', '1.5'), 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B3a confidence 1.5 [procedure]'
:judge \gset
\echo :line

\echo
\echo B3b: negative read_count
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(4, jsonb_set(:'valid_batch'::jsonb, '{0,read_count}', '-1'), 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B3b negative read_count [procedure]'
:judge \gset
\echo :line

\echo
\echo B3c: qc_flag outside pass / warn / fail
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(4, jsonb_set(:'valid_batch'::jsonb, '{0,qc_flag}', '"bogus"'), 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B3c bad qc_flag [procedure]'
:judge \gset
\echo :line

\echo
\echo B4: import into analysis 3, which is already imported (EB003: already processed)
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT import_detections(3, :'valid_batch'::jsonb, 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB003
\set label 'B4 import into an imported analysis [procedure]'
:judge \gset
\echo :line

\echo
\echo B5: import into a rejected analysis (created and rejected inside the transaction)
BEGIN;
SET LOCAL app.current_user_id = '2';
:new_draft \gset b_
SELECT reject_analysis(:b_analysis_id, 2, 'T18-A demo: rejected before import');
SELECT import_detections(:b_analysis_id, :'valid_batch'::jsonb, 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB001
\set label 'B5 import into a rejected analysis [procedure]'
:judge \gset
\echo :line

\echo
\echo B6: import by a viewer (user 6)
BEGIN;
SET LOCAL app.current_user_id = '6';
SELECT import_detections(4, :'valid_batch'::jsonb, 6);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B6 import by a viewer [procedure]'
:judge \gset
\echo :line

\echo
\echo B7: approve analysis 4, which is still a draft
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT approve_analysis(4, 2);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB001
\set label 'B7 approve a draft [procedure]'
:judge \gset
\echo :line

\echo
\echo B8: approve analysis 1, which is already approved
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT approve_analysis(1, 2);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB003
\set label 'B8 approve an approved analysis [procedure]'
:judge \gset
\echo :line

\echo
\echo B9: approve analysis 3 as its importer, user 5 (an analyst, not a principal investigator)
BEGIN;
SET LOCAL app.current_user_id = '5';
SELECT approve_analysis(3, 5);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B9 approval by the analyst importer [procedure]'
:judge \gset
\echo :line

\echo
\echo B10: an importer who IS a principal investigator approves their own import (D17)
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT import_detections(4, :'valid_batch'::jsonb, 2);
SELECT approve_analysis(4, 2);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B10 self-approval by a principal investigator [procedure]'
:judge \gset
\echo :line

\echo
\echo B11: approve an imported analysis that has no detections (built with plain SQL)
BEGIN;
SET LOCAL app.current_user_id = '5';
:new_draft \gset b_
UPDATE analysis_runs SET status = 'imported', imported_by = 5 WHERE analysis_id = :b_analysis_id;
SET LOCAL app.current_user_id = '2';
SELECT approve_analysis(:b_analysis_id, 2);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B11 approve without detections [procedure]'
:judge \gset
\echo :line

\echo
\echo B12a: reject_analysis on the approved analysis 1
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT reject_analysis(1, 2, 'T18-A demo reason');
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB001
\set label 'B12a reject an approved analysis [procedure]'
:judge \gset
\echo :line

\echo
\echo B12b: reject_analysis with a blank reason (analysis 3)
BEGIN;
SET LOCAL app.current_user_id = '2';
SELECT reject_analysis(3, 2, '   ');
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B12b reject without a reason [procedure]'
:judge \gset
\echo :line

\echo
\echo B13a: plain UPDATE of the parameters of the approved analysis 1 (bypassing the procedures)
BEGIN;
SET LOCAL app.current_user_id = '2';
UPDATE analysis_runs SET parameters = '{"tampered":true}' WHERE analysis_id = 1;
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B13a edit an approved analysis [trigger trg_analysis_runs_immutable]'
:judge \gset
\echo :line

\echo
\echo B13b: plain UPDATE of a detection of the approved analysis 1
BEGIN;
SET LOCAL app.current_user_id = '2';
UPDATE taxon_assignments SET read_count = read_count + 1
WHERE assignment_id = (SELECT min(assignment_id) FROM taxon_assignments WHERE analysis_id = 1);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B13b edit an approved detection [trigger trg_taxon_assignments_immutable]'
:judge \gset
\echo :line

\echo
\echo B13c: plain DELETE of a detection of the approved analysis 1
BEGIN;
SET LOCAL app.current_user_id = '2';
DELETE FROM taxon_assignments
WHERE assignment_id = (SELECT min(assignment_id) FROM taxon_assignments WHERE analysis_id = 1);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB002
\set label 'B13c delete an approved detection [trigger trg_taxon_assignments_immutable]'
:judge \gset
\echo :line

\echo
\echo B14: illegal status change by plain SQL: approved back to draft
BEGIN;
SET LOCAL app.current_user_id = '2';
UPDATE analysis_runs SET status = 'draft' WHERE analysis_id = 1;
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want EB001
\set label 'B14 approved to draft [trigger trg_analysis_runs_status]'
:judge \gset
\echo :line

\echo
\echo B15a: detection with a library that does not exist, plain INSERT into the draft analysis 4
BEGIN;
SET LOCAL app.current_user_id = '5';
INSERT INTO taxon_assignments (analysis_id, library_id, taxon_id, read_count, confidence, qc_flag)
VALUES (4, 999999, 7, 10, 0.9, 'pass');
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want 23503
\set label 'B15a unknown library [constraint fk_taxon_assignments_library_id]'
:judge \gset
\echo :line

\echo
\echo B15b: detection with a taxon that does not exist
BEGIN;
SET LOCAL app.current_user_id = '5';
INSERT INTO taxon_assignments (analysis_id, library_id, taxon_id, read_count, confidence, qc_flag)
VALUES (4, 1, 999999, 10, 0.9, 'pass');
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK;
\set want 23503
\set label 'B15b unknown taxon [constraint fk_taxon_assignments_taxon_id]'
:judge \gset
\echo :line

\echo
\set label 'Part 3: back at the baseline after all the rolled-back cases'
:assert_baseline \gset
\echo :line

\echo
\echo ============================================================================
\echo PART 4: SAVEPOINT variant - fix the file and re-import in the same transaction
\echo ============================================================================
\echo Expected: EB002 for the bad file, then the transaction is usable again and the corrected
\echo file imports. Mirrors "fix the CSV and upload again".

BEGIN;
SET LOCAL app.current_user_id = '5';
:new_draft \gset s_
SAVEPOINT before_import;
SELECT import_detections(:s_analysis_id, :'invalid_batch'::jsonb, 5);
\set caught :LAST_ERROR_SQLSTATE

-- Without the savepoint the next statement would fail with 25P02 (see Part 2). Rolling back to it
-- undoes only the work since the savepoint, and the transaction is usable again.
ROLLBACK TO SAVEPOINT before_import;
\echo Evidence: the transaction works again; the analysis is still a draft with no detections
SELECT status, (SELECT count(*) FROM taxon_assignments WHERE analysis_id = :s_analysis_id) AS detections
FROM analysis_runs WHERE analysis_id = :s_analysis_id;
\set want EB002
\set label 'Part 4 the bad file raised EB002 inside the savepoint [procedure]'
:judge \gset
\echo :line

SELECT import_detections(:s_analysis_id, :'valid_batch'::jsonb, 5) AS rows_imported \gset
\echo Evidence: the corrected file imported
SELECT (SELECT count(*) FROM analysis_runs) - :base_analyses AS analyses_added,
       ar.status, (SELECT count(*) FROM taxon_assignments WHERE analysis_id = ar.analysis_id) AS detections
FROM analysis_runs ar WHERE ar.analysis_id = :s_analysis_id;
\set label 'after the savepoint: one analysis, status imported, 14 detections, import returned 14'
SELECT :rows_imported = 14 AND ar.status = 'imported'
       AND (SELECT count(*) FROM taxon_assignments WHERE analysis_id = ar.analysis_id) = 14
       AND (SELECT count(*) FROM analysis_runs) = :base_analyses + 1 AS ok
FROM analysis_runs ar WHERE ar.analysis_id = :s_analysis_id \gset
:check \gset
\echo :line

-- A savepoint is only worth it when earlier work in the same transaction must be kept (here: the
-- new analysis). The API's usual path is a fresh transaction per upload: the bad file rolls back
-- completely and the user uploads again, which is simpler and needs no subtransaction.
\echo Default: rolling back Part 4.
ROLLBACK;
\set label 'Part 4 back at the baseline'
:assert_baseline \gset
\echo :line

\echo
\echo ============================================================================
\echo PART 5: Supersession is atomic - a correction replaces an approved run, or nothing changes
\echo ============================================================================
\echo Analysis 1 is approved. A correction (supersedes_analysis_id = 1) is imported and approved.

\echo
\echo 5a: success - the correction becomes approved and analysis 1 becomes superseded together
BEGIN;
SET LOCAL app.current_user_id = '5';
:new_correction \gset c_
SELECT import_detections(:c_analysis_id, :'valid_batch'::jsonb, 5) AS rows_imported \gset
SELECT count(*) AS a1_rows_before FROM v_approved_detections WHERE analysis_id = 1 \gset
SELECT count(*) AS view_before FROM v_approved_detections \gset
SET LOCAL app.current_user_id = '2';
SELECT approve_analysis(:c_analysis_id, 2);
\echo Evidence: both statuses after the one call
SELECT analysis_id, status, approved_by, supersedes_analysis_id FROM analysis_runs
WHERE analysis_id IN (1, :c_analysis_id) ORDER BY analysis_id;
\set label '5a the correction is approved and analysis 1 became superseded in the same transaction'
SELECT (SELECT status FROM analysis_runs WHERE analysis_id = :c_analysis_id) = 'approved'
       AND (SELECT status FROM analysis_runs WHERE analysis_id = 1) = 'superseded' AS ok \gset
:check \gset
\echo :line
\echo Evidence: v_approved_detections now excludes analysis 1 and includes the correction
SELECT count(*) FILTER (WHERE analysis_id = 1) AS from_analysis_1,
       count(*) FILTER (WHERE analysis_id = :c_analysis_id) AS from_correction, count(*) AS total
FROM v_approved_detections;
\set label '5a the view lost every detection of analysis 1 and gained the 10 pass rows of the correction'
SELECT (SELECT count(*) FROM v_approved_detections WHERE analysis_id = 1) = 0
       AND (SELECT count(*) FROM v_approved_detections WHERE analysis_id = :c_analysis_id) = 10
       AND (SELECT count(*) FROM v_approved_detections) = :view_before - :a1_rows_before + 10 AS ok \gset
:check \gset
\echo :line
\echo Evidence: the audit entries of the supersession (approve with supersedes, update on the old run)
SELECT entity_id, action, actor_id, details ->> 'superseded_by' AS superseded_by, details ->> 'supersedes_analysis_id' AS supersedes
FROM audit_logs WHERE audit_id > :base_audit_max AND action IN ('approve', 'update') AND entity_type = 'analysis_runs'
  AND (details ->> 'to_status' = 'superseded' OR action = 'approve') ORDER BY audit_id;
ROLLBACK;
\set label '5a back at the baseline'
:assert_baseline \gset
\echo :line

\echo
\echo 5b: failure - the approver is the importer (EB002); analysis 1 stays approved
BEGIN;
SET LOCAL app.current_user_id = '2';
:new_correction \gset c_
SELECT import_detections(:c_analysis_id, :'valid_batch'::jsonb, 2);
\echo Evidence: before the refused approval
SELECT analysis_id, status FROM analysis_runs WHERE analysis_id IN (1, :c_analysis_id) ORDER BY analysis_id;
SAVEPOINT before_approval;
SELECT approve_analysis(:c_analysis_id, 2);
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK TO SAVEPOINT before_approval;
\echo Evidence: after the refusal analysis 1 is untouched and the correction is still imported
SELECT analysis_id, status FROM analysis_runs WHERE analysis_id IN (1, :c_analysis_id) ORDER BY analysis_id;
\set want EB002
\set label '5b self-approval of a correction refused [procedure]'
:judge \gset
\echo :line
\set label '5b analysis 1 is still approved and the correction is still imported'
SELECT (SELECT status FROM analysis_runs WHERE analysis_id = 1) = 'approved'
       AND (SELECT status FROM analysis_runs WHERE analysis_id = :c_analysis_id) = 'imported' AS ok \gset
:check \gset
\echo :line

-- Optional: the trigger alone refuses to supersede without an approved correction (plain SQL).
SAVEPOINT before_supersede;
UPDATE analysis_runs SET status = 'superseded' WHERE analysis_id = 1;
\set caught :LAST_ERROR_SQLSTATE
ROLLBACK TO SAVEPOINT before_supersede;
\set want EB001
\set label '5b plain SQL cannot supersede analysis 1 without an approved correction [trigger trg_analysis_runs_status]'
:judge \gset
\echo :line
ROLLBACK;
\set label '5b after ROLLBACK the correction does not exist and analysis 1 is untouched'
:assert_baseline \gset
\echo :line

\echo
\echo ============================================================================
\echo PART 6: Double approval and locking - two sessions (copy-paste protocol)
\echo ============================================================================
\echo A single psql script cannot run two concurrent sessions, so this part is a documented
\echo copy-paste protocol in the comments of this file. Nothing is executed here. No extension
\echo (dblink) is installed, and this script adds none.

-- Open three psql tabs against the SAME test database: S1, S2 and S3 (observer). Analysis 3 is
-- imported (importer 5) with 15 detections on sequencing run 2; user 2 is a principal
-- investigator. Each scenario below ends with analysis 3 approved, so run `npm run db:reset`
-- (test database) between scenarios 1, 2 (forward), 2 (reverse) and 3.
-- Observer query for S3 (shows who waits and why):
--     SELECT pid, wait_event_type, wait_event, state, left(query, 50) AS query
--     FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();
--
-- 1. Double approval (the second approval waits, then loses with EB003).
--    S1: BEGIN;
--        SET LOCAL app.current_user_id = '2';
--        SELECT approve_analysis(3, 2);            -> returns (empty void row); leave the transaction OPEN
--    S2: BEGIN;
--        SET LOCAL app.current_user_id = '2';
--        SELECT approve_analysis(3, 2);            -> BLOCKS: both calls start with SELECT ... FOR UPDATE
--                                                     on the same analysis row; S2 waits for S1.
--    S3: the observer shows S2 with wait_event_type = 'Lock', wait_event = 'transactionid',
--        state = 'active'.
--    S1: COMMIT;   -> S2 unblocks and re-reads the status AFTER the lock (READ COMMITTED):
--                     ERROR:  EB003: Analysis 3 is already approved
--                     DETAIL:  An analysis can be approved only once.
--    S2: ROLLBACK;
--    Check: SELECT status, approved_by, approved_at IS NOT NULL FROM analysis_runs WHERE analysis_id = 3;
--           -> approved | 2 | t  (once), and
--           SELECT count(*) FROM audit_logs WHERE action = 'approve' AND entity_id = 3;  -> 1
--    Analysis 3 stays approved: run npm run db:reset (test database) afterwards.
--
-- 2. Insert versus approval (the FOR SHARE lock taken by the T17-A trigger on the parent run).
--    Forward: S1: BEGIN; SET LOCAL app.current_user_id = '2'; SELECT approve_analysis(3, 2);  (leave open)
--             S2: BEGIN;
--                 INSERT INTO taxon_assignments (analysis_id, library_id, taxon_id, read_count, confidence, qc_flag)
--                 VALUES (3, 16, 7, 5, 0.9, 'pass');
--                 -> BLOCKS (observer: Lock / transactionid): the trigger needs FOR SHARE on analysis 3,
--                    which conflicts with S1's update.
--             S1: COMMIT;   -> S2 unblocks and is refused:
--                 ERROR:  EB002: Analysis 3 is approved and its detections cannot be added to
--                 DETAIL:  Approved results are never edited in place; a correction is a new analysis run.
--             S2: ROLLBACK;
--    Reverse: (after a reset) S2 first: BEGIN; INSERT ... VALUES (3, 16, 7, 5, 0.9, 'pass');  (leave open)
--             S1: BEGIN; SET LOCAL app.current_user_id = '2'; SELECT approve_analysis(3, 2);
--                 -> BLOCKS on S2's uncommitted row (the FOR UPDATE on the run waits for the share lock).
--             S2: COMMIT;   -> S1 unblocks and approves WITH the new row:
--                 SELECT details ->> 'detection_count' FROM audit_logs WHERE action = 'approve' AND entity_id = 3;
--                 -> 16 (15 seeded + 1). S1: COMMIT;
--    Either order, an approved result never changes under the approver's feet.
--
-- 3. Isolation level: why READ COMMITTED (the default, and what the backend uses).
--    S1: BEGIN; SET LOCAL app.current_user_id = '2'; SELECT approve_analysis(3, 2);  (leave open)
--    S2: BEGIN ISOLATION LEVEL REPEATABLE READ;
--        SELECT count(*) FROM analysis_runs;       -> takes the snapshot (before S1 commits)
--        SELECT approve_analysis(3, 2);            -> BLOCKS
--    S1: COMMIT;   -> S2 fails with
--                     ERROR:  40001: could not serialize access due to concurrent update
--                     instead of the meaningful EB003. S2: ROLLBACK;
--    Not used: the loser would have to retry blindly and the client could not tell "already
--    approved" from a transient conflict. Under READ COMMITTED the lock makes the loser re-read
--    the new status, so the error is precise (EB003, HTTP 409) and needs no retry.
--
-- 4. Uncommitted work is invisible.
--    S1: BEGIN; SET LOCAL app.current_user_id = '5';
--        SELECT import_detections(4, '[{"library_code":"LIB-0001","taxon_id":7,"read_count":1,"confidence":0.9,"qc_flag":"pass"}]'::jsonb, 5);   -> 1
--    S2: SELECT count(*) FROM taxon_assignments WHERE analysis_id = 4;   -> 0 (S1 sees 1)
--    S1: COMMIT;   -> the same query in S2 now returns 1. (Or ROLLBACK: it stays 0.)
--    A committed import into analysis 4 breaks the fixtures: run npm run db:reset afterwards.
--
-- 5. dblink: not installed and not added (no extensions). This part stays a protocol; the
--    permanent automated version is tests/concurrency/double-approval.test.js (T34).

\echo (protocol: see the comments after this line in the script)

\echo
\echo ============================================================================
\echo Final check: nothing left behind
\echo ============================================================================
\if :{?keep}
    \echo keep=1: the committed demo analysis from Part 1 remains on purpose. Reset this database.
\else
    \set label 'the database is exactly as the script found it'
    :assert_baseline \gset
    \echo :line
\endif

\echo
\echo Summary: :n_pass checks passed, :n_fail checks failed.
SELECT :n_fail > 0 AS has_fail \gset
\if :has_fail
    \echo VERDICT: FAIL - read the FAIL lines above.
\else
    \echo VERDICT: all checks passed.
\endif
\echo Done.
