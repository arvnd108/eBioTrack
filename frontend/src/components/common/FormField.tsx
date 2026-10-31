// Owner: B (Frontend)
// Purpose: labelled input with validation message
//
// Wraps ONE form control (input, select or textarea) and connects it to its label, hint and
// error message, so screen readers announce them and every form looks the same:
//
//   <FormField label="Email" error={errors.email} required>
//     <input type="email" value={email} onChange={...} className={fieldControlClass(!!errors.email)} />
//   </FormField>
//
// The control gets `id`, `aria-invalid`, `aria-describedby` and `required` from here, so do
// not set those on it yourself.

import { cloneElement, isValidElement, useId, type ReactElement } from 'react';

interface FormFieldProps {
  label: string;
  /** Validation message; shown in red under the control and marks it invalid. */
  error?: string | null;
  /** Help text shown under the control when there is no error. */
  hint?: string;
  required?: boolean;
  /** Fix the control's id (otherwise generated). */
  id?: string;
  children: ReactElement<ControlProps>;
}

interface ControlProps {
  id?: string;
  required?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** Tailwind classes for a text input, select or textarea, red when invalid. */
export function fieldControlClass(invalid = false): string {
  return [
    'mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900',
    'focus:outline-none focus:ring-2 disabled:bg-slate-100',
    invalid
      ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
      : 'border-slate-300 focus:border-emerald-600 focus:ring-emerald-200',
  ].join(' ');
}

export function FormField({ label, error, hint, required, id, children }: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field-${generatedId}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        required,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })
    : children;

  return (
    <div>
      <label htmlFor={controlId} className="block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-red-600">
            *
          </span>
        )}
      </label>
      {control}
      {error ? (
        <p id={errorId} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="mt-1 text-xs text-slate-500">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
