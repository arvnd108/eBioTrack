// Owner: B (Frontend)
// Purpose: redirect when not signed in or not permitted
//
// Wraps routes in routes.tsx. Signed-out users go to /login (and come back afterwards unless
// they signed out on purpose); `anyOf` limits a route to users who may perform at least one of
// the listed actions (src/permissions.ts), which matches what the sidebar shows.

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import type { Action } from '../../permissions';
import { ErrorState } from '../common/ErrorState';
import { LoadingState } from '../common/LoadingState';

interface ProtectedRouteProps {
  /** Actions that unlock this route (any one is enough). Omit for "any signed-in user". */
  anyOf?: readonly Action[];
}

/** Where /login sends the user after signing in, and why they were sent there. */
export interface LoginRedirectState {
  from?: string;
  reason?: 'expired';
}

export function ProtectedRoute({ anyOf }: ProtectedRouteProps) {
  const { status, sessionError, refresh, canAny } = useAuth();
  const location = useLocation();
  const here = location.pathname + location.search;

  switch (status) {
    case 'loading':
      return <LoadingState label="Checking your session…" />;
    case 'unavailable':
      return (
        <div className="mx-auto max-w-xl p-8">
          <ErrorState error={sessionError} title="Could not check your session" onRetry={refresh} />
        </div>
      );
    case 'signed_out':
      return <Navigate to="/login" replace />;
    case 'expired':
      return (
        <Navigate
          to="/login"
          replace
          state={{ from: here, reason: 'expired' } satisfies LoginRedirectState}
        />
      );
    case 'anonymous':
      return <Navigate to="/login" replace state={{ from: here } satisfies LoginRedirectState} />;
    case 'authenticated':
      break;
  }

  if (anyOf && anyOf.length > 0 && !canAny(anyOf)) {
    return (
      <div role="alert" className="mx-auto max-w-xl p-8">
        <h1 className="text-xl font-semibold">Not permitted</h1>
        <p className="mt-2 text-slate-600">
          Your role does not have access to this page. Ask an administrator if you need it.
        </p>
      </div>
    );
  }

  return <Outlet />;
}
