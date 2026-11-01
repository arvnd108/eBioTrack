// Owner: A (Backend)
// Purpose: Request handling: labs, markers, extraction batches, extractions, QC results
import * as service from '../services/extractions.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listLabs(_req, res) {
  return sendSuccess(res, await service.listLabs());
}

export async function listMarkers(_req, res) {
  return sendSuccess(res, await service.listMarkers());
}

export async function listBatches(req, res) {
  const { rows, total } = await service.listBatches(req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function createBatch(req, res) {
  return sendSuccess(res, await service.createBatch(req.body, req.user), 201);
}

export async function listExtractions(req, res) {
  const { rows, total } = await service.listExtractions(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function createExtraction(req, res) {
  return sendSuccess(res, await service.createExtraction(req.body, req.user), 201);
}

export async function updateExtraction(req, res) {
  return sendSuccess(res, await service.updateExtraction(req.params.id, req.body, req.user));
}

export async function listQcResults(req, res) {
  const { rows, total } = await service.listQcResults(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function createQcResult(req, res) {
  return sendSuccess(res, await service.createQcResult(req.body, req.user), 201);
}
