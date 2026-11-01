// Owner: B (Frontend)
// Purpose: Quality-control results: list, filter, record (GET/POST /api/qc-results)
//
// A result is about a sample (extraction blank, concentration, contamination check, ...) or about
// an analysis (read quality), newest first. Recording needs record_lab where the sample (or one of
// the analysis's projects) is the user's to write; the API refuses the rest (403/404).

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/common/Badge';
import { DataTable, type Column } from '../../components/common/DataTable';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { QC_RESULTS, QC_TYPES } from '../../domain';
import { useFetch } from '../../hooks/useFetch';
import { useLabAccess } from '../../hooks/useLabAccess';
import { useUserNames } from '../../hooks/useLookups';
import { usePagination } from '../../hooks/usePagination';
import { idParam, useQueryFilters } from '../../hooks/useQueryFilters';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createQcResult } from '../../services/labService';
import type {
  AnalysisRun,
  PageMeta,
  QcResult,
  QcType,
  QualityControlResult,
  Sample,
} from '../../types';
import { formatDateTime, humanize, parseNumber } from '../../utils/format';
import { NOTES_MAX } from './labRules';

const FILTERS = ['result', 'sample_id'] as const;
const FIELDS = ['sample_id', 'analysis_id', 'qc_type', 'result', 'metric_value', 'notes'] as const;
type Field = (typeof FIELDS)[number] | 'project';

function QcResultForm({
  onSaved,
  onCancel,
}: {
  onSaved: (r: QualityControlResult) => void;
  onCancel: () => void;
}) {
  const lab = useLabAccess();
  const only = lab.writableProjects.length === 1 ? String(lab.writableProjects[0].project_id) : '';
  const [target, setTarget] = useState<'sample' | 'analysis'>('sample');
  const [projectId, setProjectId] = useState(only);
  const [sampleId, setSampleId] = useState('');
  const [analysisId, setAnalysisId] = useState('');
  const [qcType, setQcType] = useState<QcType | ''>('');
  const [result, setResult] = useState<QcResult | ''>('');
  const [metric, setMetric] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const project = projectId || only;
  const samples = useFetch<Sample[], PageMeta>(target === 'sample' && project ? '/samples' : null, {
    project_id: project,
    limit: 100,
    sort: 'sample_code',
  });
  const analyses = useFetch<AnalysisRun[], PageMeta>(target === 'analysis' ? '/analyses' : null, {
    limit: 100,
  });
  const save = useSubmit(createQcResult);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    if (target === 'sample') {
      if (!project) found.project = 'Choose the project.';
      if (!sampleId) found.sample_id = 'Choose the sample.';
    } else if (!analysisId) {
      found.analysis_id = 'Choose the analysis.';
    }
    if (!qcType) found.qc_type = 'Choose the QC type.';
    if (!result) found.result = 'Choose the result.';
    const value = metric.trim() ? parseNumber(metric) : null;
    if (metric.trim() && value === null) found.metric_value = 'Enter a number.';
    if (notes.trim().length > NOTES_MAX) found.notes = `At most ${NOTES_MAX} characters.`;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const saved = await save.run({
      ...(target === 'sample'
        ? { sample_id: Number(sampleId) }
        : { analysis_id: Number(analysisId) }),
      qc_type: qcType as QcType,
      result: result as QcResult,
      metric_value: value,
      notes: notes.trim() || null,
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
      aria-label="Record QC result"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h3 className="text-base font-semibold">Record a QC result</h3>
        <p className="text-sm text-slate-600">You are recorded as the person who checked it.</p>
      </div>
      <fieldset className="flex gap-6 text-sm">
        <legend className="sr-only">The result is about</legend>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            name="qc-target"
            checked={target === 'sample'}
            onChange={() => setTarget('sample')}
          />
          A sample
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            name="qc-target"
            checked={target === 'analysis'}
            onChange={() => setTarget('analysis')}
          />
          An analysis (for example read quality)
        </label>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {target === 'sample' ? (
          <>
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
            <FormField label="Sample" error={fieldError('sample_id')} required>
              <select
                value={sampleId}
                onChange={(e) => edit('sample_id', setSampleId)(e.target.value)}
                disabled={!project}
                className={fieldControlClass(!!fieldError('sample_id'))}
              >
                <option value="">{project ? 'Choose a sample…' : 'Choose a project first'}</option>
                {(samples.data ?? []).map((s) => (
                  <option key={s.sample_id} value={s.sample_id}>
                    {s.sample_code}
                  </option>
                ))}
              </select>
            </FormField>
          </>
        ) : (
          <FormField label="Analysis" error={fieldError('analysis_id')} required>
            <select
              value={analysisId}
              onChange={(e) => edit('analysis_id', setAnalysisId)(e.target.value)}
              className={fieldControlClass(!!fieldError('analysis_id'))}
            >
              <option value="">Choose an analysis…</option>
              {(analyses.data ?? []).map((a) => (
                <option key={a.analysis_id} value={a.analysis_id}>
                  Analysis {a.analysis_id}: {a.pipeline_name} ({humanize(a.status)})
                </option>
              ))}
            </select>
          </FormField>
        )}
        <FormField label="QC type" error={fieldError('qc_type')} required>
          <select
            value={qcType}
            onChange={(e) => edit('qc_type', (v) => setQcType(v as QcType | ''))(e.target.value)}
            className={fieldControlClass(!!fieldError('qc_type'))}
          >
            <option value="">Choose…</option>
            {QC_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Result" error={fieldError('result')} required>
          <select
            value={result}
            onChange={(e) => edit('result', (v) => setResult(v as QcResult | ''))(e.target.value)}
            className={fieldControlClass(!!fieldError('result'))}
          >
            <option value="">Choose…</option>
            {QC_RESULTS.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Metric" error={fieldError('metric_value')} hint="Optional number.">
          <input
            inputMode="decimal"
            value={metric}
            onChange={(e) => edit('metric_value', setMetric)(e.target.value)}
            className={fieldControlClass(!!fieldError('metric_value'))}
          />
        </FormField>
        <div className="sm:col-span-2 lg:col-span-3">
          <FormField label="Notes" error={fieldError('notes')} hint="Optional.">
            <input
              value={notes}
              onChange={(e) => edit('notes', setNotes)(e.target.value)}
              className={fieldControlClass(!!fieldError('notes'))}
            />
          </FormField>
        </div>
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
          {save.submitting ? 'Saving…' : 'Record result'}
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

export function QcResultsSection() {
  const lab = useLabAccess();
  const nameOf = useUserNames();
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [recording, setRecording] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const pager = usePagination();
  const result = QC_RESULTS.find((r) => r === filters.result);
  const results = useFetch<QualityControlResult[], PageMeta>('/qc-results', {
    result,
    sample_id: idParam(filters.sample_id),
    ...pager.query,
  });

  const columns: Column<QualityControlResult>[] = [
    {
      key: 'recorded_at',
      header: 'Recorded',
      sortField: 'recorded_at',
      render: (r) => formatDateTime(r.recorded_at),
    },
    {
      key: 'about',
      header: 'About',
      render: (r) =>
        r.sample_id !== null ? (
          <Link
            to={`/samples/${r.sample_id}`}
            className="whitespace-nowrap font-mono text-sm text-emerald-700 hover:underline"
          >
            {r.sample_code ?? `Sample ${r.sample_id}`}
          </Link>
        ) : (
          `Analysis ${r.analysis_id}`
        ),
    },
    { key: 'qc_type', header: 'Type', render: (r) => humanize(r.qc_type) },
    { key: 'result', header: 'Result', render: (r) => <Badge value={r.result} /> },
    {
      key: 'metric_value',
      header: 'Metric',
      align: 'right',
      render: (r) => (r.metric_value === null ? '—' : String(r.metric_value)),
    },
    { key: 'notes', header: 'Notes' },
    { key: 'recorded_by', header: 'By', render: (r) => nameOf(r.recorded_by, r.recorded_by_name) },
  ];

  const anyFilter = FILTERS.some((key) => filters[key]);

  return (
    <section aria-labelledby="qc-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="qc-heading" className="text-lg font-semibold">
            QC results
          </h2>
          <p className="text-sm text-slate-600">Newest first.</p>
        </div>
        {lab.any && !recording && (
          <button
            type="button"
            onClick={() => {
              setSaved(null);
              setRecording(true);
            }}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Record QC result
          </button>
        )}
      </div>
      {recording && (
        <QcResultForm
          onCancel={() => setRecording(false)}
          onSaved={(r) => {
            setRecording(false);
            setSaved(
              `Recorded ${humanize(r.qc_type).toLowerCase()} (${r.result}) for ${
                r.sample_code ?? `analysis ${r.analysis_id}`
              }.`,
            );
            results.reload();
          }}
        />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <FormField label="Result">
            <select
              value={result ?? ''}
              onChange={(e) => {
                setFilters({ result: e.target.value });
                pager.resetPage();
              }}
              className={fieldControlClass()}
            >
              <option value="">Any</option>
              {QC_RESULTS.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
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
              aria-label="Show QC results of every sample"
              className="ml-1 text-slate-500 hover:text-slate-900"
            >
              ×
            </button>
          </span>
        )}
      </div>
      {saved && (
        <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
          {saved}
        </p>
      )}
      <DataTable
        caption="QC results"
        columns={columns}
        rows={results.data}
        rowKey={(r) => r.qc_id}
        loading={results.status === 'loading'}
        error={results.error}
        onRetry={results.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={results.meta ? { meta: results.meta, onPageChange: pager.setPage } : null}
        emptyTitle={anyFilter ? 'No QC results match these filters' : 'No QC results yet'}
      />
    </section>
  );
}
