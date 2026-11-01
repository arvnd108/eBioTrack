// Owner: A (Backend)
// Purpose: Request handling: collection events
import * as eventsService from '../services/events.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listEvents(req, res) {
  const { rows, total } = await eventsService.listEvents(req.user, req.query, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function getEvent(req, res) {
  return sendSuccess(res, await eventsService.getEvent(req.params.id, req.user));
}

export async function createEvent(req, res) {
  return sendSuccess(res, await eventsService.createEvent(req.body, req.user), 201);
}
