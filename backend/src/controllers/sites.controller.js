// Owner: A (Backend)
// Purpose: Request handling: regions and sampling sites
import * as sitesService from '../services/sites.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listRegions(req, res) {
  return sendSuccess(res, await sitesService.listRegions(req.query));
}

export async function listSites(req, res) {
  const { rows, total } = await sitesService.listSites(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function getSite(req, res) {
  return sendSuccess(res, await sitesService.getSite(req.params.id));
}

export async function createSite(req, res) {
  return sendSuccess(res, await sitesService.createSite(req.body, req.user), 201);
}

export async function updateSite(req, res) {
  return sendSuccess(res, await sitesService.updateSite(req.params.id, req.body, req.user));
}
