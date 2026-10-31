-- Owner: B (Frontend)
-- Purpose: 1 transaction scenario with rollback case: Laboratory & Sequencing
--
-- Issue #34 / T18-B. Scenario: batch extraction entry, with row locking so two users cannot
-- assign the same extraction to a run. This is a standalone demonstration script, NOT a
-- migration: backend/src/db/migrate.js never runs database/transactions/. Run it by hand with
-- psql (the script fails on purpose, so leave ON_ERROR_STOP off, which is psql's default):
--
--   docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/lab_transaction.sql
--   psql "$DATABASE_URL" -f database/transactions/lab_transaction.sql
--   psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/lab_transaction.sql   (test database only)
--
-- By default every transaction ends in ROLLBACK, so the script leaves the database exactly as
-- it found it and can be run again and again (generated ids move on, because PostgreSQL never
-- hands a consumed identity value back; nothing else differs). With -v keep=1 the two
-- "happy" transactions (Part 1 and Part 4) end in COMMIT instead, to show durability. Never
-- use keep=1 on the development database; reset the test database afterwards.
--
-- Requires: the dev/test database after `npm run db:reset` (17 seeded extractions; the lab
-- procedures and the audit triggers installed). Part 0 checks this and stops if it is missing.
-- Creates and drops nothing: no DDL, no DELETE, no GRANT. Cleanup is always ROLLBACK.
--
-- Parts, and which property each one shows:
--   0  Preflight and baseline counts (what "unchanged" means for the later checks).
--   1  Commit path: one transaction enters an extraction batch (batch, extractions, QC
--      results, verdicts) and books the passing extractions on a new sequencing run.
--      Atomicity of a multi-table write; the audit rows carry the acting user (set with
--      SET LOCAL, as the backend does); COMMIT is what makes it durable and visible.
--   2  Rollback A: a bad row (negative concentration) in the batch. The earlier inserts and
--      their audit rows are undone too. The failed transaction refuses further statements
--      (25P02): no code after the error can save half a batch.
--   3  Rollback B: the booking rules (QC not passed, already booked) undo the run, the
--      libraries AND the earlier batch entry. Then two guard rails: REPEATABLE READ is refused,
--      and plain SQL cannot bypass the QC rule (trigger). Consistency: constraints, triggers
--      and procedures raise the CONTRACT 7 error codes.
--   4  SAVEPOINT variant: recover from one bad row without redoing the whole batch.
--   5  Locking: the two-session protocol (comments, copy-paste) that proves the second user
--      is blocked by SELECT ... FOR UPDATE and then refused. Isolation under READ COMMITTED.
--
-- Conventions used throughout:
--   * Acting user: SET LOCAL app.current_user_id = '4' (lab technician) at the start of every
--     transaction, exactly as backend withTransaction does (CONTRACT 7). SET LOCAL lasts until
--     COMMIT or ROLLBACK, so it can never leak into the next transaction on the connection.
--   * Isolation: the default READ COMMITTED, which is also what the backend uses.
--     (SERIALIZABLE would also be safe for the booking procedures, PostgreSQL would abort one
--     of two competing writers; it is not needed here and not used.)
--   * Errors: \set VERBOSITY verbose prints the SQLSTATE with every error, and the script
--     saves psql's LAST_ERROR_SQLSTATE right after each failing statement, so after the
--     ROLLBACK it can PASS/FAIL the code it expected.
--   * After any error inside BEGIN ... COMMIT the transaction is ABORTED: PostgreSQL ignores
--     every statement until ROLLBACK (25P02). So every failing statement below is followed by
--     an explicit ROLLBACK (or ROLLBACK TO SAVEPOINT).
--   * Generated ids start at 1000 and are consumed even on failure. The script never
--     hard-codes them: it captures them with RETURNING ... \gset.
--
-- Attempt numbers. No database object assigns dna_extractions.attempt_number (the table only
-- has UNIQUE (sample_id, attempt_number)); the API is meant to. So the scenario computes
-- COALESCE(max(attempt_number), 0) + 1 per sample INSIDE the transaction, after locking the
-- sample rows FOR UPDATE in ascending id order. This is the pattern the backend service
-- (extractions.service.js) should follow. Without the lock, two technicians re-extracting the
-- same sample would both compute the same number and the loser would get 23505 on
-- uq_dna_extractions_sample_attempt: still safe (no duplicate row), but a noisy failure
-- instead of a short wait.

\set ON_ERROR_STOP off
\set VERBOSITY verbose
\pset pager off

\echo
\echo ============================================================================
\echo PART 0: Preflight and baseline
\echo ============================================================================

SELECT current_database() AS database, current_user AS db_user,
       current_setting('transaction_isolation') AS isolation_level;

-- Refuse to run against a database without the fixture world. Two steps, so a missing table
-- cannot raise an error before we get to print the message.
\set fixtures_ok false
\set tables_ok false
SELECT to_regclass('dna_extractions') IS NOT NULL
   AND to_regclass('audit_logs') IS NOT NULL
   AND to_regclass('extraction_batches') IS NOT NULL
   AND to_regclass('v_lab_pipeline_status') IS NOT NULL
   AND to_regprocedure('create_sequencing_run(bigint,text,date,bigint[],bigint)') IS NOT NULL
   AS tables_ok \gset
\if :tables_ok
    SELECT (SELECT count(*) FROM dna_extractions) = 17
       AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_dna_extractions_audit',
                'trg_quality_control_results_audit', 'trg_sequencing_runs_audit',
                'trg_sequencing_libraries_audit', 'trg_sequencing_libraries_qc_pass')) = 5
       AND (SELECT count(*) FROM samples WHERE sample_id IN (6, 12, 17)) = 3
       AND EXISTS (SELECT 1 FROM users WHERE user_id = 4)
       AND (SELECT qc_status FROM dna_extractions WHERE extraction_id = 17) = 'fail'
       AS fixtures_ok \gset
\endif
\if :fixtures_ok
    \echo PASS: fixture world present (17 extractions, lab procedures, QC and audit triggers).
\else
    \echo
    \echo STOP: the fixture world is missing or incomplete. Expected 17 seeded extractions,
    \echo create_sequencing_run(), the lab triggers and the audit triggers.
    \echo Run npm run db:reset in backend/ (development database) and try again.
    \quit
\endif

-- Row counts that "unchanged" is measured against. extraction_batches has no audit trigger,
-- so its changes show up in its own count only.
\set count_all 'SELECT (SELECT count(*) FROM extraction_batches) AS batches, (SELECT count(*) FROM dna_extractions) AS extractions, (SELECT count(*) FROM quality_control_results) AS qc, (SELECT count(*) FROM sequencing_runs) AS runs, (SELECT count(*) FROM sequencing_libraries) AS libraries, (SELECT count(*) FROM audit_logs) AS audit, (SELECT COALESCE(max(audit_id), 0) FROM audit_logs) AS audit_max'
:count_all \gset base_
\echo Baseline: :base_batches batches, :base_extractions extractions, :base_qc QC results, :base_runs runs, :base_libraries libraries, :base_audit audit rows.

-- :assert_baseline expands to a one-row query: every count equals the baseline.
\set assert_baseline 'SELECT (SELECT count(*) FROM extraction_batches) = :base_batches AS batches, (SELECT count(*) FROM dna_extractions) = :base_extractions AS extractions, (SELECT count(*) FROM quality_control_results) = :base_qc AS qc, (SELECT count(*) FROM sequencing_runs) = :base_runs AS runs, (SELECT count(*) FROM sequencing_libraries) = :base_libraries AS libraries, (SELECT count(*) FROM audit_logs) = :base_audit AS audit_logs'

\echo
\echo ============================================================================
\echo PART 1: Commit path - batch extraction entry and run booking, all or nothing
\echo ============================================================================
\echo Re-extraction batch for samples 6 (low yield), 12 (faint negative control) and 17
\echo (failed extraction). Sample 6 and 12 extract well; sample 17 is deliberately poor.

BEGIN;
SET LOCAL app.current_user_id = '4';

-- Serialise technicians who touch the same samples: lock the sample rows in ascending id
-- order (the same order the booking procedures use, so no two sessions can wait on each other
-- in a cycle). The attempt numbers computed below are then stable until we finish.
SELECT sample_id FROM samples WHERE sample_id IN (6, 12, 17) ORDER BY sample_id FOR UPDATE;

INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
VALUES (1, 4, current_date, 'DNeasy PowerWater', 'Re-extraction batch (transaction demo, T18-B)')
RETURNING batch_id \gset

INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT v.sample_id, :batch_id,
       COALESCE((SELECT max(e.attempt_number) FROM dna_extractions e WHERE e.sample_id = v.sample_id), 0) + 1,
       v.concentration, v.purity
FROM (VALUES (6, 24.800, 1.88), (12, 31.200, 1.91), (17, 3.100, 1.42)) AS v(sample_id, concentration, purity)
ORDER BY v.sample_id;

-- Ids of the three new extractions (qc_status is still the default 'pending').
SELECT max(extraction_id) FILTER (WHERE sample_id = 6)  AS ext6,
       max(extraction_id) FILTER (WHERE sample_id = 12) AS ext12,
       max(extraction_id) FILTER (WHERE sample_id = 17) AS ext17
FROM dna_extractions WHERE batch_id = :batch_id \gset

-- One concentration measurement per extraction; result agrees with the verdict set next.
INSERT INTO quality_control_results (sample_id, qc_type, result, metric_value, notes, recorded_by)
VALUES (6,  'concentration', 'pass', 24.800, 'Re-extraction, yield recovered', 4),
       (12, 'concentration', 'pass', 31.200, 'Re-extraction, clean',          4),
       (17, 'concentration', 'fail',  3.100, 'Re-extraction, still too low',  4);

-- Verdicts in one statement: two pass, one fail.
UPDATE dna_extractions AS e SET qc_status = v.verdict::qc_status
FROM (VALUES (:ext6, 'pass'), (:ext12, 'pass'), (:ext17, 'fail')) AS v(extraction_id, verdict)
WHERE e.extraction_id = v.extraction_id;

-- Book ONLY the passing extractions. The procedure locks both FOR UPDATE (ascending id),
-- re-checks QC and the booking rule, and writes the run and one library per extraction.
SELECT create_sequencing_run(1, 'Illumina MiSeq', current_date, ARRAY[:ext6, :ext12]::bigint[], 4) AS run_id \gset
SELECT run_code, status, platform FROM sequencing_runs WHERE run_id = :run_id;
SELECT l.library_code, l.extraction_id, e.sample_id, e.attempt_number
FROM sequencing_libraries l JOIN dna_extractions e USING (extraction_id)
WHERE l.run_id = :run_id ORDER BY l.library_id;

\echo Evidence inside the transaction: the new attempts in v_lab_pipeline_status
SELECT sample_code, latest_attempt_number AS attempt, latest_qc_status AS qc, library_code, run_code, pipeline_stage
FROM v_lab_pipeline_status WHERE sample_id IN (6, 12, 17) ORDER BY sample_id;

\echo Evidence: row counts moved by exactly 1 batch, 3 extractions, 3 QC rows, 1 run, 2 libraries
:count_all \gset in1_
SELECT :in1_batches - :base_batches = 1 AS batches_plus_1,
       :in1_extractions - :base_extractions = 3 AS extractions_plus_3,
       :in1_qc - :base_qc = 3 AS qc_plus_3,
       :in1_runs - :base_runs = 1 AS runs_plus_1,
       :in1_libraries - :base_libraries = 2 AS libraries_plus_2;

\echo Evidence: audit rows written by this transaction, all with actor 4 (SET LOCAL did its job)
SELECT entity_type, action, count(*) AS rows, bool_and(actor_id = 4) AS actor_is_4
FROM audit_logs WHERE audit_id > :base_audit_max
GROUP BY entity_type, action ORDER BY entity_type, action;

-- Remember how many audit rows this transaction wrote, for the comparison after it ends.
SELECT :in1_audit - :base_audit AS audit_delta \gset

-- COMMIT makes every statement above visible to other sessions at once and durable: once
-- COMMIT returns, the change survives the end of this session and a restart of the server,
-- because it is in the write-ahead log. ROLLBACK discards all of it, including the audit
-- rows. The default is ROLLBACK so the demonstration leaves the database unchanged.
\if :{?keep}
    \echo keep=1: committing Part 1.
    COMMIT;
\else
    \echo Default: rolling back Part 1 (use -v keep=1 to commit).
    ROLLBACK;
\endif

-- Back in autocommit: the same counts as before, compared with the baseline.
:count_all \gset after1_
\if :{?keep}
    SELECT :after1_batches = :base_batches + 1 AND :after1_extractions = :base_extractions + 3
       AND :after1_qc = :base_qc + 3 AND :after1_runs = :base_runs + 1
       AND :after1_libraries = :base_libraries + 2 AND :after1_audit = :base_audit + :audit_delta
       AS "PASS: committed deltas visible";
    -- The committed state is the new normal for the rest of the script.
    :count_all \gset base_
\else
    :assert_baseline;
    SELECT :after1_audit = :base_audit AS "PASS: audit rows were rolled back with the data";
\endif

\echo
\echo ============================================================================
\echo PART 2: Rollback A - a bad row in the batch undoes the whole batch
\echo ============================================================================
\echo Expected: 23514 (ck_dna_extractions_concentration), then 25P02 for any later statement.

BEGIN;
SET LOCAL app.current_user_id = '4';
SELECT sample_id FROM samples WHERE sample_id IN (6, 12, 17) ORDER BY sample_id FOR UPDATE;

INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
VALUES (1, 4, current_date, 'DNeasy PowerWater', 'Rollback demo A')
RETURNING batch_id \gset

-- Two good rows succeed ...
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 6, :batch_id, COALESCE(max(attempt_number), 0) + 1, 24.800, 1.88 FROM dna_extractions WHERE sample_id = 6;
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 12, :batch_id, COALESCE(max(attempt_number), 0) + 1, 31.200, 1.91 FROM dna_extractions WHERE sample_id = 12;

SELECT count(*) AS extractions_in_batch_so_far FROM dna_extractions WHERE batch_id = :batch_id;

-- ... and the third has a negative concentration.
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 17, :batch_id, COALESCE(max(attempt_number), 0) + 1, -5.000, 1.42 FROM dna_extractions WHERE sample_id = 17;
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught

-- The transaction is now aborted. Nothing after the failed statement can half-save the batch.
SELECT 1;
\echo ^ 25P02 (current transaction is aborted): only ROLLBACK is accepted now.
ROLLBACK;

SELECT :'caught' = '23514' AS "PASS: bad row raised 23514";
:assert_baseline;

\echo
\echo ============================================================================
\echo PART 3: Rollback B - the booking rules undo the run, the libraries and the batch
\echo ============================================================================

-- B1: failed QC. Everything up to the failing call succeeded, and is undone with it.
\echo B1: booking a failed extraction. Expected EB002 (has not passed QC).
BEGIN;
SET LOCAL app.current_user_id = '4';
SELECT sample_id FROM samples WHERE sample_id IN (6, 12, 17) ORDER BY sample_id FOR UPDATE;

INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
VALUES (1, 4, current_date, 'DNeasy PowerWater', 'Rollback demo B1')
RETURNING batch_id \gset

INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT v.sample_id, :batch_id,
       COALESCE((SELECT max(e.attempt_number) FROM dna_extractions e WHERE e.sample_id = v.sample_id), 0) + 1,
       v.concentration, v.purity
FROM (VALUES (6, 24.800, 1.88), (12, 31.200, 1.91), (17, 3.100, 1.42)) AS v(sample_id, concentration, purity)
ORDER BY v.sample_id;

SELECT max(extraction_id) FILTER (WHERE sample_id = 6)  AS ext6,
       max(extraction_id) FILTER (WHERE sample_id = 12) AS ext12,
       max(extraction_id) FILTER (WHERE sample_id = 17) AS ext17
FROM dna_extractions WHERE batch_id = :batch_id \gset

UPDATE dna_extractions AS e SET qc_status = v.verdict::qc_status
FROM (VALUES (:ext6, 'pass'), (:ext12, 'pass'), (:ext17, 'fail')) AS v(extraction_id, verdict)
WHERE e.extraction_id = v.extraction_id;

-- The technician forgets to leave the failed extraction out of the list.
SELECT create_sequencing_run(1, 'Illumina MiSeq', current_date, ARRAY[:ext6, :ext12, :ext17]::bigint[], 4);
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught
ROLLBACK;

SELECT :'caught' = 'EB002' AS "PASS: B1 raised EB002";
\echo No run, no library, and also no batch, extraction, QC or audit row remains:
:assert_baseline;

-- B2: already booked. The second run is refused; the whole transaction is then rolled back,
-- which also undoes the first (valid) run and the batch entry before it.
\echo
\echo B2: one extraction on two new planned runs. Expected EB002 (already booked on run RUN-n).
BEGIN;
SET LOCAL app.current_user_id = '4';
SELECT sample_id FROM samples WHERE sample_id = 6 FOR UPDATE;

INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
VALUES (1, 4, current_date, 'DNeasy PowerWater', 'Rollback demo B2')
RETURNING batch_id \gset

INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 6, :batch_id, COALESCE(max(attempt_number), 0) + 1, 24.800, 1.88 FROM dna_extractions WHERE sample_id = 6;
SELECT max(extraction_id) AS ext6 FROM dna_extractions WHERE batch_id = :batch_id \gset
UPDATE dna_extractions SET qc_status = 'pass' WHERE extraction_id = :ext6;

SELECT create_sequencing_run(1, 'Illumina MiSeq', current_date, ARRAY[:ext6]::bigint[], 4) AS run_id \gset
SELECT run_code, status FROM sequencing_runs WHERE run_id = :run_id;

SELECT create_sequencing_run(2, 'Illumina NovaSeq', current_date, ARRAY[:ext6]::bigint[], 4);
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught
ROLLBACK;

SELECT :'caught' = 'EB002' AS "PASS: B2 raised EB002";
\echo Neither run (the first one was rolled back with the transaction) remains:
:assert_baseline;

-- Guard rails.
\echo
\echo Guard rail 1: the booking procedures refuse REPEATABLE READ. Expected EB002.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT create_sequencing_run(1, 'Illumina MiSeq', current_date, ARRAY[1]::bigint[], 4);
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT :'caught' = 'EB002' AS "PASS: REPEATABLE READ refused with EB002";

\echo
\echo Guard rail 2: plain SQL cannot put a failed extraction (17) on a run either. Expected EB002
\echo from trg_sequencing_libraries_qc_pass (the rule lives in the database, not in the API).
BEGIN;
SET LOCAL app.current_user_id = '4';
INSERT INTO sequencing_libraries (library_code, extraction_id, run_id) VALUES ('LIB-DEMO', 17, 2);
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT :'caught' = 'EB002' AS "PASS: trigger refused the library with EB002";
:assert_baseline;

\echo
\echo ============================================================================
\echo PART 4: SAVEPOINT variant - partial rollback inside one transaction
\echo ============================================================================
\echo Expected: 23514 (ck_dna_extractions_purity) for the bad row only; the good row survives.

BEGIN;
SET LOCAL app.current_user_id = '4';
SELECT sample_id FROM samples WHERE sample_id IN (6, 12) ORDER BY sample_id FOR UPDATE;

INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
VALUES (1, 4, current_date, 'DNeasy PowerWater', 'Savepoint demo')
RETURNING batch_id \gset

INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 6, :batch_id, COALESCE(max(attempt_number), 0) + 1, 24.800, 1.88 FROM dna_extractions WHERE sample_id = 6;

SAVEPOINT s1;
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 12, :batch_id, COALESCE(max(attempt_number), 0) + 1, 31.200, -1.91 FROM dna_extractions WHERE sample_id = 12;
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught

-- Unlike Part 2 the application chooses to recover: undo only the work since the savepoint.
-- The transaction is usable again (no 25P02) and the earlier statements are still pending.
ROLLBACK TO SAVEPOINT s1;
SELECT sample_id, attempt_number, purity_a260_280 FROM dna_extractions WHERE batch_id = :batch_id ORDER BY sample_id;
\echo ^ the good row (sample 6) is still there, the bad one (sample 12) is gone

-- Re-enter the corrected value for sample 12.
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
SELECT 12, :batch_id, COALESCE(max(attempt_number), 0) + 1, 31.200, 1.91 FROM dna_extractions WHERE sample_id = 12;
SELECT sample_id, attempt_number, purity_a260_280 FROM dna_extractions WHERE batch_id = :batch_id ORDER BY sample_id;

-- Audit rows of the undone insert are gone too; only the two surviving extractions are logged.
SELECT entity_type, action, count(*) AS rows FROM audit_logs
WHERE audit_id > :base_audit_max GROUP BY entity_type, action ORDER BY entity_type, action;

-- A savepoint lets the caller recover from one bad row without redoing the whole batch; the
-- backend's withTransaction uses whole-transaction rollback (Part 2), which is simpler and
-- the right default. The application decides which one a given operation needs.
\if :{?keep}
    \echo keep=1: committing Part 4.
    COMMIT;
    :count_all \gset after4_
    SELECT :after4_batches = :base_batches + 1 AND :after4_extractions = :base_extractions + 2
       AS "PASS: committed batch visible";
    :count_all \gset base_
\else
    \echo Default: rolling back Part 4.
    ROLLBACK;
    SELECT :'caught' = '23514' AS "PASS: bad row raised 23514";
    :assert_baseline;
\endif

\echo
\echo ============================================================================
\echo PART 5: Locking - two users, one extraction (two-session protocol)
\echo ============================================================================
\echo A single psql script cannot run two concurrent sessions, so this part is a documented
\echo copy-paste protocol in the comments of this file. Candidate extractions (passing, not
\echo on a planned or running run) for the protocol:

SELECT e.extraction_id AS x
FROM dna_extractions e
WHERE e.qc_status = 'pass'
  AND NOT EXISTS (SELECT 1 FROM sequencing_libraries l JOIN sequencing_runs r USING (run_id)
                  WHERE l.extraction_id = e.extraction_id AND r.status IN ('planned', 'running'))
ORDER BY e.extraction_id LIMIT 2;

-- Use the two ids above as X (and Y for step 6). Seeded extractions 1 and 2 qualify: their
-- only runs are 'completed', which the booking rule allows to be re-booked. Nothing is created
-- in advance, so there is nothing to clean up except what steps 3 (S1 COMMIT) and 6 write.
-- Open three psql tabs against the SAME database: S1, S2 and S3 (observer).
--
-- 1. S1: take the row lock and keep the transaction open.
--      BEGIN;
--      SET LOCAL app.current_user_id = '4';
--      SELECT create_sequencing_run(1, 'Illumina MiSeq', current_date, ARRAY[X]::bigint[], 4);
--    -> returns a new run id. S1 now holds a row lock on extraction X (and nothing is committed).
--
-- 2. S2: try the same extraction on another run.
--      BEGIN;
--      SET LOCAL app.current_user_id = '4';
--      SELECT create_sequencing_run(2, 'Illumina MiSeq', current_date, ARRAY[X]::bigint[], 4);
--    -> BLOCKS: the procedure's SELECT ... FOR UPDATE waits for S1. S3 shows the wait:
--      SELECT pid, wait_event_type, wait_event, state, left(query, 60) AS query
--      FROM pg_stat_activity WHERE wait_event_type = 'Lock';
--        -> one row, wait_event = 'transactionid' (S2 waits for S1's transaction to end)
--      SELECT locktype, mode, granted, pid FROM pg_locks WHERE NOT granted;
--        -> one row, locktype 'transactionid', mode 'ShareLock' (waiting for S1's xid)
--
-- 3. S1: COMMIT;
--    -> S2 unblocks immediately and fails:
--         ERROR: EB002: Extraction X is already booked on run RUN-n (planned)
--       Under READ COMMITTED S2's next statement sees S1's committed library, so the booking
--       check refuses it. S2: ROLLBACK;
--
-- 4. Evidence (any session): exactly one active run contains X.
--      SELECT r.run_code, r.status FROM sequencing_libraries l JOIN sequencing_runs r USING (run_id)
--      WHERE l.extraction_id = X AND r.status IN ('planned', 'running');
--
-- 5. Variant, rollback: repeat steps 1-2 on a free extraction, but in S1 run ROLLBACK; instead
--    of COMMIT. S2 unblocks and SUCCEEDS (returns a run id): the lock was released and the
--    booking never happened. S2: ROLLBACK; (or COMMIT; if you want it kept).
--
-- 6. Variant, opposite order, no deadlock. With two free extractions X and Y:
--      S1: BEGIN; SELECT create_sequencing_run(1, 'Illumina MiSeq', current_date, ARRAY[X, Y]::bigint[], 4);
--      S2: BEGIN; SELECT create_sequencing_run(2, 'Illumina MiSeq', current_date, ARRAY[Y, X]::bigint[], 4);
--    S2 blocks, but it never deadlocks, because the procedure sorts the ids and locks X first
--    in both sessions. S1 COMMIT -> S2 fails with EB002. Had the two sessions locked in the
--    caller's order (S1 locks X then wants Y, S2 locks Y then wants X), each would wait for the
--    other and PostgreSQL would abort one after deadlock_timeout (1 s) with:
--         ERROR: 40P01: deadlock detected
--    Ordered locking is why that cannot happen here.
--
-- 7. Cleanup. Steps 3 (and 6, if you commit) leave a committed 'planned' run. To remove it:
--    run npm run db:reset (development) or reset the test database; do NOT DELETE (D19).
--    Nothing else is left behind. Sessions still open: ROLLBACK; in each.
--
-- The permanent automated version of this protocol is tests/concurrency/run-assignment.test.js
-- (T34); this part is its specification.

\echo (protocol: see the comments after this line in the script)

\echo
\echo ============================================================================
\echo Final check: nothing left behind
\echo ============================================================================
\if :{?keep}
    \echo keep=1: committed data from Parts 1 and 4 remains on purpose. Reset this database.
\else
    :assert_baseline;
\endif

\echo Done.
