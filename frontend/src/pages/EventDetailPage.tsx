// Owner: B (Frontend)
// Purpose: One collection event: details, measurements and samples (GET /api/events/:id)
//
// An event in a project the user is not in is a 404, worded like a missing one. "Add sample" is
// for create_event_sample in the event's project (its role comes from GET /api/projects/:id).

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '../components/common/Badge';
import { DataTable } from '../components/common/DataTable';
import { ErrorState } from '../components/common/ErrorState';
import { LoadingState } from '../components/common/LoadingState';
import { STANDARD_PARAMETERS } from '../domain';
import { useAuth } from '../hooks/useAuth';
import { useFetch } from '../hooks/useFetch';
import { useSampleTypes, useUserNames } from '../hooks/useLookups';
import type { CollectionEventDetail, ProjectDetail, Site } from '../types';
import { formatDateTime, humanize } from '../utils/format';
import { AddSampleForm } from './events/AddSampleForm';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

const backLink = (
  <Link to="/events" className="text-sm text-emerald-700 hover:underline">
    ← All events
  </Link>
);

const parameterLabel = (parameter: string) =>
  STANDARD_PARAMETERS.find((p) => p.parameter === parameter)?.label ?? parameter;

export default function EventDetailPage() {
  const { eventId } = useParams();
  const { can } = useAuth();
  const nameOf = useUserNames();
  const types = useSampleTypes();
  const [added, setAdded] = useState<string | null>(null);
  const validId = /^[1-9]\d{0,14}$/.test(eventId ?? '');
  const event = useFetch<CollectionEventDetail>(validId ? `/events/${eventId}` : null);
  const project = useFetch<ProjectDetail>(event.data ? `/projects/${event.data.project_id}` : null);
  const site = useFetch<Site>(event.data ? `/sites/${event.data.site_id}` : null);

  if (!validId) {
    return (
      <section className="space-y-3">
        {backLink}
        <h1 className="text-2xl font-semibold">Event not found</h1>
      </section>
    );
  }
  if (!event.data) {
    return event.error ? (
      <section className="space-y-3">
        {backLink}
        <ErrorState error={event.error} title="Could not open this event" onRetry={event.reload} />
      </section>
    ) : (
      <LoadingState label="Loading event…" />
    );
  }

  const e = event.data;
  const canAdd = project.data ? can('create_event_sample', project.data.your_role) : false;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        {backLink}
        <h1 className="text-2xl font-semibold text-slate-900">
          Event {e.event_id}: {site.data?.name ?? `site ${e.site_id}`}
        </h1>
        <p className="text-sm text-slate-600">Collected {formatDateTime(e.collected_at)}</p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Project">
          <Link to={`/projects/${e.project_id}`} className="text-emerald-700 hover:underline">
            {project.data?.title ?? `Project ${e.project_id}`}
          </Link>
        </Fact>
        <Fact label="Site">
          <Link to={`/map?site_id=${e.site_id}`} className="text-emerald-700 hover:underline">
            {site.data?.name ?? `Site ${e.site_id}`}
          </Link>
        </Fact>
        <Fact label="Collector">{nameOf(e.collector_id)}</Fact>
        <Fact label="Recorded">{formatDateTime(e.created_at)}</Fact>
      </dl>
      <p className="whitespace-pre-line text-slate-700">{e.notes || 'No notes.'}</p>

      <section aria-labelledby="measurements-heading" className="space-y-3">
        <h2 id="measurements-heading" className="text-lg font-semibold">
          Environmental measurements
        </h2>
        <DataTable
          caption="Environmental measurements"
          columns={[
            { key: 'parameter', header: 'Parameter', render: (m) => parameterLabel(m.parameter) },
            { key: 'value', header: 'Value', align: 'right' },
            { key: 'unit', header: 'Unit' },
          ]}
          rows={e.measurements}
          rowKey={(m) => m.measurement_id}
          emptyTitle="No measurements recorded"
        />
      </section>

      <section aria-labelledby="samples-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="samples-heading" className="text-lg font-semibold">
            Samples <span className="text-sm font-normal text-slate-500">({e.samples.length})</span>
          </h2>
          <Link
            to={`/samples?event_id=${e.event_id}`}
            className="text-sm text-emerald-700 hover:underline"
          >
            Open in the sample registry
          </Link>
        </div>
        {added && (
          <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
            Registered sample {added}.
          </p>
        )}
        <DataTable
          caption="Samples"
          columns={[
            {
              key: 'sample_code',
              header: 'Sample code',
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
              key: 'volume_ml',
              header: 'Volume',
              align: 'right',
              render: (s) => (s.volume_ml === null ? '—' : `${s.volume_ml} mL`),
            },
            {
              key: 'depth_m',
              header: 'Depth',
              align: 'right',
              render: (s) => (s.depth_m === null ? '—' : `${s.depth_m} m`),
            },
            { key: 'storage_location', header: 'Storage' },
          ]}
          rows={e.samples}
          rowKey={(s) => s.sample_id}
          emptyTitle="No samples on this event"
        />
        {canAdd && (
          <AddSampleForm
            eventId={e.event_id}
            onAdded={(code) => {
              setAdded(code);
              event.reload();
            }}
          />
        )}
      </section>
    </section>
  );
}
