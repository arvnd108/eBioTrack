// Owner: B (Frontend)
// Purpose: API calls for auth
//
// CONTRACT section 10, Auth: POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me.

import type { LoginRequest, User } from '../types';
import { api } from './apiClient';

export async function login(credentials: LoginRequest): Promise<User> {
  const res = await api.post<User>('/auth/login', credentials);
  return res.data;
}

export async function logout(): Promise<void> {
  await api.post<void>('/auth/logout');
}

/** The signed-in user. Throws ApiError with status 401 when there is no session. */
export async function getCurrentUser(): Promise<User> {
  const res = await api.get<User>('/auth/me');
  return res.data;
}
