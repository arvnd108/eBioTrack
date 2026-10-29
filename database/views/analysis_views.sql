-- Owner: A (Backend)
-- Purpose: 2 views: Analysis, Taxonomy & Analytics
--
-- T15-A. Names are fixed by CONTRACT 7; column lists are documented in docs/slices/analysis.md.
-- The views are the parameter-free, set-based forms of the T14-A queries in
-- database/queries/analysis_queries.sql and use the same definitions. They are the one place in
-- the database that enforces the governing rule (CONTRACT 10): only analyses with status
-- 'approved' and only assignments with qc_flag = 'pass' are counted. Read-only: nothing writes
-- through a view, no explicit ORDER BY (consumers sort), no user emails or password_hash.
--
-- Caveat for every consumer: a detection is evidence that DNA of a taxon was present, not
-- abundance, and a non-detection is not proof of absence.
--
-- Installed by backend/src/db/migrate.js (views run after the migrations, on every run). To apply
-- by hand, safe to repeat:
--   psql "$DATABASE_URL" -f database/views/analysis_views.sql
-- Re-run database/roles/grants.sql afterwards so the app role keeps SELECT only on the views.
-- CREATE OR REPLACE VIEW cannot drop or rename columns of an existing view; if the column lists
-- change later, DROP VIEW first.

-- ============================================================================================
-- v_approved_detections
-- ============================================================================================
-- Purpose: one row per approved, passing detection, with the taxon, the analysis and where and
--          when it was collected already joined. Serves the species explorer,
--          GET /api/taxa/:id/detections, exports and analytics.
-- Columns: assignment_id, read_count, confidence, qc_flag      the detection
--          taxon_id, scientific_name, rank, parent_taxon_id    the taxon
--          analysis_id, marker_id, marker_name, pipeline_name, pipeline_version, reference_db,
--          reference_db_version, approved_at                   the analysis
--          library_id, library_code, sample_id, sample_code    the library and sample
--          event_id, collected_at, project_id, site_id, site_name, region_id, habitat_type
--                                                              where and when
-- Rules:   status = 'approved' AND qc_flag = 'pass', nothing else. This matches CONTRACT 10 and
--          the T14-A queries. Decision: qc_flag stays in the column list (always 'pass') for
--          shape compatibility with the CONTRACT 11 example; warn/fail rows of an approved
--          analysis are reviewed by routes reading the base tables under the analyst /
--          principal_investigator rule, never through this view. draft, imported, rejected and
--          superseded analyses contribute no rows: a correction is a new run and the old one
--          becomes 'superseded', so superseded results disappear by the status filter.
--          read_count is raw sequencing reads, not abundance.
-- Joins:   all inner. The NOT NULL columns and FKs (assignment -> library -> extraction ->
--          sample -> event -> site, and assignment -> analysis -> marker, -> taxon) guarantee every
--          detection has a full chain, so no row is dropped; the row count equals the base filter
--          count on taxon_assignments and analysis_runs.
-- Used by: GET /api/taxa/:id/detections (filter taxon_id, project_id, site_id, collected_at),
--          species explorer and exports (T23), query-correctness tests (T31).
-- Features: 10-table join, enum filters, cross-slice read (analysis, lab, field) by design.
-- Expected for the seed: 24 rows, from analyses 1 (14 pass) and 2 (10 pass) only; analysis 3
--          (imported) and 4 (draft) contribute none; species 15 (Gambusia affinis), 9 and 13 are
--          absent; species 8 (Labeo calbasu) occurs at one site only.

CREATE OR REPLACE VIEW v_approved_detections AS
SELECT
    ta.assignment_id,
    ta.read_count,
    ta.confidence,
    ta.qc_flag,
    t.taxon_id,
    t.scientific_name,
    t.rank,
    t.parent_taxon_id,
    ar.analysis_id,
    ar.marker_id,
    dm.marker_name,
    ar.pipeline_name,
    ar.pipeline_version,
    ar.reference_db,
    ar.reference_db_version,
    ar.approved_at,
    sl.library_id,
    sl.library_code,
    sa.sample_id,
    sa.sample_code,
    ce.event_id,
    ce.collected_at,
    ce.project_id,
    ce.site_id,
    si.name         AS site_name,
    si.region_id,
    si.habitat_type
FROM taxon_assignments ta
JOIN analysis_runs ar ON ar.analysis_id = ta.analysis_id
JOIN dna_markers dm ON dm.marker_id = ar.marker_id
JOIN taxa t ON t.taxon_id = ta.taxon_id
JOIN sequencing_libraries sl ON sl.library_id = ta.library_id
JOIN dna_extractions de ON de.extraction_id = sl.extraction_id
JOIN samples sa ON sa.sample_id = de.sample_id
JOIN collection_events ce ON ce.event_id = sa.event_id
JOIN sampling_sites si ON si.site_id = ce.site_id
WHERE ar.status = 'approved'
  AND ta.qc_flag = 'pass';

-- ============================================================================================
-- v_site_richness
-- ============================================================================================
-- Purpose: observed richness and sampling effort per project, site and year; the numbers behind
--          the analytics page and GET /api/analytics/richness. Query 2
--          (analysis_richness_by_site_year) without parameters, split by project.
-- Columns: project_id, site_id, site_name
--          year            integer, calendar year of collected_at in UTC
--          observed_taxa   distinct species-rank taxa with a passing detection in an approved
--                          analysis; 0 means "no detections", never "absent"
--          sample_count    distinct samples collected at the site in that year, including
--                          samples with no detection (sampling effort)
--          event_count     distinct collection events
-- Rules:   one row per (project, site, year) that has at least one sample. Same definitions and
--          the same approved + pass + species filter as T14-A Query 2. UTC year, so a collection
--          near midnight on 31 December is not moved by the session time zone.
-- Grain:   an event belongs to exactly one project and a site can belong to several projects, so
--          the project is part of the grain; filtering by project_id is then possible. Distinct
--          samples never overlap between projects, so SUM(sample_count) and SUM(event_count)
--          across projects are valid per-site totals. Do NOT sum observed_taxa across projects:
--          the same species would be counted once per project. Query 2 groups by (site, year)
--          only, so the two agree exactly when a site has one project (the seed).
-- Finest grain is the year, so there is no month column: a monthly view (group_by=month) is
--          computed by the service from v_approved_detections or the base tables.
-- Used by: GET /api/analytics/richness (T23), analytics page (T27), tests (T31).
-- Features: CTEs, COUNT(DISTINCT), LEFT JOIN with COALESCE, multi-join.
-- Expected for the seed (project 1: sites 1-3, project 2: sites 4-5):
--          site 1: 2025 -> 2 taxa, 3 samples; 2026 -> 2 taxa, 2 samples
--          site 2: 2025 -> 2, 2; 2026 -> 1, 2     site 3: 2025 -> 2, 2; 2026 -> 2, 2
--          site 4: 2026 -> 2, 2                   site 5: 2026 -> 1, 2
--          (counting warn/fail too would give site 1 2026 = 3 and site 5 2026 = 2; not shown)

CREATE OR REPLACE VIEW v_site_richness AS
WITH effort AS (
    SELECT
        ce.project_id,
        ce.site_id,
        EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')::integer AS year,
        COUNT(DISTINCT sa.sample_id)                                   AS sample_count,
        COUNT(DISTINCT ce.event_id)                                    AS event_count
    FROM collection_events ce
    JOIN samples sa ON sa.event_id = ce.event_id
    GROUP BY ce.project_id, ce.site_id, EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')
),
detected AS (
    SELECT
        ce.project_id,
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
    GROUP BY ce.project_id, ce.site_id, EXTRACT(YEAR FROM ce.collected_at AT TIME ZONE 'UTC')
)
SELECT
    ef.project_id,
    ef.site_id,
    si.name                       AS site_name,
    ef.year,
    COALESCE(de.observed_taxa, 0) AS observed_taxa,
    ef.sample_count,
    ef.event_count
FROM effort ef
JOIN sampling_sites si ON si.site_id = ef.site_id
LEFT JOIN detected de
       ON de.project_id = ef.project_id
      AND de.site_id = ef.site_id
      AND de.year = ef.year;
