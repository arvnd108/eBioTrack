# Member C — Testing & QA

**Assigned to:** Dhruve

**Database slice:** Access, Projects & Audit

Related documents: [TEAM_ROLES](../TEAM_ROLES.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [WORKFLOW](../WORKFLOW.md) · [CONTRACT](../CONTRACT.md)

---

## 1. Your role

You make sure everything the team builds actually works and keeps working. You set up the test harness and CI, create the fixtures and datasets that make results verifiable, and write the tests for every slice: integrity, transactions, concurrency, authorization, query correctness, performance, and recovery.

You also own the database slice for users, roles, projects, and audit. That slice is early in the chain and many things depend on it: A's authentication reads your users and roles tables, and every other member attaches your audit trigger function to their tables. Do your migration and the audit function first.

## 2. What you need to do

**Test infrastructure**
- Test framework for backend and database, a test database that can be created, migrated, seeded, and reset
- CI pipeline: lint, build the database from scratch, run the test suites
- Fixtures with known values, so counts and joins can be checked exactly
- Starter dataset, CSV import fixtures (valid and with a bad row), and a volume-data generator for performance tests, with sources, licenses, and real-vs-synthetic labels

**Test suites**
- **Integrity:** invalid foreign keys, duplicate sample codes, illegal status transitions
- **Transactions:** an injected import error rolls back everything; project creation is atomic
- **Concurrency:** simultaneous approval attempts; the same extraction assigned to two runs at once
- **Authorization:** unauthorized users cannot read or edit restricted projects
- **Queries:** results match known fixtures
- **Performance:** `EXPLAIN (ANALYZE, BUFFERS)` before and after indexes
- **Recovery:** restore a backup and verify key records

**Database slice: Access, Projects & Audit**

| Tables (7) | `users`, `roles`, `user_roles`, `projects`, `project_members`, `project_sites`, `audit_logs` |
|---|---|

| Deliverable | Detail |
|---|---|
| Migration and constraints | PK, FK, UNIQUE, CHECK, NOT NULL (`010`) |
| 3 complex queries | Projects a user can access via role and membership; members per project; audit trail of one entity over time |
| 2 views | `v_user_project_access`, `v_project_summary` |
| 1 stored procedure | `create_project_with_owner()` |
| 1 trigger | Generic audit trigger function `audit_row_change()` writing to `audit_logs`. A, B, and D attach it to their tables |
| 1 transaction | Create a project and add members atomically; roll back on a bad member |
| 2 indexes | `project_members(user_id, project_id)`, `audit_logs(entity_type, entity_id, created_at)`, justified with `EXPLAIN (ANALYZE, BUFFERS)` |
| Extras | Database roles and grants; backup and restore scripts |
| Write-up | Slice and normalization notes in `docs/slices/access.md`, handed to D |

## 3. Files and folders you own

| Area | Path |
|---|---|
| Tests | `tests/**` (`setup/`, `fixtures/`, `integrity/`, `queries/`, `transactions/`, `concurrency/`, `authorization/`, `performance/`, `recovery/`) |
| CI | `.github/workflows/ci.yml` |
| Data | `datasets/sample_detections.csv` |
| Your slice | `database/migrations/010_access_projects_audit.sql`, `database/seeds/010_seed_access.sql` |
| | `database/views/access_views.sql`, `database/procedures/access_procedures.sql`, `database/triggers/access_triggers.sql` |
| | `database/queries/access_queries.sql`, `database/indexes/access_indexes.sql`, `database/transactions/access_transaction.sql` |
| Security and recovery | `database/roles/grants.sql`, `database/backup/backup.sh`, `database/backup/restore.sh` |
| Docs input | `docs/slices/access.md` |

## 4. Your workflow

Task IDs match [WORKFLOW.md](../WORKFLOW.md).

1. **T00** Take part in the contract workshop. Make sure statuses (`approved`, `pass`) and seed ID ranges are specified clearly; your tests depend on them.
2. **T02** Access migration and database roles/grants. Do this first: A's authentication depends on it.
3. **T09** Test harness and CI. Draft early; run once A's database setup (T01) is merged.
4. **T11** Seed rows for your slice, using the agreed ID ranges.
5. **T17** (audit function first) Write `audit_row_change()` early so A, B, and D can attach it.
6. **T12** CSV fixtures, starter dataset, volume-data generator (needs sample and library codes from B's and D's seeds).
7. Your slice SQL, in this order: **T14** queries → **T15** views → **T16** `create_project_with_owner()` → **T17** remaining trigger work → **T18** transaction → **T19** indexes.
8. **T37** Backup and restore scripts.
9. **T30 – T36** Test suites, written from the spec first, then enabled as the code arrives:
   - T30 integrity → T31 query correctness → T32 transactions → T33 authorization → T34 concurrency → T35 performance → T36 recovery
10. **T40** Write up your slice.
11. **T50 – T52** End-to-end run and demo rehearsal.

Branches: `c/<task-id>-<short-name>` (for example `c/t02-access-migration`). One pull request per task. Arvind reviews and merges it (you cannot merge to `main` yourself).

## 5. Tasks you can start now

After the contract workshop (T00):

- **T02** Access migration (do this first)
- **T09** Test harness and CI (draft now; execute against the database once A merges T01)

You can also write test cases from the specification before the code exists, and design the fixture CSVs and the volume-data generator.

## 6. Tasks that need someone else first

| Your task | Needs | From | While you wait |
|---|---|---|---|
| T09 Run CI against a database | T01 repo setup and migration runner | A | Draft the harness and CI file |
| T11 Load your seeds | T06 schema complete (G1) | A | Write the seed file from the agreed ID ranges |
| T12 Fixtures and volume data | Sample and library codes from seeds (T11) | B, D | Write the generator and CSV layout from the contract |
| T17 Attach nothing: your trigger is the base | (none) | — | Write `audit_row_change()` and your own trigger |
| T19 Indexes with `EXPLAIN` | T12 volume data | You | Write the index definitions; compare when the data exists |
| T30 Integrity tests | G1 and each slice's triggers (T17) | A, B, D | Write cases from the constraints list |
| T31 Query tests | Each slice's queries (T14) and G2 | A, B, D | Compute the expected values by hand from fixtures |
| T32 Transaction tests | Each slice's transaction scenario (T18) | A, B, D | Write rollback cases from the spec |
| T33 Authorization tests | T13 auth and T20 projects routes | A | Define the matrix of roles vs. actions |
| T34 Concurrency tests | T16-B `create_sequencing_run()`, T16-A `approve_analysis()`, T18 | B, A | Prepare the parallel-request harness |
| T35 Performance | T19 indexes from every slice and T12 volume data | A, B, D | Prepare the benchmark queries |
| T50 End-to-end run | Everyone's work (gates G4, G5) | All | Run the suites and report failures |

## 7. Who is waiting on you

| Person | Task | Waiting for |
|---|---|---|
| A | T06 cross-slice FKs | Your migration (T02) |
| A | T13 auth | Your users and roles tables (T02) |
| A | T20 projects routes | Your `create_project_with_owner()` (T16-C) |
| A, B, D | Attaching the audit trigger to their tables, and A's `approve_analysis()` | Your `audit_row_change()` (T17-C) |
| Everyone | Pull requests need CI to pass | T09 |
| A | T19 index comparison | T12 volume data |
| B | T19 index comparison | T12 volume data |
| D | T19 index comparison | T12 volume data |
| D | T47 data sources doc | T12 dataset and source notes |
| D | T45 query-plan report | T35 benchmark results |
| D | T44 backup and recovery doc | T36 recovery test and T37 scripts |
| D | T41 normalization report | Your slice write-up (T40) |

If you are late on T02 or the audit function, A's authentication and analysis procedures are blocked, so give those priority.

## 8. Rules and done criteria

- Tests use fixtures with known values, never production-like random data, so results are checkable.
- A bug found by a test is reported to the task owner with the failing case; you do not silently fix other members' files.
- Label fixtures and datasets as real or synthetic and record the source and license.
- Done means: the suite runs in CI from a clean database, fails when it should, and passes on `main`.
