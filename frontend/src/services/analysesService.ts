// Owner: B (Frontend)
// Purpose: API calls for analyses
//
// CONTRACT 10, Analyses and detections (backend T23). An analysis starts as a draft; one CSV of
// detections is imported into it (the dry run checks the file and writes nothing); a principal
// investigator who did not import it approves or rejects it. Approved results are never edited:
// a correction is a new analysis naming the approved one in `supersedes_analysis_id`, and the old
// one becomes `superseded` when the correction is approved (CONTRACT section 3).

import type { AnalysisRun, ImportDryRunResult, ImportResult } from '../types';
import { api } from './apiClient';

export interface NewAnalysis {
  run_id: number;
  marker_id: number;
  pipeline_name: string;
  pipeline_version: string;
  reference_db: string;
  reference_db_version?: string | null;
  parameters?: Record<string, unknown>;
  supersedes_analysis_id?: number | null;
}

/** Dry runs list at most 100 row errors; `meta` gives the total when there are more. */
export interface DryRunMeta {
  total_errors: number;
  errors_shown: number;
}

export async function createAnalysis(body: NewAnalysis): Promise<AnalysisRun> {
  return (await api.post<AnalysisRun>('/analyses', body)).data;
}

function importForm(analysisId: number, file: File): FormData {
  const form = new FormData();
  form.append('analysis_id', String(analysisId));
  form.append('file', file, file.name);
  return form;
}

/** Checks the CSV against the analysis (libraries of its run, known taxa); writes nothing. */
export async function dryRunImport(
  analysisId: number,
  file: File,
): Promise<{ data: ImportDryRunResult; meta?: DryRunMeta }> {
  const res = await api.post<ImportDryRunResult, DryRunMeta>(
    '/analyses/import?dry_run=true',
    importForm(analysisId, file),
  );
  return { data: res.data, meta: res.meta };
}

/** Imports every row or none (422 with the row errors); the analysis becomes `imported`. */
export async function importDetections(analysisId: number, file: File): Promise<ImportResult> {
  return (await api.post<ImportResult>('/analyses/import', importForm(analysisId, file))).data;
}

export async function approveAnalysis(analysisId: number): Promise<AnalysisRun> {
  return (await api.post<AnalysisRun>(`/analyses/${analysisId}/approve`)).data;
}

export async function rejectAnalysis(analysisId: number, reason: string): Promise<AnalysisRun> {
  return (await api.post<AnalysisRun>(`/analyses/${analysisId}/reject`, { reason })).data;
}
