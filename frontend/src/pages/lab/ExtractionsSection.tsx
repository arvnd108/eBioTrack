// Owner: B (Frontend)
// Purpose: DNA extractions: list with QC status, record one, decide its QC verdict, edit measurements
//
// GET /api/extractions shows extractions in the user's projects (administrators: all). Writes
// (record_lab) are offered only where the user may write: each row carries its project_id.
// Database rules the page explains up front:
//   - the attempt number is the sample's next one; a stored sample becomes extracted;
//   - a failed or discarded sample cannot be extracted (422);
//   - the QC verdict is decided once, pending -> pass or fail (409 after that); a wrong verdict
//     is fixed by recording a new attempt. Measurements stay editable.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/common/Badge';
import { DataTable, type Column } from '../../components/common/DataTable';
import { ErrorState } from '../../components/common/ErrorState';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { QC_STATUSES } from '../../domain';
import { useFetch } from '../../hooks/useFetch';
import { useLabAccess } from '../../hooks/useLabAccess';
import { usePagination } from '../../hooks/usePagination';
import { idParam, useQueryFilters } from '../../hooks/useQueryFilters';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createExtraction, updateExtraction } from '../../services/labService';
import type { DnaExtraction, ExtractionBatch, PageMeta, Sample } from '../../types';
import { formatDate, formatDateTime, formatLocalDate, humanize } from '../../utils/format';
import { BatchesSection } from './BatchesSection';
import { CONCENTRATION_MAX, PURITY_MAX, checkMeasurement } from './labRules';

const FILTERS = ['batch_id', 'qc_status', 'sample_id'] as const;
const FIELDS = ['sample_id', 'batch_id', 'concentration_ng_ul', 'purity_a260_280'] as const;
type Field = (typeof FIELDS)[number] | 'project';

const measure = (value: number | null, unit = '') => (value === null ? '—' : `${value}${unit}`);

/** Samples of a project that can still be extracted (not failed or discarded). */
function useExtractableSamples(projectId: string) {
  const samples = useFetch<Sample[], PageMeta>(projectId ? '/samples' : null, {
    project_id: projectId,
    limit: 100,
    sort: 'sample_code',
  });
  return (samples.data ?? []).filter((s) => s.status !== 'failed' && s.status !== 'discarded');
}

function RecordExtractionForm({
  onSaved,
  onCancel,
}: {
  onSaved: (x: DnaExtraction) => void;
  onCancel: () => void;
}) {
  const lab = useLabAccess();
  const only = lab.writableProjects.length === 1 ? String(lab.writableProjects[0].project_id) : '';
  const [projectId, setProjectId] = useState(only);
  const [sampleId, setSampleId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [concentration, setConcentration] = useState('');
  const [purity, setPurity] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const samples = useExtractableSamples(projectId || only);
  const batches = useFetch<ExtractionBatch[], PageMeta>('/extraction-batches', {
    limit: 100,
    sort: '-extraction_date',
  });
  const save = useSubmit(createExtraction);
  const project = projectId || only;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    if (!project) found.project = 'Choose the project.';
    if (!sampleId) found.sample_id = 'Choose the sample.';
    if (!batchId) found.batch_id = 'Choose the batch.';
    const c = checkMeasurement(concentration, CONCENTRATION_MAX);
    const p = checkMeasurement(purity, PURITY_MAX);
    if (c.error) found.concentration_ng_ul = c.error;
    if (p.error) found.purity_a260_280 = p.error;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const saved = await save.run({
      sample_id: Number(sampleId),
      batch_id: Number(batchId),
      concentration_ng_ul: c.value,
      purity_a260_280: p.value,
    });
    if (saved) onSaved(saved);
  }

  const server = save.error ? formErrors(save.error, FIELDS) : { fieldErrors: {}, formError: null };
  const serverErrors: Partial<Record<Field, string>> = server.fieldErrors;
  const fieldError = (field: Field) => errors[field] ?? serverErrors[field];
  const edit = (field: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors(({ [field]: _cleared, ...rest }) => rest);
    save.reset();
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Record extraction"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h3 className="text-base font-semibold">Record an extraction</h3>
        <p className="text-sm text-slate-600">
          The attempt number is assigned for you. A stored sample becomes Extracted. Decide the QC
          verdict in the table once the measurements are in.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label="Project" error={fieldError('project')} required>
          <select
            value={project}
            onChange={(e) => {
              edit('project', setProjectId)(e.target.value);
              setSampleId('');
            }}
            className={fieldControlClass(!!fieldError('project'))}
          >
            <option value="">Choose a project…</option>
            {lab.writableProjects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.title}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Sample"
          error={fieldError('sample_id')}
          hint={
            project && samples.length === 0
              ? 'No sample in this project can be extracted.'
              : undefined
          }
          required
        >
          <select
            value={sampleId}
            onChange={(e) => edit('sample_id', setSampleId)(e.target.value)}
            disabled={!project}
            className={fieldControlClass(!!fieldError('sample_id'))}
          >
            <option value="">{project ? 'Choose a sample…' : 'Choose a project first'}</option>
            {samples.map((s) => (
              <option key={s.sample_id} value={s.sample_id}>
                {s.sample_code} ({humanize(s.status)})
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Batch" error={fieldError('batch_id')} required>
          <select
            value={batchId}
            onChange={(e) => edit('batch_id', setBatchId)(e.target.value)}
            className={fieldControlClass(!!fieldError('batch_id'))}
          >
            <option value="">Choose a batch…</option>
            {(batches.data ?? []).map((b) => (
              <option key={b.batch_id} value={b.batch_id}>
                #{b.batch_id}, {formatDate(b.extraction_date)}
                {b.kit_name ? `, ${b.kit_name}` : ''}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Concentration (ng/µL)"
          error={fieldError('concentration_ng_ul')}
          hint="Optional."
        >
          <input
            inputMode="decimal"
            value={concentration}
            onChange={(e) => edit('concentration_ng_ul', setConcentration)(e.target.value)}
            className={fieldControlClass(!!fieldError('concentration_ng_ul'))}
          />
        </FormField>
        <FormField label="Purity (A260/280)" error={fieldError('purity_a260_280')} hint="Optional.">
          <input
            inputMode="decimal"
            value={purity}
            onChange={(e) => edit('purity_a260_280', setPurity)(e.target.value)}
            className={fieldControlClass(!!fieldError('purity_a260_280'))}
          />
        </FormField>
      </div>
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
          {save.submitting ? 'Saving…' : 'Record extraction'}
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

/** Pass / Fail with a second click, because the verdict is final. */
function VerdictButtons({
  extraction,
  onDecide,
  busy,
}: {
  extraction: DnaExtraction;
  onDecide: (verdict: 'pass' | 'fail') => void;
  busy: boolean;
}) {
  const [asking, setAsking] = useState<'pass' | 'fail' | null>(null);
  const base = 'rounded-md px-2.5 py-1 text-sm font-medium disabled:opacity-50';
  if (asking) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          title="The QC verdict is final"
          onClick={() => {
            setAsking(null);
            onDecide(asking);
          }}
          className={`${base} ${asking === 'pass' ? 'bg-emerald-700' : 'bg-red-700'} text-white`}
        >
          {asking === 'pass' ? 'Confirm pass' : 'Confirm fail'}
        </button>
        <button type="button" onClick={() => setAsking(null)} className={`${base} text-slate-600`}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => setAsking('pass')}
        aria-label={`Mark extraction ${extraction.extraction_id} as passed QC`}
        className={`${base} border border-emerald-300 text-emerald-800 hover:bg-emerald-50`}
      >
        Pass
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setAsking('fail')}
        aria-label={`Mark extraction ${extraction.extraction_id} as failed QC`}
        className={`${base} border border-red-200 text-red-700 hover:bg-red-50`}
      >
        Fail
      </button>
    </span>
  );
}

function MeasurementsForm({
  extraction,
  onSaved,
  onCancel,
}: {
  extraction: DnaExtraction;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const text = (value: number | null) => (value === null ? '' : String(value));
  const [concentration, setConcentration] = useState(text(extraction.concentration_ng_ul));
  const [purity, setPurity] = useState(text(extraction.purity_a260_280));
  const [errors, setErrors] = useState<{ concentration?: string; purity?: string }>({});
  const [note, setNote] = useState<string | null>(null);
  const save = useSubmit(updateExtraction);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote(null);
    const c = checkMeasurement(concentration, CONCENTRATION_MAX);
    const p = checkMeasurement(purity, PURITY_MAX);
    setErrors({ concentration: c.error, purity: p.error });
    if (c.error || p.error) return;
    const changes: { concentration_ng_ul?: number | null; purity_a260_280?: number | null } = {};
    if (c.value !== extraction.concentration_ng_ul) changes.concentration_ng_ul = c.value;
    if (p.value !== extraction.purity_a260_280) changes.purity_a260_280 = p.value;
    if (Object.keys(changes).length === 0) {
      setNote('Nothing has changed.');
      return;
    }
    if (await save.run(extraction.extraction_id, changes)) onSaved();
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={`Edit measurements of extraction ${extraction.extraction_id}`}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <p className="w-full text-sm font-semibold">
        Measurements of extraction #{extraction.extraction_id} ({extraction.sample_code}, attempt{' '}
        {extraction.attempt_number})
      </p>
      <div className="w-48">
        <FormField label="Concentration (ng/µL)" error={errors.concentration}>
          <input
            inputMode="decimal"
            value={concentration}
            onChange={(e) => setConcentration(e.target.value)}
            className={fieldControlClass(!!errors.concentration)}
          />
        </FormField>
      </div>
      <div className="w-48">
        <FormField label="Purity (A260/280)" error={errors.purity}>
          <input
            inputMode="decimal"
            value={purity}
            onChange={(e) => setPurity(e.target.value)}
            className={fieldControlClass(!!errors.purity)}
          />
        </FormField>
      </div>
      <button
        type="submit"
        disabled={save.submitting}
        className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {save.submitting ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
      >
        Cancel
      </button>
      <p className="w-full text-xs text-slate-500">Leave a box empty to clear the value.</p>
      {note && (
        <p role="status" className="w-full text-sm text-slate-600">
          {note}
        </p>
      )}
      {save.error ? (
        <ErrorState error={save.error} title="Could not save the measurements" />
      ) : null}
    </form>
  );
}

export function ExtractionsSection() {
  const lab = useLabAccess();
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<DnaExtraction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pager = usePagination({ initialSort: '-extraction_id' });
  const qc = QC_STATUSES.find((s) => s === filters.qc_status);
  const extractions = useFetch<DnaExtraction[], PageMeta>('/extractions', {
    batch_id: idParam(filters.batch_id),
    sample_id: idParam(filters.sample_id),
    qc_status: qc,
    ...pager.query,
  });
  const batches = useFetch<ExtractionBatch[], PageMeta>('/extraction-batches', {
    limit: 100,
    sort: '-extraction_date',
  });
  const decide = useSubmit(updateExtraction);

  async function setVerdict(x: DnaExtraction, verdict: 'pass' | 'fail') {
    setMessage(null);
    const saved = await decide.run(x.extraction_id, { qc_status: verdict });
    if (saved) {
      setMessage(
        `Extraction #${saved.extraction_id} (${saved.sample_code}) ${
          verdict === 'pass' ? 'passed QC and can now be sequenced' : 'failed QC'
        }.`,
      );
    }
    extractions.reload(); // also after a 409: show the verdict someone else recorded
  }

  const columns: Column<DnaExtraction>[] = [
    {
      key: 'extraction_id',
      header: 'ID',
      sortField: 'extraction_id',
      render: (x) => `#${x.extraction_id}`,
    },
    {
      key: 'sample_code',
      header: 'Sample',
      render: (x) => (
        <>
          <Link
            to={`/samples/${x.sample_id}`}
            className="whitespace-nowrap font-mono text-sm text-emerald-700 hover:underline"
          >
            {x.sample_code}
          </Link>
          <span className="block text-xs text-slate-500">attempt {x.attempt_number}</span>
        </>
      ),
    },
    { key: 'batch_id', header: 'Batch', render: (x) => `#${x.batch_id}` },
    {
      key: 'concentration_ng_ul',
      header: <span className="whitespace-nowrap">ng/µL</span>,
      align: 'right',
      render: (x) => measure(x.concentration_ng_ul),
    },
    {
      key: 'purity_a260_280',
      header: 'A260/280',
      align: 'right',
      render: (x) => measure(x.purity_a260_280),
    },
    {
      key: 'qc_status',
      header: 'QC',
      render: (x) => (
        <>
          <Badge value={x.qc_status} />
          {x.active_run_id && (
            <span className="block whitespace-nowrap text-xs text-slate-600">
              on{' '}
              <Link
                to={`/lab/runs/${x.active_run_id}`}
                className="text-emerald-700 hover:underline"
              >
                {x.active_run_code}
              </Link>
            </span>
          )}
        </>
      ),
    },
    {
      key: 'created_at',
      header: 'Recorded',
      sortField: 'created_at',
      render: (x) => (
        <time
          dateTime={x.created_at}
          title={formatDateTime(x.created_at)}
          className="whitespace-nowrap"
        >
          {formatLocalDate(x.created_at)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (x) =>
        lab.canWrite(x.project_id) ? (
          <span className="inline-flex flex-col items-end gap-1 whitespace-nowrap">
            {x.qc_status === 'pending' && (
              <VerdictButtons
                extraction={x}
                busy={decide.submitting}
                onDecide={(verdict) => setVerdict(x, verdict)}
              />
            )}
            <button
              type="button"
              onClick={() => {
                setMessage(null);
                setEditing(x);
              }}
              aria-label={`Edit the measurements of extraction ${x.extraction_id}`}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100"
            >
              Edit
            </button>
          </span>
        ) : null,
    },
  ];

  const anyFilter = FILTERS.some((key) => filters[key]);

  return (
    <section aria-labelledby="extractions-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="extractions-heading" className="text-lg font-semibold">
            DNA extractions
          </h2>
          <p className="text-sm text-slate-600">
            A QC verdict is final; if it was wrong, record a new attempt.
          </p>
        </div>
        {lab.any && !recording && (
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setRecording(true);
            }}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Record extraction
          </button>
        )}
      </div>

      {recording && (
        <RecordExtractionForm
          onCancel={() => setRecording(false)}
          onSaved={(x) => {
            setRecording(false);
            setMessage(
              `Recorded extraction #${x.extraction_id} for ${x.sample_code} (attempt ${x.attempt_number}).`,
            );
            extractions.reload();
          }}
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <FormField label="Batch">
            <select
              value={idParam(filters.batch_id) ?? ''}
              onChange={(e) => {
                setFilters({ batch_id: e.target.value });
                pager.resetPage();
              }}
              className={fieldControlClass()}
            >
              <option value="">All batches</option>
              {(batches.data ?? []).map((b) => (
                <option key={b.batch_id} value={b.batch_id}>
                  #{b.batch_id}, {formatDate(b.extraction_date)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-48">
          <FormField label="QC status">
            <select
              value={qc ?? ''}
              onChange={(e) => {
                setFilters({ qc_status: e.target.value });
                pager.resetPage();
              }}
              className={fieldControlClass()}
            >
              <option value="">Any</option>
              {QC_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {idParam(filters.sample_id) && (
          <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
            One sample
            <button
              type="button"
              onClick={() => setFilters({ sample_id: '' })}
              aria-label="Show extractions of every sample"
              className="ml-1 text-slate-500 hover:text-slate-900"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {message && (
        <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
      {decide.error ? (
        <ErrorState error={decide.error} title="Could not record the QC verdict" />
      ) : null}
      {editing && (
        <MeasurementsForm
          key={editing.extraction_id}
          extraction={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setMessage(`Saved the measurements of extraction #${editing.extraction_id}.`);
            setEditing(null);
            extractions.reload();
          }}
        />
      )}

      <DataTable
        caption="DNA extractions"
        columns={columns}
        rows={extractions.data}
        rowKey={(x) => x.extraction_id}
        loading={extractions.status === 'loading'}
        error={extractions.error}
        onRetry={extractions.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={
          extractions.meta ? { meta: extractions.meta, onPageChange: pager.setPage } : null
        }
        emptyTitle={anyFilter ? 'No extractions match these filters' : 'No extractions yet'}
      />
    </section>
  );
}

/** Batches and extractions together: the Extractions tab. */
export function ExtractionsTab() {
  const [, setFilters] = useQueryFilters(FILTERS);
  return (
    <div className="space-y-8">
      <ExtractionsSection />
      <BatchesSection
        onShowExtractions={(batchId) =>
          setFilters({ batch_id: String(batchId), sample_id: '', qc_status: '' })
        }
      />
    </div>
  );
}
