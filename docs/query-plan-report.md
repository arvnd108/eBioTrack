# Query-plan and index benchmark report

## Scope and reproducibility

This report summarizes the measured PostgreSQL index comparisons recorded in `database/indexes/field_indexes.sql` and the benchmark statements in `tests/performance/explain-benchmarks.sql`. These are repository-recorded results, not a new benchmark run during this documentation change.

The field benchmark used PostgreSQL 16 and the `ebiotrack_test` database, loaded with the medium volume fixture (20,008 collection events, 100,017 samples, 2,005 sites, and 400,084 status-history rows). The time-series query additionally used 80,032 deterministic environmental readings. Each comparison used `EXPLAIN (ANALYZE, BUFFERS)`, one warm-up, then the median of five runs; parallel workers and JIT were disabled, custom plans were forced, and involved tables were vacuumed/analyzed. Data was in shared buffers, so buffer counts help interpret timing.

Reproduce from the repository root using the documented test database only. The benchmark setup and exact statements are in `tests/performance/explain-benchmarks.sql`; the field index file documents the required unindexed baseline, fixture preparation, trigger state, and rollback commands. Do not run its destructive/reset steps against a production database.

## Recorded before/after comparisons

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

## Running the benchmark

1. Use the isolated `ebiotrack_test` database and load the documented medium fixture.
2. Prepare the deterministic environmental readings described in the benchmark SQL.
3. Capture the baseline plans before applying the field index file; vacuum/analyze the involved tables as documented.
4. Apply `database/indexes/field_indexes.sql`, capture the after plans, and compare execution time, buffers, plan shape, and result checksums.
5. Keep the audit/status triggers enabled for write-cost comparisons. Use the source file's rollback only to reset the benchmark database.

The index SQL directory is not applied by the migration runner; the source file documents that deployment limitation. Confirm the intended deployment process with the backend owner before applying indexes to another environment.
