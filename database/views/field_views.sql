-- Owner: D (Docs & Demo)
-- Purpose: Registry and site-level summary views for Field & Samples.
--
-- Issue #24 / T15-D. Contract 7 fixes the view names; column lists are documented in
-- docs/slices/field.md. These are read-only, parameter-free views over the normalized tables.
--
-- Installed by backend/src/db/migrate.js after migrations, on every run. To apply by hand:
--   psql "$DATABASE_URL" -f database/views/field_views.sql
-- Re-run database/roles/grants.sql afterwards so the app role retains SELECT-only access.
-- CREATE OR REPLACE VIEW is safe to repeat, but cannot rename or remove existing columns;
-- if a column list must change later, drop the affected view first.

-- ============================================================================================
-- v_sample_registry: one row per sample, with the main collection details already joined
-- ============================================================================================
-- Used by: sample registry/list pages, sample API routes and CSV/reporting code.
-- Hides:   the joins from samples to sample_types, collection_events, sampling_sites and
--          projects. Consumers do not need to repeat those joins to show the sample type,
--          collection time, site and project alongside the sample's own fields.
-- Grain:   exactly one row per samples.sample_id. Every join below follows a many-to-one
--          foreign-key relationship, so these joins do not multiply sample rows.
-- Includes failed/discarded samples too; status is shown, not used to filter the registry.

CREATE OR REPLACE VIEW v_sample_registry AS
SELECT
    s.sample_id,
    s.sample_code,
    s.status,
    st.type_name          AS sample_type,
    ce.event_id,
    ce.site_id,
    site.name             AS site_name,
    ce.project_id,
    p.title               AS project_title,
    ce.collected_at,
    s.volume_ml,
    s.depth_m,
    s.storage_location
FROM samples s
JOIN sample_types st
    ON st.sample_type_id = s.sample_type_id
JOIN collection_events ce
    ON ce.event_id = s.event_id
JOIN sampling_sites site
    ON site.site_id = ce.site_id
JOIN projects p
    ON p.project_id = ce.project_id;

COMMENT ON VIEW v_sample_registry IS
    'One row per sample with status, type, event, site, project and collection details joined for registry pages and API consumers.';

-- ============================================================================================
-- v_site_sample_summary: one row per sampling site, including sites with no events or samples
-- ============================================================================================
-- Used by: site overview pages, dashboards and API routes that show collection activity.
-- Hides:   the one-to-many joins from a site to collection events and samples, plus the
--          status-by-status aggregation. Consumers get counts without recalculating them.
-- Grain:   exactly one row per sampling_sites.site_id.
-- Counts:  event_count counts distinct events; total_samples and each status count samples.
--          LEFT JOINs keep sites with no events/samples in the output. Status counts are zero
--          for such sites. latest_collection_date is NULL when no event has been recorded.

CREATE OR REPLACE VIEW v_site_sample_summary AS
SELECT
    site.site_id,
    site.name                                           AS site_name,
    site.region_id,
    r.name                                              AS region_name,
    site.habitat_type,
    COUNT(DISTINCT ce.event_id)                         AS event_count,
    COUNT(s.sample_id)                                  AS total_samples,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'collected') AS collected_count,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'stored')    AS stored_count,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'extracted') AS extracted_count,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'sequenced') AS sequenced_count,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'analyzed')  AS analyzed_count,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'failed')    AS failed_count,
    COUNT(s.sample_id) FILTER (WHERE s.status = 'discarded') AS discarded_count,
    MAX(ce.collected_at)                                AS latest_collection_date
FROM sampling_sites site
JOIN regions r
    ON r.region_id = site.region_id
LEFT JOIN collection_events ce
    ON ce.site_id = site.site_id
LEFT JOIN samples s
    ON s.event_id = ce.event_id
GROUP BY
    site.site_id,
    site.name,
    site.region_id,
    r.name,
    site.habitat_type;

COMMENT ON VIEW v_site_sample_summary IS
    'One row per sampling site with event count, total samples, sample counts by status and latest collection timestamp.';
