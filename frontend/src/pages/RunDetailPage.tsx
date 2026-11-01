// Owner: B (Frontend)
// Purpose: One sequencing run: libraries with their source samples, add a library, move its status
//
// GET /api/sequencing-runs/:id. A run belongs to the projects of its libraries' samples: a
// non-administrator sees it when one library is in their projects, and sees only those
// libraries. Changing it (record_lab) needs a non-viewer membership in one of those projects
// (administrators always). Libraries can be added while the run is planned; the status follows
// planned -> running -> completed, or failed from planned or running (CONTRACT section 3).

import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '../components/common/Badge';
import { DataTable } from '../components/common/DataTable';
import { ErrorState } from '../components/common/ErrorState';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { LoadingState } from '../components/common/LoadingState';
import { RUN_TRANSITIONS } from '../domain';
import { useAuth } from '../hooks/useAuth';
import { useFetch } from '../hooks/useFetch';
import { useLabAccess } from '../hooks/useLabAccess';
import { useLabs } from '../hooks/useLookups';
import { useSubmit } from '../hooks/useSubmit';
import { isApiError } from '../services/apiClient';
import { errorMessage } from '../services/errorMessages';
import { addLibrary, changeRunStatus } from '../services/labService';
import type { RunStatus, SequencingRunDetail } from '../types';
import { formatDate, formatDateTime } from '../utils/format';
import { bookingBlock, usePassedExtractions } from './lab/RunsSection';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

const backLink = (
  <Link to="/lab?tab=runs" className="text-sm text-emerald-700 hover:underline">
    ← All runs
  </Link>
);

/** Button text for each target status. */
const ACTION: Record<RunStatus, string> = {
  planned: 'Plan',
  running: 'Start run',
  completed: 'Mark completed',
  failed: 'Mark failed',
};

function StatusActions({ run, onChanged }: { run: SequencingRunDetail; onChanged: () => void }) {
  const [asking, setAsking] = useState<RunStatus | null>(null);
  const save = useSubmit(async (status: RunStatus) => {
    try {
      return await changeRunStatus(run.run_id, status);
    } catch (err) {
      // 409: the run moved since the page loaded; show where it is now.
      if (isApiError(err) && err.code === 'invalid_transition') onChanged();
      throw err;
    }
  });
  const options = RUN_TRANSITIONS[run.status];
  if (options.length === 0) {
    return (
      <div className="space-y-2">
        {save.error ? <ErrorState error={save.error} title="Could not change the status" /> : null}
        <p className="text-sm text-slate-600">This run is {run.status}; its status is final.</p>
      </div>
    );
  }
  const base = 'rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {options.map((status) =>
          asking === status ? (
            <span key={status} className="inline-flex items-center gap-2">
              <button
                type="button"
                autoFocus
                disabled={save.submitting}
                onClick={async () => {
                  setAsking(null);
                  if (await save.run(status)) onChanged();
                }}
                className={`${base} bg-red-700 text-white`}
              >
                Confirm: mark failed
              </button>
              <button
                type="button"
                onClick={() => setAsking(null)}
                className={`${base} text-slate-600`}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              key={status}
              type="button"
              disabled={save.submitting}
              onClick={async () => {
                // Failing a run cannot be undone: ask once more.
                if (status === 'failed') return setAsking(status);
                if (await save.run(status)) onChanged();
              }}
              className={
                status === 'failed'
                  ? `${base} border border-red-200 text-red-700 hover:bg-red-50`
                  : `${base} bg-emerald-700 text-white hover:bg-emerald-800`
              }
            >
              {ACTION[status]}
            </button>
          ),
        )}
      </div>
      {run.status === 'planned' && (
        <p className="text-xs text-slate-500">
          Starting the run closes it to new libraries. Completed and failed are final.
        </p>
      )}
      {save.error ? (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </div>
  );
}

function AddLibraryForm({
  run,
  onAdded,
}: {
  run: SequencingRunDetail;
  onAdded: (code: string) => void;
}) {
  const lab = useLabAccess();
  const extractions = usePassedExtractions();
  const [extractionId, setExtractionId] = useState('');
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const save = useSubmit(addLibrary);
  const choices = (extractions.data ?? []).filter((x) => !bookingBlock(x, lab.canWrite));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!extractionId) {
      setChoiceError('Choose an extraction.');
      return;
    }
    setChoiceError(null);
    const library = await save.run(run.run_id, Number(extractionId));
    extractions.reload();
    if (library) {
      setExtractionId('');
      onAdded(library.library_code);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Add library"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="min-w-72 flex-1">
        <FormField
          label="Extraction"
          error={choiceError}
          hint="Extractions that passed QC and are not on another planned or running run."
          required
        >
          <select
            value={extractionId}
            onChange={(e) => {
              setExtractionId(e.target.value);
              setChoiceError(null);
              save.reset();
            }}
            className={fieldControlClass(!!choiceError)}
          >
            <option value="">{choices.length ? 'Choose an extraction…' : 'None available'}</option>
            {choices.map((x) => (
              <option key={x.extraction_id} value={x.extraction_id}>
                #{x.extraction_id}: {x.sample_code}, attempt {x.attempt_number}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <button
        type="submit"
        disabled={save.submitting}
        className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {save.submitting ? 'Adding…' : 'Add library'}
      </button>
      {save.error ? (
        <p role="alert" className="w-full rounded-md bg-red-50 p-2 text-sm text-red-700">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </form>
  );
}

export default function RunDetailPage() {
  const { runId } = useParams();
  const { hasRole } = useAuth();
  const lab = useLabAccess();
  const labs = useLabs();
  const [added, setAdded] = useState<string | null>(null);
  const validId = /^[1-9]\d{0,14}$/.test(runId ?? '');
  const run = useFetch<SequencingRunDetail>(validId ? `/sequencing-runs/${runId}` : null);

  if (!validId) {
    return (
      <section className="space-y-3">
        {backLink}
        <h1 className="text-2xl font-semibold">Run not found</h1>
      </section>
    );
  }
  if (!run.data) {
    return run.error ? (
      <section className="space-y-3">
        {backLink}
        <ErrorState error={run.error} title="Could not open this run" onRetry={run.reload} />
      </section>
    ) : (
      <LoadingState label="Loading run…" />
    );
  }

  const r = run.data;
  const isAdmin = hasRole('administrator');
  // services/sequencing.service.js: a writer in one of the run's projects (its libraries' projects).
  const canChange = isAdmin || r.libraries.some((l) => lab.canWrite(l.project_id));
  const projectTitle = (id: number) => lab.projects.byId.get(id)?.title ?? `Project ${id}`;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        {backLink}
        <h1 className="text-2xl font-semibold text-slate-900">{r.run_code}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <Badge value={r.status} />
          {r.platform}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Lab">{labs.byId.get(r.lab_id)?.name ?? `Lab ${r.lab_id}`}</Fact>
        <Fact label="Run date">{formatDate(r.run_date)}</Fact>
        <Fact label="Created">{formatDateTime(r.created_at)}</Fact>
        <Fact label="Libraries">{r.libraries.length}</Fact>
      </dl>

      {canChange && (
        <section aria-labelledby="status-heading" className="space-y-2">
          <h2 id="status-heading" className="text-lg font-semibold">
            Status
          </h2>
          <StatusActions run={r} onChanged={run.reload} />
        </section>
      )}

      <section aria-labelledby="libraries-heading" className="space-y-3">
        <h2 id="libraries-heading" className="text-lg font-semibold">
          Libraries and source samples
        </h2>
        {!isAdmin && (
          <p className="text-sm text-slate-600">
            Only libraries from your own projects are listed.
          </p>
        )}
        {added && (
          <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
            Added library {added}.
          </p>
        )}
        <DataTable
          caption="Libraries"
          columns={[
            { key: 'library_code', header: 'Library' },
            {
              key: 'sample_code',
              header: 'Sample',
              render: (l) => (
                <Link
                  to={`/samples/${l.sample_id}`}
                  className="whitespace-nowrap font-mono text-sm text-emerald-700 hover:underline"
                >
                  {l.sample_code}
                </Link>
              ),
            },
            { key: 'extraction_id', header: 'Extraction', render: (l) => `#${l.extraction_id}` },
            { key: 'project_id', header: 'Project', render: (l) => projectTitle(l.project_id) },
            { key: 'created_at', header: 'Added', render: (l) => formatDateTime(l.created_at) },
          ]}
          rows={r.libraries}
          rowKey={(l) => l.library_id}
          emptyTitle="No libraries"
        />
        {canChange && r.status === 'planned' && (
          <AddLibraryForm
            run={r}
            onAdded={(code) => {
              setAdded(code);
              run.reload();
            }}
          />
        )}
      </section>
    </section>
  );
}
