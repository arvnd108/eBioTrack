// Owner: B (Frontend)
// Purpose: redirect when not signed in or not permitted

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import type { RoleName } from '../../types';

interface ProtectedRouteProps {
  /** Global roles allowed in. Leave empty for "any signed-in user". */
  roles?: RoleName[];
}

export function ProtectedRoute({ roles }: ProtectedRouteProps) {
  const { status, hasRole } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <p role="status" className="p-8 text-slate-500">
        Checking your session…
      </p>
    );
  }

  if (status === 'signed_out') {
    return <Navigate to="/login" replace />;
  }

  if (status === 'anonymous') {
    // Remember where the user was going so login can send them back.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (roles && roles.length > 0 && !hasRole(...roles)) {
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
