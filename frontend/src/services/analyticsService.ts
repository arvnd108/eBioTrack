// Owner: B (Frontend)
// Purpose: API calls for analytics
//
// Richness and detection frequency (GET /api/analytics/*) count only approved analyses and
// detections with QC flag pass, in the caller's projects; every answer carries `meta.caveat`.
// Exports (POST /api/exports, then GET /api/exports/:id/download) are regenerated from the same
// rules when downloaded; only the person who asked for an export can download it.

import type { CreateExportRequest, ExportResult } from '../types';
import { api, type DownloadedFile } from './apiClient';

export type GroupBy = 'year' | 'month' | 'site';
export const GROUP_BYS: readonly GroupBy[] = ['year', 'month', 'site'];

export async function createExport(body: CreateExportRequest): Promise<ExportResult> {
  return (await api.post<ExportResult>('/exports', body)).data;
}

export async function downloadExport(exportId: number): Promise<DownloadedFile> {
  return api.download(`/exports/${exportId}/download`);
}

/** Asks for an export, downloads it and hands the file to the browser. */
export async function exportCsv(
  body: CreateExportRequest,
): Promise<{ filename: string; rowCount: number; caveat: string | null }> {
  const created = await createExport(body);
  const file = await downloadExport(created.export_id);
  const filename = file.filename ?? `ebiotrack-${body.export_type}-${created.export_id}.csv`;
  saveTextFile(file.text, filename, 'text/csv;charset=utf-8');
  return { filename, rowCount: file.rowCount ?? created.row_count, caveat: file.caveat };
}

/** Offers text to the browser as a file download. */
export function saveTextFile(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
