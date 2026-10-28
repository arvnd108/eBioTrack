-- Owner: B (Frontend)
-- Purpose: Transaction scenario with rollback: Laboratory & Sequencing
--
-- Issue #34 / T18-B. Needs the seeded database (seeds 010-040) and the T16-B functions
-- (database/procedures/lab_procedures.sql). Run it in one psql session:
--
--   psql "$DATABASE_URL" -f database/transactions/lab_transaction.sql
--
-- Every scenario ends in ROLLBACK, so the database is left exactly as it was.
-- Scenario 2 also has a real two-session version at the bottom (Session A / Session B).
--
-- Isolation level: PostgreSQL's default, READ COMMITTED. Each statement sees data committed
-- before that statement started. That is what makes the row lock in Scenario 2 work: the second
-- session waits on the lock, and once the first commits, its next statement sees the new booking.
-- (create_sequencing_run / assign_extraction_to_run refuse REPEATABLE READ, where a transaction
-- keeps its first snapshot and would miss the other session's booking; see lab_procedures.sql.)

\set ON_ERROR_STOP off
\set VERBOSITY default

-- ============================================================================================
-- Scenario 1: batch extraction entry is all or nothing
-- ============================================================================================
-- A technician enters a new extraction batch and its extractions together. The third row has a
-- negative concentration, which ck_dna_extractions_concentration rejects (SQLSTATE 23514). The
-- error aborts the transaction, so ROLLBACK removes the batch AND the two rows that had already
-- been inserted: no half-entered batch is ever visible to anyone else.

\echo '== Scenario 1: before'
SELECT (SELECT count(*) FROM extraction_batches) AS batches,
       (SELECT count(*) FROM dna_extractions)    AS extractions;
-- Expected on the seed: batches 3, extractions 17

BEGIN;

INSERT INTO extraction_batches (batch_id, lab_id, operator_id, extraction_date, kit_name, notes)
VALUES (900, 1, 4, DATE '2026-05-02', 'DNeasy PowerWater Kit', 'Re-extraction batch (demo)');

INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
VALUES (17, 900, 2, 6.120, 1.81);   -- re-extraction of the failed sample: valid
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
VALUES (12, 900, 2, 9.400, 1.84);   -- valid

\echo '== Scenario 1: inside the transaction, after 2 good rows (only this session can see them)'
SELECT (SELECT count(*) FROM extraction_batches) AS batches,
       (SELECT count(*) FROM dna_extractions)    AS extractions;
-- Expected: batches 4, extractions 19

\echo '== Scenario 1: the bad row (expect ERROR 23514, ck_dna_extractions_concentration)'
INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
VALUES (13, 900, 2, -1.500, 1.80);  -- negative concentration: CHECK violation

-- Any further statement now fails with "current transaction is aborted" until ROLLBACK.
ROLLBACK;

\echo '== Scenario 1: after ROLLBACK (same as before: nothing from batch 900 survived)'
SELECT (SELECT count(*) FROM extraction_batches)                    AS batches,
       (SELECT count(*) FROM dna_extractions)                       AS extractions,
       (SELECT count(*) FROM extraction_batches WHERE batch_id = 900) AS batch_900_rows;
-- Expected: batches 3, extractions 17, batch_900_rows 0

-- ============================================================================================
-- Scenario 2: the same extraction cannot be booked on two active runs
-- ============================================================================================
-- Two planned runs exist and two lab technicians each try to add extraction 3 to a different
-- one. assign_extraction_to_run() locks the extraction row (SELECT ... FOR UPDATE) before it
-- checks the booking rule, so the second caller has to wait for the first, then sees the first
-- booking and is refused with EB002. Below, the two calls run one after the other in one session
-- to show the outcome; the truly concurrent version is at the bottom of this file.
-- (Extractions 1-3 are only on completed runs in the seed, so they are free to book again.)

\echo '== Scenario 2: setup, two planned runs'
BEGIN;

SELECT create_sequencing_run(1, 'Illumina MiSeq (demo A)', DATE '2026-06-01', ARRAY[1]::bigint[], 4) AS run_a \gset
SELECT create_sequencing_run(1, 'Illumina MiSeq (demo B)', DATE '2026-06-02', ARRAY[2]::bigint[], 4) AS run_b \gset

\echo '== Scenario 2: before, active bookings of extraction 3'
SELECT count(*) AS active_bookings_of_extraction_3
FROM sequencing_libraries l JOIN sequencing_runs r USING (run_id)
WHERE l.extraction_id = 3 AND r.status IN ('planned', 'running');
-- Expected: 0

\echo '== Scenario 2: technician 1 adds extraction 3 to run A (succeeds)'
SELECT assign_extraction_to_run(:run_a, 3, 4) AS library_id;

SAVEPOINT before_second_booking;
\echo '== Scenario 2: technician 2 adds extraction 3 to run B (expect ERROR EB002: already booked)'
SELECT assign_extraction_to_run(:run_b, 3, 4) AS library_id;
ROLLBACK TO SAVEPOINT before_second_booking;  -- undo only the failed call

\echo '== Scenario 2: after, still exactly one active booking'
SELECT r.run_code, r.status, l.library_code
FROM sequencing_libraries l JOIN sequencing_runs r USING (run_id)
WHERE l.extraction_id = 3 AND r.status IN ('planned', 'running');
-- Expected: 1 row, on run A

\echo '== Scenario 2: extraction 17 (failed QC) is refused too (expect ERROR EB002)'
SAVEPOINT before_failed_qc;
SELECT assign_extraction_to_run(:run_a, 17, 4);
ROLLBACK TO SAVEPOINT before_failed_qc;

ROLLBACK;  -- remove the demo runs and libraries

\echo '== Scenario 2: after ROLLBACK, no demo runs remain'
SELECT count(*) AS demo_runs FROM sequencing_runs WHERE platform LIKE '%(demo%';
-- Expected: 0

-- ============================================================================================
-- Scenario 2, concurrent version (two psql sessions)
-- ============================================================================================
-- Open two terminals with psql on the same database and type the steps in this order.
-- The interesting moment is step 4: Session B's call does not return until Session A commits.
--
-- 1. Session A (setup, committed so both sessions can see the runs):
--      SELECT create_sequencing_run(1, 'Illumina MiSeq (demo A)', DATE '2026-06-01', ARRAY[1]::bigint[], 4);
--      SELECT create_sequencing_run(1, 'Illumina MiSeq (demo B)', DATE '2026-06-02', ARRAY[2]::bigint[], 4);
--      -- note the two run IDs it prints, called <run_a> and <run_b> below
--
-- 2. Session A:
--      BEGIN;
--      SELECT assign_extraction_to_run(<run_a>, 3, 4);   -- returns a library_id; row 3 now locked
--
-- 3. Session B:
--      BEGIN;
--      SELECT assign_extraction_to_run(<run_b>, 3, 4);   -- HANGS: waiting for Session A's lock
--
-- 4. Session A:
--      COMMIT;
--    Session B's call now returns:
--      ERROR:  Extraction 3 is already booked on run RUN-<run_a> (planned)      (SQLSTATE EB002)
--
-- 5. Session B:
--      ROLLBACK;
--      SELECT r.run_code, l.library_code
--      FROM sequencing_libraries l JOIN sequencing_runs r USING (run_id)
--      WHERE l.extraction_id = 3 AND r.status IN ('planned', 'running');
--      -- exactly 1 row, on <run_a>
--
-- 6. Clean up (either session). Fails the runs so they no longer count as active, which is the
--    normal way to retire a run (D19: no hard deletes of scientific records):
--      UPDATE sequencing_runs SET status = 'failed' WHERE run_id IN (<run_a>, <run_b>);
--
-- If Session A had run ROLLBACK at step 4 instead, Session B would get the lock, find no
-- booking, and succeed: still exactly one booking.
