// Owner: B (Frontend)
// Purpose: Current user and role state
//
// Holds the signed-in user (CONTRACT 11 user object), signs in and out through
// /api/auth/login|logout|me (CONTRACT 10, Auth), and answers permission questions with the same
// matrix the API enforces (src/permissions.ts). Works the same in mock and real mode.

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LoginRequest, Project, ProjectRole, RegisterRequest, RoleName, User } from '../types';
import * as authService from '../services/authService';
import { api, isApiError, setUnauthenticatedHandler } from '../services/apiClient';
import { can as canDo, canAny as canDoAny, type Action } from '../permissions';

/**
 * - `loading`: asking the API whether a session already exists (first load, or Retry).
 * - `authenticated`: `user` is set.
 * - `anonymous`: no session on load; after login the user goes back where they were heading.
 * - `expired`: was signed in, then a request came back 401 (session timed out or the account was
 *   deactivated); the login page says so and returns the user to the same page.
 * - `signed_out`: the user clicked Sign out; login starts fresh at the dashboard.
 * - `unavailable`: the session check failed for another reason (API down, network); the user
 *   gets an error with Retry instead of a misleading login form.
 */
export type AuthStatus =
  'loading' | 'authenticated' | 'anonymous' | 'expired' | 'signed_out' | 'unavailable';

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  /** The error from the last session check when `status` is `unavailable`. */
  sessionError: unknown;
  login: (credentials: LoginRequest) => Promise<User>;
  /** Creates an account and signs in as it. */
  register: (details: RegisterRequest) => Promise<User>;
  logout: () => Promise<void>;
  /** Re-runs the session check (Retry after `unavailable`). */
  refresh: () => Promise<void>;
  /** The project roles the user holds in any project (for labels; `can` already uses them). */
  projectRoles: readonly ProjectRole[];
  /** Re-reads the project roles the user holds; call after creating a project or changing members. */
  reloadHeldRoles: () => Promise<void>;
  /** True if the user holds any of the roles. Administrators pass every role check. */
  hasRole: (...roles: RoleName[]) => boolean;
  /** Permission check with the API's matrix; see `can` in src/permissions.ts. */
  can: (action: Action, projectRole?: ProjectRole | null) => boolean;
  /** True when the user may perform at least one of the actions. */
  canAny: (actions: readonly Action[], projectRole?: ProjectRole | null) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** The project roles the user holds in any project; empty if the list cannot be read. */
async function loadHeldRoles(): Promise<ProjectRole[]> {
  try {
    const res = await api.get<Project[]>('/projects?limit=100');
    return [...new Set(res.data.flatMap((p) => (p.your_role ? [p.your_role] : [])))];
  } catch {
    return []; // pages that need a project ask for it themselves
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [sessionError, setSessionError] = useState<unknown>(null);
  // The project roles this user holds in any project, so questions without a single project
  // ("may I create a site at all?") also count roles given by project membership.
  const [heldRoles, setHeldRoles] = useState<ProjectRole[]>([]);
  // Ignores answers to a session check that a newer check (or login/logout) has replaced.
  const checkId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++checkId.current;
    setStatus('loading');
    setSessionError(null);
    try {
      const me = await authService.getCurrentUser();
      const held = await loadHeldRoles();
      if (id !== checkId.current) return;
      setHeldRoles(held);
      setUser(me);
      setStatus('authenticated');
    } catch (err) {
      if (id !== checkId.current) return;
      setUser(null);
      if (isApiError(err) && err.status === 401) {
        setStatus('anonymous'); // no session yet: normal before signing in
      } else {
        setSessionError(err);
        setStatus('unavailable');
      }
    }
  }, []);

  // On first load, ask the API whether a session cookie is already present.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The current user for the 401 handler below, which is registered once.
  const userRef = useRef<User | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Any later 401 `unauthenticated` (session timed out, account deactivated) signs out here too.
  useEffect(
    () =>
      setUnauthenticatedHandler(() => {
        if (!userRef.current) return; // already signed out: nothing to expire
        checkId.current += 1;
        userRef.current = null;
        setUser(null);
        setStatus('expired');
      }),
    [],
  );

  const login = useCallback(async (credentials: LoginRequest) => {
    checkId.current += 1;
    const me = await authService.login(credentials);
    setHeldRoles(await loadHeldRoles());
    setUser(me);
    setSessionError(null);
    setStatus('authenticated');
    return me;
  }, []);

  const register = useCallback(async (details: RegisterRequest) => {
    checkId.current += 1;
    const me = await authService.register(details);
    setHeldRoles(await loadHeldRoles());
    setUser(me);
    setSessionError(null);
    setStatus('authenticated');
    return me;
  }, []);

  const logout = useCallback(async () => {
    checkId.current += 1;
    try {
      await authService.logout();
    } finally {
      // Clear locally even if the request failed, so the screen never shows a stale user.
      setUser(null);
      setHeldRoles([]);
      setStatus('signed_out');
    }
  }, []);

  const reloadHeldRoles = useCallback(async () => {
    setHeldRoles(await loadHeldRoles());
  }, []);

  const hasRole = useCallback(
    (...roles: RoleName[]) =>
      !!user && (user.roles.includes('administrator') || user.roles.some((r) => roles.includes(r))),
    [user],
  );

  const can = useCallback(
    (action: Action, projectRole?: ProjectRole | null) =>
      canDo(user, action, projectRole, heldRoles),
    [user, heldRoles],
  );

  const canAny = useCallback(
    (actions: readonly Action[], projectRole?: ProjectRole | null) =>
      canDoAny(user, actions, projectRole, heldRoles),
    [user, heldRoles],
  );

  const value = useMemo(
    () => ({
      user,
      status,
      sessionError,
      login,
      register,
      logout,
      refresh,
      projectRoles: heldRoles,
      reloadHeldRoles,
      hasRole,
      can,
      canAny,
    }),
    [
      user,
      status,
      sessionError,
      login,
      register,
      logout,
      refresh,
      heldRoles,
      reloadHeldRoles,
      hasRole,
      can,
      canAny,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
