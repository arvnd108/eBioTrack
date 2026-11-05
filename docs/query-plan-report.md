# Query-plan and index benchmark report

> Owner: D (Docs & Demo) · T45 / issue #68. Source of every number: `tests/performance/results/benchmark-results.md` and `cold-cache-results.md` (T35), and the recorded runs in `database/indexes/field_indexes.sql`. No benchmark was re-run for this document.

## Scope and method

The T35 benchmark (`node performance/run-benchmarks.js --scale medium --phase both --runs 5`, 2026-11-02) compares each statement **before** and **after** the slice indexes exist, on PostgreSQL 16.15 with the medium volume fixture (20,008 collection events, 100,017 samples, 2,005 sites, 400,084 status-history rows, 80,000 added environmental measurements, 200 analyses approved). Settings: `max_parallel_workers_per_gather = 0`, `jit = off`, `plan_cache_mode = force_custom_plan`, `shared_buffers = 128MB`, `work_mem = 4MB`. Per statement: one checksum run (the result must be identical before and after), one discarded warm-up, then the **median of five** `EXPLAIN (ANALYZE, BUFFERS)` runs with the data warm in shared buffers. Buffers (hit + read) are the primary measure; time is secondary and machine dependent. A second run (`run-cold-cache.js`) restarts the database and drops the page cache before each execution to measure cold I/O.

## The eight indexes

| Slice | Index | Purpose | Best recorded gain | Verdict |
|---|---|---|---|---|
| Access | `idx_project_members_user_id_project_id` | Memberships of one user (the authorization lookup on every request) | BQ1: 148 → 3 buffers, 0.410 → 0.007 ms | Justified |
| Access | `idx_audit_logs_entity_type_entity_id_created_at` | Audit trail of one entity | BQ3b: 6,679 → 15 buffers, 17.83 → 0.016 ms | Justified |
| Analysis | `idx_taxon_assignments_taxon_id_qc_flag` | Detections of a taxon, filtered by QC flag | BQ1b: 5,156 → 64 buffers, 18.93 → 0.028 ms | Justified for selective taxa; see the cold-cache note |
| Analysis | `idx_taxon_assignments_library_id` | Detections of one library; joins from libraries | BQ7a: 5,156 → 4 buffers, 17.07 → 0.004 ms | Justified |
| Field | `idx_collection_events_site_id_collected_at` | Events of a site, optionally within a date range | FQ3b: 188 → 10 buffers, 0.612 → 0.008 ms | Justified for site-scoped queries only (leading-column rule) |
| Field | `samples_sample_code_key` (the `UNIQUE` constraint's index) | Exact sample-code lookup | FQ1: 4 buffers before and after | No new index needed; it already existed |
| Lab | `idx_sequencing_libraries_run_id` | Libraries of a run | BQ1: 2,138 → 1,207 buffers, 2.64 → 0.294 ms | Justified, modest gain |
| Lab | `idx_dna_extractions_batch_id` | Extractions of a batch | BQ2a: 1,032 → 3 buffers, 2.92 → 0.008 ms | Justified |

Three more field indexes (`samples(event_id)`, `sample_status_history(sample_id)`, and a `text_pattern_ops` index on `sample_code`) were added later by #135. They are not in the T35 index set, so T35 shows the queries they serve (FQ2, FQ5) as unchanged; their own before and after figures are in [the last section](#field-follow-up-indexes-t19-d-follow-up-135).

## Before and after, per slice (warm cache)

The tables below are the T35 results, condensed: rows returned, plan before → after (with the index used), shared buffers and median milliseconds. "expected-unchanged" means no index was supposed to help and none did; the reason is given under each table.

### Access, Projects & Audit

| id | Query | Rows | Plan before → after | Buffers | ms | Verdict |
|---|---|---:|---|---|---|---|
| BQ1 | memberships of one user (authorize.js) (selective) | 34 | Seq Scan → Index Only Scan (idx_project_members_user_id_project_id) | 148 → 3 | 0.410 → 0.007 | improved |
| BQ1b | members of one project (redundancy: primary key leads with project_id) (selective) | 200 | Index Only Scan (pk_project_members) → Index Only Scan (pk_project_members) | 3 → 3 | 0.015 → 0.017 | expected-unchanged |
| BQ2 | Q1 access_user_projects, one user (selective) | 34 | Index Only Scan + Index Scan + Seq Scan → Bitmap Heap Scan + Index Only Scan + Index Scan (idx_project_members_user_id_project_id) | 487 → 374 | 1.06 → 0.814 | improved |
| BQ3a | Q3 audit trail, hot sample (selective) | 2154 | Seq Scan → Bitmap Heap Scan (idx_audit_logs_entity_type_entity_id_created_at) | 10096 → 5300 | 21.46 → 4.57 | improved |
| BQ3b | Q3 audit trail, cold sample (3 rows) (selective) | 3 | Seq Scan → Index Scan (idx_audit_logs_entity_type_entity_id_created_at) | 6679 → 15 | 17.83 → 0.016 | improved |
| BQ3c | Q3 audit trail, hot sample, one month (selective) | 158 | Seq Scan → Bitmap Heap Scan (idx_audit_logs_entity_type_entity_id_created_at) | 6700 → 1904 | 19.11 → 1.86 | improved |
| BQ4a | GET /api/audit, largest project trail (~4% of the table) (unselective) | 21551 | Seq Scan → Bitmap Heap Scan (idx_audit_logs_entity_type_entity_id_created_at) | 6670 → 6621 | 20.80 → 7.42 | improved |
| BQ4b | GET /api/audit, small project trail (selective) | 310 | Seq Scan → Bitmap Heap Scan (idx_audit_logs_entity_type_entity_id_created_at) | 6670 → 308 | 17.44 → 0.131 | improved |
| BQ5 | audit rows of one actor (actor_id is not indexed) (selective) | 50 | Seq Scan → Seq Scan | 6670 → 6822 | 13.21 → 15.85 | expected-unchanged |
| BQ6 | dashboard: newest 5 audit rows (created_at is not leading) (unselective) | 5 | Seq Scan → Seq Scan | 6670 → 6822 | 65.99 → 62.93 | expected-unchanged |

### Field & Samples

| id | Query | Rows | Plan before → after | Buffers | ms | Verdict |
|---|---|---:|---|---|---|---|
| FQ1 | sample by exact code (unique index) (selective) | 1 | Index Scan (samples_sample_code_key) → Index Scan (samples_sample_code_key) | 4 → 4 | 0.005 → 0.006 | expected-unchanged |
| FQ2a | prefix search, rarest year (selective) | 7 | Seq Scan → Seq Scan | 1334 → 1374 | 3.70 → 3.56 | expected-unchanged |
| FQ2b | prefix search, ~12% of the table (unselective) | 12400 | Seq Scan → Seq Scan | 1334 → 1374 | 4.15 → 4.14 | expected-unchanged |
| FQ2c | prefix search, largest year (~88%) (unselective) | 87600 | Seq Scan → Seq Scan | 1334 → 1374 | 8.05 → 8.04 | expected-unchanged |
| FQ2d | prefix search, the samples of one event (selective) | 5 | Seq Scan → Seq Scan | 1334 → 1374 | 3.83 → 4.07 | expected-unchanged |
| FQ3a | events of one site in one year (selective) | 78 | Seq Scan → Bitmap Heap Scan (idx_collection_events_site_id_collected_at) | 188 → 66 | 0.658 → 0.037 | improved |
| FQ3b | events of one site in one month (selective) | 9 | Seq Scan → Bitmap Heap Scan (idx_collection_events_site_id_collected_at) | 188 → 10 | 0.612 → 0.008 | improved |
| FQ3c | all events of one site, ordered (selective) | 83 | Seq Scan → Bitmap Heap Scan (idx_collection_events_site_id_collected_at) | 188 → 71 | 0.594 → 0.035 | improved |
| FQ3d | one month, all sites (leading-column rule) (selective) | 1344 | Seq Scan → Seq Scan | 188 → 188 | 0.794 → 0.775 | expected-unchanged |
| FQ4a | T14 Q3 moving average, one site (selective) | 83 | Seq Scan → Bitmap Heap Scan (idx_collection_events_site_id_collected_at) | 440 → 323 | 0.611 → 0.176 | improved |
| FQ4b | T14 Q3 moving average, all sites (unselective) | 20008 | Seq Scan → Seq Scan | 1021 → 1021 | 28.40 → 28.34 | expected-unchanged |
| FQ5a | Q2 latest status of the samples of one event (selective) | 5 | Seq Scan → Seq Scan | 4672 → 4737 | 68.22 → 74.64 | expected-unchanged |
| FQ5b | samples of one event (selective) | 5 | Seq Scan → Seq Scan | 1334 → 1374 | 2.94 → 2.93 | expected-unchanged |
| FQ5c | Q1 sample counts, all sites (unselective) | 2005 | Seq Scan → Seq Scan | 1550 → 1590 | 43.04 → 44.06 | expected-unchanged |
| FQ5d | v_site_sample_summary, one site (selective) | 1 | Seq Scan → Seq Scan (idx_collection_events_site_id_collected_at) | 1527 → 1450 | 7.14 → 7.84 | expected-unchanged |

### Analysis, Taxonomy & Analytics

| id | Query | Rows | Plan before → after | Buffers | ms | Verdict |
|---|---|---:|---|---|---|---|
| BQ1a | detections of the hot taxon (unselective) | 13432 | Seq Scan → Bitmap Heap Scan (idx_taxon_assignments_taxon_id_qc_flag) | 5156 → 4864 | 20.04 → 3.26 | improved |
| BQ1b | detections of the cold taxon (selective) | 62 | Seq Scan → Bitmap Heap Scan (idx_taxon_assignments_taxon_id_qc_flag) | 5156 → 64 | 18.93 → 0.028 | improved |
| BQ1c | passing detections of the hot taxon (selective) | 2587 | Seq Scan → Bitmap Heap Scan (idx_taxon_assignments_taxon_id_qc_flag) | 5156 → 2029 | 19.23 → 0.767 | improved |
| BQ2a | detection history, genus subtree (unselective) | 19953 | Seq Scan → Seq Scan | 8747 → 8815 | 79.64 → 80.79 | expected-unchanged |
| BQ2b | detection history, hot taxon (unselective) | 514 | Seq Scan → Seq Scan | 8729 → 8797 | 63.85 → 61.69 | expected-unchanged |
| BQ3 | taxa at the busiest site (selective) | 91 | Seq Scan + Seq Scan → Index Scan + Index Scan (idx_collection_events_site_id_collected_at, idx_taxon_assignments_library_id, idx_taxon_assignments_taxon_id_qc_flag) | 17996 → 7443 | 97.55 → 9.68 | improved |
| BQ4a | richness by site and year, all sites (unselective) | 3296 | Seq Scan → Seq Scan | 10230 → 10338 | 137 → 144 | expected-unchanged |
| BQ4b | richness by site and year, one site (selective) | 2 | Seq Scan → Index Scan (idx_collection_events_site_id_collected_at, idx_taxon_assignments_library_id) | 10882 → 5728 | 37.39 → 16.95 | improved |
| BQ5a | v_approved_detections, hot taxon (unselective) | 514 | Index Scan → Bitmap Heap Scan (idx_taxon_assignments_taxon_id_qc_flag) | 9877 → 8247 | 3.72 → 2.93 | improved |
| BQ5b | v_approved_detections, busiest site (selective) | 95 | Seq Scan → Index Scan (idx_collection_events_site_id_collected_at, idx_taxon_assignments_library_id) | 9337 → 4283 | 32.58 → 9.27 | improved |
| BQ6 | assignments of one analysis (redundancy: unique constraint index) (selective) | 500 | Index Scan (uq_taxon_assignments_analysis_library_taxon) → Index Scan (uq_taxon_assignments_analysis_library_taxon) | 13 → 13 | 0.055 → 0.053 | expected-unchanged |
| BQ7a | detections of one library (selective) | 5 | Seq Scan → Index Scan (idx_taxon_assignments_library_id) | 5156 → 4 | 17.07 → 0.004 | improved |
| BQ7b | approved and pass counts per taxon (unselective) | 5 | Seq Scan → Seq Scan | 5174 → 5174 | 25.07 → 23.73 | expected-unchanged |
| BQ8 | count for one analysis (redundancy: unique constraint index) (selective) | 1 | Index Only Scan (uq_taxon_assignments_analysis_library_taxon) → Index Only Scan (uq_taxon_assignments_analysis_library_taxon) | 8 → 8 | 0.045 → 0.046 | expected-unchanged |

### Laboratory & Sequencing

| id | Query | Rows | Plan before → after | Buffers | ms | Verdict |
|---|---|---:|---|---|---|---|
| BQ1 | Q2 libraries of the biggest run with their samples (selective) | 100 | Seq Scan → Index Scan (idx_sequencing_libraries_run_id) | 2138 → 1207 | 2.64 → 0.294 | improved |
| BQ2a | extractions of one batch (GET /api/extractions?batch_id=) (selective) | 50 | Seq Scan → Index Scan (idx_dna_extractions_batch_id) | 1032 → 3 | 2.92 → 0.008 | improved |
| BQ2b | Q1 extraction QC by batch, one lab (aggregates every batch) (unselective) | 1002 | Seq Scan → Seq Scan | 1050 → 1050 | 18.83 → 19.50 | expected-unchanged |
| BQ3a | extractions of one sample (redundancy: unique constraint index) (selective) | 1 | Index Scan (uq_dna_extractions_sample_attempt) → Index Scan (uq_dna_extractions_sample_attempt) | 3 → 3 | 0.005 → 0.005 | expected-unchanged |
| BQ3b | v_lab_pipeline_status, one sample (redundancy) (selective) | 1 | Index Only Scan + Index Scan (uq_dna_extractions_sample_attempt) → Index Only Scan + Index Scan (uq_dna_extractions_sample_attempt) | 27 → 27 | 0.034 → 0.036 | expected-unchanged |

Why the "expected-unchanged" rows stay unchanged:

- **Access:** BQ1b is served by the primary key, which already leads with `project_id`. BQ5 filters on `actor_id` and BQ6 has no entity filter, so the new audit index cannot be used.
- **Field:** FQ1 is served by the unique constraint index in both phases. The composite index starts with `site_id`, so a month across all sites (FQ3d) or the all-sites moving average (FQ4b) cannot use it. FQ2 (prefix search) cannot use a plain btree under `en_US.utf8`, and a prefix that matches 88% of the table (FQ2c) is correctly a sequential scan anyway. FQ5 is covered only by the follow-up indexes below.
- **Analysis:** BQ2 and BQ4a read every approved detection, so no per-taxon index helps. BQ6 and BQ8 are served by the unique index `uq_taxon_assignments_analysis_library_taxon`. BQ7b scans for counts of every taxon.
- **Lab:** BQ2b aggregates every batch of the lab. BQ3a and BQ3b use `uq_dna_extractions_sample_attempt` in both phases.

## Where an index did not help, or cost something

- **Unselective queries stay sequential.** Reading most of a table through an index would be slower, and the planner correctly keeps the sequential scan (BQ4a access/analysis, FQ2c, FQ4b).
- **Redundant indexes were rejected.** A separate `collection_events(site_id)` index repeats the leading column of the composite one; `project_members(project_id)` and the `(analysis_id, ...)` and `(sample_id, attempt)` lookups are already covered by primary or unique keys.
- **Cold cache can reverse a warm win.** With the cache emptied, BQ1a (detections of the hot taxon, 13,432 rows) took 14.8 ms before and 179 ms after: the index plan fetches many scattered heap pages from storage, where a sequential scan reads them in order. BQ1c went 15.7 → 77.1 ms, and the access-slice audit queries BQ3a and BQ3c went 22.9 → 73.8 and 20.2 → 73.3 ms, although each reads far fewer buffers (6,701 → 1,908 for BQ3a). The selective cases stay clear wins when cold (BQ7a 13.6 → 0.12 ms, BQ2a 4.9 → 0.08 ms, BQ3b 18.9 → 0.58 ms). Conclusion: the indexes are for selective lookups; queries that return a large share of a table gain buffers, not necessarily time.
- **Leading-column rule.** An index on `(site_id, collected_at)` does nothing for a date-only filter.

## Write and storage cost

Measured with the audit and status-history triggers enabled, in rolled-back transactions (T35 "Write cost" table). Baseline → indexed, median ms:

| Operation | Baseline | Indexed | Multiplier |
|---|---:|---:|---:|
| Bulk insert, 20,000 `project_members` (audit trigger) | 551 | 579 | 1.05x |
| Bulk insert, 20,000 `collection_events` (audit trigger) | 617 | 673 | 1.09x |
| Bulk insert, 20,000 `dna_extractions` (audit trigger) | 669 | 669 | 1.00x |
| Bulk insert, 20,000 `sequencing_libraries` (audit trigger) | 610 | 637 | 1.04x |
| Bulk insert, 100,000 `taxon_assignments` (no audit trigger) | 128 | 210 | 1.65x |
| Bulk insert, 20,000 `audit_logs` | 138 | 164 | 1.19x |
| 500 × `register_sample` | 1,542 | 1,518 | 0.98x |
| 100 × `create_sequencing_run` (5 extractions each) | 93.5 | 99.8 | 1.07x |
| 50 × `import_detections` (200 rows each) | 526 | 535 | 1.02x |

Extra write cost is between none and 22% for the audited tables, at most about 3 ms per thousand rows. The largest relative cost is on `taxon_assignments` (1.65x on a 100,000-row bulk insert, 128 → 210 ms) because that table has no audit trigger to dominate the time; absolute cost is still about 0.8 ms per thousand rows. T35 reported no findings (no index made a statement slower in the warm run).

## Field follow-up indexes (T19-D follow-up, #135)

| Query / access pattern | Recorded result | Interpretation |
|---|---:|---|
| Exact sample-code lookup (100,017 samples) | 3.095 ms / 1,344 buffers → 0.007 ms / 4 buffers | Existing unique constraint index is already the right access path; no duplicate exact-match index is needed. |
| Selective sample-code prefix (7 rows) | 5.070 ms / 1,334 buffers → 0.011 ms / 4 buffers | `text_pattern_ops` index supports selective prefix search under the test database's non-C collation. |
| Collection events for one site, one year (78 rows) | 0.751 ms / 188 buffers → 0.036 ms / 66 buffers | Composite `(site_id, collected_at)` index narrows the site/date query. |
| One site's events, one month (9 rows) | 0.963 ms / 188 buffers → 0.010 ms / 10 buffers | Selective date range benefits strongly. |
| One site's events, no date filter (83 rows) | 0.464 ms / 188 buffers → 0.039 ms / 71 buffers | Site filter benefits; plan still sorts the small result. |
| Time-series moving average for one site (83 readings) | 0.596 ms / 440 buffers → 0.168 ms / 323 buffers | Event lookup improves; measurement lookups remain a substantial share of work. |
| Samples belonging to one event (5 of 100,017) | 2.092 ms / 1,334 buffers → 0.004 ms / 3 buffers | `samples(event_id)` avoids scanning the full samples table. |
| Latest status for one event (5 samples; both relevant indexes) | 64.031 ms / 5,160 buffers → 0.052 ms / 13 buffers | Combining `samples(event_id)` and `sample_status_history(sample_id)` avoids scanning/ranking the large history table and is about 1,200× faster in the recorded run. |

These are workload- and fixture-specific measurements, not service-level guarantees. The source benchmark contains additional prefix selectivity, broad-query, and write-cost cases.

## Cases where an index does not help

- A month of events across **all** sites remained a sequential scan (about 0.819 → 0.813 ms): the composite index begins with `site_id`, so it cannot efficiently serve a date-only filter.
- The all-sites moving-average query reads every event (24.824 → 25.120 ms); the index does not reduce the required scan.
- A prefix matching 87.6% of sample codes remained a sequential scan; the planner correctly avoided an index that would fetch most rows.
- The unique sample-code index is retained for its uniqueness guarantee. The pattern index is additional and serves prefix matching, not a replacement.
- The sample-status query needs both the event-to-samples index and the history-by-sample index; either alone leaves a large scan.
- A separate `collection_events(site_id)` index is redundant with the leading column of the composite index. The environmental-measurement event index is already covered by its unique `(event_id, parameter)` constraint.

## Write and storage trade-offs

The recorded field benchmark found the composite collection-event index added about 88% to a bulk insert of 20,008 rows in a temporary table (8.353 → 15.715 ms), while the selective reads improved. With audit and status-history triggers enabled, registering 1,000 samples fell from about 2,268 ms without the new indexes to about 84 ms with all three measured sample/history indexes, primarily because the event sample-count lookup became indexed. A 1,000-row status update rose from about 41.0 to 44.8 ms (+9%, approximately 4 μs per row). Recorded index sizes and more detailed query cases are in the field index source file.

## Reproducing

```bash
cd backend && npm run db:reset
cd ../tests && npm run volume:load -- --scale medium
npm run bench
npm run bench -- --cleanup && npm run volume:clean
```

Use only the isolated `ebiotrack_test` database; the volume loader and cleanup are destructive. The index SQL files are not applied by the migration runner, so confirm how indexes reach another environment with the backend owner before relying on them there. The cold-cache run (`node performance/run-cold-cache.js`) restarts the Docker database container.
