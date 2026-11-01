// Owner: A (Backend)
// Purpose: Request handling: taxa and detection history
import * as service from '../services/taxa.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listTaxa(req, res) {
  const { rows, total } = await service.listTaxa(req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function getTaxon(req, res) {
  return sendSuccess(res, await service.getTaxon(req.params.id));
}

export async function listDetections(req, res) {
  const { rows, total } = await service.listDetections(
    req.user,
    req.params.id,
    req.query,
    req.pagination,
  );
  return sendPaginated(res, rows, { ...req.pagination, total });
}
