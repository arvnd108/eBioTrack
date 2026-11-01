// Owner: B (Frontend)
// Purpose: Searchable sample registry
//
// GET /api/samples (CONTRACT 10): samples in the user's projects (administrators: all), filtered
// by code prefix (`q`, case-insensitive), project, site, event and status, sorted by the API.
// Filters live in the URL, so the map and event pages can link to a filtered list. Samples are
// registered from a collection event (its page or the New event form).

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/common/Badge';
import { DataTable, type Column } from '../components/common/DataTable';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { SAMPLE_STATUSES } from '../domain';
import { useFetch } from '../hooks/useFetch';
import { useProjectIndex, useSampleTypes, useSiteIndex } from '../hooks/useLookups';
import { usePagination } from '../hooks/usePagination';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import type { PageMeta, Sample } from '../types';
import { formatDateTime, humanize } from '../utils/format';

const FILTERS = ['q', 'project_id', 'site_id', 'event_id', 'status'] as const;
const CODE_MAX = 64;

const amount = (value: number | null, unit: string) => (value === null ? '—' : `${value} ${unit}`);

export default function SamplesPage() {
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [search, setSearch] = useState(filters.q);
  const [searchError, setSearchError] = useState<string | null>(null);
  const pager = usePagination();
  const projects = useProjectIndex();
  const projectId = idParam(filters.project_id);
  const sites = useSiteIndex(projectId ? Number(projectId) : null);
  const types = useSampleTypes();
  const status = SAMPLE_STATUSES.find((s) => s === filters.status);

  const samples = useFetch<Sample[], PageMeta>('/samples', {
    q: filters.q.trim() || undefined,
    project_id: projectId,
    site_id: idParam(filters.site_id),
    event_id: idParam(filters.event_id),
    status,
    ...pager.query,
  });

  function change(key: (typeof FILTERS)[number], value: string) {
    // A site belongs to a project's list, so a new project clears the site.
    setFilters(key === 'project_id' ? { project_id: value, site_id: '' } : { [key]: value });
    pager.resetPage();
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (search.trim().length > CODE_MAX) {
      setSearchError(`A sample code has at most ${CODE_MAX} characters.`);
      return;
    }
    setSearchError(null);
    change('q', search.trim());
  }

  const columns: Column<Sample>[] = [
    {
      key: 'sample_code',
      header: 'Sample code',
      sortField: 'sample_code',
      render: (s) => (
        <Link
          to={`/samples/${s.sample_id}`}
          className="font-mono text-sm font-medium text-emerald-700 hover:underline"
        >
          {s.sample_code}
        </Link>
      ),
    },
    {
      key: 'sample_type_id',
      header: 'Type',
      render: (s) =>
        humanize(types.byId.get(s.sample_type_id)?.type_name ?? `type ${s.sample_type_id}`),
    },
    { key: 'status', header: 'Status', render: (s) => <Badge value={s.status} /> },
    {
      key: 'event_id',
      header: 'Event',
      render: (s) => (
        <Link to={`/events/${s.event_id}`} className="text-emerald-700 hover:underline">
          Event {s.event_id}
        </Link>
      ),
    },
    {
      key: 'volume_ml',
      header: 'Volume',
      align: 'right',
      render: (s) => amount(s.volume_ml, 'mL'),
    },
    { key: 'depth_m', header: 'Depth', align: 'right', render: (s) => amount(s.depth_m, 'm') },
    { key: 'storage_location', header: 'Storage' },
    {
      key: 'created_at',
      header: 'Registered',
      sortField: 'created_at',
      render: (s) => formatDateTime(s.created_at),
    },
  ];

  const anyFilter = FILTERS.some((key) => filters[key]);

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Samples</h1>
        <p className="mt-1 text-slate-600">
          Samples in your projects. New samples are registered on a collection event.
        </p>
      </div>

      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <form onSubmit={applySearch} noValidate role="search" className="flex items-end gap-2">
          <div className="flex-1">
            <FormField label="Sample code starts with" error={searchError}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="EB-2026"
                className={fieldControlClass(!!searchError)}
              />
            </FormField>
          </div>
          <button
            type="submit"
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Search
          </button>
        </form>
        <FormField label="Project">
          <select
            value={projectId ?? ''}
            onChange={(e) => change('project_id', e.target.value)}
            className={fieldControlClass()}
          >
            <option value="">All projects</option>
            {projects.list.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.title}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Site">
          <select
            value={idParam(filters.site_id) ?? ''}
            onChange={(e) => change('site_id', e.target.value)}
            className={fieldControlClass()}
          >
            <option value="">All sites</option>
            {sites.list.map((s) => (
              <option key={s.site_id} value={s.site_id}>
                {s.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Status">
          <select
            value={status ?? ''}
            onChange={(e) => change('status', e.target.value)}
            className={fieldControlClass()}
          >
            <option value="">Any status</option>
            {SAMPLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {(idParam(filters.event_id) || anyFilter) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {idParam(filters.event_id) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-slate-700">
              Event {filters.event_id}
              <button
                type="button"
                onClick={() => change('event_id', '')}
                aria-label="Show samples from every event"
                className="ml-1 text-slate-500 hover:text-slate-900"
              >
                ×
              </button>
            </span>
          )}
          {anyFilter && (
            <button
              type="button"
              onClick={() => {
                setFilters(Object.fromEntries(FILTERS.map((key) => [key, ''])));
                setSearch('');
                pager.resetPage();
              }}
              className="text-emerald-700 hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      <DataTable
        caption="Samples"
        columns={columns}
        rows={samples.data}
        rowKey={(s) => s.sample_id}
        loading={samples.status === 'loading'}
        error={samples.error}
        onRetry={samples.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={samples.meta ? { meta: samples.meta, onPageChange: pager.setPage } : null}
        emptyTitle={anyFilter ? 'No samples match these filters' : 'No samples yet'}
        emptyDescription={
          anyFilter
            ? 'Try other filters.'
            : 'Samples appear here once they are registered on a collection event.'
        }
      />
    </section>
  );
}
