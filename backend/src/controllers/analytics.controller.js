// Owner: A (Backend)
// Purpose: Request handling: richness, detection frequency, dashboard summary
import * as service from '../services/analytics.service.js';
import { sendSuccess, sendWithMeta } from '../utils/response.js';

const caveat = { caveat: service.EDNA_CAVEAT };

export async function richness(req, res) {
  return sendWithMeta(res, await service.richness(req.user, req.query), caveat);
}

export async function detectionFrequency(req, res) {
  return sendWithMeta(res, await service.detectionFrequency(req.user, req.query), caveat);
}

export async function dashboardSummary(req, res) {
  return sendSuccess(res, await service.dashboardSummary(req.user, req.query));
}
