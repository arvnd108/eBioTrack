// Owner: B (Frontend)
// Purpose: API calls for projects
//
// CONTRACT 10, Projects; built in backend routes/projects.routes.js (T20). Lists are read with
// useFetch('/projects', ...) on the pages; these functions are for single reads and writes.

import type {
  AddMemberRequest,
  CreateProjectRequest,
  Project,
  ProjectDetail,
  ProjectMember,
  ProjectSiteLink,
  UpdateProjectRequest,
} from '../types';
import { api } from './apiClient';

/** Administrator or principal investigator; the caller becomes the owner. */
export async function createProject(body: CreateProjectRequest): Promise<Project> {
  return (await api.post<Project>('/projects', body)).data;
}

export async function getProject(projectId: number): Promise<ProjectDetail> {
  return (await api.get<ProjectDetail>(`/projects/${projectId}`)).data;
}

/** Administrator, or a principal investigator who is the project's owner or manager. */
export async function updateProject(
  projectId: number,
  body: UpdateProjectRequest,
): Promise<Project> {
  return (await api.patch<Project>(`/projects/${projectId}`, body)).data;
}

export async function addMember(projectId: number, body: AddMemberRequest): Promise<ProjectMember> {
  return (await api.post<ProjectMember>(`/projects/${projectId}/members`, body)).data;
}

export async function removeMember(projectId: number, userId: number): Promise<void> {
  await api.delete(`/projects/${projectId}/members/${userId}`);
}

export async function addSite(projectId: number, siteId: number): Promise<ProjectSiteLink> {
  return (await api.post<ProjectSiteLink>(`/projects/${projectId}/sites`, { site_id: siteId }))
    .data;
}

/** Refused with 409 `conflict` while collection events in this project use the site. */
export async function removeSite(projectId: number, siteId: number): Promise<void> {
  await api.delete(`/projects/${projectId}/sites/${siteId}`);
}
