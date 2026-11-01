// Owner: B (Frontend)
// Purpose: Richness and detection charts with caveats
//
// GET /api/analytics/richness: observed species per year, month or site, one row per group and
// site, with the number of samples collected there (sampling effort, samples without a detection
// included). GET /api/analytics/detection-frequency: for one species, in how many analysed
// samples of each site it was detected. Both count only approved analyses and QC-passed
// detections in the user's projects, and carry the caveat shown in the banner. Filters live in
// the URL; the richness table can be downloaded as CSV for one project (POST /api/exports).

import { CaveatBanner } from '../components/common/CaveatBanner';
import { ErrorState } from '../components/common/ErrorState';
import { ExportButton } from '../components/common/ExportButton';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { LoadingState } from '../components/common/LoadingState';
import {
  DetectionFrequencyChart,
  detectionRate,
} from '../components/charts/DetectionFrequencyChart';
import { RichnessChart, richnessChartFits } from '../components/charts/RichnessChart';
import { useFetch } from '../hooks/useFetch';
import { useSiteIndex } from '../hooks/useLookups';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import { GROUP_BYS, type GroupBy } from '../services/analyticsService';
import type { CaveatMeta, DetectionFrequencyRow, PageMeta, RichnessRow, Taxon } from '../types';
import { SCOPE_KEYS, ScopeFilters, scopeQuery, type Scope } from './analytics/ScopeFilters';
import { TaxonName } from './species/TaxonPanel';

const KEYS = [...SCOPE_KEYS, 'group_by', 'taxon_id'] as const;
const GROUP_LABEL: Record<GroupBy, string> = { year: 'Year', month: 'Month', site: 'Site' };

/** "2 samples" at every site, or "1–5 samples per site and year". */
export function effortNote(rows: readonly RichnessRow[], groupBy: GroupBy): string | null {
  if (rows.length === 0) return null;
  const counts = rows.map((r) => r.sample_count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const per = groupBy === 'site' ? 'per site' : `per site and ${groupBy}`;
  return min === max
    ? `Sampling effort is even: ${min} sample${min === 1 ? '' : 's'} ${per}.`
    : `Sampling effort differs: ${min} to ${max} samples ${per}. More samples usually find more species, so compare with care.`;
}

function Th({ children, right = false }: { children: string; right?: boolean }) {
  return (
    <th scope="col" className={`px-3 py-2 font-medium ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

export default function BiodiversityAnalyticsPage() {
  const [filters, setFilters] = useQueryFilters(KEYS);
  const groupBy: GroupBy = GROUP_BYS.find((g) => g === filters.group_by) ?? 'year';
  const scope: Scope = {
    project_id: filters.project_id,
    site_id: filters.site_id,
    from: filters.from,
    to: filters.to,
  };
  const query = scopeQuery(scope);
  const richness = useFetch<RichnessRow[], CaveatMeta>(
    query.invalid ? null : '/analytics/richness',
    {
      project_id: query.project_id,
      site_id: query.site_id,
      from: query.from,
      to: query.to,
      group_by: groupBy,
    },
  );
  const species = useFetch<Taxon[], PageMeta>('/taxa', { rank: 'species', limit: 100 });
  const taxonId = idParam(filters.taxon_id);
  const frequency = useFetch<DetectionFrequencyRow[], CaveatMeta>(
    taxonId ? '/analytics/detection-frequency' : null,
    { taxon_id: taxonId, project_id: query.project_id },
  );
  const sites = useSiteIndex();
  const siteName = (id: number) => sites.byId.get(id)?.name ?? `Site ${id}`;
  const sitesById = [...sites.list].sort((a, b) => a.site_id - b.site_id);

  const rows = richness.data ?? [];
  const effort = effortNote(rows, groupBy);
  const chosen = (species.data ?? []).find((t) => String(t.taxon_id) === taxonId) ?? null;
  const freqRows = frequency.data ?? [];

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Biodiversity analytics</h1>
        <p className="mt-1 max-w-3xl text-slate-600">
          How many species were detected where and when, and how often one species turns up, from
          approved analyses of your projects.
        </p>
      </div>

      <CaveatBanner
        caveat={richness.meta?.caveat ?? frequency.meta?.caveat}
        notes={[
          'Observed species counts distinct species (rank species) detected in a group; detections identified only to a genus or higher are not counted.',
          ...(effort ? [effort] : []),
        ]}
      />

      <ScopeFilters scope={scope} onChange={(changes) => setFilters(changes)}>
        <div className="w-36">
          <FormField label="Group by">
            <select
              value={groupBy}
              onChange={(e) =>
                setFilters({ group_by: e.target.value === 'year' ? '' : e.target.value })
              }
              className={fieldControlClass()}
            >
              {GROUP_BYS.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </ScopeFilters>

      <section aria-labelledby="richness-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="richness-heading" className="text-lg font-semibold">
              Observed species richness
            </h2>
            <p className="text-sm text-slate-600">
              Per {groupBy === 'site' ? 'site' : `${groupBy} and site`}. Counts of different groups
              or sites cannot be added up: the same species can be in several.
            </p>
          </div>
          <ExportButton
            label="Download richness CSV"
            request={
              query.project_id && !query.invalid
                ? {
                    export_type: 'richness_csv',
                    project_id: Number(query.project_id),
                    filters: {
                      group_by: groupBy,
                      ...(query.site_id ? { site_id: Number(query.site_id) } : {}),
                      ...(query.from ? { from: query.from } : {}),
                      ...(query.to ? { to: query.to } : {}),
                    },
                  }
                : null
            }
          />
        </div>
        {query.invalid ? null : richness.error ? (
          <ErrorState
            error={richness.error}
            title="Could not load richness"
            onRetry={richness.reload}
          />
        ) : richness.status === 'loading' && !richness.data ? (
          <LoadingState label="Loading richness…" />
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
            No samples were collected with these filters.
          </p>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {richnessChartFits(rows, groupBy === 'site') ? (
              <RichnessChart rows={rows} bySite={groupBy === 'site'} sites={sitesById} />
            ) : (
              <p className="text-sm text-slate-600">
                Too many sites to tell apart in one chart; choose a project or a site, or read the
                table.
              </p>
            )}
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <caption className="sr-only">Observed species richness</caption>
                <thead className="bg-slate-50 text-slate-700">
                  <tr>
                    <Th>{GROUP_LABEL[groupBy]}</Th>
                    {groupBy !== 'site' && <Th>Site</Th>}
                    <Th right>Observed species</Th>
                    <Th right>Samples</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={`${r.group}-${r.site_id}`}>
                      <td className="px-3 py-2">{r.group}</td>
                      {groupBy !== 'site' && <td className="px-3 py-2">{siteName(r.site_id)}</td>}
                      <td className="px-3 py-2 text-right tabular-nums">{r.observed_taxa}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.sample_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="frequency-heading" className="space-y-3">
        <div>
          <h2 id="frequency-heading" className="text-lg font-semibold">
            Detection frequency
          </h2>
          <p className="text-sm text-slate-600">
            In how many analysed samples of each site one species was detected. Uses the project
            filter only.
          </p>
        </div>
        <div className="w-72">
          <FormField label="Species">
            <select
              value={taxonId ?? ''}
              onChange={(e) => setFilters({ taxon_id: e.target.value })}
              className={fieldControlClass()}
            >
              <option value="">Choose a species…</option>
              {(species.data ?? []).map((t) => (
                <option key={t.taxon_id} value={t.taxon_id}>
                  {t.scientific_name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {!taxonId ? (
          <p className="text-sm text-slate-600">Choose a species to see its detection frequency.</p>
        ) : frequency.error ? (
          <ErrorState
            error={frequency.error}
            title="Could not load the detection frequency"
            onRetry={frequency.reload}
          />
        ) : frequency.status === 'loading' && !frequency.data ? (
          <LoadingState label="Loading the detection frequency…" />
        ) : freqRows.length === 0 ? (
          <p className="text-sm text-slate-600">No samples in these projects yet.</p>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <DetectionFrequencyChart rows={freqRows} siteName={siteName} />
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <caption className="sr-only">
                  Detection frequency of {chosen?.scientific_name ?? 'the species'} by site
                </caption>
                <thead className="bg-slate-50 text-slate-700">
                  <tr>
                    <Th>Site</Th>
                    <Th right>Detected in</Th>
                    <Th right>Analysed samples</Th>
                    <Th right>Share</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {freqRows.map((r) => {
                    const rate = detectionRate(r);
                    return (
                      <tr key={r.site_id}>
                        <td className="px-3 py-2">{siteName(r.site_id)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.detections}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.samples_total}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {rate === null ? 'Not analysed' : `${rate}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {chosen && (
                <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                  <TaxonName taxon={chosen} /> not detected at a site does not mean it is absent
                  there.
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
