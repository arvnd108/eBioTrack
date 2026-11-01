// Owner: B (Frontend)
// Purpose: Upload CSV, preview errors, validate, commit
//
// The analyses workspace for principal investigators, analysts and administrators (the route is
// guarded by create_analysis, like the sidebar link). GET /api/analyses lists the analyses of
// the caller's projects in every status; choosing one (?analysis_id=, so a link can open it)
// shows its details and its next step (AnalysisPanel): import a CSV into a draft with a dry run
// first, approve or reject an imported one, or start a correction of an approved one.
// Filters live in the URL (?status&run_id&marker_id).

import { useMemo, useState } from 'react';
import { Badge } from '../components/common/Badge';
import { DataTable, type Column } from '../components/common/DataTable';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { ANALYSIS_STATUSES } from '../domain';
import { useAnalysisAccess } from '../hooks/useAnalysisAccess';
import { useFetch } from '../hooks/useFetch';
import { useUserNames } from '../hooks/useLookups';
import { usePagination } from '../hooks/usePagination';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import type { AnalysisRun, DnaMarker, PageMeta, SequencingRun } from '../types';
import { formatLocalDate, humanize } from '../utils/format';
import { AnalysisPanel } from './analyses/AnalysisPanel';
import { NewAnalysisForm, type CorrectionOf } from './analyses/NewAnalysisForm';

const FILTERS = ['status', 'run_id', 'marker_id', 'analysis_id'] as const;

/** What the selected analysis waits for, in a few words for the list. */
function waitingFor(a: AnalysisRun): string {
  switch (a.status) {
    case 'draft':
      return 'Needs its CSV';
    case 'imported':
      return 'Needs approval';
    default:
      return '';
  }
}

export default function AnalysisImportPage() {
  const access = useAnalysisAccess();
  const names = useUserNames();
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [form, setForm] = useState<{ correctionOf: CorrectionOf | null } | null>(null);
  const pager = usePagination({ initialSort: '-analysis_id' });
  const status = ANALYSIS_STATUSES.find((s) => s === filters.status);
  const analyses = useFetch<AnalysisRun[], PageMeta>('/analyses', {
    status,
    run_id: idParam(filters.run_id),
    marker_id: idParam(filters.marker_id),
    ...pager.query,
  });
  // Every analysis the user can see (up to 100), to find which one corrects another.
  const all = useFetch<AnalysisRun[], PageMeta>('/analyses', { limit: 100 });
  const runs = useFetch<SequencingRun[], PageMeta>('/sequencing-runs', {
    limit: 100,
    sort: 'run_id',
  });
  const markers = useFetch<DnaMarker[]>('/markers');
  const selected = idParam(filters.analysis_id);

  const open = (id: number) => {
    setForm(null);
    setFilters({ analysis_id: String(id) });
  };
  const reloadLists = () => {
    analyses.reload();
    all.reload();
  };

  const columns: Column<AnalysisRun>[] = useMemo(
    () => [
      {
        key: 'analysis_id',
        header: 'ID',
        sortField: 'analysis_id',
        render: (a) => (
          <button
            type="button"
            onClick={() => open(a.analysis_id)}
            aria-label={`Open analysis ${a.analysis_id}`}
            className="font-medium text-emerald-700 hover:underline"
          >
            #{a.analysis_id}
          </button>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        render: (a) => (
          <span className="flex flex-col items-start gap-0.5">
            <Badge value={a.status} />
            {waitingFor(a) && <span className="text-xs text-slate-500">{waitingFor(a)}</span>}
            {a.supersedes_analysis_id !== null && (
              <span className="whitespace-nowrap text-xs text-slate-500">
                Corrects #{a.supersedes_analysis_id}
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'run_code',
        header: 'Run',
        render: (a) => <span className="whitespace-nowrap">{a.run_code}</span>,
      },
      { key: 'marker_name', header: 'Marker' },
      {
        key: 'pipeline_name',
        header: 'Pipeline and reference',
        render: (a) => (
          <span>
            <span className="whitespace-nowrap">
              {a.pipeline_name} {a.pipeline_version}
            </span>
            <span className="block text-xs text-slate-500">
              {a.reference_db}
              {a.reference_db_version ? ` ${a.reference_db_version}` : ''}
            </span>
          </span>
        ),
      },
      {
        key: 'imported_by',
        header: 'Imported by',
        render: (a) => (a.imported_by === null ? '—' : names(a.imported_by, a.imported_by_name)),
      },
      {
        key: 'decided',
        header: 'Decided by',
        render: (a) =>
          a.approved_by !== null
            ? names(a.approved_by, a.approved_by_name)
            : a.rejection
              ? names(a.rejection.rejected_by, a.rejection.rejected_by_name)
              : '—',
      },
      {
        key: 'created_at',
        header: 'Created',
        sortField: 'created_at',
        render: (a) => <span className="whitespace-nowrap">{formatLocalDate(a.created_at)}</span>,
      },
    ],
    // `open` only calls URL and state setters, which never change.
    [names],
  );

  const anyFilter = (['status', 'run_id', 'marker_id'] as const).some((key) => filters[key]);
  const filter = (key: 'status' | 'run_id' | 'marker_id') => (value: string) => {
    setFilters({ [key]: value });
    pager.resetPage();
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Analysis import</h1>
          <p className="mt-1 max-w-3xl text-slate-600">
            Bring bioinformatics results in: create an analysis for a sequencing run, check its
            detections CSV and import it, then a principal investigator who did not import it
            approves or rejects it. Only approved detections with QC flag pass are counted anywhere.
          </p>
        </div>
        {access.canCreate && !form && (
          <button
            type="button"
            onClick={() => setForm({ correctionOf: null })}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            New analysis
          </button>
        )}
      </div>

      {form && (
        <NewAnalysisForm
          key={form.correctionOf?.analysis_id ?? 'new'}
          correctionOf={form.correctionOf}
          onCancel={() => setForm(null)}
          onCreated={(created) => {
            reloadLists();
            open(created.analysis_id);
          }}
        />
      )}

      {selected && !form && (
        <AnalysisPanel
          key={selected}
          analysisId={Number(selected)}
          known={all.data ?? []}
          onOpen={open}
          onChanged={reloadLists}
          onCorrect={(a) => setForm({ correctionOf: a })}
          onClose={() => setFilters({ analysis_id: '' })}
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <FormField label="Status">
            <select
              value={status ?? ''}
              onChange={(e) => filter('status')(e.target.value)}
              className={fieldControlClass()}
            >
              <option value="">Any</option>
              {ANALYSIS_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-44">
          <FormField label="Run">
            <select
              value={idParam(filters.run_id) ?? ''}
              onChange={(e) => filter('run_id')(e.target.value)}
              className={fieldControlClass()}
            >
              <option value="">All runs</option>
              {(runs.data ?? []).map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_code}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-44">
          <FormField label="Marker">
            <select
              value={idParam(filters.marker_id) ?? ''}
              onChange={(e) => filter('marker_id')(e.target.value)}
              className={fieldControlClass()}
            >
              <option value="">All markers</option>
              {(markers.data ?? []).map((m) => (
                <option key={m.marker_id} value={m.marker_id}>
                  {m.marker_name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </div>

      <DataTable
        caption="Analyses"
        columns={columns}
        rows={analyses.data}
        rowKey={(a) => a.analysis_id}
        loading={analyses.status === 'loading'}
        error={analyses.error}
        onRetry={analyses.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={analyses.meta ? { meta: analyses.meta, onPageChange: pager.setPage } : null}
        emptyTitle={anyFilter ? 'No analyses match these filters' : 'No analyses yet'}
        emptyDescription={
          anyFilter ? undefined : 'Create an analysis for a completed sequencing run to start.'
        }
      />
    </section>
  );
}
