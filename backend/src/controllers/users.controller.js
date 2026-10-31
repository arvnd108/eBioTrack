// Owner: A (Backend)
// Purpose: Request handling: users (administration) and roles
import * as usersService from '../services/users.service.js';
import { sendPaginated, sendSuccess } from '../utils/response.js';

export async function listRoles(_req, res) {
  return sendSuccess(res, await usersService.listRoles());
}

export async function listUsers(req, res) {
  const { active, role } = req.query;
  const { rows, total } = await usersService.listUsers({ active, role }, req.pagination);
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function createUser(req, res) {
  const user = await usersService.createUser(req.body, req.user);
  return sendSuccess(res, user, 201);
}

export async function updateUser(req, res) {
  const user = await usersService.updateUser(req.params.id, req.body, req.user);
  return sendSuccess(res, user);
}
