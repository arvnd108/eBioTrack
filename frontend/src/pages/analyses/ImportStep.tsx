// Owner: B (Frontend)
// Purpose: Upload a detections CSV into a draft analysis: check it, preview row errors, import
//
// CONTRACT 12. The file is first checked here (size, header, values: the same rules and messages
// as the API, utils/detectionCsv.ts), then with the server as a dry run
// (POST /api/analyses/import?dry_run=true), which also knows the run's library codes and the
// taxa. Import is offered only after a clean dry run of the same file; it writes every row or
// none, and the analysis becomes `imported`.

import { useState, type ChangeEvent } from 'react';
import { useSubmit } from '../../hooks/useSubmit';
import { isApiError } from '../../services/apiClient';
import { dryRunImport, importDetections, type DryRunMeta } from '../../services/analysesService';
import { saveTextFile } from '../../services/analyticsService';
import { errorMessage } from '../../services/errorMessages';
import type { AnalysisRun, ImportDryRunResult, ImportRowError } from '../../types';
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_BYTES,
  checkDetectionCsv,
  type CsvRowError,
} from '../../utils/detectionCsv';
import { formatBytes, templateCsv } from './analysisRules';

interface Chosen {
  file: File;
  /** Problems found before uploading: a whole-file problem, or row errors. */
  fileProblem: string | null;
  localErrors: CsvRowError[];
  dataRows: number;
}

/** Reads a chosen file and checks it like the API does, without sending it. */
export async function checkLocally(file: File): Promise<Omit<Chosen, 'file'>> {
  if (file.size === 0) return { fileProblem: 'the file is empty', localErrors: [], dataRows: 0 };
  if (file.size > MAX_IMPORT_BYTES) {
    return { fileProblem: 'the file is larger than 10 MB', localErrors: [], dataRows: 0 };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { fileProblem: 'the file must be UTF-8 text', localErrors: [], dataRows: 0 };
  }
  const checked = checkDetectionCsv(text);
  return {
    fileProblem: checked.fileProblem,
    localErrors: checked.errors,
    dataRows: checked.rows.length + new Set(checked.errors.map((e) => e.row)).size,
  };
}

export function ErrorTable({
  caption,
  errors,
  total,
}: {
  caption: string;
  errors: readonly ImportRowError[];
  total?: number;
}) {
  return (
    <div className="space-y-1">
      <div className="max-h-72 overflow-auto rounded-md border border-red-200 bg-white">
        <table className="min-w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-red-50 text-left text-red-900">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Row
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Column
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Problem
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-red-100">
            {errors.map((e, i) => (
              <tr key={`${e.row}-${e.field}-${i}`}>
                <td className="px-3 py-1.5 tabular-nums">{e.row}</td>
                <td className="px-3 py-1.5 font-mono">{e.field}</td>
                <td className="px-3 py-1.5">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total !== undefined && total > errors.length && (
        <p className="text-xs text-slate-600">
          Showing the first {errors.length} of {total} problems. Fix these and check again to see
          the rest.
        </p>
      )}
    </div>
  );
}

interface ImportStepProps {
  analysis: AnalysisRun;
  libraryCodes: readonly string[];
  onImported: (inserted: number) => void;
}

export function ImportStep({ analysis, libraryCodes, onImported }: ImportStepProps) {
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [dryRun, setDryRun] = useState<{
    file: File;
    result: ImportDryRunResult;
    meta?: DryRunMeta;
  } | null>(null);
  const check = useSubmit(dryRunImport);
  const commit = useSubmit(importDetections);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setDryRun(null);
    check.reset();
    commit.reset();
    if (!file) {
      setChosen(null);
      return;
    }
    setChosen({ file, ...(await checkLocally(file)) });
  }

  async function runCheck() {
    if (!chosen) return;
    const res = await check.run(analysis.analysis_id, chosen.file);
    if (res) setDryRun({ file: chosen.file, result: res.data, meta: res.meta });
  }

  async function runImport() {
    if (!chosen) return;
    const res = await commit.run(analysis.analysis_id, chosen.file);
    if (res) onImported(res.inserted);
  }

  // Choosing a file clears the last result; the file check also covers a dry run that answers
  // after another file was chosen.
  const checked = dryRun && chosen && dryRun.file === chosen.file ? dryRun : null;
  const clean = !!checked && checked.result.errors.length === 0 && checked.result.valid_rows > 0;
  const blocked = !chosen || !!chosen.fileProblem;
  // A refused import lists its row errors in the error details, like a dry run.
  const importErrors =
    isApiError(commit.error) &&
    commit.error.details.length > 0 &&
    commit.error.details.every((d) => typeof d.row === 'number')
      ? (commit.error.details as ImportRowError[])
      : [];

  return (
    <section aria-labelledby="import-heading" className="space-y-3">
      <div>
        <h3 id="import-heading" className="text-sm font-semibold text-slate-900">
          Import detections
        </h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-600">
          <li>
            One CSV file, UTF-8, at most 10 MB, with exactly the columns{' '}
            {IMPORT_COLUMNS.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <code className="rounded bg-slate-100 px-1 text-xs">{c}</code>
              </span>
            ))}
            .
          </li>
          <li>Library codes of {analysis.run_code} only; each library and taxon once.</li>
          <li>Taxa must already exist with that rank; an import never creates taxa.</li>
          <li>
            Read counts are whole numbers, confidence is from 0 to 1, QC flag is pass, warn or fail.
          </li>
          <li>
            The whole file is imported, or nothing.{' '}
            <button
              type="button"
              onClick={() =>
                saveTextFile(templateCsv(libraryCodes), 'detections-template.csv', 'text/csv')
              }
              className="text-emerald-700 underline hover:text-emerald-800"
            >
              Download a template
            </button>
          </li>
        </ul>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-slate-700">
          Detections CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={choose}
            className="mt-1 block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-200"
          />
        </label>
        <button
          type="button"
          onClick={runCheck}
          disabled={blocked || check.submitting || commit.submitting}
          className="rounded-md border border-emerald-700 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
        >
          {check.submitting ? 'Checking…' : 'Check file'}
        </button>
        <button
          type="button"
          onClick={runImport}
          disabled={!clean || commit.submitting}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {commit.submitting
            ? 'Importing…'
            : clean
              ? `Import ${checked.result.valid_rows} detection${checked.result.valid_rows === 1 ? '' : 's'}`
              : 'Import'}
        </button>
      </div>

      {chosen && (
        <p className="text-sm text-slate-600">
          {chosen.file.name} · {formatBytes(chosen.file.size)}
          {!chosen.fileProblem &&
            ` · ${chosen.dataRows} data row${chosen.dataRows === 1 ? '' : 's'}`}
        </p>
      )}
      {chosen?.fileProblem && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          This file cannot be imported: {chosen.fileProblem}.
        </p>
      )}
      {chosen && !chosen.fileProblem && !checked && chosen.localErrors.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-red-800">
            {chosen.localErrors.length} problem{chosen.localErrors.length === 1 ? '' : 's'} found
            before uploading. Fix the file, or check it with the server for the full list (library
            codes and taxa are checked there).
          </p>
          <ErrorTable caption="Problems found before uploading" errors={chosen.localErrors} />
        </div>
      )}
      {chosen && !chosen.fileProblem && !checked && chosen.localErrors.length === 0 && (
        <p className="text-sm text-slate-600">
          The format looks right. Check the file to compare it with {analysis.run_code}&rsquo;s
          libraries and the taxa.
        </p>
      )}

      {checked && (
        <div className="space-y-2" aria-live="polite">
          {checked.result.errors.length === 0 ? (
            <p className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-900">
              All {checked.result.valid_rows} rows are valid. Nothing has been saved yet: import
              them to finish.
            </p>
          ) : (
            <>
              <p className="text-sm text-red-800">
                {checked.meta?.total_errors ?? checked.result.errors.length} problem
                {(checked.meta?.total_errors ?? checked.result.errors.length) === 1 ? '' : 's'} to
                fix ({checked.result.valid_rows} valid row
                {checked.result.valid_rows === 1 ? '' : 's'}). Nothing was saved; fix the file,
                choose it again and check it.
              </p>
              <ErrorTable
                caption="Problems found by the dry run"
                errors={checked.result.errors}
                total={checked.meta?.total_errors}
              />
            </>
          )}
        </div>
      )}

      {check.error ? (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {fileErrorText(check.error)}
        </p>
      ) : null}
      {commit.error ? (
        <div role="alert" className="space-y-2 rounded-md bg-red-50 p-2 text-sm text-red-700">
          <p>{fileErrorText(commit.error)}</p>
          {importErrors.length > 0 && (
            <ErrorTable caption="Problems found by the import" errors={importErrors} />
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The API's message, plus the file-level detail ("The file is not a valid CSV: …"). */
function fileErrorText(error: unknown): string {
  if (isApiError(error)) {
    const fileDetail = error.details.find((d) => d.field === 'file' && d.row === undefined);
    if (fileDetail) return `${error.message}: ${fileDetail.message}.`;
  }
  return errorMessage(error);
}
