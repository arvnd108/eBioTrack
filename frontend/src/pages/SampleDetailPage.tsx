// Owner: B (Frontend)
// Purpose: Sample detail and status timeline
//
// GET /api/samples/:id (CONTRACT 10/11): the sample with its event, site, DNA extractions and
// status history. A sample in a project the user is not in is a 404, worded like a missing one.
// The status control appears for change_sample_status in the sample's project (its role comes
// from GET /api/projects/:id).

import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '../components/common/Badge';
import { DataTable } from '../components/common/DataTable';
import { ErrorState } from '../components/common/ErrorState';
import { LoadingState } from '../components/common/LoadingState';
import { useAuth } from '../hooks/useAuth';
import { useFetch } from '../hooks/useFetch';
import { useUserNames } from '../hooks/useLookups';
import type { ProjectDetail, SampleDetail } from '../types';
import { formatDateTime, humanize } from '../utils/format';
import { StatusChangeForm } from './samples/StatusChangeForm';
import { StatusTimeline } from './samples/StatusTimeline';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

const backLink = (
  <Link to="/samples" className="text-sm text-emerald-700 hover:underline">
    ← All samples
  </Link>
);

export default function SampleDetailPage() {
  const { sampleId } = useParams();
  const { can } = useAuth();
  const nameOf = useUserNames();
  const validId = /^[1-9]\d{0,14}$/.test(sampleId ?? '');
  const sample = useFetch<SampleDetail>(validId ? `/samples/${sampleId}` : null);
  const projectId = sample.data?.event.project_id;
  const project = useFetch<ProjectDetail>(projectId ? `/projects/${projectId}` : null);

  if (!validId) {
    return (
      <section className="space-y-3">
        {backLink}
        <h1 className="text-2xl font-semibold">Sample not found</h1>
      </section>
    );
  }
  if (!sample.data) {
    return sample.error ? (
      <section className="space-y-3">
        {backLink}
        <ErrorState
          error={sample.error}
          title="Could not open this sample"
          onRetry={sample.reload}
        />
      </section>
    ) : (
      <LoadingState label="Loading sample…" />
    );
  }

  const s = sample.data;
  // Wait for the project before deciding, so the control never flashes for a project viewer.
  const canChange = project.data ? can('change_sample_status', project.data.your_role) : false;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        {backLink}
        <h1 className="font-mono text-2xl font-semibold text-slate-900">{s.sample_code}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <Badge value={s.status} />
          {humanize(s.sample_type)} sample
        </p>
      </div>

      {sample.error ? (
        <ErrorState
          error={sample.error}
          title="Could not refresh this sample"
          onRetry={sample.reload}
        />
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Volume">{s.volume_ml === null ? '—' : `${s.volume_ml} mL`}</Fact>
        <Fact label="Depth">{s.depth_m === null ? '—' : `${s.depth_m} m`}</Fact>
        <Fact label="Collected">{formatDateTime(s.event.collected_at)}</Fact>
        <Fact label="Event">
          <Link to={`/events/${s.event.event_id}`} className="text-emerald-700 hover:underline">
            Event {s.event.event_id}
          </Link>
        </Fact>
        <Fact label="Site">
          <Link to={`/map?site_id=${s.site.site_id}`} className="text-emerald-700 hover:underline">
            {s.site.name}
          </Link>
        </Fact>
        <Fact label="Project">
          <Link to={`/projects/${s.event.project_id}`} className="text-emerald-700 hover:underline">
            {project.data?.title ?? `Project ${s.event.project_id}`}
          </Link>
        </Fact>
      </dl>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="history-heading" className="space-y-3">
          <h2 id="history-heading" className="text-lg font-semibold">
            Status history
          </h2>
          {canChange && (
            <StatusChangeForm sampleId={s.sample_id} status={s.status} onChanged={sample.reload} />
          )}
          <StatusTimeline history={s.status_history} nameOf={nameOf} />
        </section>

        <section aria-labelledby="extractions-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="extractions-heading" className="text-lg font-semibold">
              DNA extractions
            </h2>
            <span className="flex gap-3 text-sm">
              <Link
                to={`/lab?sample_id=${s.sample_id}`}
                className="text-emerald-700 hover:underline"
              >
                Extractions in Lab processing
              </Link>
              <Link
                to={`/lab?tab=qc&sample_id=${s.sample_id}`}
                className="text-emerald-700 hover:underline"
              >
                QC results
              </Link>
            </span>
          </div>
          <DataTable
            caption="DNA extractions"
            columns={[
              { key: 'extraction_id', header: 'Extraction' },
              { key: 'attempt_number', header: 'Attempt', align: 'right' },
              {
                key: 'qc_status',
                header: 'QC status',
                render: (x) => <Badge value={x.qc_status} />,
              },
            ]}
            rows={s.extractions}
            rowKey={(x) => x.extraction_id}
            emptyTitle="No extractions yet"
            emptyDescription="Lab technicians record extractions on the Lab processing page."
          />
        </section>
      </div>
    </section>
  );
}
