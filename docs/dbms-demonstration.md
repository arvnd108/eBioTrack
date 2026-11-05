# DBMS demonstration guide

> Owner: D (Docs & Demo) · T43 / issue #66
> Run write demonstrations only against a disposable, seeded test database. Transaction scripts default to rollback; never use their commit option on a shared or production database.

## Preparation

From the repository root, prepare the project's local seeded test database and confirm DATABASE_URL points to it. SQL object files are applied after schema migrations; index files are applied manually, not by the migration runner.

```bash
psql "$DATABASE_URL" -c "\\dv"
psql "$DATABASE_URL" -c "\\df"
psql "$DATABASE_URL" -c "\\di"
```

For index demonstrations use the volume-loaded test database and the before/after procedure in [Query Plan Report](query-plan-report.md). Never run volume preparation or benchmark resets against production.

## Object-to-concept map

| DBMS concept | Objects | Concept demonstrated | Source |
|---|---|---|---|
| Views | Field: v_sample_registry, v_site_sample_summary | Reusable joins and site-level summaries across samples, events, sites, projects, and types | database/views/field_views.sql; docs/slices/field.md |
| Views | Access: v_user_project_access, v_project_summary | Per-user project access (membership or administrator) and one-row-per-project counts | database/views/access_views.sql; docs/slices/access.md |
| Views | Lab: v_lab_pipeline_status, v_failed_qc | Pipeline status and failed-QC reporting | database/views/lab_views.sql; docs/slices/lab.md |
| Views | Analysis: v_approved_detections, v_site_richness | Approved-only results and richness; only passing detections count | database/views/analysis_views.sql; docs/slices/analysis.md |
| Stored routine | register_sample(...) | Validates registration, allocates a sample code while locking the event | database/procedures/field_procedures.sql |
| Stored routine | create_project_with_owner(...) | Atomic project and owner setup | database/procedures/access_procedures.sql |
| Stored routines | create_sequencing_run(), assign_extraction_to_run() | Row-locked booking of extractions onto planned runs; conflicts and failed QC rejected | database/procedures/lab_procedures.sql |
| Stored routines | import_detections(), approve_analysis(), reject_analysis() | Atomic import and controlled review/status transitions | database/procedures/analysis_procedures.sql |
| Triggers | trg_samples_status_transition, trg_samples_status_history | Enforce valid lifecycle transitions (SQLSTATE EB001) and record history | database/triggers/field_triggers.sql |
| Triggers | Access: `trg_*_audit` (users, user_roles, projects, project_members, project_sites) via audit_row_change() | Row-level audit written by the database itself | database/triggers/access_triggers.sql |
| Triggers | Lab: trg_sequencing_libraries_qc_pass, trg_sequencing_runs_status, trg_dna_extractions_qc_status, trg_dna_extractions_sample_status | QC must pass before sequencing; run status flow; extraction results move the sample status | database/triggers/lab_triggers.sql |
| Triggers | Analysis: trg_analysis_runs_status, trg_analysis_runs_immutable, trg_taxon_assignments_immutable, trg_taxa_tree | Status flow, approved rows frozen, taxonomy tree kept acyclic | database/triggers/analysis_triggers.sql |
| Transactions | Access onboarding; lab processing; field event+children; analysis import/review | Atomic multi-row workflows and rollback on failure | database/transactions/{access,lab,field,analysis}_transaction.sql |
| Indexes | access_indexes.sql, lab_indexes.sql, analysis_indexes.sql, field_indexes.sql | Selective access paths, leading-column rule, planner behaviour and read/write trade-offs | database/indexes/*.sql; tests/performance/explain-benchmarks.sql |

## Runnable object demonstrations

All snippets were run on a freshly migrated and seeded database (`npm run db:reset` in `backend/`, then `psql "$DATABASE_URL"`). The seed gives users 1 to 6 (administrator, principal investigator, field researcher, lab technician, analyst, viewer). Every write sits inside `BEGIN ... ROLLBACK`, so the database is unchanged afterwards (generated ids still advance). Output is shown as it was returned.

### Views (8)

```sql
SELECT site_name, event_count, total_samples, analyzed_count, failed_count FROM v_site_sample_summary ORDER BY site_id;
-- 5 rows: Dakpathar Barrage 2/5/4/1, Okhla Barrage 2/4/4/0, Sangam Prayagraj 2/4/4/0, Diamond Harbour 1/2/2/0, Kakdwip Bay 1/2/2/0

SELECT sample_code, status, sample_type, site_name FROM v_sample_registry WHERE status = 'failed';
-- EB-20250515-0001-003 | failed | water | Dakpathar Barrage

SELECT project_id, access_via, project_role, can_edit FROM v_user_project_access WHERE user_id = 4;
-- 1 | membership | contributor | f

SELECT project_id, title, member_count, site_count, event_count, sample_count FROM v_project_summary ORDER BY 1;
-- 1 | Yamuna Biodiversity Survey | 5 | 3 | 6 | 13
-- 2 | Coastal Estuary Pilot      | 2 | 2 | 2 | 4

SELECT sample_code, extraction_attempts, latest_qc_status, library_code, run_code, pipeline_stage
FROM v_lab_pipeline_status WHERE sample_id IN (1, 17) ORDER BY sample_id;
-- EB-20250515-0001-001 | 1 | pass | LIB-0001 | RUN-001 | sequenced
-- EB-20250515-0001-003 | 1 | fail |          |         | sample_failed

SELECT sample_code, source, qc_type, severity FROM v_failed_qc ORDER BY sample_id, extraction_id NULLS LAST LIMIT 4;
-- EB-20260315-0006-002 | qc_result  | negative_control    | warn
-- EB-20250515-0001-003 | extraction |                     | fail
-- EB-20250515-0001-003 | qc_result  | concentration       | fail
-- EB-20250515-0001-003 | qc_result  | contamination_check | fail

SELECT site_name, year, observed_taxa, sample_count FROM v_site_richness WHERE project_id = 1 ORDER BY site_id, year;
-- 6 rows, e.g. Dakpathar Barrage | 2025 | 2 | 3 and Dakpathar Barrage | 2026 | 2 | 2

SELECT count(*) AS approved_detections, count(DISTINCT scientific_name) AS taxa FROM v_approved_detections;
-- 24 | 3
```

### Procedures and functions (7 routines plus the audit trigger function)

```sql
BEGIN;
SET LOCAL app.current_user_id = '3';                      -- the backend does this for every request
SELECT register_sample(1, 1, 250, 0.5, 'Freezer A-9', 3);  -- 1000 (a new sample_id)
SELECT sample_code, status FROM samples ORDER BY sample_id DESC LIMIT 1;   -- EB-20250515-0001-004 | collected
SELECT old_status, new_status, changed_by FROM sample_status_history ORDER BY history_id DESC LIMIT 1;  -- NULL | collected | 3
SELECT create_project_with_owner('Demo survey', NULL, DATE '2026-06-01', 2);   -- 1000; user 2 is now its owner
ROLLBACK;

BEGIN; SELECT create_sequencing_run(1, 'Illumina MiSeq', DATE '2026-06-01', ARRAY[17]::bigint[], 4); ROLLBACK;
-- ERROR: Extraction 17 has not passed QC (qc_status fail)

BEGIN; SELECT assign_extraction_to_run(1, 1, 4); ROLLBACK;
-- ERROR: Run RUN-001 is completed; libraries can only be added to a planned run

BEGIN; SELECT import_detections(4, '[{"library_code":"LIB-0001","taxon_id":8,"read_count":1450,"confidence":0.97,"qc_flag":"pass"}]'::jsonb, 5); ROLLBACK;
-- 1 (rows inserted for draft analysis 4)

BEGIN; SELECT approve_analysis(3, 5); ROLLBACK;
-- ERROR: User 5 may not approve analyses   (DETAIL: Allowed roles: administrator, principal_investigator.)

BEGIN; SELECT approve_analysis(3, 2); SELECT status FROM analysis_runs WHERE analysis_id = 3; ROLLBACK;
-- approved

BEGIN; SELECT reject_analysis(3, 2, 'Demo rejection'); SELECT status FROM analysis_runs WHERE analysis_id = 3; ROLLBACK;
-- rejected
```

### Triggers

```sql
BEGIN; UPDATE samples SET status = 'analyzed' WHERE sample_id = 17; ROLLBACK;
-- ERROR: Invalid sample status transition: failed -> analyzed   (trg_samples_status_transition, SQLSTATE EB001)

BEGIN;
SET LOCAL app.current_user_id = '3';
UPDATE samples SET status = 'discarded' WHERE sample_id = 17;   -- UPDATE 1
SELECT count(*) FROM audit_logs WHERE entity_type = 'samples' AND entity_id = 17 AND action = 'update';   -- 1 (audit trigger)
ROLLBACK;
```

### Indexes

```bash
for f in database/indexes/*.sql; do psql "$DATABASE_URL" -q -f "$f"; done   # not part of the migration runner
psql "$DATABASE_URL" -c "SELECT indexname, tablename FROM pg_indexes WHERE indexname LIKE 'idx\_%' ORDER BY 1"
```

Fourteen `idx_*` indexes exist afterwards (one, `idx_session_expire`, belongs to the session store; the other thirteen come from the four index files). The recorded before and after plans for them are in [query-plan-report.md](query-plan-report.md); to see one yourself on the seed data, use `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM samples WHERE event_id = 1;` (on 17 rows the planner may still prefer a sequential scan, which is why the benchmarks use the volume fixture).

## Transaction demos

Each transaction file is a manual demonstration, not a migration. Read its header for prerequisites and exact setup. Scripts exercise failing cases; leave their error-handling settings as documented. By default, changes roll back. The keep=1 option commits the happy path and is only for a disposable test database.

```bash
psql "$TEST_DATABASE_URL" -f database/transactions/field_transaction.sql
```

Each prints `PASS:` or `FAIL:` lines per check. Repeat with access_transaction.sql, lab_transaction.sql, and analysis_transaction.sql. Expected invariant: default runs leave business, audit, and history rows unchanged (sequence values may advance). Committed runs are not repeatable without resetting the test database. Use each script's own postcondition output rather than assuming generated IDs.

## Index demonstration

Use a volume-loaded ebiotrack_test database. Capture the baseline plan before applying the corresponding index file; then apply it and repeat after refreshing statistics. Query labels and benchmark controls are in tests/performance/explain-benchmarks.sql. Results depend on volume, statistics, and hardware; do not promise that every query improves. The query-plan report records measured wins, unchanged plans, and write costs.

## Expected observations and cautions

- Views read current base-table data; they are not materialized result sets.
- Constraints may create indexes beyond those listed in performance index files.
- Rollback removes transactional writes, but PostgreSQL sequence values are not reclaimed.
- Indexes cost storage and write maintenance; broad queries may correctly remain sequential scans.
- Approved detections are evidence of taxon DNA, not an abundance estimate; non-detection is not proof of absence.
- This guide maps source objects and safe execution paths; it does not claim a fresh runtime rehearsal. Capture actual terminal output during the demo.
