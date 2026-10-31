# lab

> **Owner:** B (Frontend)
>
> Slice write-up and normalization notes: Laboratory & Sequencing

## Schema

Migration `database/migrations/030_lab_sequencing.sql` (CONTRACT 4.3). The normalization write-up follows in T40.

| Table | Primary key | Foreign keys | Other constraints |
| --- | --- | --- | --- |
| `laboratories` | `pk_laboratories` (`lab_id`) | none | `uq_laboratories_name`, `ck_laboratories_name_not_blank` |
| `extraction_batches` | `pk_extraction_batches` (`batch_id`) | `fk_extraction_batches_lab_id`; `operator_id` FK is added in 090 | none |
| `dna_extractions` | `pk_dna_extractions` (`extraction_id`) | `fk_dna_extractions_batch_id`; `sample_id` FK is added in 090 | `uq_dna_extractions_sample_attempt`, `ck_dna_extractions_attempt_number`, `ck_dna_extractions_concentration`, `ck_dna_extractions_purity` |
| `sequencing_runs` | `pk_sequencing_runs` (`run_id`) | `fk_sequencing_runs_lab_id` | `uq_sequencing_runs_run_code`, `ck_sequencing_runs_run_code_not_blank`, `ck_sequencing_runs_platform_not_blank` |
| `sequencing_libraries` | `pk_sequencing_libraries` (`library_id`) | `fk_sequencing_libraries_extraction_id`, `fk_sequencing_libraries_run_id` | `uq_sequencing_libraries_library_code`, `uq_sequencing_libraries_extraction_run`, `ck_sequencing_libraries_library_code_not_blank` |
| `quality_control_results` | `pk_quality_control_results` (`qc_id`) | `sample_id`, `analysis_id`, `recorded_by` FKs are added in 090 | `ck_quality_control_results_target` (sample or analysis required) |

Seed rows: `database/seeds/030_seed_lab.sql` (2 labs, 3 batches, 17 extractions, 2 runs, 16 libraries, 23 QC results).

## Queries

`database/queries/lab_queries.sql` (T14-B). Each is a prepared statement with `$1` parameters; expected results for the seed are in the file.

| Name | Question | Parameter |
| --- | --- | --- |
| `q1_extraction_qc_by_batch` | Extractions per batch with QC pass rate | `lab_id` (NULL = all) |
| `q2_run_libraries_with_samples` | Libraries per run with their source samples | `run_id` (NULL = all) |
| `q3_samples_with_qc_problems` | Samples with failed or contaminated QC, with every reason | `project_id` (NULL = all) |

## Views

`database/views/lab_views.sql` (T15-B). Names fixed by CONTRACT 7.

### `v_lab_pipeline_status`

One row per sample (every sample, including ones not yet extracted). Collapses a sample's history to its latest extraction attempt and, for that extraction, the library on its most recent run (latest `run_date`, then newest `created_at`). Used by the Lab processing page (T27), the lab routes (T22), and the dashboard.

| Column | Type | Meaning |
| --- | --- | --- |
| `sample_id` | bigint | Sample |
| `sample_code` | text | `EB-YYYYMMDD-EEEE-NNN` |
| `project_id` | bigint | Project of the sample's collection event (for access filtering) |
| `site_id` | bigint | Sampling site |
| `site_name` | text | Site name |
| `collected_at` | timestamptz | When the sample was collected |
| `sample_status` | sample_status | Current status from `samples` |
| `extraction_attempts` | bigint | Number of extraction attempts (0 if none) |
| `latest_extraction_id` | bigint | Latest attempt, NULL if not extracted |
| `latest_attempt_number` | integer | Attempt number of the latest extraction |
| `latest_qc_status` | qc_status | `pending`, `pass`, or `fail` for the latest extraction |
| `latest_concentration_ng_ul` | numeric | Concentration of the latest extraction |
| `latest_purity_a260_280` | numeric | A260/280 of the latest extraction |
| `batch_id` | bigint | Batch of the latest extraction |
| `lab_name` | text | Lab that ran that batch |
| `library_id` | bigint | Library from the latest extraction on its most recent run (by `run_date`), NULL if none |
| `library_code` | text | `LIB-NNNN` |
| `run_id` | bigint | That library's run |
| `run_code` | text | `RUN-NNN` |
| `run_status` | run_status | `planned`, `running`, `completed`, or `failed` |
| `run_date` | date | Run date |
| `pipeline_stage` | text | Derived stage, first match wins: `sample_failed` (sample `failed`/`discarded`), `not_extracted`, `extraction_qc_pending`, `extraction_failed`, `awaiting_library`, `run_planned`, `sequencing`, `sequenced`, `run_failed` |

Seeded data: 17 rows; samples 1–16 `sequenced` (8 on `RUN-001`, 8 on `RUN-002`), sample 17 `sample_failed`.

### `v_failed_qc`

One row per QC problem on a sample or extraction: extractions whose `qc_status` is `fail`, `quality_control_results` rows with result `fail` or `warn` that name a sample, and those recorded against an analysis only (no `sample_id`), which are applied to every sample whose library is in that analysis's run (the same rule as Q3). Passing QC and pending extractions are left out. History is kept, so a failed attempt still appears after a later re-extraction passes. Used by the Lab processing page's QC list (T27) and QC reporting. For one row per sample, see Q3.

| Column | Type | Meaning |
| --- | --- | --- |
| `sample_id` | bigint | Sample with the problem |
| `sample_code` | text | Sample code |
| `project_id` | bigint | Project (for access filtering) |
| `site_name` | text | Site name |
| `extraction_id` | bigint | Failed extraction; NULL for rows from `quality_control_results` |
| `source` | text | `extraction`, `qc_result`, or `analysis_qc` (analysis-only QC applied to the samples of its run) |
| `qc_type` | qc_type | QC check type; NULL for `extraction` rows |
| `severity` | text | `fail` or `warn` |
| `metric_value` | numeric | Measured value (concentration for failed extractions), may be NULL |
| `reason` | text | QC notes, or a generated sentence for failed extractions |
| `recorded_by` | bigint | User who recorded it (batch operator for extractions) |
| `recorded_at` | timestamptz | When it was recorded |

Seeded data: 4 rows (no analysis-only QC is seeded). Sample 17: failed extraction 17, `concentration` fail (0.35 ng/µL), `contamination_check` fail. Sample 12: `negative_control` warn.

## Transaction (T18-B)

`database/transactions/lab_transaction.sql` (issue #34). Scenario: **batch extraction entry, with row locking so two users cannot assign the same extraction to a run.** It is a standalone demonstration run by hand with `psql`; `database/transactions/` is not run by the migration runner. It creates and deletes nothing: every transaction ends in `ROLLBACK`, so it can be run repeatedly and leaves the database unchanged (it asserts this itself, `audit_logs` included). Generated ids move on, since PostgreSQL never reuses a consumed identity value.

```bash
docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/lab_transaction.sql
psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/lab_transaction.sql   # COMMIT Parts 1 and 4; test database only, reset afterwards
```

The scenario re-extracts samples 6, 12 and 17 (all seeded samples already have an extraction, so batch entry is modelled as attempt 2 or later). Every transaction starts with `SET LOCAL app.current_user_id = '4'` (lab technician), as the backend does, and runs at the default READ COMMITTED level. Part 0 stops with a message if the fixture world is missing.

| Case | What it does | Expected SQLSTATE | What is undone |
| --- | --- | --- | --- |
| Part 1, commit path | Lock samples, insert batch, 3 extractions, 3 QC rows, set verdicts, `create_sequencing_run` for the 2 passing extractions | none | Default `ROLLBACK`: everything, including the audit rows. With `keep=1` it is committed and visible from another connection |
| Part 2, rollback A | Third extraction has a negative concentration | `23514` (`ck_dna_extractions_concentration`), then `25P02` for later statements | Batch and the two good extractions, with their audit rows |
| Part 3 B1 | Book a list that includes a failed extraction | `EB002` (has not passed QC) | Batch, extractions, QC rows and verdicts entered earlier in the same transaction |
| Part 3 B2 | Book an extraction on a second new run | `EB002` (already booked on run RUN-n) | The second run is refused; the whole transaction, including the first run and its libraries, is rolled back |
| Guard rail 1 | Call the procedure under `REPEATABLE READ` | `EB002` | Nothing was written |
| Guard rail 2 | Plain `INSERT INTO sequencing_libraries` for failed extraction 17 | `EB002` (`trg_sequencing_libraries_qc_pass`) | Nothing was written |
| Part 4, savepoint | Bad purity row, `ROLLBACK TO SAVEPOINT`, corrected row | `23514` | Only the bad row and its audit row; the batch and the good row survive |
| Part 5, locking | Two sessions book the same extraction (protocol in the script comments) | `EB002` for the second session after the first commits | The second session's attempt; one active run holds the extraction |

### Two-session protocol

A single script cannot run two sessions, so Part 5 is a copy-paste protocol in the script (S1, S2 and an observer S3): S1 `BEGIN` + `create_sequencing_run` for extraction X and keeps the transaction open; S2 books X and **blocks** on the procedure's `SELECT ... FOR UPDATE` (`pg_stat_activity` shows `wait_event_type = Lock`, `wait_event = transactionid`; `pg_locks` shows an ungranted `ShareLock`); S1 `COMMIT` makes S2 fail with `EB002` because, under READ COMMITTED, S2 then sees S1's library; exactly one planned/running run contains X. If S1 rolls back instead, S2 succeeds. Two sessions booking `[a, b]` and `[b, a]` do not deadlock, because the procedures lock in ascending id order; locking in the caller's order would end with `40P01`. Committed runs from this protocol are removed by `npm run db:reset` (no `DELETE`, D19). The automated version is `tests/concurrency/run-assignment.test.js` (T34).

### What each part demonstrates

- **Atomicity:** one transaction writes five tables (and the audit log); an error anywhere undoes all of it (Parts 2, 3), a savepoint undoes only part of it (Part 4).
- **Consistency:** check constraints (`23514`), the QC trigger and the procedures' booking rules (`EB002`) hold even when the batch is half entered.
- **Isolation:** row locks serialise two writers of the same extraction; at READ COMMITTED the second writer re-reads after the first commits (Part 5). `REPEATABLE READ` is refused (`EB002`).
- **Durability:** after `COMMIT` (`keep=1`) the rows are visible to a second connection and survive the session; they also survive a server restart because of the write-ahead log.

### Attempt numbers

No database object assigns `dna_extractions.attempt_number`; the table only has `uq_dna_extractions_sample_attempt`. The scenario computes `max(attempt_number) + 1` per sample inside the transaction after locking the sample rows `FOR UPDATE` in ascending id order. Without the lock, two technicians re-extracting the same sample would get `23505` on the unique constraint (safe, but a noisy failure). The backend service should follow the same pattern.

## Indexes (T19-B)

`database/indexes/lab_indexes.sql` (issue #38). Applied by hand with `psql -f` (the migration runner does not run `database/indexes/`, so the unindexed baseline stays available for benchmarks) and safe to run twice. Exactly two indexes, each chosen from measured `EXPLAIN (ANALYZE, BUFFERS)` plans on volume data.

| Index | Serves | Before | After | Size |
| --- | --- | --- | --- | --- |
| `idx_sequencing_libraries_run_id` on `sequencing_libraries (run_id)` | Q2, `GET /api/sequencing-runs/:id`, `RESTRICT` check on runs | Seq Scan, 2138 buffers, 3.273 ms | Index Scan, 1207 buffers, 0.300 ms (about 11x) | 688 kB |
| `idx_dna_extractions_batch_id` on `dna_extractions (batch_id)` | `GET /api/extractions?batch_id=`, one batch in Q1, FK check | Seq Scan, 1032 buffers, 2.407 ms | Index Scan, 3 buffers, 0.007 ms (about 340x) | 712 kB |

### Measurement

Test database `ebiotrack_test` loaded with `npm run volume:load -- --scale medium`: 100 017 extractions, 100 016 libraries, 1 002 runs, 2 003 batches (about 100 libraries per run, 50 extractions per batch). `ANALYZE` after loading and after creating the indexes. One session with `max_parallel_workers_per_gather = 0`, `jit = off` and `plan_cache_mode = force_custom_plan` (a prepared statement with `($1 IS NULL OR col = $1)` gets a generic plan that cannot use an index, so it was planned for its actual parameter, like the backend's literal-sized lookups); one warm-up, then the median of 5 runs; no `enable_*` setting changed. All pages were in shared buffers, so `Buffers: shared hit` is the fairer comparison than time. Benchmark queries, with ids looked up from the data:

- BQ1: `EXECUTE q2_run_libraries_with_samples(1000500)`
- BQ2a: `SELECT * FROM dna_extractions WHERE batch_id = 1000700`
- BQ2b: `EXECUTE q1_extraction_qc_by_batch(1)`
- BQ3a: `SELECT * FROM dna_extractions WHERE sample_id = 1040000`
- BQ3b: `SELECT * FROM v_lab_pipeline_status WHERE sample_id = 1040000`

| Query | Before: node, buffers, ms | After: node, buffers, ms | Factor |
| --- | --- | --- | --- |
| BQ1 | Seq Scan on `sequencing_libraries`, 2138, 3.273 | Index Scan using `idx_sequencing_libraries_run_id`, 1207, 0.300 | 10.9x |
| BQ2a | Seq Scan on `dna_extractions`, 1032, 2.407 | Index Scan using `idx_dna_extractions_batch_id`, 3, 0.007 | about 340x |
| BQ2b | Seq Scan + Hash Right Join, 1050, 16.099 | unchanged plan, 1050, 16.344 | none |
| BQ3a | Index Scan using `uq_dna_extractions_sample_attempt`, 3, 0.004 | unchanged, 3, 0.004 | none |
| BQ3b | Index (Only) Scans on `uq_dna_extractions_sample_attempt`, 27, 0.029 | unchanged, 27, 0.035 | none (noise) |

Abridged plans (BQ1 libraries scan and BQ2a):

```
before  Seq Scan on sequencing_libraries lib (actual time=1.496..2.942 rows=100)
          Rows Removed by Filter: 99916   Buffers: shared hit=935
after   Index Scan using idx_sequencing_libraries_run_id on sequencing_libraries lib (actual rows=100)
          Buffers: shared hit=4

before  Seq Scan on dna_extractions (rows=50)  Rows Removed by Filter: 99967
          Buffers: shared hit=1032   Execution Time: 2.407 ms
after   Index Scan using idx_dna_extractions_batch_id (rows=50)
          Buffers: shared hit=3      Execution Time: 0.007 ms
```

The results do not change: `Q1` for lab 1 (1 002 rows), `Q2` for run 1000500 (100 rows) and for all runs (100 016 rows), and `BQ2a` (50 rows) have identical row counts and `md5` checksums with and without the indexes.

### Already indexed by a constraint

PostgreSQL creates an index for every `PRIMARY KEY` and `UNIQUE` constraint, but not for foreign keys.

| Existing index | Leading column | Already serves |
| --- | --- | --- |
| `uq_dna_extractions_sample_attempt (sample_id, attempt_number)` | `sample_id` | `sample_id` lookups and `ORDER BY attempt_number DESC LIMIT 1` (the lateral in `v_lab_pipeline_status`) |
| `uq_sequencing_libraries_extraction_run (extraction_id, run_id)` | `extraction_id` | `extraction_id` lookups (booking check); **not** `run_id` alone |
| primary keys, `uq_sequencing_libraries_library_code`, `uq_sequencing_runs_run_code`, `uq_laboratories_name` | their own columns | their own lookups |

### Not indexed, and why

- **`dna_extractions (sample_id)` (named in the role document): redundant.** It is the leading column of `uq_dna_extractions_sample_attempt`, and BQ3a and BQ3b above show the planner already using that index, so a second index would add only write cost. `dna_extractions (batch_id)` replaces it as the second index.
- `sequencing_libraries (extraction_id)`: leading column of `uq_sequencing_libraries_extraction_run`.
- `extraction_batches (lab_id)`, `sequencing_runs (lab_id)`: 2 003 and 1 002 rows, and one lab owns about half of them. A sequential scan (17 and 12 buffers, about 0.4 ms) is the right plan.
- `quality_control_results (sample_id)`: the volume generator creates no QC rows, so there was nothing honest to measure.

### Trade-offs

Each index takes about 0.7 MB at this scale. Inserting about 100 000 rows into a temporary copy of the table (primary and unique indexes only, rolled back) took 181 ms without and 206 ms with `idx_sequencing_libraries_run_id` (+14%), and 97 ms without and 120 ms with `idx_dna_extractions_batch_id` (+24%). Real writes are a few rows at a time (booking a run, entering a batch), so the cost is small against the read gain. An index does not always win: Q1 as written reads every extraction to build the per-batch counts, so a sequential scan stays correct for it (BQ2b), and the same holds for any query that returns a large share of a table.
