// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: richness, detection frequency, dashboard
//
// The governing rule (CONTRACT 10): only analyses with status `approved` and assignments with
// qc_flag `pass` count. Every query below applies both predicates itself (or reads
// v_approved_detections); draft, imported, rejected and superseded analyses and warn/fail rows can
// never change a number. All dates are UTC. Results are limited to the caller's projects.
//
// Definitions (not all are pinned by the contract; B and C should read these):
//  - observed_taxa: distinct SPECIES (rank species) with at least one approved + pass detection in
//    the group.
//  - rows: one per (group, site), site_id always present (CONTRACT 10 example, B's mock).
//  - sample_count: distinct samples collected in the group at the site, including samples with no
//    detection (sampling effort); the same definition as v_site_richness.
//  - detection-frequency: per site, `detections` = distinct samples with an approved + pass
//    detection of the taxon, `samples_total` = distinct samples of that site that have such an
//    approved analysis (the denominator of a detection rate). Sites with at least one sample are
//    listed, with 0 when nothing was detected.
//  - dashboard: projects = accessible projects; sites = distinct sites attached to them
//    (administrator without a filter: every site); samples = samples of events in those projects;
//    approved_detections = rows of v_approved_detections in those projects.
import { query, queryOne } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { accessibleProjectIds } from '../middleware/authorize.js';
import { recentActivity } from './audit.service.js';
import { assertProjectAccess } from './projectAccess.js';

export const EDNA_CAVEAT =
  'Detection does not indicate abundance; non-detection does not indicate absence.';

/** The projects a read may cover: the one asked for (checked), else all the caller's (null = all). */
export async function scopeProjects(user, projectId) {
  if (projectId !== undefined) {
    await assertProjectAccess(user, projectId);
    return [projectId];
  }
  return accessibleProjectIds(user);
}

const GROUP_EXPRESSION = {
  year: "to_char(ce.collected_at AT TIME ZONE 'UTC', 'YYYY')",
  month: "to_char(ce.collected_at AT TIME ZONE 'UTC', 'YYYY-MM')",
  site: 'si.name',
};

// A sample is "analysed" when a library of it sits on a run that has an approved analysis.
const ANALYSED = `EXISTS (
  SELECT 1 FROM dna_extractions x
    JOIN sequencing_libraries l ON l.extraction_id = x.extraction_id
    JOIN analysis_runs a ON a.run_id = l.run_id AND a.status = 'approved'
   WHERE x.sample_id = s.sample_id)`;

/**
 * Richness rows, shared by the analytics route and the richness export.
 * @param {{ projectIds: number[] | null, siteId?: number, groupBy: 'year'|'month'|'site', from?: string, to?: string }} options
 * @returns {Promise<{ group: string, site_id: number, observed_taxa: number, sample_count: number }[]>}
 */
export async function queryRichness({ projectIds, siteId, groupBy, from, to }) {
  const expression = GROUP_EXPRESSION[groupBy];
  if (!expression) throw new TypeError(`invalid group_by: ${groupBy}`);
  const rows = await query(
    `WITH ev AS (
       SELECT ce.event_id, ce.site_id, ${expression} AS grp
         FROM collection_events ce
         JOIN sampling_sites si ON si.site_id = ce.site_id
        WHERE ($1::bigint[] IS NULL OR ce.project_id = ANY($1::bigint[]))
          AND ($2::bigint IS NULL OR ce.site_id = $2::bigint)
          AND ($3::timestamptz IS NULL OR ce.collected_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR ce.collected_at <= $4::timestamptz)
     ),
     effort AS (
       SELECT ev.grp, ev.site_id AS site_id, count(DISTINCT s.sample_id) AS sample_count
         FROM ev JOIN samples s ON s.event_id = ev.event_id
        GROUP BY 1, 2
     ),
     detected AS (
       SELECT ev.grp, ev.site_id AS site_id, count(DISTINCT ta.taxon_id) AS observed_taxa
         FROM ev
         JOIN samples s ON s.event_id = ev.event_id
         JOIN dna_extractions x ON x.sample_id = s.sample_id
         JOIN sequencing_libraries l ON l.extraction_id = x.extraction_id
         JOIN taxon_assignments ta ON ta.library_id = l.library_id
         JOIN analysis_runs a ON a.analysis_id = ta.analysis_id AND a.status = 'approved'
         JOIN taxa t ON t.taxon_id = ta.taxon_id AND t.rank = 'species'
        WHERE ta.qc_flag = 'pass'
        GROUP BY 1, 2
     )
     SELECT e.grp AS "group", e.site_id, COALESCE(d.observed_taxa, 0)::int AS observed_taxa,
            e.sample_count::int AS sample_count
       FROM effort e
       LEFT JOIN detected d ON d.grp = e.grp AND d.site_id = e.site_id
      ORDER BY e.grp, e.site_id`,
    [projectIds, siteId ?? null, from ?? null, to ?? null],
  );
  return rows;
}

export async function richness(user, filters) {
  const projectIds = await scopeProjects(user, filters.project_id);
  return queryRichness({
    projectIds,
    siteId: filters.site_id,
    groupBy: filters.group_by,
    from: filters.from,
    to: filters.to,
  });
}

export async function detectionFrequency(user, filters) {
  if (!(await queryOne('SELECT 1 AS ok FROM taxa WHERE taxon_id = $1', [filters.taxon_id]))) {
    throw new AppError(404, 'not_found', 'Taxon not found');
  }
  const projectIds = await scopeProjects(user, filters.project_id);
  return query(
    `SELECT ce.site_id,
            count(DISTINCT s.sample_id) FILTER (WHERE EXISTS (
              SELECT 1 FROM dna_extractions x
                JOIN sequencing_libraries l ON l.extraction_id = x.extraction_id
                JOIN taxon_assignments ta ON ta.library_id = l.library_id AND ta.taxon_id = $2::bigint
                JOIN analysis_runs a ON a.analysis_id = ta.analysis_id AND a.status = 'approved'
               WHERE x.sample_id = s.sample_id AND ta.qc_flag = 'pass'))::int AS detections,
            count(DISTINCT s.sample_id) FILTER (WHERE ${ANALYSED})::int AS samples_total
       FROM samples s
       JOIN collection_events ce ON ce.event_id = s.event_id
      WHERE ($1::bigint[] IS NULL OR ce.project_id = ANY($1::bigint[]))
      GROUP BY ce.site_id
      ORDER BY ce.site_id`,
    [projectIds, filters.taxon_id],
  );
}

export async function dashboardSummary(user, filters) {
  const projectIds = await scopeProjects(user, filters.project_id);
  const [projects, sites, samples, detections, activity] = await Promise.all([
    queryOne(
      'SELECT count(*)::int AS n FROM projects WHERE ($1::bigint[] IS NULL OR project_id = ANY($1::bigint[]))',
      [projectIds],
    ),
    projectIds === null
      ? queryOne('SELECT count(*)::int AS n FROM sampling_sites')
      : queryOne(
          'SELECT count(DISTINCT site_id)::int AS n FROM project_sites WHERE project_id = ANY($1::bigint[])',
          [projectIds],
        ),
    queryOne(
      `SELECT count(*)::int AS n FROM samples s JOIN collection_events e ON e.event_id = s.event_id
        WHERE ($1::bigint[] IS NULL OR e.project_id = ANY($1::bigint[]))`,
      [projectIds],
    ),
    queryOne(
      'SELECT count(*)::int AS n FROM v_approved_detections d WHERE ($1::bigint[] IS NULL OR d.project_id = ANY($1::bigint[]))',
      [projectIds],
    ),
    recentActivity(user, { limit: 5, projectId: filters.project_id }),
  ]);
  return {
    projects: projects.n,
    sites: sites.n,
    samples: samples.n,
    approved_detections: detections.n,
    recent_activity: activity,
  };
}
