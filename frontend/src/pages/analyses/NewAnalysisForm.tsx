// Owner: B (Frontend)
// Purpose: Create an analysis (a draft) for a sequencing run, or a correction of an approved one
//
// POST /api/analyses. The analysis belongs to the projects of its run's samples; the form loads
// the chosen run (GET /api/sequencing-runs/:id) to say up front whether the user may add an
// analysis to it (create_analysis in one of those projects) and to list its library codes, which
// the CSV must use. A correction names the approved analysis it replaces; that one is superseded
// only when the correction is approved, and an analysis can have one correction.

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { LoadingState } from '../../components/common/LoadingState';
import { useAnalysisAccess } from '../../hooks/useAnalysisAccess';
import { useFetch } from '../../hooks/useFetch';
import { useSubmit } from '../../hooks/useSubmit';
import { createAnalysis } from '../../services/analysesService';
import { formErrors } from '../../services/errorMessages';
import type {
  AnalysisRun,
  DnaMarker,
  PageMeta,
  SequencingRun,
  SequencingRunDetail,
} from '../../types';
import { formatDate, humanize } from '../../utils/format';
import {
  PIPELINES,
  PIPELINE_NAME_MAX,
  PIPELINE_VERSION_MAX,
  REFERENCE_DBS,
  REFERENCE_DB_MAX,
  REFERENCE_DB_VERSION_MAX,
  checkRequiredText,
  parseParameters,
} from './analysisRules';

const FIELDS = [
  'run_id',
  'marker_id',
  'pipeline_name',
  'pipeline_version',
  'reference_db',
  'reference_db_version',
  'parameters',
  'supersedes_analysis_id',
] as const;
type Field = (typeof FIELDS)[number];

/** The approved analysis a correction starts from: its settings are copied into the form. */
export type CorrectionOf = Pick<
  AnalysisRun,
  | 'analysis_id'
  | 'run_id'
  | 'marker_id'
  | 'pipeline_name'
  | 'pipeline_version'
  | 'reference_db'
  | 'reference_db_version'
  | 'parameters'
>;

interface NewAnalysisFormProps {
  correctionOf?: CorrectionOf | null;
  onCancel: () => void;
  onCreated: (analysis: AnalysisRun) => void;
}

const parametersText = (value: Record<string, unknown> | undefined) =>
  value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '';

export function NewAnalysisForm({
  correctionOf = null,
  onCancel,
  onCreated,
}: NewAnalysisFormProps) {
  const access = useAnalysisAccess();
  const runs = useFetch<SequencingRun[], PageMeta>('/sequencing-runs', {
    limit: 100,
    sort: '-created_at',
  });
  const markers = useFetch<DnaMarker[]>('/markers');
  const approved = useFetch<AnalysisRun[], PageMeta>('/analyses', {
    status: 'approved',
    limit: 100,
  });
  const [runId, setRunId] = useState(correctionOf ? String(correctionOf.run_id) : '');
  const [markerId, setMarkerId] = useState(correctionOf ? String(correctionOf.marker_id) : '');
  const [pipelineName, setPipelineName] = useState(correctionOf?.pipeline_name ?? '');
  const [pipelineVersion, setPipelineVersion] = useState(correctionOf?.pipeline_version ?? '');
  const [referenceDb, setReferenceDb] = useState(correctionOf?.reference_db ?? '');
  const [referenceDbVersion, setReferenceDbVersion] = useState(
    correctionOf?.reference_db_version ?? '',
  );
  const [parameters, setParameters] = useState(parametersText(correctionOf?.parameters));
  const [supersedes, setSupersedes] = useState(
    correctionOf ? String(correctionOf.analysis_id) : '',
  );
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const save = useSubmit(createAnalysis);
  const run = useFetch<SequencingRunDetail>(runId ? `/sequencing-runs/${runId}` : null);

  // Only the run that is loaded now counts (a slow answer for an earlier choice is ignored).
  const runDetail = run.data && String(run.data.run_id) === runId ? run.data : null;
  const runProjects = [...new Set((runDetail?.libraries ?? []).map((l) => l.project_id))];
  const runAllowed = runDetail ? access.canCreateIn(runProjects) : true;

  const edit = (field: Field, set: (value: string) => void) => (value: string) => {
    set(value);
    setErrors(({ [field]: _cleared, ...rest }) => rest);
    save.reset();
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    if (!runId) found.run_id = 'Choose the sequencing run.';
    else if (!runAllowed) found.run_id = 'You cannot add analyses to this run.';
    if (!markerId) found.marker_id = 'Choose the marker.';
    const name = checkRequiredText(pipelineName, 'pipeline name', PIPELINE_NAME_MAX);
    if (name) found.pipeline_name = name;
    const version = checkRequiredText(pipelineVersion, 'pipeline version', PIPELINE_VERSION_MAX);
    if (version) found.pipeline_version = version;
    const db = checkRequiredText(referenceDb, 'reference database', REFERENCE_DB_MAX);
    if (db) found.reference_db = db;
    if (referenceDbVersion.trim().length > REFERENCE_DB_VERSION_MAX) {
      found.reference_db_version = `At most ${REFERENCE_DB_VERSION_MAX} characters.`;
    }
    const parsed = parseParameters(parameters);
    if ('error' in parsed) found.parameters = parsed.error;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const created = await save.run({
      run_id: Number(runId),
      marker_id: Number(markerId),
      pipeline_name: pipelineName.trim(),
      pipeline_version: pipelineVersion.trim(),
      reference_db: referenceDb.trim(),
      reference_db_version: referenceDbVersion.trim() || null,
      ...('value' in parsed && parsed.value ? { parameters: parsed.value } : {}),
      ...(supersedes ? { supersedes_analysis_id: Number(supersedes) } : {}),
    });
    if (created) onCreated(created);
  }

  const server = save.error
    ? formErrors(save.error, FIELDS, {
        duplicate: {
          field: 'supersedes_analysis_id',
          message: 'This analysis already has a correction. Open that one from the list instead.',
        },
        invalid_reference: { field: 'marker_id', message: 'Choose a marker from the list.' },
      })
    : { fieldErrors: {}, formError: null };
  const fieldError = (field: Field) => errors[field] ?? server.fieldErrors[field];
  const control = (field: Field) => fieldControlClass(!!fieldError(field));

  if (
    (runs.status === 'loading' && !runs.data) ||
    (markers.status === 'loading' && !markers.data)
  ) {
    return <LoadingState label="Loading runs and markers…" />;
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={correctionOf ? 'New correction' : 'New analysis'}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div>
        <h2 className="text-base font-semibold">
          {correctionOf ? `Correct analysis #${correctionOf.analysis_id}` : 'New analysis'}
        </h2>
        <p className="text-sm text-slate-600">
          {correctionOf
            ? `The correction starts as a draft with these settings copied from #${correctionOf.analysis_id}. Change what was wrong, import the corrected CSV and send it for approval; #${correctionOf.analysis_id} stays approved until the correction is approved.`
            : 'The analysis starts as a draft. Import its detections CSV next, then a principal investigator who did not import it approves or rejects it.'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Sequencing run"
          error={fieldError('run_id')}
          required
          hint="The CSV may only use library codes of this run."
        >
          <select
            value={runId}
            onChange={(e) => edit('run_id', setRunId)(e.target.value)}
            className={control('run_id')}
          >
            <option value="">Choose a run…</option>
            {(runs.data ?? []).map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.run_code} · {r.platform} · {formatDate(r.run_date)} · {humanize(r.status)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Marker" error={fieldError('marker_id')} required>
          <select
            value={markerId}
            onChange={(e) => edit('marker_id', setMarkerId)(e.target.value)}
            className={control('marker_id')}
          >
            <option value="">Choose a marker…</option>
            {(markers.data ?? []).map((m) => (
              <option key={m.marker_id} value={m.marker_id}>
                {m.marker_name}
                {m.target_region ? ` · ${m.target_region}` : ''}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {runId && (
        <RunSummary
          loading={run.status === 'loading' && !runDetail}
          error={run.error}
          run={runDetail}
          allowed={runAllowed}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Pipeline" error={fieldError('pipeline_name')} required>
          <input
            list="analysis-pipelines"
            value={pipelineName}
            onChange={(e) => edit('pipeline_name', setPipelineName)(e.target.value)}
            placeholder="OBITools3"
            className={control('pipeline_name')}
          />
        </FormField>
        <FormField label="Pipeline version" error={fieldError('pipeline_version')} required>
          <input
            value={pipelineVersion}
            onChange={(e) => edit('pipeline_version', setPipelineVersion)(e.target.value)}
            placeholder="3.0.1"
            className={control('pipeline_version')}
          />
        </FormField>
        <FormField label="Reference database" error={fieldError('reference_db')} required>
          <input
            list="analysis-reference-dbs"
            value={referenceDb}
            onChange={(e) => edit('reference_db', setReferenceDb)(e.target.value)}
            placeholder="MitoFish"
            className={control('reference_db')}
          />
        </FormField>
        <FormField
          label="Reference database version"
          error={fieldError('reference_db_version')}
          hint="Optional, for example 2026-01."
        >
          <input
            value={referenceDbVersion}
            onChange={(e) => edit('reference_db_version', setReferenceDbVersion)(e.target.value)}
            className={control('reference_db_version')}
          />
        </FormField>
      </div>
      <datalist id="analysis-pipelines">
        {PIPELINES.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id="analysis-reference-dbs">
        {REFERENCE_DBS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <FormField
        label="Parameters"
        error={fieldError('parameters')}
        hint='Optional pipeline settings as a JSON object, for example {"min_length": 100, "identity_cutoff": 0.97}.'
      >
        <textarea
          rows={3}
          value={parameters}
          onChange={(e) => edit('parameters', setParameters)(e.target.value)}
          className={`${control('parameters')} font-mono`}
        />
      </FormField>

      <FormField
        label="Corrects analysis"
        error={fieldError('supersedes_analysis_id')}
        hint="Only for a correction: the approved analysis this one replaces once it is approved."
      >
        <select
          value={supersedes}
          onChange={(e) => edit('supersedes_analysis_id', setSupersedes)(e.target.value)}
          className={control('supersedes_analysis_id')}
        >
          <option value="">None (a new analysis)</option>
          {(approved.data ?? []).map((a) => (
            <option key={a.analysis_id} value={a.analysis_id}>
              #{a.analysis_id} · {a.run_code} · {a.marker_name} · {a.pipeline_name}{' '}
              {a.pipeline_version}
            </option>
          ))}
        </select>
      </FormField>

      {server.formError && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {server.formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.submitting || !runAllowed}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Creating…' : correctionOf ? 'Create correction' : 'Create analysis'}
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

function RunSummary({
  loading,
  error,
  run,
  allowed,
}: {
  loading: boolean;
  error: unknown;
  run: SequencingRunDetail | null;
  allowed: boolean;
}) {
  if (loading) return <LoadingState label="Loading the run…" variant="inline" />;
  if (error || !run) {
    return <p className="text-sm text-red-700">Could not load this run. Choose it again.</p>;
  }
  const codes = run.libraries.map((l) => l.library_code);
  return (
    <div
      className={`rounded-md border p-3 text-sm ${allowed ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
    >
      {allowed ? (
        <p>
          {run.run_code} has {codes.length} {codes.length === 1 ? 'library' : 'libraries'} you can
          see: <span className="font-mono">{codes.join(', ') || '—'}</span>
        </p>
      ) : (
        <p role="alert">
          You cannot add analyses to {run.run_code}: its samples are in projects where you are not a
          principal investigator or analyst who can write (a project viewer is read-only).
        </p>
      )}
    </div>
  );
}
