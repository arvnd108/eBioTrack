// Owner: B (Frontend)
// Purpose: One taxon: lineage, lower taxa, detection frequency by site, and its detections
//
// GET /api/taxa/:id (lineage root first), GET /api/taxa?parent_taxon_id= (lower taxa),
// GET /api/analytics/detection-frequency?taxon_id= (per site: samples with a detection out of the
// analysed samples) and GET /api/taxa/:id/detections (paginated). Detections are approved
// analyses' rows with QC flag pass in the user's projects, assigned to exactly this taxon: a
// genus lists what was identified only to the genus, its species list their own.

import { Link } from 'react-router-dom';
import { Badge } from '../../components/common/Badge';
import { CaveatBanner } from '../../components/common/CaveatBanner';
import { DataTable, type Column } from '../../components/common/DataTable';
import { ErrorState } from '../../components/common/ErrorState';
import { ExportButton } from '../../components/common/ExportButton';
import { LoadingState } from '../../components/common/LoadingState';
import {
  DetectionFrequencyChart,
  detectionRate,
} from '../../components/charts/DetectionFrequencyChart';
import { useFetch } from '../../hooks/useFetch';
import { useSiteIndex } from '../../hooks/useLookups';
import { usePagination } from '../../hooks/usePagination';
import type {
  CaveatMeta,
  DetectionFrequencyRow,
  PageMeta,
  Taxon,
  TaxonDetail,
  TaxonDetection,
} from '../../types';
import { formatLocalDate } from '../../utils/format';
import { ScopeFilters, scopeQuery, type Scope } from '../analytics/ScopeFilters';

/** Genus and species names are written in italics. */
export function TaxonName({ taxon }: { taxon: Pick<Taxon, 'scientific_name' | 'rank'> }) {
  return taxon.rank === 'genus' || taxon.rank === 'species' ? (
    <i>{taxon.scientific_name}</i>
  ) : (
    <>{taxon.scientific_name}</>
  );
}

interface TaxonPanelProps {
  taxonId: number;
  scope: Scope;
  onScopeChange: (changes: Partial<Scope>) => void;
  onOpen: (taxonId: number) => void;
}

export function TaxonPanel({ taxonId, scope, onScopeChange, onOpen }: TaxonPanelProps) {
  const taxon = useFetch<TaxonDetail>(`/taxa/${taxonId}`);
  const children = useFetch<Taxon[], PageMeta>('/taxa', {
    parent_taxon_id: taxonId,
    limit: 100,
  });
  const query = scopeQuery(scope);
  const pager = usePagination({ initialSort: '-collected_at' });
  const frequency = useFetch<DetectionFrequencyRow[], CaveatMeta>(
    '/analytics/detection-frequency',
    { taxon_id: taxonId, project_id: query.project_id },
  );
  const detections = useFetch<TaxonDetection[], PageMeta>(
    query.invalid ? null : `/taxa/${taxonId}/detections`,
    {
      project_id: query.project_id,
      site_id: query.site_id,
      from: query.from,
      to: query.to,
      ...pager.query,
    },
  );
  const sites = useSiteIndex();
  const siteName = (id: number) => sites.byId.get(id)?.name ?? `Site ${id}`;

  const data = taxon.data && taxon.data.taxon_id === taxonId ? taxon.data : null;
  if (!data) {
    return taxon.error ? (
      <ErrorState error={taxon.error} title="Could not load this taxon" onRetry={taxon.reload} />
    ) : (
      <LoadingState label="Loading the taxon…" />
    );
  }

  const changeScope = (changes: Partial<Scope>) => {
    onScopeChange(changes);
    pager.resetPage();
  };
  const rows = frequency.data ?? [];
  const totals = rows.reduce(
    (sum, r) => ({ detected: sum.detected + r.detections, total: sum.total + r.samples_total }),
    { detected: 0, total: 0 },
  );
  const lower = (children.data ?? []).filter((c) => c.parent_taxon_id === taxonId);

  const columns: Column<TaxonDetection>[] = [
    {
      key: 'collected_at',
      header: 'Collected',
      sortField: 'collected_at',
      render: (d) => <span className="whitespace-nowrap">{formatLocalDate(d.collected_at)}</span>,
    },
    {
      key: 'sample_code',
      header: 'Sample',
      render: (d) => (
        <Link
          to={`/samples/${d.sample_id}`}
          className="whitespace-nowrap font-mono text-sm text-emerald-700 hover:underline"
        >
          {d.sample_code}
        </Link>
      ),
    },
    { key: 'site_name', header: 'Site' },
    { key: 'analysis_id', header: 'Analysis', render: (d) => `#${d.analysis_id}` },
    {
      key: 'read_count',
      header: 'Reads',
      align: 'right',
      render: (d) => d.read_count.toLocaleString(),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      align: 'right',
      render: (d) => d.confidence.toFixed(4),
    },
  ];

  return (
    <section aria-labelledby="taxon-heading" className="min-w-0 space-y-5">
      <div className="space-y-2">
        <nav aria-label="Lineage" className="text-sm text-slate-600">
          <ol className="flex flex-wrap items-center gap-1">
            {data.lineage.map((t, i) => (
              <li key={t.taxon_id} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true">›</span>}
                {t.taxon_id === data.taxon_id ? (
                  <span aria-current="page" className="font-medium text-slate-900">
                    <TaxonName taxon={t} />
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(t.taxon_id)}
                    className="text-emerald-700 hover:underline"
                    title={t.rank}
                  >
                    <TaxonName taxon={t} />
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="taxon-heading" className="text-xl font-semibold text-slate-900">
            <TaxonName taxon={data} />
          </h2>
          <Badge value={data.rank} tone="purple" />
          {data.external_id && (
            <span className="text-sm text-slate-600">External ID {data.external_id}</span>
          )}
        </div>
        {lower.length > 0 && (
          <div role="group" aria-label="Lower taxa" className="text-sm">
            <span className="text-slate-600">Lower taxa: </span>
            {lower.map((c, i) => (
              <span key={c.taxon_id}>
                {i > 0 && ', '}
                <button
                  type="button"
                  onClick={() => onOpen(c.taxon_id)}
                  className="text-emerald-700 hover:underline"
                >
                  <TaxonName taxon={c} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <CaveatBanner
        caveat={frequency.meta?.caveat}
        notes={[
          'Only detections assigned to exactly this taxon are listed; detections of its lower taxa are on their own pages.',
          'Read counts depend on the sample and the pipeline; they are not a measure of how many animals were there.',
        ]}
      />

      <ScopeFilters scope={scope} onChange={changeScope} />

      <section aria-labelledby="frequency-heading" className="space-y-2">
        <div>
          <h3 id="frequency-heading" className="text-base font-semibold">
            Detection frequency by site
          </h3>
          <p className="text-sm text-slate-600">
            In how many analysed samples of each site it was detected
            {totals.total > 0 &&
              ` (${totals.detected} of ${totals.total} analysed samples overall)`}
            . Uses the project filter only.
          </p>
        </div>
        {frequency.error ? (
          <ErrorState
            error={frequency.error}
            title="Could not load the detection frequency"
            onRetry={frequency.reload}
          />
        ) : frequency.status === 'loading' && !frequency.data ? (
          <LoadingState label="Loading the detection frequency…" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">No samples in these projects yet.</p>
        ) : (
          <div className="space-y-3">
            <DetectionFrequencyChart rows={rows} siteName={siteName} />
            <FrequencyTable rows={rows} siteName={siteName} />
          </div>
        )}
      </section>

      <section aria-labelledby="detections-heading" className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id="detections-heading" className="text-base font-semibold">
              Detections
            </h3>
            <p className="text-sm text-slate-600">
              Approved detections with QC flag pass in your projects, newest first.
            </p>
          </div>
          <ExportButton
            request={
              query.project_id && !query.invalid
                ? {
                    export_type: 'detections_csv',
                    project_id: Number(query.project_id),
                    filters: {
                      taxon_id: taxonId,
                      ...(query.site_id ? { site_id: Number(query.site_id) } : {}),
                      ...(query.from ? { from: query.from } : {}),
                      ...(query.to ? { to: query.to } : {}),
                    },
                  }
                : null
            }
          />
        </div>
        <DataTable
          caption={`Detections of ${data.scientific_name}`}
          columns={columns}
          rows={detections.data}
          rowKey={(d) => `${d.analysis_id}-${d.sample_code}-${d.read_count}-${d.collected_at}`}
          loading={detections.status === 'loading'}
          error={detections.error}
          onRetry={detections.reload}
          sort={pager.sort}
          onSortChange={(sort) => pager.setSort(sort ?? 'collected_at')}
          pagination={
            detections.meta ? { meta: detections.meta, onPageChange: pager.setPage } : null
          }
          emptyTitle="No approved detections"
          emptyDescription={
            data.rank === 'species'
              ? 'Not detected in an approved analysis with these filters. Non-detection does not mean the species is absent.'
              : `Nothing was identified only to this ${data.rank}. Its lower taxa may have detections.`
          }
        />
      </section>
    </section>
  );
}

function FrequencyTable({
  rows,
  siteName,
}: {
  rows: readonly DetectionFrequencyRow[];
  siteName: (id: number) => string;
}) {
  return (
    <div className="max-w-2xl overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">Detection frequency by site</caption>
        <thead className="bg-slate-50 text-left text-slate-700">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Site
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Detected in
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Analysed samples
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Share
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => {
            const rate = detectionRate(r);
            return (
              <tr key={r.site_id}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {siteName(r.site_id)}
                </th>
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
    </div>
  );
}
