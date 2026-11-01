// Owner: B (Frontend)
// Purpose: Create or edit a user (administrator only; backend routes/users.routes.js)
//
// Limits from the API: full name 1–200 characters; a valid email (lowercased by the API);
// password 8 characters to 72 bytes (set at creation only; there is no password-change endpoint);
// at least one role, no duplicates. Lock-out rules the API enforces (422 rule_violation):
// you cannot deactivate yourself or remove your own administrator role, and the last active
// administrator cannot be deactivated or lose the role. The form explains the first two up front.

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createUser, updateUser } from '../../services/usersService';
import type { Role, UpdateUserRequest, User } from '../../types';
import { humanize } from '../../utils/format';

const FIELDS = ['full_name', 'email', 'password', 'role_ids', 'active'] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserFormProps {
  roles: Role[];
  /** The user being edited; leave out to create one. */
  user?: User;
  /** The signed-in administrator (for the lock-out rules). */
  currentUserId: number;
  onSaved: (user: User) => void;
  onCancel: () => void;
}

export function UserForm({ roles, user, currentUserId, onSaved, onCancel }: UserFormProps) {
  const editing = !!user;
  const self = user?.user_id === currentUserId;
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(user?.active ?? true);
  const [roleIds, setRoleIds] = useState<number[]>(
    user ? roles.filter((r) => user.roles.includes(r.role_name)).map((r) => r.role_id) : [],
  );
  const [errors, setErrors] = useState<Errors>({});
  const [note, setNote] = useState<string | null>(null);
  const create = useSubmit(createUser);
  const update = useSubmit(updateUser);
  const save = editing ? update : create;

  const adminRoleId = roles.find((r) => r.role_name === 'administrator')?.role_id;
  const lockedRoleId = self && user?.roles.includes('administrator') ? adminRoleId : undefined;

  function toggleRole(roleId: number) {
    setRoleIds((current) =>
      current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId],
    );
  }

  function check(): Errors {
    const found: Errors = {};
    const name = fullName.trim();
    if (!name) found.full_name = 'Enter the full name.';
    else if (name.length > 200) found.full_name = 'Full name must be at most 200 characters.';
    if (!editing) {
      const address = email.trim();
      if (!address) found.email = 'Enter an email address.';
      else if (!EMAIL.test(address) || address.length > 254) {
        found.email = 'Enter a valid email address, like name@example.org.';
      }
      if (password.length < 8) found.password = 'Password must be at least 8 characters.';
      else if (new TextEncoder().encode(password).length > 72) {
        found.password = 'Password must be at most 72 bytes.';
      }
    }
    if (roleIds.length === 0) found.role_ids = 'Choose at least one role.';
    return found;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote(null);
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const sortedRoles = [...roleIds].sort((a, b) => a - b);
    if (!editing) {
      const created = await create.run({
        full_name: fullName.trim(),
        email: email.trim(),
        password,
        role_ids: sortedRoles,
      });
      if (created) onSaved(created);
      return;
    }

    const changes: UpdateUserRequest = {};
    if (fullName.trim() !== user.full_name) changes.full_name = fullName.trim();
    if (active !== user.active) changes.active = active;
    const before = roles
      .filter((r) => user.roles.includes(r.role_name))
      .map((r) => r.role_id)
      .sort((a, b) => a - b);
    if (before.join() !== sortedRoles.join()) changes.role_ids = sortedRoles;
    if (Object.keys(changes).length === 0) {
      setNote('Nothing has changed.');
      return;
    }
    const saved = await update.run(user.user_id, changes);
    if (saved) onSaved(saved);
  }

  const server = save.error
    ? formErrors(save.error, FIELDS, {
        duplicate: { field: 'email', message: 'A user with this email address already exists.' },
      })
    : { fieldErrors: {}, formError: null };
  const fieldError = (field: Field) => errors[field] ?? server.fieldErrors[field];

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={editing ? `Edit ${user.full_name}` : 'New user'}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">{editing ? `Edit ${user.full_name}` : 'New user'}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Full name" error={fieldError('full_name')} required>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="off"
            className={fieldControlClass(!!fieldError('full_name'))}
          />
        </FormField>
        {editing ? (
          <FormField label="Email" hint="The email address cannot be changed.">
            <input value={user.email} readOnly disabled className={fieldControlClass()} />
          </FormField>
        ) : (
          <FormField label="Email" error={fieldError('email')} required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              className={fieldControlClass(!!fieldError('email'))}
            />
          </FormField>
        )}
        {!editing && (
          <FormField
            label="Password"
            error={fieldError('password')}
            hint="At least 8 characters. Share it with the person securely; it cannot be changed here later."
            required
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className={fieldControlClass(!!fieldError('password'))}
            />
          </FormField>
        )}
      </div>

      <fieldset aria-describedby={fieldError('role_ids') ? 'role-error' : undefined}>
        <legend className="text-sm font-medium text-slate-700">
          Roles
          <span aria-hidden="true" className="ml-0.5 text-red-600">
            *
          </span>
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {roles.map((r) => {
            const locked = r.role_id === lockedRoleId;
            return (
              <label key={r.role_id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roleIds.includes(r.role_id)}
                  onChange={() => toggleRole(r.role_id)}
                  disabled={locked}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{humanize(r.role_name)}</span>
                  <span className="block text-xs text-slate-500">
                    {locked ? 'You cannot remove your own administrator role.' : r.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {fieldError('role_ids') && (
          <p id="role-error" className="mt-1 text-sm text-red-700">
            {fieldError('role_ids')}
          </p>
        )}
      </fieldset>

      {editing && (
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={self}
            />
            <span className="font-medium">Active</span>
          </label>
          <p className="mt-1 text-xs text-slate-500">
            {self
              ? 'You cannot deactivate your own account.'
              : 'A deactivated user cannot sign in and is signed out at once.'}
          </p>
          {fieldError('active') && (
            <p className="mt-1 text-sm text-red-700">{fieldError('active')}</p>
          )}
        </div>
      )}

      {note && (
        <p role="status" className="text-sm text-slate-600">
          {note}
        </p>
      )}
      {server.formError && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {server.formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.submitting}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
