// Owner: B (Frontend)
// Purpose: One analysis: its settings, detection counts, and the next step for its status
//
// GET /api/analyses/:id (with assignment_counts) and its run (GET /api/sequencing-runs/:id), whose
// libraries give the projects that decide who may act (useAnalysisAccess) and the library codes
// the CSV must use. The next step follows the status (CONTRACT section 3):
//   draft      import a CSV (create_analysis); a principal investigator may also reject it
//   imported   approve or reject (decide_analysis; the importer may not approve their own)
//   approved   start a correction (create_analysis), unless one exists
//   rejected / superseded   final; shown with the reason or the correction that replaced it

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/common/Badge';
import { ErrorState } from '../../components/common/ErrorState';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { LoadingState } from '../../components/common/LoadingState';
import { useAnalysisAccess } from '../../hooks/useAnalysisAccess';
import { useFetch } from '../../hooks/useFetch';
import { useUserNames } from '../../hooks/useLookups';
import { useSubmit } from '../../hooks/useSubmit';
import { approveAnalysis, rejectAnalysis } from '../../services/analysesService';
import { isApiError } from '../../services/apiClient';
import { errorMessage } from '../../services/errorMessages';
import type { AnalysisDetail, AnalysisRun, SequencingRunDetail } from '../../types';
import { formatDateTime } from '../../utils/format';
import { REASON_MAX } from './analysisRules';
import { ImportStep } from './ImportStep';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

interface AnalysisPanelProps {
  analysisId: number;
  /** Analyses already loaded on the page, to find the correction of this one. */
  known: readonly AnalysisRun[];
  onOpen: (analysisId: number) => void;
  onChanged: () => void;
  onCorrect: (analysis: AnalysisRun) => void;
  onClose: () => void;
}

export function AnalysisPanel({
  analysisId,
  known,
  onOpen,
  onChanged,
  onCorrect,
  onClose,
}: AnalysisPanelProps) {
  const access = useAnalysisAccess();
  const names = useUserNames();
  const detail = useFetch<AnalysisDetail>(`/analyses/${analysisId}`);
  const analysis = detail.data && detail.data.analysis_id === analysisId ? detail.data : null;
  const run = useFetch<SequencingRunDetail>(
    analysis ? `/sequencing-runs/${analysis.run_id}` : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  // Someone else changed it first: say what happened while the panel shows where it is now.
  const [stale, setStale] = useState<string | null>(null);
  const top = useRef<HTMLElement>(null);
  // Opened from a row further down the list: bring the panel into view.
  const loaded = analysis !== null;
  useEffect(() => {
    if (loaded) top.current?.scrollIntoView?.({ block: 'nearest' });
  }, [loaded]);

  if (!analysis) {
    if (detail.error) {
      return (
        <ErrorState
          error={detail.error}
          title={`Could not load analysis #${analysisId}`}
          onRetry={detail.reload}
        />
      );
    }
    return <LoadingState label={`Loading analysis #${analysisId}…`} />;
  }

  const runDetail = run.data && run.data.run_id === analysis.run_id ? run.data : null;
  const projectIds = [...new Set((runDetail?.libraries ?? []).map((l) => l.project_id))];
  const canWrite = !!runDetail && access.canCreateIn(projectIds);
  const canDecide = !!runDetail && access.canDecideIn(projectIds);
  const correction = known.find((a) => a.supersedes_analysis_id === analysis.analysis_id) ?? null;
  const counts = analysis.assignment_counts;
  const total = counts.pass + counts.warn + counts.fail;

  const changed = (message: string) => {
    setStale(null);
    setNotice(message);
    detail.reload();
    onChanged();
  };

  return (
    <section
      ref={top}
      aria-labelledby="analysis-heading"
      className="scroll-mt-4 space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="analysis-heading" className="text-lg font-semibold">
            Analysis #{analysis.analysis_id}
          </h2>
          <Badge value={analysis.status} />
          {analysis.supersedes_analysis_id !== null && (
            <span className="text-sm text-slate-600">
              corrects{' '}
              <button
                type="button"
                onClick={() => onOpen(analysis.supersedes_analysis_id!)}
                className="text-emerald-700 underline"
              >
                #{analysis.supersedes_analysis_id}
              </button>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
        >
          Close
        </button>
      </div>

      {notice && (
        <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-900">
          {notice}
        </p>
      )}
      {stale && (
        <p role="alert" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">
          {stale}. It changed since you opened it; this is where it is now.
        </p>
      )}

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Sequencing run">
          <Link to={`/lab/runs/${analysis.run_id}`} className="text-emerald-700 hover:underline">
            {analysis.run_code}
          </Link>
        </Fact>
        <Fact label="Marker">{analysis.marker_name}</Fact>
        <Fact label="Pipeline">
          {analysis.pipeline_name} {analysis.pipeline_version}
        </Fact>
        <Fact label="Reference database">
          {analysis.reference_db}
          {analysis.reference_db_version ? ` (${analysis.reference_db_version})` : ''}
        </Fact>
        <Fact label="Created">{formatDateTime(analysis.created_at)}</Fact>
        <Fact label="Imported by">
          {analysis.imported_by === null
            ? 'Not imported yet'
            : names(analysis.imported_by, analysis.imported_by_name)}
        </Fact>
        <Fact label="Approved">
          {analysis.approved_by === null
            ? '—'
            : `${names(analysis.approved_by, analysis.approved_by_name)}, ${formatDateTime(analysis.approved_at)}`}
        </Fact>
        <Fact label="Detections">
          {total === 0 ? (
            'None yet'
          ) : (
            <span className="flex flex-wrap gap-1">
              <Badge value="pass" label={`${counts.pass} pass`} />
              <Badge value="warn" label={`${counts.warn} warn`} />
              <Badge value="fail" label={`${counts.fail} fail`} />
            </span>
          )}
        </Fact>
      </dl>

      {Object.keys(analysis.parameters).length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-700">Pipeline parameters</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-2 font-mono text-xs">
            {JSON.stringify(analysis.parameters, null, 2)}
          </pre>
        </details>
      )}

      {analysis.status === 'rejected' && analysis.rejection && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-medium">
            Rejected by {names(analysis.rejection.rejected_by, analysis.rejection.rejected_by_name)}
            , {formatDateTime(analysis.rejection.rejected_at)}
          </p>
          <p className="mt-1 whitespace-pre-line">{analysis.rejection.reason}</p>
          <p className="mt-2 text-red-800">
            A rejected analysis stays on record and is never counted. To try again, create a new
            analysis and import the corrected file.
          </p>
        </div>
      )}
      {analysis.status === 'superseded' && (
        <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          Superseded
          {correction ? (
            <>
              {' '}
              by{' '}
              <button
                type="button"
                onClick={() => onOpen(correction.analysis_id)}
                className="text-emerald-700 underline"
              >
                #{correction.analysis_id}
              </button>
            </>
          ) : (
            ' by an approved correction'
          )}
          . Its detections no longer count in analytics or exports.
        </p>
      )}

      {run.error && !runDetail ? (
        <ErrorState error={run.error} title="Could not load the run" onRetry={run.reload} />
      ) : !runDetail ? (
        <LoadingState label="Checking what you can do…" variant="inline" />
      ) : (
        <NextStep
          analysis={analysis}
          canWrite={canWrite}
          canDecide={canDecide}
          isImporter={analysis.imported_by !== null && analysis.imported_by === access.userId}
          libraryCodes={runDetail.libraries.map((l) => l.library_code)}
          correction={correction}
          onOpen={onOpen}
          onCorrect={() => onCorrect(analysis)}
          onChanged={changed}
          onStale={(error) => {
            setNotice(null);
            setStale(errorMessage(error));
            detail.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

interface NextStepProps {
  analysis: AnalysisDetail;
  canWrite: boolean;
  canDecide: boolean;
  isImporter: boolean;
  libraryCodes: string[];
  correction: AnalysisRun | null;
  onOpen: (analysisId: number) => void;
  onCorrect: () => void;
  onChanged: (message: string) => void;
  onStale: (error: unknown) => void;
}

function NextStep({
  analysis,
  canWrite,
  canDecide,
  isImporter,
  libraryCodes,
  correction,
  onOpen,
  onCorrect,
  onChanged,
  onStale,
}: NextStepProps) {
  switch (analysis.status) {
    case 'draft':
      return (
        <div className="space-y-4 border-t border-slate-200 pt-4">
          {canWrite ? (
            <ImportStep
              analysis={analysis}
              libraryCodes={libraryCodes}
              onImported={(n) =>
                onChanged(
                  `Imported ${n} detection${n === 1 ? '' : 's'}. The analysis now waits for approval by a principal investigator who did not import it.`,
                )
              }
            />
          ) : (
            <p className="text-sm text-slate-600">
              This draft waits for its detections CSV. A principal investigator or analyst of{' '}
              {analysis.run_code}&rsquo;s projects imports it.
            </p>
          )}
          {canDecide && (
            <RejectForm
              analysis={analysis}
              onRejected={() => onChanged(`Analysis #${analysis.analysis_id} was rejected.`)}
              onStale={onStale}
            />
          )}
        </div>
      );
    case 'imported':
      return canDecide ? (
        <DecideStep
          analysis={analysis}
          isImporter={isImporter}
          onChanged={onChanged}
          onStale={onStale}
        />
      ) : (
        <p className="border-t border-slate-200 pt-4 text-sm text-slate-600">
          Waiting for approval by a principal investigator of {analysis.run_code}&rsquo;s projects
          who did not import it. Until then its detections are not counted anywhere.
        </p>
      );
    case 'approved':
      return (
        <div className="space-y-2 border-t border-slate-200 pt-4 text-sm text-slate-700">
          <p>
            Approved results are never edited. If something is wrong, a correction is a new analysis
            that replaces this one when it is approved.
          </p>
          {correction ? (
            <p>
              Correction{' '}
              <button
                type="button"
                onClick={() => onOpen(correction.analysis_id)}
                className="text-emerald-700 underline"
              >
                #{correction.analysis_id}
              </button>{' '}
              is {correction.status}.
            </p>
          ) : (
            canWrite && (
              <button
                type="button"
                onClick={onCorrect}
                className="rounded-md border border-emerald-700 px-4 py-2 font-medium text-emerald-800 hover:bg-emerald-50"
              >
                Start a correction
              </button>
            )
          )}
        </div>
      );
    default:
      return null;
  }
}

function DecideStep({
  analysis,
  isImporter,
  onChanged,
  onStale,
}: {
  analysis: AnalysisDetail;
  isImporter: boolean;
  onChanged: (message: string) => void;
  onStale: (error: unknown) => void;
}) {
  const approve = useSubmit(async () => {
    try {
      return await approveAnalysis(analysis.analysis_id);
    } catch (err) {
      // 409: someone decided it meanwhile; show where it is now.
      if (isApiError(err) && err.status === 409) onStale(err);
      throw err;
    }
  });
  const counts = analysis.assignment_counts;
  return (
    <div className="space-y-4 border-t border-slate-200 pt-4">
      <section aria-labelledby="approve-heading" className="space-y-2 text-sm">
        <h3 id="approve-heading" className="font-semibold text-slate-900">
          Approve
        </h3>
        <p className="text-slate-700">
          Approving makes the {counts.pass} detection{counts.pass === 1 ? '' : 's'} with QC flag
          pass count in species, analytics and exports ({counts.warn} warn and {counts.fail} fail
          stay on record but are never counted).
          {analysis.supersedes_analysis_id !== null &&
            ` Analysis #${analysis.supersedes_analysis_id} becomes superseded at the same time.`}
        </p>
        {isImporter ? (
          <p className="rounded-md bg-amber-50 p-2 text-amber-900">
            You imported this analysis, so another principal investigator must approve it.
          </p>
        ) : (
          <button
            type="button"
            disabled={approve.submitting}
            onClick={async () => {
              if (await approve.run()) {
                onChanged(`Analysis #${analysis.analysis_id} is approved.`);
              }
            }}
            className="rounded-md bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {approve.submitting ? 'Approving…' : 'Approve analysis'}
          </button>
        )}
        {approve.error ? (
          <p role="alert" className="rounded-md bg-red-50 p-2 text-red-700">
            {errorMessage(approve.error)}
          </p>
        ) : null}
      </section>
      <RejectForm
        analysis={analysis}
        onRejected={() => onChanged(`Analysis #${analysis.analysis_id} was rejected.`)}
        onStale={onStale}
      />
    </div>
  );
}

function RejectForm({
  analysis,
  onRejected,
  onStale,
}: {
  analysis: AnalysisRun;
  onRejected: () => void;
  onStale: (error: unknown) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const reject = useSubmit(async (text: string) => {
    try {
      return await rejectAnalysis(analysis.analysis_id, text);
    } catch (err) {
      if (isApiError(err) && err.status === 409) onStale(err);
      throw err;
    }
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reason.trim();
    const problem = !text
      ? 'Say why the analysis is rejected.'
      : text.length > REASON_MAX
        ? `At most ${REASON_MAX} characters.`
        : undefined;
    setError(problem);
    if (problem) return;
    if (await reject.run(text)) onRejected();
  }

  const serverField = isApiError(reject.error) ? reject.error.fieldMessage('reason') : undefined;
  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Reject analysis"
      className="max-w-2xl space-y-2 text-sm"
    >
      <h3 className="font-semibold text-slate-900">Reject</h3>
      <FormField
        label="Reason"
        error={error ?? serverField}
        required
        hint="Shown to the analyst. Rejecting is final; a new analysis is needed to try again."
      >
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(undefined);
            reject.reset();
          }}
          className={fieldControlClass(!!(error ?? serverField))}
        />
      </FormField>
      {reject.error && !serverField ? (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-red-700">
          {errorMessage(reject.error)}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={reject.submitting}
        className="rounded-md border border-red-300 px-4 py-2 font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
      >
        {reject.submitting ? 'Rejecting…' : 'Reject analysis'}
      </button>
    </form>
  );
}
