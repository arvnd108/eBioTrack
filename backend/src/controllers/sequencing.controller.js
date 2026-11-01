// Owner: A (Backend)
// Purpose: Request handling: sequencing libraries and runs
import * as service from '../services/sequencing.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listRuns(req, res) {
  const { rows, total } = await service.listRuns(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function getRun(req, res) {
  return sendSuccess(res, await service.getRun(req.user, req.params.id));
}

export async function createRun(req, res) {
  return sendSuccess(res, await service.createRun(req.body, req.user), 201);
}

export async function addLibrary(req, res) {
  return sendSuccess(res, await service.addLibrary(req.params.id, req.body, req.user), 201);
}

export async function updateRunStatus(req, res) {
  return sendSuccess(res, await service.updateRunStatus(req.params.id, req.body, req.user));
}
