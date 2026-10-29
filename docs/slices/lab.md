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
