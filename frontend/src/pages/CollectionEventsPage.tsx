// Owner: B (Frontend)
// Purpose: Field event forms and measurements
//
// GET /api/events (CONTRACT 10): events in the user's projects, newest first unless sorted,
// filtered by project, site and collection day (days are the user's local days, sent as
// instants). Filters live in the URL so the map can link to a site's events. "New event" is for
// create_event_sample (administrator, principal investigator, field researcher); the form offers
// only the projects where the user may record events.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Can } from '../components/common/Can';
import { DataTable, type Column } from '../components/common/DataTable';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { useFetch } from '../hooks/useFetch';
import { useProjectIndex, useSiteIndex, useUserNames } from '../hooks/useLookups';
import { usePagination } from '../hooks/usePagination';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import { dayEnd, dayStart } from '../services/auditService';
import type { CollectionEvent, PageMeta } from '../types';
import { formatDateTime } from '../utils/format';
import { CreateEventForm } from './events/CreateEventForm';

const FILTERS = ['project_id', 'site_id', 'from', 'to'] as const;
const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

export default function CollectionEventsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [creating, setCreating] = useState(false);
  const pager = usePagination();
  const projects = useProjectIndex();
  const projectId = idParam(filters.project_id);
  const sites = useSiteIndex(projectId ? Number(projectId) : null);
  const allSites = useSiteIndex();
  const nameOf = useUserNames();
  const from = isDay(filters.from) ? filters.from : '';
  const to = isDay(filters.to) ? filters.to : '';
  const rangeError =
    from && to && from > to ? 'The "from" day must not be after the "to" day.' : null;

  const events = useFetch<CollectionEvent[], PageMeta>(rangeError ? null : '/events', {
    project_id: projectId,
    site_id: idParam(filters.site_id),
    from: from ? dayStart(from) : undefined,
    to: to ? dayEnd(to) : undefined,
    ...pager.query,
  });

  function change(key: (typeof FILTERS)[number], value: string) {
    setFilters(key === 'project_id' ? { project_id: value, site_id: '' } : { [key]: value });
    pager.resetPage();
  }

  const columns: Column<CollectionEvent>[] = [
    {
      key: 'collected_at',
      header: 'Collected',
      sortField: 'collected_at',
      render: (e) => (
        <Link to={`/events/${e.event_id}`} className="font-medium text-emerald-700 hover:underline">
          {formatDateTime(e.collected_at)}
        </Link>
      ),
    },
    { key: 'event_id', header: 'Event', sortField: 'event_id', render: (e) => `#${e.event_id}` },
    {
      key: 'project_id',
      header: 'Project',
      render: (e) => projects.byId.get(e.project_id)?.title ?? `Project ${e.project_id}`,
    },
    {
      key: 'site_id',
      header: 'Site',
      render: (e) => allSites.byId.get(e.site_id)?.name ?? `Site ${e.site_id}`,
    },
    {
      key: 'collector_id',
      header: 'Collector',
      render: (e) => nameOf(e.collector_id, e.collector_name),
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (e) =>
        e.notes ? <span className="line-clamp-2 max-w-xs text-slate-700">{e.notes}</span> : '—',
    },
  ];

  const anyFilter = FILTERS.some((key) => filters[key]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Collection events</h1>
          <p className="mt-1 text-slate-600">
            Field visits in your projects, with their measurements and samples.
          </p>
        </div>
        <Can action="create_event_sample">
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              New event
            </button>
          )}
        </Can>
      </div>

      {creating && (
        <CreateEventForm
          projects={projects.list}
          onCancel={() => setCreating(false)}
          onCreated={(event) => navigate(`/events/${event.event_id}`)}
        />
      )}

      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <FormField label="From day" error={rangeError}>
          <input
            type="date"
            value={from}
            onChange={(e) => change('from', e.target.value)}
            className={fieldControlClass(!!rangeError)}
          />
        </FormField>
        <FormField label="To day">
          <input
            type="date"
            value={to}
            onChange={(e) => change('to', e.target.value)}
            className={fieldControlClass()}
          />
        </FormField>
      </div>
      {anyFilter && (
        <button
          type="button"
          onClick={() => {
            setFilters({ project_id: '', site_id: '', from: '', to: '' });
            pager.resetPage();
          }}
          className="text-sm text-emerald-700 hover:underline"
        >
          Clear all filters
        </button>
      )}

      {!rangeError && (
        <DataTable
          caption="Collection events"
          columns={columns}
          rows={events.data}
          rowKey={(e) => e.event_id}
          loading={events.status === 'loading'}
          error={events.error}
          onRetry={events.reload}
          sort={pager.sort}
          onSortChange={pager.setSort}
          pagination={events.meta ? { meta: events.meta, onPageChange: pager.setPage } : null}
          emptyTitle={anyFilter ? 'No events match these filters' : 'No collection events yet'}
          emptyDescription={anyFilter ? 'Try other filters.' : undefined}
        />
      )}
    </section>
  );
}
