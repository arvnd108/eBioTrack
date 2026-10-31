-- Owner: D (Docs & Demo)
-- Purpose: 1 transaction scenario with rollback case: Field & Samples
--
-- T18-D. Scenario: register a collection event with its environmental measurements and its
-- samples atomically. One collection_events row, N environmental_measurements rows and M
-- samples created through register_sample() (T16-D) form ONE transaction that either commits
-- completely or leaves no trace, audit rows and status-history rows included. This is what
-- POST /api/events does (CONTRACT 10: "event with created samples and measurements (one
-- transaction)"). The rollback cases are a bad step in the middle of that sequence.
--
-- This is a standalone demonstration script, NOT a migration: backend/src/db/migrate.js never
-- runs database/transactions/. Run it by hand with psql (the script fails on purpose, so
-- leave ON_ERROR_STOP off, which is psql's default):
--
--   docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/field_transaction.sql
--   psql "$DATABASE_URL" -f database/transactions/field_transaction.sql
--   psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/field_transaction.sql   (test database only)
--
-- By default every transaction ends in ROLLBACK, so the script leaves the database exactly as
-- it found it and can be run again and again (generated ids move on, because PostgreSQL never
-- hands a consumed identity value back; nothing else differs). With -v keep=1 the one "happy"
-- transaction (Part 1) ends in COMMIT instead, to show durability. Never use keep=1 on the
-- development database; reset the test database afterwards.
--
-- Requires: the dev/test database after `npm run db:reset` (17 seeded samples, 8 seeded events,
-- register_sample(), the status triggers and the audit triggers). Part 0 checks this and stops
-- if it is missing. Creates and drops nothing: no DDL, no DELETE, no GRANT. Cleanup is
-- always ROLLBACK (D19: scientific records are never hard-deleted).
--
-- Parts, and which property each one shows:
--   0  Preflight and baseline counts (what "unchanged" means for the later checks).
--   1  Commit path: event + 4 measurements + 3 samples (register_sample) in one transaction.
--      Atomicity of a multi-table write; 3 status-history rows and 4 audit rows carry the
--      acting user (SET LOCAL, as the backend does); COMMIT is what makes it durable.
--   2  Rollback A: a duplicate measurement parameter (23505) after the event and the first
--      measurements succeeded. The failed transaction refuses further statements (25P02).
--   3  Rollback B: consistency rules, one transaction each: foreign key, CHECK, the
--      procedure's validation and the status-transition trigger. Earlier work disappears.
--   4  SAVEPOINT variant: recover from one bad sample without redoing the whole event.
--   5  Locking and isolation: the two-session protocol (comments, copy-paste).
--
-- Conventions used throughout:
--   * Acting user: SET LOCAL app.current_user_id = '3' (field researcher, the collector) at
--     the start of every transaction, exactly as backend withTransaction does (CONTRACT 7).
--     SET LOCAL lasts until COMMIT or ROLLBACK, so it cannot leak into the next transaction.
--   * Isolation: the default READ COMMITTED, which is also what the backend uses. SERIALIZABLE
--     is not needed (register_sample() serialises per event with FOR UPDATE) and not used.
--   * Errors: \set VERBOSITY verbose prints the SQLSTATE with every error, and the script
--     saves psql's LAST_ERROR_SQLSTATE and LAST_ERROR_MESSAGE right after each failing
--     statement, so after the ROLLBACK it can report PASS or FAIL for the code it expected.
--   * After any error inside BEGIN ... COMMIT the transaction is ABORTED: PostgreSQL ignores
--     every statement until ROLLBACK (25P02). So every failing statement below is followed by
--     an explicit ROLLBACK (or ROLLBACK TO SAVEPOINT).
--   * Generated ids start at 1000 and are consumed even on failure. The script never
--     hard-codes them: it captures them with RETURNING ... \gset or SELECT ... \gset. Sample
--     codes derive from the event id, so they differ from run to run; the script asserts
--     their pattern, not their value.
--   * Audit coverage: samples and collection_events are audited; environmental_measurements
--     and sample_status_history are NOT, so no audit rows are expected for them.

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
\set tables_ok false
\set demo_exists false
\set fixtures_ok false
SELECT to_regclass('collection_events') IS NOT NULL
   AND to_regclass('samples') IS NOT NULL
   AND to_regclass('environmental_measurements') IS NOT NULL
   AND to_regclass('sample_status_history') IS NOT NULL
   AND to_regclass('audit_logs') IS NOT NULL
   AND to_regprocedure('register_sample(bigint,bigint,numeric,numeric,text,bigint)') IS NOT NULL
   AS tables_ok \gset
\if :tables_ok
    -- A previous keep=1 run leaves this event behind; events have no unique key to stop a
    -- second committed copy, so the notes marker is the guard.
    SELECT EXISTS (SELECT 1 FROM collection_events WHERE notes = 'T18-D field trip demo') AS demo_exists \gset
    SELECT (SELECT count(*) FROM samples) = 17
       AND (SELECT count(*) FROM collection_events) = 8
       AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_samples_status_transition',
                'trg_samples_status_history', 'trg_samples_audit', 'trg_collection_events_audit')) = 4
       AND EXISTS (SELECT 1 FROM users WHERE user_id = 3)
       AND EXISTS (SELECT 1 FROM project_sites WHERE project_id = 1 AND site_id = 1)
       AND (SELECT count(*) FROM sample_types WHERE sample_type_id IN (1, 3)) = 2
       AS fixtures_ok \gset
\endif
\if :demo_exists
    \echo
    \echo STOP: the demo event (notes 'T18-D field trip demo') already exists. A previous run with
    \echo keep=1 committed it. Reset the test database and try again.
    \quit
\endif
\if :fixtures_ok
    \echo PASS: fixture world present (17 samples, 8 events, register_sample, status and audit triggers).
\else
    \echo
    \echo STOP: the fixture world is missing or incomplete. Expected 17 seeded samples, 8 seeded
    \echo events, register_sample(), the status triggers and the audit triggers (run the migration
    \echo runner so audit_row_change() exists before field_triggers.sql).
    \echo Run npm run db:reset in backend/ (development database) and try again.
    \quit
\endif

-- Row counts that "unchanged" is measured against. environmental_measurements and
-- sample_status_history have no audit trigger, so their changes show up in their own counts.
\set count_all 'SELECT (SELECT count(*) FROM collection_events) AS events, (SELECT count(*) FROM samples) AS samples, (SELECT count(*) FROM environmental_measurements) AS measurements, (SELECT count(*) FROM sample_status_history) AS history, (SELECT count(*) FROM audit_logs) AS audit, (SELECT COALESCE(max(audit_id), 0) FROM audit_logs) AS audit_max'
:count_all \gset base_
\echo Baseline: :base_events events, :base_samples samples, :base_measurements measurements, :base_history history rows, :base_audit audit rows.

-- :assert_baseline expands to a one-row query: every count equals the baseline.
\set assert_baseline 'SELECT CASE WHEN (SELECT count(*) FROM collection_events) = :base_events AND (SELECT count(*) FROM samples) = :base_samples AND (SELECT count(*) FROM environmental_measurements) = :base_measurements AND (SELECT count(*) FROM sample_status_history) = :base_history AND (SELECT count(*) FROM audit_logs) = :base_audit THEN ''PASS'' ELSE ''FAIL'' END || '': events, samples, measurements, history and audit rows all equal the baseline'' AS result'

\echo
\echo ============================================================================
\echo PART 1: Commit path - event, measurements and samples, all or nothing
\echo ============================================================================
\echo One collection event at project 1 / site 1 with 4 measurements and 3 samples
\echo (2 water, 1 sediment), registered as one unit of work (mirrors POST /api/events).

-- What the site summary says before the transaction (read it, do not hard-code it).
SELECT event_count AS pre_events, total_samples AS pre_samples
FROM v_site_sample_summary WHERE site_id = 1 \gset

BEGIN;
SET LOCAL app.current_user_id = '3';

INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D field trip demo')
RETURNING event_id \gset

INSERT INTO environmental_measurements (event_id, parameter, value, unit)
SELECT :event_id, v.parameter, v.value, v.unit
FROM (VALUES ('temperature_c', 24.6, 'celsius'),
             ('ph', 7.8, 'pH'),
             ('dissolved_oxygen_mg_l', 6.9, 'mg/L'),
             ('turbidity_ntu', 12.4, 'NTU')) AS v(parameter, value, unit);

-- One call per sample, so the sequence 001, 002, 003 is deterministic. Each call locks the
-- event row FOR UPDATE, writes the sample and writes its first history row.
SELECT register_sample(:event_id, 1, 1000.00, 0.50, NULL, 3) AS s1 \gset
SELECT register_sample(:event_id, 1, 500.00, 1.00, NULL, 3) AS s2 \gset
SELECT register_sample(:event_id, 3, NULL, NULL, 'Freezer D-1', 3) AS s3 \gset

\echo Evidence inside the transaction: the event row
SELECT event_id, project_id, site_id, collector_id, collected_at, notes
FROM collection_events WHERE event_id = :event_id;
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END
       || ': event is project 1, site 1, collector 3' AS result
FROM collection_events
WHERE event_id = :event_id AND project_id = 1 AND site_id = 1 AND collector_id = 3;

\echo Evidence: 4 measurements, all with the event id
SELECT parameter, value, unit FROM environmental_measurements WHERE event_id = :event_id ORDER BY measurement_id;
SELECT CASE WHEN count(*) = 4 AND count(DISTINCT parameter) = 4 THEN 'PASS' ELSE 'FAIL' END
       || ': 4 distinct measurements belong to the event' AS result
FROM environmental_measurements WHERE event_id = :event_id;

\echo Evidence: 3 samples, status collected, codes numbered 001-003 in call order
SELECT sample_id, sample_code, status, sample_type_id, volume_ml, depth_m, storage_location
FROM samples WHERE event_id = :event_id ORDER BY sample_id;
SELECT CASE WHEN count(*) = 3 AND bool_and(status = 'collected') THEN 'PASS' ELSE 'FAIL' END
       || ': 3 samples exist and every one is collected' AS result
FROM samples WHERE event_id = :event_id;
SELECT CASE WHEN count(*) = 3 AND count(DISTINCT sample_code) = 3
              AND bool_and(sample_code ~ '^EB-20260615-[0-9]{4,}-00[1-3]$') THEN 'PASS' ELSE 'FAIL' END
       || ': sample codes match EB-20260615-nnnn-00n and are distinct' AS result
FROM samples WHERE event_id = :event_id;
SELECT CASE WHEN (SELECT sample_code FROM samples WHERE sample_id = :s1) ~ '-001$'
              AND (SELECT sample_code FROM samples WHERE sample_id = :s2) ~ '-002$'
              AND (SELECT sample_code FROM samples WHERE sample_id = :s3) ~ '-003$' THEN 'PASS' ELSE 'FAIL' END
       || ': sequences are 001, 002, 003 in call order' AS result;

\echo Evidence: exactly 3 new history rows, written once by register_sample() (no duplicates)
SELECT sample_id, old_status, new_status, changed_by
FROM sample_status_history WHERE sample_id IN (:s1, :s2, :s3) ORDER BY sample_id;
SELECT CASE WHEN (SELECT count(*) FROM sample_status_history) - :base_history = 3
              AND (SELECT count(*) FROM sample_status_history WHERE sample_id IN (:s1, :s2, :s3)) = 3
              AND (SELECT bool_and(old_status IS NULL AND new_status = 'collected' AND changed_by = 3)
                   FROM sample_status_history WHERE sample_id IN (:s1, :s2, :s3)) THEN 'PASS' ELSE 'FAIL' END
       || ': 3 history rows, each NULL -> collected, changed_by 3' AS result;

\echo Evidence: audit rows written by this transaction (measurements and history are not audited)
SELECT entity_type, action, actor_id, count(*) AS rows
FROM audit_logs WHERE audit_id > :base_audit_max
GROUP BY entity_type, action, actor_id ORDER BY entity_type, action;
SELECT CASE WHEN count(*) = 4
              AND count(*) FILTER (WHERE entity_type = 'collection_events' AND action = 'insert') = 1
              AND count(*) FILTER (WHERE entity_type = 'samples' AND action = 'insert') = 3
              AND bool_and(actor_id = 3) THEN 'PASS' ELSE 'FAIL' END
       || ': 4 audit rows (1 event insert + 3 sample inserts), all with actor 3' AS result
FROM audit_logs WHERE audit_id > :base_audit_max;

\echo Evidence: the views see the new rows
SELECT sample_id, sample_code, status, sample_type, site_name
FROM v_sample_registry WHERE event_id = :event_id ORDER BY sample_id;
SELECT CASE WHEN count(*) = 3 THEN 'PASS' ELSE 'FAIL' END
       || ': v_sample_registry shows the 3 new samples' AS result
FROM v_sample_registry WHERE event_id = :event_id;
SELECT event_count AS events_now, total_samples AS samples_now
FROM v_site_sample_summary WHERE site_id = 1;
SELECT CASE WHEN event_count = :pre_events + 1 AND total_samples = :pre_samples + 3 THEN 'PASS' ELSE 'FAIL' END
       || ': v_site_sample_summary for site 1 gained 1 event and 3 samples' AS result
FROM v_site_sample_summary WHERE site_id = 1;

-- COMMIT makes every statement above visible to other sessions at once and durable: once
-- COMMIT returns, the change survives the end of this session and a restart of the server,
-- because it is in the write-ahead log. ROLLBACK discards all of it, including the audit
-- rows and the history rows. The default is ROLLBACK so the demonstration leaves the
-- database unchanged.
\if :{?keep}
    \echo keep=1: committing Part 1.
    COMMIT;
\else
    \echo Default: rolling back Part 1 (use -v keep=1 to commit).
    ROLLBACK;
\endif

-- Back in autocommit: the same counts as before, compared with the baseline.
\if :{?keep}
    :count_all \gset after1_
    SELECT CASE WHEN :after1_events = :base_events + 1 AND :after1_samples = :base_samples + 3
                  AND :after1_measurements = :base_measurements + 4 AND :after1_history = :base_history + 3
                  AND :after1_audit = :base_audit + 4 THEN 'PASS' ELSE 'FAIL' END
           || ': committed deltas visible (1 event, 3 samples, 4 measurements, 3 history, 4 audit)' AS result;
    \echo The event is now durable and visible to every session; resetting the test database removes it.
    -- The committed state is the new normal for the rest of the script.
    :count_all \gset base_
\else
    :assert_baseline;
\endif

\echo
\echo ============================================================================
\echo PART 2: Rollback A - a duplicate measurement undoes the whole event
\echo ============================================================================
\echo Expected: 23505 (uq_environmental_measurements_event_parameter), then 25P02 for any
\echo later statement.

BEGIN;
SET LOCAL app.current_user_id = '3';

INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D rollback demo A')
RETURNING event_id \gset

-- The first four measurements succeed ...
INSERT INTO environmental_measurements (event_id, parameter, value, unit)
SELECT :event_id, v.parameter, v.value, v.unit
FROM (VALUES ('temperature_c', 24.6, 'celsius'),
             ('ph', 7.8, 'pH'),
             ('dissolved_oxygen_mg_l', 6.9, 'mg/L'),
             ('turbidity_ntu', 12.4, 'NTU')) AS v(parameter, value, unit);

SELECT (SELECT count(*) FROM collection_events WHERE event_id = :event_id) AS event_rows,
       (SELECT count(*) FROM environmental_measurements WHERE event_id = :event_id) AS measurement_rows,
       (SELECT count(*) FROM audit_logs WHERE audit_id > :base_audit_max) AS audit_rows;
\echo ^ the event, its 4 measurements and its audit row exist so far ...

-- ... and the second ph row repeats a parameter of the same event.
INSERT INTO environmental_measurements (event_id, parameter, value, unit)
VALUES (:event_id, 'ph', 7.9, 'pH');
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught

-- The transaction is now aborted. Nothing after the failed statement can half-save the event.
SELECT 1;
\set caught_after :LAST_ERROR_SQLSTATE
\echo ^ 25P02 (current transaction is aborted): only ROLLBACK is accepted now.
ROLLBACK;

SELECT CASE WHEN :'caught' = '23505'
              AND position('uq_environmental_measurements_event_parameter' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': duplicate parameter raised 23505 on uq_environmental_measurements_event_parameter' AS result;
SELECT CASE WHEN :'caught_after' = '25P02' THEN 'PASS' ELSE 'FAIL' END
       || ': the next statement was refused with 25P02' AS result;
\echo Event, measurements and the audit row are all gone:
:assert_baseline;

\echo
\echo ============================================================================
\echo PART 3: Rollback B - consistency rules, one transaction each
\echo ============================================================================
\echo Each attempt: BEGIN, the failing step, save the SQLSTATE, ROLLBACK, check the code, then
\echo check that the database equals the baseline.

-- B1: the site is not attached to the project (composite foreign key).
\echo
\echo B1: event for project 2 at site 1. Expected 23503 (fk_collection_events_project_site).
BEGIN;
SET LOCAL app.current_user_id = '3';
INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (2, 1, 3, '2026-06-15 08:00:00+00', 'T18-D rollback demo B1');
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT CASE WHEN :'caught' = '23503' AND position('fk_collection_events_project_site' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': B1 raised 23503 on fk_collection_events_project_site' AS result;
:assert_baseline;

-- B2: collection time in the future (time-dependent CHECK, so the bad value is relative to now()).
\echo
\echo B2: collected_at three days in the future. Expected 23514 (ck_collection_events_collected_at).
BEGIN;
SET LOCAL app.current_user_id = '3';
INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, now() + interval '3 days', 'T18-D rollback demo B2');
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT CASE WHEN :'caught' = '23514' AND position('ck_collection_events_collected_at' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': B2 raised 23514 on ck_collection_events_collected_at' AS result;
:assert_baseline;

-- B3: unknown sample type after a good sample. The best demo that earlier work disappears.
\echo
\echo B3: sample 1 is fine, sample 2 has unknown sample type 999. Expected 23503; the event, sample 1,
\echo its history row and its audit rows are undone too.
\unset event_id
\unset s1
BEGIN;
SET LOCAL app.current_user_id = '3';
INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D rollback demo B3')
RETURNING event_id \gset
SELECT register_sample(:event_id, 1, 1000.00, 0.50, NULL, 3) AS s1 \gset
SELECT (SELECT count(*) FROM samples WHERE event_id = :event_id) AS samples_so_far,
       (SELECT count(*) FROM sample_status_history WHERE sample_id = :s1) AS history_so_far,
       (SELECT count(*) FROM audit_logs WHERE audit_id > :base_audit_max) AS audit_so_far;
\echo ^ before the failing call: 1 sample, 1 history row, 2 audit rows (event + sample)
SELECT register_sample(:event_id, 999, 500.00, 1.00, NULL, 3);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT CASE WHEN :'caught' = '23503' AND position('Sample type 999 does not exist' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': B3 raised 23503 (sample type 999 does not exist)' AS result;
:assert_baseline;

-- B4: negative volume, raised by the procedure with the CONTRACT message.
\echo
\echo B4: negative volume. Expected 23514 (raised by register_sample).
\unset event_id
BEGIN;
SET LOCAL app.current_user_id = '3';
INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D rollback demo B4')
RETURNING event_id \gset
SELECT register_sample(:event_id, 1, -5, 0.50, NULL, 3);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT CASE WHEN :'caught' = '23514' AND position('Sample volume must be greater than zero' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': B4 raised 23514 (volume must be greater than zero)' AS result;
:assert_baseline;

-- B5: negative depth.
\echo
\echo B5: negative depth. Expected 23514 (raised by register_sample).
\unset event_id
BEGIN;
SET LOCAL app.current_user_id = '3';
INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D rollback demo B5')
RETURNING event_id \gset
SELECT register_sample(:event_id, 1, 100, -1, NULL, 3);
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT CASE WHEN :'caught' = '23514' AND position('Sample depth cannot be negative' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': B5 raised 23514 (depth cannot be negative)' AS result;
:assert_baseline;

-- B6: a status change the transition table does not allow, inside the same unit of work.
\echo
\echo B6: collected -> analyzed. Expected EB001 (trg_samples_status_transition); the whole event
\echo is undone.
\unset event_id
\unset s1
BEGIN;
SET LOCAL app.current_user_id = '3';
INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D rollback demo B6')
RETURNING event_id \gset
SELECT register_sample(:event_id, 1, 1000.00, 0.50, NULL, 3) AS s1 \gset
UPDATE samples SET status = 'analyzed' WHERE sample_id = :s1;
\set caught :LAST_ERROR_SQLSTATE
\set caught_msg :'LAST_ERROR_MESSAGE'
\echo Caught SQLSTATE :caught
ROLLBACK;
SELECT CASE WHEN :'caught' = 'EB001' AND position('collected -> analyzed' in :caught_msg) > 0
            THEN 'PASS' ELSE 'FAIL' END
       || ': B6 raised EB001 (collected -> analyzed is not allowed)' AS result;
:assert_baseline;

-- Consistency: the database refuses any state that breaks its rules (foreign key, CHECK, the
-- procedure's validation, the transition trigger), whichever statement tries to create it,
-- and Atomicity: the refusal takes everything the transaction did before it along (B3 is the
-- clearest demo: the event, sample 1, its history row and its audit rows all vanish).

\echo
\echo ============================================================================
\echo PART 4: SAVEPOINT variant - partial rollback inside one transaction
\echo ============================================================================
\echo Expected: 23503 for the bad sample only; the event and sample 1 survive and the corrected
\echo sample reuses sequence 002 (the failed call inserted nothing).

\unset event_id
\unset s1
\unset s2
BEGIN;
SET LOCAL app.current_user_id = '3';

INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
VALUES (1, 1, 3, '2026-06-15 08:00:00+00', 'T18-D savepoint demo')
RETURNING event_id \gset
SELECT register_sample(:event_id, 1, 1000.00, 0.50, NULL, 3) AS s1 \gset

SAVEPOINT sample_b;
SELECT register_sample(:event_id, 999, 500.00, 1.00, NULL, 3);
\set caught :LAST_ERROR_SQLSTATE
\echo Caught SQLSTATE :caught

-- Unlike Part 2 the application chooses to recover: undo only the work since the savepoint.
-- The transaction is usable again (no 25P02) and the earlier statements are still pending.
ROLLBACK TO SAVEPOINT sample_b;

-- Re-enter the corrected sample 2 (type 1).
SELECT register_sample(:event_id, 1, 500.00, 1.00, NULL, 3) AS s2 \gset

SELECT sample_id, sample_code, status FROM samples WHERE event_id = :event_id ORDER BY sample_id;
SELECT CASE WHEN count(*) = 2
              AND count(*) FILTER (WHERE sample_code ~ '-001$') = 1
              AND count(*) FILTER (WHERE sample_code ~ '-002$') = 1 THEN 'PASS' ELSE 'FAIL' END
       || ': exactly two samples, numbered 001 and 002 (the failed call did not burn 002)' AS result
FROM samples WHERE event_id = :event_id;
SELECT CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END
       || ': exactly two history rows' AS result
FROM sample_status_history WHERE sample_id IN (:s1, :s2);
SELECT entity_type, action, count(*) AS rows
FROM audit_logs WHERE audit_id > :base_audit_max
GROUP BY entity_type, action ORDER BY entity_type, action;
SELECT CASE WHEN count(*) = 3
              AND count(*) FILTER (WHERE entity_type = 'collection_events' AND action = 'insert') = 1
              AND count(*) FILTER (WHERE entity_type = 'samples' AND action = 'insert') = 2 THEN 'PASS' ELSE 'FAIL' END
       || ': audit rows so far: 1 event + 2 samples, none for the failed call' AS result
FROM audit_logs WHERE audit_id > :base_audit_max;

-- A savepoint recovers from one bad step without redoing the whole unit. It is NOT needed for
-- the all-or-nothing guarantee (Part 2 and Part 3 get that from plain ROLLBACK); the backend's
-- withTransaction rolls everything back, which is the simpler default. register_sample()
-- contains no EXCEPTION block, so it does not open a subtransaction of its own.
ROLLBACK;
SELECT CASE WHEN :'caught' = '23503' THEN 'PASS' ELSE 'FAIL' END
       || ': bad sample type raised 23503 and the savepoint recovered' AS result;
:assert_baseline;

\echo
\echo ============================================================================
\echo PART 5: Locking and isolation - two sessions (two-session protocol)
\echo ============================================================================
\echo A single psql script cannot run two concurrent sessions, so this part is a documented
\echo copy-paste protocol in the comments of this file (S1 and S2, plus an observer).

-- Seeded event 1 already has three samples (ids 1, 2 and 17), so the next two codes on it end
-- in -004 and -005. Verify against your database first:
--   SELECT sample_code FROM samples WHERE event_id = 1 ORDER BY sample_id;
-- Open two psql windows against the SAME database: S1 and S2 (and a third, S3, to observe).
--
-- 1. Sample-code race on the same event (register_sample locks the event row FOR UPDATE).
--      S1: BEGIN;
--          SET LOCAL app.current_user_id = '3';
--          SELECT register_sample(1, 1, 100, 0.5, NULL, 3);
--          -> returns a new sample id. S1 holds the lock on event 1; nothing is committed.
--      S2: BEGIN;
--          SET LOCAL app.current_user_id = '3';
--          SELECT register_sample(1, 1, 100, 0.5, NULL, 3);
--          -> BLOCKS on the event row lock. S3 shows the wait:
--          SELECT pid, wait_event_type, wait_event, state, left(query, 60) AS query
--          FROM pg_stat_activity
--          WHERE datname = current_database() AND pid <> pg_backend_pid();
--          -> S2 has wait_event_type = 'Lock', wait_event = 'transactionid'.
--      S1: COMMIT;
--          -> S2 unblocks at once and gets the NEXT sequence: S1's sample ends -004, S2's
--          ends -005. Never a duplicate code, never 23505 on samples_sample_code_key.
--      Variant: repeat with S1 ROLLBACK instead. S2 unblocks and gets -004 (the sequence
--      is COUNT(*) + 1, so a rolled-back sample leaves no gap).
--      S2: ROLLBACK;   (so the database stays as found; if you committed S1, reset it.)
--
-- 2. Uncommitted work is invisible (READ COMMITTED).
--      S1: BEGIN; SELECT register_sample(1, 1, 100, 0.5, NULL, 3);
--      S2: SELECT count(*) FROM samples WHERE event_id = 1;
--          -> the OLD count (3): S2 does not see S1's uncommitted sample.
--      S1: COMMIT;
--      S2: SELECT count(*) FROM samples WHERE event_id = 1;
--          -> the new count (4): each statement under READ COMMITTED sees what is committed
--          when it starts. (If you prefer to keep the database unchanged, S1: ROLLBACK;
--          and S2 still shows 3.)
--
-- 3. Status change against status change (row lock plus transition trigger). Test database only.
--    Seeded samples are all past 'collected', so first create one in its own committed step:
--      S1: SELECT register_sample(1, 1, 100, 0.5, NULL, 3);   -- autocommit; note it as <sid>
--    Then:
--      S1: BEGIN; UPDATE samples SET status = 'stored' WHERE sample_id = <sid>;   (uncommitted)
--      S2: BEGIN; UPDATE samples SET status = 'collected' WHERE sample_id = <sid>;
--          -> BLOCKS on the row lock (the new value looks like a no-op, deliberately).
--      S1: COMMIT;
--          -> S2 re-reads the row: its trigger now sees OLD.status = 'stored', and
--          stored -> collected is not in the transition table, so S2 fails with
--             ERROR: EB001: Invalid sample status transition: stored -> collected
--      S2: ROLLBACK;
--    The committed helper sample stays behind: reset the test database afterwards.
--
-- The permanent automated version of this protocol is the sample-code concurrency case in
-- tests/concurrency (T34); this part is its specification.

\echo (protocol: see the comments after this line in the script)

\echo
\echo ============================================================================
\echo Final check: nothing left behind
\echo ============================================================================
\if :{?keep}
    \echo keep=1: the event from Part 1 remains on purpose. Reset this database.
\endif
:assert_baseline;

\echo Done.
