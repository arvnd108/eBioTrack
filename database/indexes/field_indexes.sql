-- Owner: D (Docs & Demo)
-- Purpose: 2 justified indexes: Field & Samples
-- Issue #40 / T19-D.
--
-- 1. samples(sample_code): already indexed by the UNIQUE constraint declared in
--    database/migrations/020_field_samples.sql. PostgreSQL automatically creates a
--    unique B-tree index for that constraint, so creating another index on sample_code
--    would duplicate storage and write overhead. Verify with:
--      SELECT indexname, indexdef
--      FROM pg_indexes
--      WHERE schemaname = 'public' AND tablename = 'samples';
--
-- 2. Collection-event site/time lookups: supports filtering events by site and then
--    reading them in collected_at order, as used by field time-series queries.
--    Column order matters: site_id is the equality filter; collected_at is the time
--    range/order column.
CREATE INDEX IF NOT EXISTS idx_collection_events_site_id_collected_at
    ON collection_events (site_id, collected_at);

-- Prefix-search note for sample_code:
-- A normal B-tree index can support LIKE 'EB-2026%' with a non-C locale only when
-- an appropriate pattern operator class is used (text_pattern_ops). Under the C
-- locale, the default B-tree operator class can support this prefix pattern too.
-- Do not add a second pattern index unless EXPLAIN evidence and the project contract
-- justify the extra index. Record the database collation and actual plans in the
-- T19-D benchmark notes before making a recommendation.
