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
| Views | Access: v_user_project_access, v_audit_trail | Centralized access and audit projections | database/views/access_views.sql; docs/slices/access.md |
| Views | Lab: v_lab_pipeline_status, v_failed_qc | Pipeline status and failed-QC reporting | database/views/lab_views.sql; docs/slices/lab.md |
| Views | Analysis: v_approved_detections, v_site_richness | Approved-only results and richness; only passing detections count | database/views/analysis_views.sql; docs/slices/analysis.md |
| Stored routine | register_sample(...) | Validates registration, allocates a sample code while locking the event | database/procedures/field_procedures.sql |
| Stored routine | create_project_with_owner(...) | Atomic project and owner setup | database/procedures/access_procedures.sql |
| Stored routines | Lab run/extraction booking routines | Encapsulated booking and conflict prevention | database/procedures/lab_procedures.sql |
| Stored routines | import_detections(), approve_analysis(), reject_analysis() | Atomic import and controlled review/status transitions | database/procedures/analysis_procedures.sql |
| Triggers | Field sample status/history triggers | Enforce valid lifecycle transitions and record history | database/triggers/field_triggers.sql |
| Triggers | Access, lab, and analysis triggers | Database-level audit and slice invariants | database/triggers/access_triggers.sql; lab_triggers.sql; analysis_triggers.sql |
| Transactions | Access onboarding; lab processing; field event+children; analysis import/review | Atomic multi-row workflows and rollback on failure | database/transactions/{access,lab,field,analysis}_transaction.sql |
| Indexes | Four slice index files | Selective access paths, planner behavior, and read/write trade-offs | database/indexes/*.sql; tests/performance/explain-benchmarks.sql |

## Transaction demos

Each transaction file is a manual demonstration, not a migration. Read its header for prerequisites and exact setup. Scripts exercise failing cases; leave their error-handling settings as documented. By default, changes roll back. The keep=1 option commits the happy path and is only for a disposable test database.

```bash
psql "$TEST_DATABASE_URL" -f database/transactions/field_transaction.sql
```

Repeat with access_transaction.sql, lab_transaction.sql, and analysis_transaction.sql. Expected invariant: default runs leave business, audit, and history rows unchanged (sequence values may advance). Committed runs are not repeatable without resetting the test database. Use each script's own postcondition output rather than assuming generated IDs.

## Index demonstration

Use a volume-loaded ebiotrack_test database. Capture the baseline plan before applying the corresponding index file; then apply it and repeat after refreshing statistics. Query labels and benchmark controls are in tests/performance/explain-benchmarks.sql. Results depend on volume, statistics, and hardware; do not promise that every query improves. The query-plan report records measured wins, unchanged plans, and write costs.

## Expected observations and cautions

- Views read current base-table data; they are not materialized result sets.
- Constraints may create indexes beyond those listed in performance index files.
- Rollback removes transactional writes, but PostgreSQL sequence values are not reclaimed.
- Indexes cost storage and write maintenance; broad queries may correctly remain sequential scans.
- Approved detections are evidence of taxon DNA, not an abundance estimate; non-detection is not proof of absence.
- This guide maps source objects and safe execution paths; it does not claim a fresh runtime rehearsal. Capture actual terminal output during the demo.
