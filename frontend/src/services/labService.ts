// Owner: B (Frontend)
// Purpose: API calls for lab
//
// CONTRACT 10, Laboratory (backend T22). Writes need record_lab: an administrator, or a principal
// investigator or lab technician who is a non-viewer member of the project the sample belongs to.
// The database owns the lab rules: the next attempt number, a QC verdict decided once
// (pending -> pass | fail), only QC-passed extractions in runs, one planned or running run per
// extraction, and the run status transitions.

import type {
  DnaExtraction,
  ExtractionBatch,
  QcResult,
  QcType,
  QualityControlResult,
  RunStatus,
  SequencingLibrary,
  SequencingRun,
  SequencingRunDetail,
} from '../types';
import { api } from './apiClient';

export interface NewBatch {
  lab_id: number;
  extraction_date: string;
  kit_name?: string | null;
  notes?: string | null;
}

export interface NewExtraction {
  sample_id: number;
  batch_id: number;
  concentration_ng_ul?: number | null;
  purity_a260_280?: number | null;
}

export type ExtractionChanges = Partial<{
  qc_status: 'pass' | 'fail';
  concentration_ng_ul: number | null;
  purity_a260_280: number | null;
}>;

export interface NewQcResult {
  sample_id?: number | null;
  analysis_id?: number | null;
  qc_type: QcType;
  result: QcResult;
  metric_value?: number | null;
  notes?: string | null;
}

export interface NewRun {
  lab_id: number;
  platform: string;
  run_date: string;
  extraction_ids: number[];
}

export async function createBatch(body: NewBatch): Promise<ExtractionBatch> {
  return (await api.post<ExtractionBatch>('/extraction-batches', body)).data;
}

/** The API assigns the attempt number; a stored sample becomes extracted. */
export async function createExtraction(body: NewExtraction): Promise<DnaExtraction> {
  return (await api.post<DnaExtraction>('/extractions', body)).data;
}

export async function updateExtraction(
  extractionId: number,
  changes: ExtractionChanges,
): Promise<DnaExtraction> {
  return (await api.patch<DnaExtraction>(`/extractions/${extractionId}`, changes)).data;
}

export async function createQcResult(body: NewQcResult): Promise<QualityControlResult> {
  return (await api.post<QualityControlResult>('/qc-results', body)).data;
}

/** One request: the run (RUN-<id>, planned) and a library per extraction, or nothing. */
export async function createRun(body: NewRun): Promise<SequencingRunDetail> {
  return (await api.post<SequencingRunDetail>('/sequencing-runs', body)).data;
}

export async function addLibrary(runId: number, extractionId: number): Promise<SequencingLibrary> {
  return (
    await api.post<SequencingLibrary>(`/sequencing-runs/${runId}/libraries`, {
      extraction_id: extractionId,
    })
  ).data;
}

export async function changeRunStatus(runId: number, status: RunStatus): Promise<SequencingRun> {
  return (await api.patch<SequencingRun>(`/sequencing-runs/${runId}`, { status })).data;
}
