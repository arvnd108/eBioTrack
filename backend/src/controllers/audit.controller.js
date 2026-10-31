// Owner: A (Backend)
// Purpose: Request handling: authorized audit history
import * as auditService from '../services/audit.service.js';
import { sendPaginated } from '../utils/response.js';

export async function listAudit(req, res) {
  const { rows, total } = await auditService.listAudit(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}
