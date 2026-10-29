-- Owner: A (Backend)
-- Purpose: 3 complex queries: Analysis, Taxonomy & Analytics
--
-- SCIENTIFIC CAVEAT: detection does not indicate abundance, and non-detection does not indicate
-- absence. read_count is a raw sequencing read count (returned as total_reads / read_count), never
-- a population measure. A zero below means "no passing detections", not "absent".
--
-- GOVERNING DATA RULE (CONTRACT section 10): analytics use only analyses with status 'approved'
-- and assignments with qc_flag = 'pass'. Every query below applies it; draft, imported, rejected
-- and superseded analyses and warn/fail rows never appear. Nothing here relaxes the rule.
--
-- HOW TO RUN: each query is a PREPARE with explicit parameter types, so this file runs end to end
-- with psql -f and the services can lift the text after AS (the $n placeholders are the same).
-- Run one with EXECUTE using the example values given in its block, for example:
--     psql -d ebiotrack -f database/queries/analysis_queries.sql -c "EXECUTE analysis_taxa_at_site(1, NULL, NULL, NULL)"
-- Optional filters take NULL to mean "no filter". Dates are compared in UTC. Prepared statements
-- last for the session only; no objects are created.
--
-- Join chain (confirmed against migrations 020, 030, 040):
--   taxon_assignments -> analysis_runs (status) / taxa (name, rank)
--   taxon_assignments.library_id -> sequencing_libraries.extraction_id -> dna_extractions.sample_id
--   -> samples.event_id -> collection_events (site_id, project_id, collected_at) [-> sampling_sites]
--
-- Query 1 does not join sampling_sites: collection_events.site_id is all it needs. No indexes are
-- added on purpose; T19 measures these statements unindexed first.


-- =============================================================================================
-- Query 1: taxa detected at a site
-- Purpose:   which taxa have been detected at a site, how often, and when.
-- Parameters: $1 site_id (required, example 1); $2 project_id (NULL = any, example 1);
--             $3 from date (NULL = no lower bound, example '2026-01-01'); $4 to date (NULL = none).
-- Columns:   taxon_id, scientific_name, rank, sample_count, event_count, detection_count,
--            first_detected (date), last_detected (date), max_confidence, total_reads,
--            also_at_other_sites (boolean).
-- Serves:    GET /api/taxa (site filter), the site detail page, and the base of
--            v_approved_detections (T15).
-- Features:  multi-join (6 tables), aggregation, correlated subquery (EXISTS).
-- Definitions: "detected" = approved analysis + qc_flag 'pass'. Taxa found only by non-approved
--            analyses or only with warn/fail flags do not appear. All ranks are returned, because
--            assignments may be genus-level; richness (Query 2) is the one that restricts to
--            species. sample_count is DISTINCT because one sample can be detected by several
--            analyses; event_count likewise. total_reads is a raw read count, not abundance.
--            also_at_other_sites looks at every site in the system (same approved + pass rule),
--            ignoring the project and date filters, so it answers "is this taxon known elsewhere".
-- =============================================================================================
PREPARE analysis_taxa_at_site (bigint, bigint, date, date) AS
SELECT
    t.taxon_id,
    t.scientific_name,
    t.rank,
    COUNT(DISTINCT sa.sample_id)                         AS sample_count,
    COUNT(DISTINCT ce.event_id)                          AS event_count,
    COUNT(*)                                             AS detection_count,
    MIN((ce.collected_at AT TIME ZONE 'UTC')::date)      AS first_detected,
    MAX((ce.collected_at AT TIME ZONE 'UTC')::date)      AS last_detected,
    MAX(ta.confidence)                                   AS max_confidence,
    SUM(ta.read_count)                                   AS total_reads,
    EXISTS (
        SELECT 1
        FROM taxon_assignments ta_other
        JOIN analysis_runs ar_other ON ar_other.analysis_id = ta_other.analysis_id
        JOIN sequencing_libraries sl_other ON sl_other.library_id = ta_other.library_id
        JOIN dna_extractions de_other ON de_other.extraction_id = sl_other.extraction_id
        JOIN samples sa_other ON sa_other.sample_id = de_other.sample_id
        JOIN collection_events ce_other ON ce_other.event_id = sa_other.event_id
        WHERE ta_other.taxon_id = t.taxon_id
          AND ar_other.status = 'approved'
          AND ta_other.qc_flag = 'pass'
          AND ce_other.site_id <> $1
    )                                                    AS also_at_other_sites
FROM taxon_assignments ta
JOIN analysis_runs ar ON ar.analysis_id = ta.analysis_id
JOIN taxa t ON t.taxon_id = ta.taxon_id
JOIN sequencing_libraries sl ON sl.library_id = ta.library_id
JOIN dna_extractions de ON de.extraction_id = sl.extraction_id
JOIN samples sa ON sa.sample_id = de.sample_id
JOIN collection_events ce ON ce.event_id = sa.event_id
WHERE ce.site_id = $1
  AND ar.status = 'approved'
  AND ta.qc_flag = 'pass'
  AND ($2::bigint IS NULL OR ce.project_id = $2)
  AND ($3::date IS NULL OR (ce.collected_at AT TIME ZONE 'UTC')::date >= $3)
  AND ($4::date IS NULL OR (ce.collected_at AT TIME ZONE 'UTC')::date <= $4)
GROUP BY t.taxon_id, t.scientific_name, t.rank
ORDER BY sample_count DESC, t.scientific_name, t.taxon_id;


-- =============================================================================================
-- Query 2: taxon richness by site and year
-- Purpose:   distinct taxa observed per site per year, next to the sampling effort.
-- Parameters: $1 project_id (NULL = any, example 1); $2 site_id (NULL = any, example 1);
--             $3 from year (NULL = none, example 2025); $4 to year (NULL = none, example 2026).
-- Columns:   site_id, site_name, year, observed_taxa, sample_count, events_count,
--            change_vs_previous_year (NULL unless the previous calendar year is also returned).
-- Serves:    GET /api/analytics/richness (year grain) and v_site_richness (T15).
-- Features:  CTEs, multi-join, aggregation, LEFT JOIN, window function (LAG).
-- Definitions: observed_taxa = DISTINCT species-rank taxa with a 'pass' detection in an approved
--            analysis at the site in that year. Genus-level and higher assignments are excluded
--            so ranks are not mixed in one count (a genus hit is not a separate species).
--            sample_count = distinct samples registered for collection events at the site in that
--            year, whether or not they have a library or a detection: the denominator is sampling
--            effort, not positives. That includes sample 17 (failed extraction, no library).
--            A site-year with samples but no passing species detections shows observed_taxa = 0,
--            meaning "no detections", never "absent". Years follow UTC.
--            change_vs_previous_year is the only window column and is separable: drop the final
--            LAG expression and the rest is the base query. The grain is site and year; distinct
--            counts are not additive, so group_by=month or a site-only total needs its own
--            statement rather than re-aggregating these rows.
-- =============================================================================================
PREPARE analysis_richness_by_site_year (bigint, bigint, integer, integer) AS
WITH effort AS (
    SELECT
        ce.site_id,
        EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')::integer AS year,
        COUNT(DISTINCT sa.sample_id)                                   AS sample_count,
        COUNT(DISTINCT ce.event_id)                                    AS events_count
    FROM collection_events ce
    JOIN samples sa ON sa.event_id = ce.event_id
    WHERE ($1::bigint IS NULL OR ce.project_id = $1)
      AND ($2::bigint IS NULL OR ce.site_id = $2)
      AND ($3::integer IS NULL OR EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC') >= $3)
      AND ($4::integer IS NULL OR EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC') <= $4)
    GROUP BY ce.site_id, EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')
),
detected AS (
    SELECT
        ce.site_id,
        EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')::integer AS year,
        -- DISTINCT: the same species is detected in several libraries, samples and analyses.
        COUNT(DISTINCT ta.taxon_id)                                    AS observed_taxa
    FROM taxon_assignments ta
    JOIN analysis_runs ar ON ar.analysis_id = ta.analysis_id
    JOIN taxa t ON t.taxon_id = ta.taxon_id
    JOIN sequencing_libraries sl ON sl.library_id = ta.library_id
    JOIN dna_extractions de ON de.extraction_id = sl.extraction_id
    JOIN samples sa ON sa.sample_id = de.sample_id
    JOIN collection_events ce ON ce.event_id = sa.event_id
    WHERE ar.status = 'approved'
      AND ta.qc_flag = 'pass'
      AND t.rank = 'species'
      AND ($1::bigint IS NULL OR ce.project_id = $1)
      AND ($2::bigint IS NULL OR ce.site_id = $2)
      AND ($3::integer IS NULL OR EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC') >= $3)
      AND ($4::integer IS NULL OR EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC') <= $4)
    GROUP BY ce.site_id, EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')
),
site_year AS (
    SELECT
        ef.site_id,
        si.name                              AS site_name,
        ef.year,
        COALESCE(de.observed_taxa, 0)        AS observed_taxa,
        ef.sample_count,
        ef.events_count
    FROM effort ef
    JOIN sampling_sites si ON si.site_id = ef.site_id
    LEFT JOIN detected de ON de.site_id = ef.site_id AND de.year = ef.year
)
SELECT
    sy.site_id,
    sy.site_name,
    sy.year,
    sy.observed_taxa,
    sy.sample_count,
    sy.events_count,
    CASE
        WHEN LAG(sy.year) OVER by_site = sy.year - 1
        THEN sy.observed_taxa - LAG(sy.observed_taxa) OVER by_site
    END                                      AS change_vs_previous_year
FROM site_year sy
WINDOW by_site AS (PARTITION BY sy.site_id ORDER BY sy.year)
ORDER BY sy.site_id, sy.year;


-- =============================================================================================
-- Query 3: detection history for a taxon (recursive CTE over the taxonomy)
-- Purpose:   every approved, passing detection of a taxon AND all its descendants (a genus rolls
--            up its species), over time and by site.
-- Parameters: $1 taxon_id (required, any rank, example 6 = Labeo); $2 project_id (NULL = any);
--             $3 from date (NULL = none); $4 to date (NULL = none).
-- Columns:   site_id, site_name, collected_at (timestamptz, as in the CONTRACT 11 payload),
--            sample_code, analysis_id, taxon_id, scientific_name, rank (the detected descendant),
--            read_count, confidence, qc_flag.
-- Serves:    GET /api/taxa/:id/detections (the service paginates and may add a site_id filter).
-- Features:  WITH RECURSIVE (downward walk), multi-join (8 tables).
-- Definitions: one row per detection (one library of one sample in one analysis), so the history
--            keeps replicate detail; the caller can group by site and year. Ordered by collection
--            time, then site. The recursion carries depth and a path array; "NOT taxon_id =
--            ANY(path)" stops a cycle even though the schema already forbids self-parenting.
--            A taxon with no passing approved detections (or an unknown id) returns zero rows and
--            no error. qc_flag is always 'pass' here; it is returned for payload parity.
-- =============================================================================================
PREPARE analysis_taxon_detection_history (bigint, bigint, date, date) AS
WITH RECURSIVE subtree AS (
    SELECT
        tx.taxon_id,
        0                       AS depth,
        ARRAY[tx.taxon_id]      AS path
    FROM taxa tx
    WHERE tx.taxon_id = $1
    UNION ALL
    SELECT
        child.taxon_id,
        parent.depth + 1,
        parent.path || child.taxon_id
    FROM subtree parent
    JOIN taxa child ON child.parent_taxon_id = parent.taxon_id
    WHERE NOT child.taxon_id = ANY (parent.path)
)
SELECT
    si.site_id,
    si.name                     AS site_name,
    ce.collected_at,
    sa.sample_code,
    ta.analysis_id,
    t.taxon_id,
    t.scientific_name,
    t.rank,
    ta.read_count,
    ta.confidence,
    ta.qc_flag
FROM subtree st
JOIN taxa t ON t.taxon_id = st.taxon_id
JOIN taxon_assignments ta ON ta.taxon_id = t.taxon_id
JOIN analysis_runs ar ON ar.analysis_id = ta.analysis_id
JOIN sequencing_libraries sl ON sl.library_id = ta.library_id
JOIN dna_extractions de ON de.extraction_id = sl.extraction_id
JOIN samples sa ON sa.sample_id = de.sample_id
JOIN collection_events ce ON ce.event_id = sa.event_id
JOIN sampling_sites si ON si.site_id = ce.site_id
WHERE ar.status = 'approved'
  AND ta.qc_flag = 'pass'
  AND ($2::bigint IS NULL OR ce.project_id = $2)
  AND ($3::date IS NULL OR (ce.collected_at AT TIME ZONE 'UTC')::date >= $3)
  AND ($4::date IS NULL OR (ce.collected_at AT TIME ZONE 'UTC')::date <= $4)
ORDER BY ce.collected_at, si.site_id, t.scientific_name, sa.sample_code, ta.analysis_id;


-- =============================================================================================
-- Query 3b (optional): lineage of a taxon, root first
-- Purpose:   the ancestors of a taxon up to the root, for GET /api/taxa/:id ("taxon with lineage").
-- Parameters: $1 taxon_id (required, example 7).
-- Columns:   taxon_id, scientific_name, rank, parent_taxon_id, depth (0 = root).
-- Features:  WITH RECURSIVE (upward walk), window function.
-- An unknown id returns zero rows. Ranks omitted in the data (Gambusia sits directly under its
-- class) are simply absent from the chain.
-- =============================================================================================
PREPARE analysis_taxon_lineage (bigint) AS
WITH RECURSIVE lineage AS (
    SELECT
        tx.taxon_id,
        tx.scientific_name,
        tx.rank,
        tx.parent_taxon_id,
        0                       AS steps_up,
        ARRAY[tx.taxon_id]      AS path
    FROM taxa tx
    WHERE tx.taxon_id = $1
    UNION ALL
    SELECT
        anc.taxon_id,
        anc.scientific_name,
        anc.rank,
        anc.parent_taxon_id,
        child.steps_up + 1,
        child.path || anc.taxon_id
    FROM lineage child
    JOIN taxa anc ON anc.taxon_id = child.parent_taxon_id
    WHERE NOT anc.taxon_id = ANY (child.path)
)
SELECT
    ln.taxon_id,
    ln.scientific_name,
    ln.rank,
    ln.parent_taxon_id,
    MAX(ln.steps_up) OVER () - ln.steps_up AS depth
FROM lineage ln
ORDER BY depth;
