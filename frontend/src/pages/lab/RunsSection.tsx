// Owner: B (Frontend)
// Purpose: Sequencing runs: list, filter, and create a run from selected extractions
//
// GET /api/sequencing-runs shows runs with at least one library in the user's projects
// (administrators: all). A new run (POST /api/sequencing-runs) is planned, gets RUN-<id> and one
// library (LIB-<id>) per chosen extraction, all or nothing. The picker offers QC-passed
// extractions the user may write and marks the ones already booked on a planned or running run
// (the booking rule allows one), so the database's 422 only happens if someone else books first.

import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../../components/common/Badge';
import { DataTable, type Column } from '../../components/common/DataTable';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { LoadingState } from '../../components/common/LoadingState';
import { RUN_STATUSES } from '../../domain';
import { useFetch } from '../../hooks/useFetch';
import { useLabAccess } from '../../hooks/useLabAccess';
import { useLabs } from '../../hooks/useLookups';
import { usePagination } from '../../hooks/usePagination';
import { idParam, useQueryFilters } from '../../hooks/useQueryFilters';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createRun } from '../../services/labService';
import type { DnaExtraction, PageMeta, SequencingRun } from '../../types';
import { formatDate, formatDateTime, humanize, todayLocal } from '../../utils/format';
import { isCalendarDate } from '../projects/projectRules';
import { MAX_EXTRACTIONS_PER_RUN, PLATFORMS, PLATFORM_MAX } from './labRules';

const FILTERS = ['lab_id', 'status'] as const;
const FIELDS = ['lab_id', 'platform', 'run_date', 'extraction_ids'] as const;
type Field = (typeof FIELDS)[number];

/** QC-passed extractions, newest first, for choosing libraries (up to 100, the API's page). */
export function usePassedExtractions() {
  return useFetch<DnaExtraction[], PageMeta>('/extractions', {
    qc_status: 'pass',
    limit: 100,
    sort: '-extraction_id',
  });
}

/** Why an extraction cannot be booked now, or null when it can. */
export function bookingBlock(
  x: DnaExtraction,
  canWrite: (projectId: number) => boolean,
): string | null {
  if (x.active_run_code) return `On ${x.active_run_code}`;
  if (!canWrite(x.project_id)) return 'Not your project to change';
  return null;
}

function NewRunForm({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const lab = useLabAccess();
  const labs = useLabs();
  const extractions = usePassedExtractions();
  const [labId, setLabId] = useState('');
  const [platform, setPlatform] = useState('');
  const [runDate, setRunDate] = useState(todayLocal());
  const [chosen, setChosen] = useState<number[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const save = useSubmit(createRun);
  const projectTitle = (id: number) => lab.projects.byId.get(id)?.title ?? `Project ${id}`;
  const rows = extractions.data ?? [];
  const bookable = rows.filter((x) => !bookingBlock(x, lab.canWrite));

  function toggle(id: number) {
    setChosen((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
    setErrors(({ extraction_ids: _cleared, ...rest }) => rest);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    if (!labId) found.lab_id = 'Choose the lab.';
    const name = platform.trim();
    if (!name) found.platform = 'Enter the sequencing platform.';
    else if (name.length > PLATFORM_MAX) found.platform = `At most ${PLATFORM_MAX} characters.`;
    if (!runDate) found.run_date = 'Enter the run date.';
    else if (!isCalendarDate(runDate)) found.run_date = 'Enter a real date.';
    if (chosen.length === 0) found.extraction_ids = 'Choose at least one extraction.';
    else if (chosen.length > MAX_EXTRACTIONS_PER_RUN) {
      found.extraction_ids = `At most ${MAX_EXTRACTIONS_PER_RUN} extractions in one run.`;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const run = await save.run({
      lab_id: Number(labId),
      platform: name,
      run_date: runDate,
      extraction_ids: [...chosen].sort((a, b) => a - b),
    });
    if (run) {
      navigate(`/lab/runs/${run.run_id}`);
      return;
    }
    extractions.reload(); // a 422 may mean someone booked one first: show the current bookings
  }

  const server = save.error ? formErrors(save.error, FIELDS) : { fieldErrors: {}, formError: null };
  const fieldError = (field: Field) => errors[field] ?? server.fieldErrors[field];
  const edit = (field: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors(({ [field]: _cleared, ...rest }) => rest);
  };

  const columns: Column<DnaExtraction>[] = [
    {
      key: 'choose',
      header: <span className="sr-only">Choose</span>,
      render: (x) => {
        const block = bookingBlock(x, lab.canWrite);
        return (
          <input
            type="checkbox"
            aria-label={`Choose extraction ${x.extraction_id} (${x.sample_code})`}
            checked={chosen.includes(x.extraction_id)}
            disabled={!!block}
            onChange={() => toggle(x.extraction_id)}
          />
        );
      },
    },
    { key: 'extraction_id', header: 'Extraction', render: (x) => `#${x.extraction_id}` },
    {
      key: 'sample_code',
      header: 'Sample',
      render: (x) => <span className="whitespace-nowrap font-mono text-sm">{x.sample_code}</span>,
    },
    { key: 'attempt_number', header: 'Attempt', align: 'right' },
    {
      key: 'concentration_ng_ul',
      header: 'ng/µL',
      align: 'right',
      render: (x) => (x.concentration_ng_ul === null ? '—' : String(x.concentration_ng_ul)),
    },
    { key: 'project_id', header: 'Project', render: (x) => projectTitle(x.project_id) },
    {
      key: 'available',
      header: 'Available',
      render: (x) => bookingBlock(x, lab.canWrite) ?? <span className="text-emerald-700">Yes</span>,
    },
  ];

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="New sequencing run"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h3 className="text-base font-semibold">New sequencing run</h3>
        <p className="text-sm text-slate-600">
          The run starts as Planned with one library per extraction. Only extractions that passed QC
          can be sequenced, and each can be on one planned or running run at a time.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Lab" error={fieldError('lab_id')} required>
          <select
            value={labId}
            onChange={(e) => edit('lab_id', setLabId)(e.target.value)}
            className={fieldControlClass(!!fieldError('lab_id'))}
          >
            <option value="">Choose a lab…</option>
            {labs.list.map((l) => (
              <option key={l.lab_id} value={l.lab_id}>
                {l.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Platform" error={fieldError('platform')} required>
          <input
            list="sequencing-platforms"
            value={platform}
            onChange={(e) => edit('platform', setPlatform)(e.target.value)}
            placeholder="Illumina MiSeq"
            className={fieldControlClass(!!fieldError('platform'))}
          />
        </FormField>
        <datalist id="sequencing-platforms">
          {PLATFORMS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <FormField label="Run date" error={fieldError('run_date')} required>
          <input
            type="date"
            value={runDate}
            onChange={(e) => edit('run_date', setRunDate)(e.target.value)}
            className={fieldControlClass(!!fieldError('run_date'))}
          />
        </FormField>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-slate-800">
          Extractions{' '}
          <span className="font-normal text-slate-500">
            ({chosen.length} chosen, {bookable.length} available)
          </span>
        </legend>
        {fieldError('extraction_ids') && (
          <p className="text-sm text-red-700">{fieldError('extraction_ids')}</p>
        )}
        {extractions.status === 'loading' && !extractions.data ? (
          <LoadingState label="Loading extractions…" />
        ) : (
          <DataTable
            caption="Extractions that passed QC"
            columns={columns}
            rows={rows}
            rowKey={(x) => x.extraction_id}
            error={extractions.error}
            onRetry={extractions.reload}
            emptyTitle="No extraction has passed QC yet"
            emptyDescription="Record an extraction and mark it as passed on the Extractions tab."
          />
        )}
      </fieldset>

      {server.formError && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {server.formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.submitting}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Creating…' : 'Create run'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RunsSection() {
  const lab = useLabAccess();
  const labs = useLabs();
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [creating, setCreating] = useState(false);
  const pager = usePagination({ initialSort: '-run_id' });
  const status = RUN_STATUSES.find((s) => s === filters.status);
  const runs = useFetch<SequencingRun[], PageMeta>('/sequencing-runs', {
    lab_id: idParam(filters.lab_id),
    status,
    ...pager.query,
  });

  const columns: Column<SequencingRun>[] = useMemo(
    () => [
      {
        key: 'run_code',
        header: 'Run',
        sortField: 'run_id',
        render: (r) => (
          <Link
            to={`/lab/runs/${r.run_id}`}
            className="font-medium text-emerald-700 hover:underline"
          >
            {r.run_code}
          </Link>
        ),
      },
      { key: 'status', header: 'Status', render: (r) => <Badge value={r.status} /> },
      { key: 'platform', header: 'Platform' },
      {
        key: 'lab_id',
        header: 'Lab',
        render: (r) => labs.byId.get(r.lab_id)?.name ?? `Lab ${r.lab_id}`,
      },
      { key: 'run_date', header: 'Run date', render: (r) => formatDate(r.run_date) },
      {
        key: 'created_at',
        header: 'Created',
        sortField: 'created_at',
        render: (r) => formatDateTime(r.created_at),
      },
    ],
    [labs.byId],
  );

  const anyFilter = FILTERS.some((key) => filters[key]);

  return (
    <section aria-labelledby="runs-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runs-heading" className="text-lg font-semibold">
            Sequencing runs
          </h2>
          <p className="text-sm text-slate-600">Planned → Running → Completed, or Failed.</p>
        </div>
        {lab.any && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            New run
          </button>
        )}
      </div>
      {creating && <NewRunForm onCancel={() => setCreating(false)} />}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <FormField label="Lab">
            <select
              value={idParam(filters.lab_id) ?? ''}
              onChange={(e) => {
                setFilters({ lab_id: e.target.value });
                pager.resetPage();
              }}
              className={fieldControlClass()}
            >
              <option value="">All labs</option>
              {labs.list.map((l) => (
                <option key={l.lab_id} value={l.lab_id}>
                  {l.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-48">
          <FormField label="Status">
            <select
              value={status ?? ''}
              onChange={(e) => {
                setFilters({ status: e.target.value });
                pager.resetPage();
              }}
              className={fieldControlClass()}
            >
              <option value="">Any</option>
              {RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </div>
      <DataTable
        caption="Sequencing runs"
        columns={columns}
        rows={runs.data}
        rowKey={(r) => r.run_id}
        loading={runs.status === 'loading'}
        error={runs.error}
        onRetry={runs.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={runs.meta ? { meta: runs.meta, onPageChange: pager.setPage } : null}
        emptyTitle={anyFilter ? 'No runs match these filters' : 'No sequencing runs yet'}
      />
    </section>
  );
}
