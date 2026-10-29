// Owner: B (Frontend)
// Purpose: Sign in
//
// Minimal sign-in from T08 so the protected shell can be reached. T24 rebuilds the form with
// the shared FormField component and client-side validation.

import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { isApiError, isMockMode } from '../services/apiClient';
import { mockUsers } from '../services/mock/fixtures';

export default function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') return <Navigate to={from} replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
      navigate(from, { replace: true });
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        noValidate
      >
        <div>
          <h1 className="text-2xl font-semibold text-emerald-700">eBioTrack</h1>
          <p className="text-sm text-slate-600">Sign in to continue</p>
        </div>

        <label className="block text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
            required
          />
        </label>

        <label className="block text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
            required
          />
        </label>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        {isMockMode() && (
          <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-medium">Mock mode: pick a user, any password works</p>
            <ul className="mt-1 space-y-0.5">
              {mockUsers.map((u) => (
                <li key={u.user_id}>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setEmail(u.email);
                      setPassword('dev');
                    }}
                  >
                    {u.email}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </main>
  );
}
