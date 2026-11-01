// Owner: B (Frontend)
// Purpose: Sign in
//
// POST /api/auth/login (CONTRACT 10, Auth). Behaves the same against the mock and the real API
// (backend/src/routes/auth.routes.js, controllers/auth.controller.js):
//   - fields are checked here first, with plain messages, and nothing is sent until they pass;
//   - 422 validation_error from the server is shown on the matching field;
//   - 401 invalid_credentials: one message for a wrong email OR password (the API does not say
//     which, so neither do we); the password is cleared and focused;
//   - 429 too_many_attempts: says how long to wait (Retry-After);
//   - network and server errors get a plain sentence (services/errorMessages.ts).
// After signing in the user goes back to the page they were heading to (ProtectedRoute passes
// it in the location state), or to the dashboard.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ErrorState } from '../components/common/ErrorState';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { LoadingState } from '../components/common/LoadingState';
import type { LoginRedirectState } from '../components/layout/ProtectedRoute';
import { useAuth } from '../hooks/useAuth';
import { isApiError, isMockMode } from '../services/apiClient';
import { errorMessage } from '../services/errorMessages';
import { DEV_PASSWORD, mockUsers } from '../services/mock/fixtures';

interface FieldErrors {
  email?: string;
  password?: string;
}

/** Same limits as the API (backend auth.routes.js): a valid email, and 1 to 72 bytes of password. */
export function validateLogin(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  const trimmed = email.trim();
  if (!trimmed) errors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) {
    errors.email = 'Enter a valid email address, like name@example.org.';
  }
  if (!password) errors.password = 'Enter your password.';
  else if (new TextEncoder().encode(password).length > 72) {
    errors.password = 'Password must be at most 72 bytes.';
  }
  return errors;
}

/** Only follow redirects inside this app (never to another site or back to /login). */
function safeRedirect(from: string | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/login')) {
    return '/';
  }
  return from;
}

export default function LoginPage() {
  const { status, sessionError, refresh, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirect = (location.state as LoginRedirectState | null) ?? {};
  const from = safeRedirect(redirect.from);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  if (status === 'loading' && !submitting) {
    return <LoadingState label="Checking your session…" />;
  }
  if (status === 'authenticated' && !submitting) {
    return <Navigate to={from} replace />;
  }

  // After the first attempt, re-check as the user types so fixed fields clear at once.
  function update(field: keyof FieldErrors, value: string) {
    if (field === 'email') setEmail(value);
    else setPassword(value);
    if (submitted) {
      const next = validateLogin(
        field === 'email' ? value : email,
        field === 'password' ? value : password,
      );
      setFieldErrors((current) => ({ ...current, [field]: next[field] }));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setFormError(null);

    const errors = validateLogin(email, password);
    setFieldErrors(errors);
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();

    setSubmitting(true);
    try {
      await login({ email: email.trim(), password });
      navigate(from, { replace: true });
    } catch (err) {
      if (isApiError(err) && err.code === 'validation_error') {
        const serverErrors: FieldErrors = {
          email: err.fieldMessage('email'),
          password: err.fieldMessage('password'),
        };
        setFieldErrors(serverErrors);
        if (serverErrors.email) emailRef.current?.focus();
        else if (serverErrors.password) passwordRef.current?.focus();
        else setFormError(err.message);
      } else if (isApiError(err) && err.code === 'invalid_credentials') {
        setPassword('');
        setFormError('Invalid email or password.');
        passwordRef.current?.focus();
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
          noValidate
          aria-labelledby="login-heading"
        >
          <div>
            <h1 id="login-heading" className="text-2xl font-semibold text-emerald-700">
              eBioTrack
            </h1>
            <p className="text-sm text-slate-600">Sign in to continue</p>
          </div>

          {status === 'expired' || redirect.reason === 'expired' ? (
            <p role="status" className="rounded-md bg-sky-50 p-2 text-sm text-sky-800">
              Your session has ended. Please sign in again.
            </p>
          ) : null}

          {status === 'unavailable' && (
            <ErrorState
              error={sessionError}
              title="Could not check your session"
              onRetry={refresh}
            />
          )}

          <FormField label="Email" error={fieldErrors.email} required>
            <input
              ref={emailRef}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => update('email', e.target.value)}
              disabled={submitting}
              className={fieldControlClass(!!fieldErrors.email)}
            />
          </FormField>

          <FormField label="Password" error={fieldErrors.password} required>
            <input
              ref={passwordRef}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => update('password', e.target.value)}
              disabled={submitting}
              className={fieldControlClass(!!fieldErrors.password)}
            />
          </FormField>

          {formError && (
            <p
              ref={formErrorRef}
              role="alert"
              tabIndex={-1}
              className="rounded-md bg-red-50 p-2 text-sm text-red-700 focus:outline-none"
            >
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {isMockMode() && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-medium">Mock mode: fill in a seeded user</p>
            <p className="mt-0.5">
              All six share the development password from tests/fixtures/README.md.
            </p>
            <ul className="mt-2 space-y-0.5">
              {mockUsers.map((u) => (
                <li key={u.user_id}>
                  <button
                    type="button"
                    className="underline hover:text-amber-700"
                    onClick={() => {
                      setEmail(u.email);
                      setPassword(DEV_PASSWORD);
                      setFieldErrors({});
                      setFormError(null);
                    }}
                  >
                    {u.email}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
