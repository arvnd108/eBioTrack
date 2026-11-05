// Owner: B (Frontend)
// Purpose: Create an account
//
// POST /api/auth/register (backend routes/auth.routes.js). Only full name, email and password are
// required; organization, job title and phone can be left empty and are then not sent. The new
// account gets the viewer role (an administrator can grant more) and is signed in straight away.
//   - fields are checked here first with plain messages; 422 from the server lands on its field;
//   - 409 email_taken is shown on the email field.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { LoadingState } from '../components/common/LoadingState';
import { useAuth } from '../hooks/useAuth';
import { isApiError } from '../services/apiClient';
import { errorMessage } from '../services/errorMessages';
import type { RegisterRequest } from '../types';

type Field =
  'full_name' | 'email' | 'password' | 'confirm' | 'organization' | 'job_title' | 'phone';
type FieldErrors = Partial<Record<Field, string>>;
type Values = Record<Field, string>;

const EMPTY: Values = {
  full_name: '',
  email: '',
  password: '',
  confirm: '',
  organization: '',
  job_title: '',
  phone: '',
};
const ORDER: Field[] = [
  'full_name',
  'email',
  'password',
  'confirm',
  'organization',
  'job_title',
  'phone',
];

/** Same limits as the API (backend auth.routes.js registerBody). */
export function validateRegister(values: Values): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.full_name.trim();
  if (!name) errors.full_name = 'Enter your full name.';
  else if (name.length > 200) errors.full_name = 'Name must be at most 200 characters.';

  const email = values.email.trim();
  if (!email) errors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    errors.email = 'Enter a valid email address, like name@example.org.';
  }

  if (!values.password) errors.password = 'Choose a password.';
  else if (values.password.length < 8) errors.password = 'Password must be at least 8 characters.';
  else if (new TextEncoder().encode(values.password).length > 72) {
    errors.password = 'Password must be at most 72 bytes.';
  }

  if (!errors.password && values.confirm !== values.password) {
    errors.confirm = 'Passwords do not match.';
  }

  if (values.organization.trim().length > 200) errors.organization = 'At most 200 characters.';
  if (values.job_title.trim().length > 200) errors.job_title = 'At most 200 characters.';
  if (values.phone.trim().length > 40) errors.phone = 'At most 40 characters.';
  return errors;
}

export default function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState<Values>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  if (status === 'loading' && !submitting) return <LoadingState label="Checking your session…" />;
  if (status === 'authenticated' && !submitting) return <Navigate to="/" replace />;

  function update(field: Field, value: string) {
    const next = { ...values, [field]: value };
    setValues(next);
    if (submitted) {
      const errors = validateRegister(next);
      // Typing in the password can also fix or break the confirmation.
      setFieldErrors((current) => ({
        ...current,
        [field]: errors[field],
        ...(field === 'password' ? { confirm: errors.confirm } : {}),
      }));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setFormError(null);

    const errors = validateRegister(values);
    setFieldErrors(errors);
    const firstBad = ORDER.find((f) => errors[f]);
    if (firstBad) return refs.current[firstBad]?.focus();

    // Empty optional fields are skipped, not sent as "".
    const body: RegisterRequest = {
      full_name: values.full_name.trim(),
      email: values.email.trim(),
      password: values.password,
    };
    for (const f of ['organization', 'job_title', 'phone'] as const) {
      const v = values[f].trim();
      if (v) body[f] = v;
    }

    setSubmitting(true);
    try {
      await register(body);
      navigate('/', { replace: true });
    } catch (err) {
      if (isApiError(err) && err.code === 'validation_error') {
        const serverErrors: FieldErrors = {};
        for (const f of [
          'full_name',
          'email',
          'password',
          'organization',
          'job_title',
          'phone',
        ] as const) {
          serverErrors[f] = err.fieldMessage(f);
        }
        setFieldErrors(serverErrors);
        const bad = ORDER.find((f) => serverErrors[f]);
        if (bad) refs.current[bad]?.focus();
        else setFormError(err.message);
      } else if (isApiError(err) && err.code === 'email_taken') {
        setFieldErrors({ email: 'An account with this email already exists.' });
        refs.current.email?.focus();
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const input = (
    field: Field,
    props: { type?: string; autoComplete?: string; inputMode?: 'email' | 'tel' } = {},
  ) => (
    <input
      ref={(el) => {
        refs.current[field] = el;
      }}
      type={props.type ?? 'text'}
      name={field}
      autoComplete={props.autoComplete}
      inputMode={props.inputMode}
      value={values[field]}
      onChange={(e) => update(field, e.target.value)}
      disabled={submitting}
      className={fieldControlClass(!!fieldErrors[field])}
    />
  );

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
          noValidate
          aria-labelledby="register-heading"
        >
          <div>
            <h1 id="register-heading" className="text-2xl font-semibold text-emerald-700">
              Create an account
            </h1>
            <p className="text-sm text-slate-600">
              Name, email and password are required. The rest is optional.
            </p>
          </div>

          <FormField label="Full name" error={fieldErrors.full_name} required>
            {input('full_name', { autoComplete: 'name' })}
          </FormField>
          <FormField label="Email" error={fieldErrors.email} required>
            {input('email', { type: 'email', autoComplete: 'username', inputMode: 'email' })}
          </FormField>
          <FormField
            label="Password"
            error={fieldErrors.password}
            hint="At least 8 characters."
            required
          >
            {input('password', { type: 'password', autoComplete: 'new-password' })}
          </FormField>
          <FormField label="Confirm password" error={fieldErrors.confirm} required>
            {input('confirm', { type: 'password', autoComplete: 'new-password' })}
          </FormField>

          <fieldset className="space-y-4 border-t border-slate-200 pt-4">
            <legend className="text-sm font-medium text-slate-500">Optional details</legend>
            <FormField label="Organization" error={fieldErrors.organization}>
              {input('organization', { autoComplete: 'organization' })}
            </FormField>
            <FormField label="Job title" error={fieldErrors.job_title}>
              {input('job_title', { autoComplete: 'organization-title' })}
            </FormField>
            <FormField label="Phone" error={fieldErrors.phone}>
              {input('phone', { type: 'tel', autoComplete: 'tel', inputMode: 'tel' })}
            </FormField>
          </fieldset>

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
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link to="/login" className="text-emerald-700 underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
