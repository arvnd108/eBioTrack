T19-D: Field & Samples Index Benchmark

Issue: #40
Branch: d/t19-field-indexes
Database: Local PostgreSQL 16 test database (ebiotrack_test)
Dataset: Small generated dataset, seed 20260101
Collation: en_US.utf8

1. Index decisions

Sample-code lookup

The samples.sample_code column already has a UNIQUE constraint. PostgreSQL creates the unique B-tree index samples_sample_code_key for this constraint. A duplicate index is unnecessary because it would increase storage and write overhead without providing a new access path.

Collection-event site/time lookup

The proposed composite index is:

CREATE INDEX IF NOT EXISTS idx_collection_events_site_id_collected_at
    ON collection_events (site_id, collected_at);

The leading site_id column supports equality filtering, followed by time filtering on collected_at. This index can also help queries retrieve events in time order.

2. Benchmark results

Measurements used EXPLAIN (ANALYZE, BUFFERS) on a small generated test dataset.

Query	Plan	Execution time	Rows returned
Exact sample-code lookup	Index Scan using samples_sample_code_key	0.079 ms	1
Prefix search before pattern-index experiment	Sequential Scan	1.883 ms	5,000
Prefix search with experimental text_pattern_ops index	Sequential Scan	1.800 ms	5,000
Collection-event site/time query before composite index	Sequential Scan	0.188 ms	14
Collection-event site/time query after composite index	Bitmap Index Scan + Bitmap Heap Scan, followed by Sort	0.091 ms	14

Collection-event comparison

The observed execution time decreased from 0.188 ms to 0.091 ms, approximately 51.6% in this individual comparison. The post-index plan used idx_collection_events_site_id_collected_at to filter the site and time range.

This is preliminary evidence from a small dataset. Cache state, planner decisions, and measurement variability affect execution time. The observed percentage is not a guarantee of improvement on larger datasets.

Prefix-search experiment

The database collation was en_US.utf8. The query was:

SELECT *
FROM samples
WHERE sample_code LIKE 'EB-2019%';

The query returned 5,000 rows and used a sequential scan both before and after a temporary text_pattern_ops index was tested. The temporary index was removed after testing.

Because the prefix matched almost all generated samples, a sequential scan was reasonable. These results do not justify adding a permanent pattern index. A more selective prefix and larger dataset would need separate testing.

3. Limitations and next steps

* Only the small generated dataset was benchmarked; medium and large datasets were not tested.
* The generated data does not provide a representative large-scale environmental-measurement benchmark for the T14 time-series query.
* Repeat benchmarks at larger scale before making production performance claims.
* Share the findings with Dhruve for T35 and reuse them in the T45 write-up.

4. Reproduction queries

Exact sample-code lookup

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM samples
WHERE sample_code = 'EB-20190101-1000000-000';

Prefix search

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM samples
WHERE sample_code LIKE 'EB-2019%';

Collection-event site/time lookup

EXPLAIN (ANALYZE, BUFFERS)
SELECT event_id, site_id, collected_at
FROM collection_events
WHERE site_id = 1000100
  AND collected_at >= '2019-01-01 00:00:00+00'
  AND collected_at < '2019-02-01 00:00:00+00'
ORDER BY collected_at;
