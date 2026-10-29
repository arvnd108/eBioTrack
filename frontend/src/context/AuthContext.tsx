// Owner: B (Frontend)
// Purpose: Current user and role state
//
// Minimal version from T08 so protected routes work. T24 adds the full login flow on top.

import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginRequest, RoleName, User } from '../types';
import * as authService from '../services/authService';

/**
 * `anonymous`: no session when the app loaded (login sends the user back where they were going).
 * `signed_out`: the user just signed out (login starts fresh at the dashboard).
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'signed_out';

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  login: (credentials: LoginRequest) => Promise<User>;
  logout: () => Promise<void>;
  /** True if the user holds any of the roles. Administrators pass every role check. */
  hasRole: (...roles: RoleName[]) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // On first load, ask the API whether a session cookie is already present.
  useEffect(() => {
    let cancelled = false;
    authService
      .getCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => {
        // 401 (no session) or the API is unreachable: treat as signed out.
        if (cancelled) return;
        setUser(null);
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials: LoginRequest) => {
    const me = await authService.login(credentials);
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } finally {
      setUser(null);
      setStatus('signed_out');
    }
  }, []);

  const hasRole = useCallback(
    (...roles: RoleName[]) =>
      !!user && (user.roles.includes('administrator') || user.roles.some((r) => roles.includes(r))),
    [user],
  );

  const value = useMemo(
    () => ({ user, status, login, logout, hasRole }),
    [user, status, login, logout, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
