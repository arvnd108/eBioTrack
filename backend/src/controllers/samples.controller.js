// Owner: A (Backend)
// Purpose: Request handling: samples, detail and status
import * as samplesService from '../services/samples.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listSampleTypes(_req, res) {
  return sendSuccess(res, await samplesService.listSampleTypes());
}

export async function listSamples(req, res) {
  const { rows, total } = await samplesService.listSamples(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function getSample(req, res) {
  return sendSuccess(res, await samplesService.getSample(req.params.id, req.user));
}

export async function createSample(req, res) {
  return sendSuccess(res, await samplesService.createSample(req.body, req.user), 201);
}

export async function changeSampleStatus(req, res) {
  return sendSuccess(
    res,
    await samplesService.changeSampleStatus(req.params.id, req.body, req.user),
  );
}
