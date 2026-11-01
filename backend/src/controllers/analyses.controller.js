// Owner: A (Backend)
// Purpose: Request handling: analysis runs, CSV import, approval
import * as service from '../services/analyses.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listAnalyses(req, res) {
  const { rows, total } = await service.listAnalyses(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function getAnalysis(req, res) {
  return sendSuccess(res, await service.getAnalysis(req.user, req.params.id));
}

export async function createAnalysis(req, res) {
  return sendSuccess(res, await service.createAnalysis(req.body, req.user), 201);
}

export async function importDetections(req, res) {
  const result = await service.importDetections(
    { analysisId: req.body.analysis_id, buffer: req.file.buffer, dryRun: req.query.dry_run },
    req.user,
  );
  if (result.dryRun) {
    const body = { data: { valid_rows: result.valid_rows, errors: result.errors } };
    if (result.totalErrors > result.errors.length) {
      body.meta = { total_errors: result.totalErrors, errors_shown: result.errors.length };
    }
    return res.status(200).json(body);
  }
  return sendSuccess(res, { inserted: result.inserted }, 201);
}

export async function approveAnalysis(req, res) {
  return sendSuccess(res, await service.approveAnalysis(req.params.id, req.user));
}

export async function rejectAnalysis(req, res) {
  return sendSuccess(res, await service.rejectAnalysis(req.params.id, req.body.reason, req.user));
}
