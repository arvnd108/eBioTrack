// Owner: A (Backend)
// Purpose: Request handling: projects and members
import * as projectsService from '../services/projects.service.js';
import { sendNoContent, sendPaginated, sendSuccess } from '../utils/response.js';

export async function listProjects(req, res) {
  const { rows, total } = await projectsService.listProjects(
    req.user,
    { status: req.query.status },
    req.pagination,
  );
  return sendPaginated(res, rows, { ...req.pagination, total });
}

export async function createProject(req, res) {
  return sendSuccess(res, await projectsService.createProject(req.body, req.user), 201);
}

export async function getProject(req, res) {
  return sendSuccess(res, await projectsService.getProject(req.params.id, req.user));
}

export async function updateProject(req, res) {
  return sendSuccess(res, await projectsService.updateProject(req.params.id, req.body, req.user));
}

export async function addMember(req, res) {
  return sendSuccess(res, await projectsService.addMember(req.params.id, req.body, req.user), 201);
}

export async function removeMember(req, res) {
  await projectsService.removeMember(req.params.id, req.params.userId, req.user);
  return sendNoContent(res);
}

export async function addSite(req, res) {
  return sendSuccess(res, await projectsService.addSite(req.params.id, req.body, req.user), 201);
}

export async function removeSite(req, res) {
  await projectsService.removeSite(req.params.id, req.params.siteId, req.user);
  return sendNoContent(res);
}
