# eBioTrack — Team Roles

Two dimensions keep the work equal:

1. **Database work is divided equally.** The 25 tables are split into four slices, one per member, and every member delivers the same DBMS quota.
2. **Engineering work is divided by discipline.** Each member also owns one of backend, frontend, testing, or docs for the whole project. Platform and DevOps work is part of the backend role.

| Member | Discipline (whole project) | Database slice |
|---|---|---|
| **A** | **Backend** (including platform/DevOps) | Access, Projects & Audit |
| **B** | **Frontend** | Laboratory & Sequencing |
| **C** | **Testing & QA** | Analysis, Taxonomy & Analytics |
| **D** | **Documentation & Demo** | Field & Samples |

Database slices are chosen to fit each discipline: A's auth and audit slice pairs with the backend authorization work, and C's analysis slice (transactions, concurrency, query correctness) pairs with testing.

---

## 1. Database work (divided equally)

### Table ownership (25 tables)

| Slice | Owner | Tables | Count |
|---|---|---|---|
| Access, Projects & Audit | A | `users`, `roles`, `user_roles`, `projects`, `project_members`, `project_sites`, `audit_logs` | 7 |
| Field & Samples | D | `regions`, `sampling_sites`, `collection_events`, `sample_types`, `samples`, `environmental_measurements`, `sample_status_history` | 7 |
| Laboratory & Sequencing | B | `laboratories`, `extraction_batches`, `dna_extractions`, `sequencing_runs`, `sequencing_libraries`, `quality_control_results` | 6 |
| Analysis, Taxonomy & Analytics | C | `dna_markers`, `analysis_runs`, `taxa`, `taxon_assignments`, `data_exports` | 5 |

The Analysis slice has the fewest tables but the most join-heavy queries and the transactional import/approval workflow.

### Equal DBMS quota (each member delivers all of this for their slice)

- Migration with PK, FK, UNIQUE, CHECK, NOT NULL constraints, plus seed rows
- **3** complex SQL queries (multi-join, CTE, correlated subquery, aggregation)
- **2** views
- **1** stored procedure/function
- **1** trigger
- **1** transaction scenario with a rollback test
- **2** indexes, justified with `EXPLAIN (ANALYZE, BUFFERS)` before and after
- A normalization write-up for the slice (handed to D for the docs)

### Slice details

**A — Access, Projects & Audit** (authorization, constraints, audit, backup/recovery)
- Queries: projects a user can access via role and membership; members per project; audit trail of one entity over time.
- Views: `v_user_project_access`, `v_project_summary`.
- Procedure: `create_project_with_owner()`.
- Trigger: generic audit trigger writing to `audit_logs` (reused on other slices' tables).
- Transaction: create a project and add members atomically; roll back on a bad member.
- Indexes: `project_members(user_id, project_id)`, `audit_logs(entity_type, entity_id, created_at)`.
- Also: DB roles and grants; `pg_dump`/restore procedure.

**D — Field & Samples** (ER modeling, normalization, workflow triggers)
- Queries: sample count per site; samples per event with latest status; environmental readings per site over time.
- Views: `v_sample_registry`, `v_site_sample_summary`.
- Procedure: `register_sample()` (generates and validates the sample code).
- Trigger: enforce valid status transitions and write `sample_status_history`.
- Transaction: register an event with its samples and measurements atomically.
- Indexes: unique `samples(sample_code)`, `collection_events(site_id, collected_at)`.
- Also: validity constraints (coordinate ranges, non-negative depth).

**B — Laboratory & Sequencing** (transactions, concurrency, data quality)
- Queries: extractions per batch with QC pass rate; libraries per run with source samples; samples with failed or contaminated QC.
- Views: `v_lab_pipeline_status`, `v_failed_qc`.
- Procedure: `create_sequencing_run()` (assign libraries to a run).
- Trigger: block adding a library from an extraction that failed QC.
- Transaction: batch extraction entry; row-locking so two users cannot assign the same extraction to a run.
- Indexes: `dna_extractions(sample_id)`, `sequencing_libraries(run_id)`.
- Also: CHECK constraints on concentrations and QC values.

**C — Analysis, Taxonomy & Analytics** (complex SQL, views, transactional approval)
- Queries: taxa detected at a site; taxon richness by site and year; detection history for a taxon (recursive CTE over the taxonomy hierarchy).
- Views: `v_approved_detections`, `v_site_richness`.
- Procedure: `approve_analysis()` (`SELECT ... FOR UPDATE`, insert detections, mark approved, audit).
- Trigger: block edits to approved results.
- Transaction: CSV import where an invalid row rolls back the whole import; double-approval protection.
- Indexes: `taxon_assignments(taxon_id)`, `taxon_assignments(analysis_id)`.

---

## 2. Engineering work (divided by discipline)

### A — Backend (including platform/DevOps)

**Platform**
- Repo scaffold (`backend/`, `database/`, folders per the README layout), `.env` handling, DB setup and reset scripts, migration runner
- DB connection pool, parameterized-query helpers
- Request validation, consistent error format, pagination
- Sessions, password hashing, role and project-level authorization middleware

**API routes (all slices)**
- `/api/auth`, `/api/projects`, `/api/audit`
- `/api/sites`, `/api/events`, `/api/samples`
- `/api/extractions`, libraries and sequencing run routes
- `/api/analyses/import`, `/api/analyses/:id/approve`, `/api/taxa/:id/detections`, `/api/analytics/richness`
- CSV import validation and report/CSV export endpoints

**Also:** wiring each member's stored procedures and transactions into endpoints; keeping `docs/api.md` source info up to date for D.

### B — Frontend

- App shell, routing, auth-aware layout, API client, shared form/table components, loading and error states
- Pages: Login, Dashboard, Projects, Sampling map (Leaflet), Collection events, Samples (registry and status timeline), Lab processing, Analysis import (upload, preview errors, commit), Species explorer, Biodiversity analytics (Recharts), Administration, optional ML insights
- Display of scientific caveats (uncertainty, effort, QC flags, non-detection wording) on analytics pages
- Responsive layout and form validation

### C — Testing & QA

**Test infrastructure**
- Test framework for backend and DB, test database setup, CI pipeline (lint and tests)
- Seed fixtures with known values so counts and joins are verifiable
- Seed dataset and CSV import fixtures (with sources and licenses, real vs. synthetic labeling)

**Test suites**
- Integrity: invalid foreign keys, duplicate sample codes, illegal status transitions
- Transactions: injected import errors, full rollback
- Concurrency: simultaneous approval and run-assignment attempts
- Authorization: unauthorized users cannot view or edit restricted projects
- Query correctness against fixtures
- Performance: indexed vs. non-indexed `EXPLAIN ANALYZE` runs (using each member's indexes)
- Recovery: restore a backup and verify key records
- Optional stretch: anomaly-detection experiment (Python) on approved data

### D — Documentation & Demo

- README upkeep and `docs/` consistency
- Combined ER/EER diagram from all slices; normalization report (flat sample sheet to 3NF/BCNF) built from each member's write-up
- `docs/api.md` (from A's routes), user guide, role/permission doc
- `docs/dbms-demonstration.md`: every view, procedure, trigger, transaction, and index mapped to a DBMS concept
- Query-plan benchmark report (compiled from C's results)
- Backup/restore and recovery documentation
- Data sourcing, attribution, and license notes
- Demo script, slides, screenshots, and rehearsal coordination

---

## 3. Workload summary

| | A (Backend) | B (Frontend) | C (Testing) | D (Docs & Demo) |
|---|---|---|---|---|
| Database slice | 7 tables | 6 tables | 5 tables, hardest SQL | 7 tables |
| Discipline | All APIs and platform | All pages and UI | All tests, CI, fixtures | All docs and demo |

## 4. Working conventions

- One branch per feature (`a/auth-api`, `b/sample-pages`, and so on); merge to `main` by pull request only.
- Every pull request needs one review. Rotation: A → B → C → D → A.
- Schema changes go through numbered migrations in `database/migrations/`. Tell the table owner before changing their tables.
- Parameterized queries only; never commit secrets.
- Agree cross-slice FK names early (for example `samples.event_id`, `taxon_assignments.library_id`) and keep them stable.

## 5. Order of work

Work is organized by phase and dependency, not by dates. The full task list, prerequisites, and gates are in [WORKFLOW.md](WORKFLOW.md). In outline:

1. **Contracts and schema:** agree table names, keys, and statuses together; each member drafts their slice migration. A sets up the repo and migration runner; D starts the ER diagram.
2. **Seed data and foundation:** constraints and seeds; A delivers auth and the API foundation; B delivers the app shell; C sets up the test harness and CI.
3. **Slice SQL, APIs, and pages:** APIs (A) and pages (B) per slice in parallel; views, procedures, and triggers (everyone, own slice).
4. **Transactions, indexes, and tests:** transactions, concurrency, indexes, and tests (C with everyone); docs written as features land (D).
5. **Integration and demo:** integration, benchmarks, backup/restore, demo rehearsal.

## 6. Demo ownership

| Demo step | Presenter |
|---|---|
| ER diagram and normalization | D |
| Register site, event, sample through the UI | D (data) with B (UI) |
| Extraction and sequencing metadata | B |
| CSV import with rollback; trace a detection to its sample | C |
| Multi-join SQL, views, stored procedures | each their own slice |
| Trigger audit log and role restriction | A |
| `EXPLAIN ANALYZE` before and after indexing | each their own slice |
| Backup/restore | A |
