// Owner: B (Frontend)
// Purpose: API calls for users and roles (administration)
//
// CONTRACT 10, Users (administration); built in backend routes/users.routes.js (T20). Only an
// administrator may list, create or change users; GET /api/roles is open to any signed-in user.
// The user list is read with useFetch('/users', ...) on the Administration page.

import type { CreateUserRequest, Role, UpdateUserRequest, User } from '../types';
import { api } from './apiClient';

export async function listRoles(): Promise<Role[]> {
  return (await api.get<Role[]>('/roles')).data;
}

export async function createUser(body: CreateUserRequest): Promise<User> {
  return (await api.post<User>('/users', body)).data;
}

/**
 * The API refuses (422 rule_violation) deactivating your own account, removing your own
 * administrator role, and leaving no active administrator.
 */
export async function updateUser(userId: number, body: UpdateUserRequest): Promise<User> {
  return (await api.patch<User>(`/users/${userId}`, body)).data;
}
