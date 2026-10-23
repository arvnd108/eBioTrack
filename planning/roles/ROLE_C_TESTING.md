# Member C — Testing & QA

**Database slice:** Analysis, Taxonomy & Analytics

Related documents: [TEAM_ROLES](../TEAM_ROLES.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [WORKFLOW](../WORKFLOW.md)

---

## 1. Your role

You make sure everything the team builds actually works and keeps working. You set up the test harness and CI, create the fixtures and datasets that make results verifiable, and write the tests for every slice: integrity, transactions, concurrency, authorization, query correctness, performance, and recovery. You also own the database slice for analysis and taxonomy, which holds the most join-heavy queries and the transactional import and approval workflow.

Your slice depends on everyone else's data, so you sit at the end of the data chain. Start with the parts that do not.

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
- **Optional:** anomaly-detection experiment in Python on approved data

**Database slice: Analysis, Taxonomy & Analytics**

| Tables (5) | `dna_markers`, `analysis_runs`, `taxa`, `taxon_assignments`, `data_exports` |
|---|---|

| Deliverable | Detail |
|---|---|
| Migration and constraints | PK, FK, UNIQUE, CHECK, NOT NULL (`040`) |
| 3 complex queries | Taxa detected at a site; taxon richness by site and year; detection history for a taxon (recursive CTE over the taxonomy) |
| 2 views | `v_approved_detections`, `v_site_richness` |
| 1 stored procedure | `approve_analysis()`: `SELECT ... FOR UPDATE`, insert detections, mark approved, write audit |
| 1 trigger | Block edits to approved results |
| 1 transaction | CSV import where an invalid row rolls back the whole import; double-approval protection |
| 2 indexes | `taxon_assignments(taxon_id)`, `taxon_assignments(analysis_id)`, justified with `EXPLAIN (ANALYZE, BUFFERS)` |
| Write-up | Slice and normalization notes in `docs/slices/analysis.md`, handed to D |

## 3. Files and folders you own

| Area | Path |
|---|---|
| Tests | `tests/**` (`setup/`, `fixtures/`, `integrity/`, `queries/`, `transactions/`, `concurrency/`, `authorization/`, `performance/`, `recovery/`) |
| CI | `.github/workflows/ci.yml` |
| Optional ML | `ml/**` |
| Data | `datasets/sample_detections.csv` |
| Your slice | `database/migrations/040_analysis_taxonomy.sql`, `database/seeds/040_seed_analysis.sql` |
| | `database/views/analysis_views.sql`, `database/procedures/analysis_procedures.sql`, `database/triggers/analysis_triggers.sql` |
| | `database/queries/analysis_queries.sql`, `database/indexes/analysis_indexes.sql`, `database/transactions/analysis_transaction.sql` |
| Docs input | `docs/slices/analysis.md` |

## 4. Your workflow

Task IDs match [WORKFLOW.md](../WORKFLOW.md).

1. **T00** Take part in the contract workshop. Make sure statuses (`approved`, `pass`) and seed ID ranges are specified clearly; your tests depend on them.
2. **T05** Analysis migration.
3. **T09** Test harness and CI. Draft early; run once A's database setup (T01) is merged.
4. **T11** Seed rows for your slice, using the agreed ID ranges.
5. **T12** CSV fixtures, starter dataset, volume-data generator (needs sample and library codes from B's and D's seeds).
6. Your slice SQL, in this order: **T14** queries → **T15** views → **T16** `approve_analysis()` → **T17** trigger → **T18** transaction → **T19** indexes. Queries and views need all four slices seeded.
7. **T30 – T36** Test suites, written from the spec first, then enabled as the code arrives:
   - T30 integrity → T31 query correctness → T32 transactions → T33 authorization → T34 concurrency → T35 performance → T36 recovery
8. **T38** Optional anomaly-detection experiment.
9. **T40** Write up your slice.
10. **T50 – T52** End-to-end run and demo rehearsal.

Branches: `c/<task-id>-<short-name>` (for example `c/t09-test-harness`). One pull request per task, one reviewer (D reviews yours).

## 5. Tasks you can start now

After the contract workshop (T00):

- **T05** Analysis migration
- **T09** Test harness and CI (draft now; execute against the database once A merges T01)

You can also write test cases from the specification before the code exists, and design the fixture CSVs and the volume-data generator.

## 6. Tasks that need someone else first

| Your task | Needs | From | While you wait |
|---|---|---|---|
| T09 Run CI against a database | T01 repo setup and migration runner | A | Draft the harness and CI file |
| T12 Fixtures and volume data | Sample and library codes from seeds (T11) | B, D | Write the generator and CSV layout from the contract |
| T14 / T15 Cross-slice queries and views | G2: all four seed files loaded | A, B, D | Write the SQL against the schema; verify when seeds load |
| T16 `approve_analysis()` | T06 cross-slice FKs and the audit function (T17-A) | A | Write the locking and import logic; plug in audit when available |
| T30 Integrity tests | G1 and each slice's triggers (T17) | A, B, D | Write cases from the constraints list |
| T31 Query tests | Each slice's queries (T14) and G2 | A, B, D | Compute the expected values by hand from fixtures |
| T32 Transaction tests | Each slice's transaction scenario (T18) | A, B, D | Write rollback cases from the spec |
| T33 Authorization tests | T13 auth and T20 projects routes | A | Define the matrix of roles vs. actions |
| T34 Concurrency tests | T16-B `create_sequencing_run()`, T16-C (yours), T18 | B | Prepare the parallel-request harness |
| T35 Performance | T19 indexes from every slice and T12 volume data | A, B, D | Prepare the benchmark queries |
| T36 Recovery test | T37 backup and restore scripts | A | Define which records to verify after restore |
| T38 Optional ML | Approved detections (G2 and T23) | A | Prototype on the fixture dataset |
| T50 End-to-end run | Everyone's work (gates G4, G5) | All | Run the suites and report failures |

## 7. Who is waiting on you

| Person | Task | Waiting for |
|---|---|---|
| Everyone | Pull requests need CI to pass | T09 |
| A | T23 CSV validation and routes | T12 fixtures and T16-C `approve_analysis()` |
| B | T19 index comparison | T12 volume data |
| D | T47 data sources doc | T12 dataset and source notes |
| D | T45 query-plan report | T35 benchmark results |
| D | T44 backup and recovery doc | T36 recovery test |
| D | T41 normalization report | Your slice write-up (T40) |

## 8. Rules and done criteria

- Tests use fixtures with known values, never production-like random data, so results are checkable.
- A bug found by a test is reported to the task owner with the failing case; you do not silently fix other members' files.
- Label fixtures and datasets as real or synthetic and record the source and license.
- Done means: the suite runs in CI from a clean database, fails when it should, and passes on `main`.
