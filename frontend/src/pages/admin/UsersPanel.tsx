// Owner: B (Frontend)
// Purpose: User administration: list, filter, create, edit (administrator only, manage_users)

import { useCallback, useState } from 'react';
import { Badge } from '../../components/common/Badge';
import { DataTable, type Column } from '../../components/common/DataTable';
import { ErrorState } from '../../components/common/ErrorState';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { useFetch } from '../../hooks/useFetch';
import { usePagination } from '../../hooks/usePagination';
import type { PageMeta, Role, User } from '../../types';
import { humanize } from '../../utils/format';
import { UserForm } from './UserForm';

export function UsersPanel() {
  const { user: me } = useAuth();
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [role, setRole] = useState('');
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; user: User } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const pager = usePagination({ initialSort: 'full_name' });
  const roles = useFetch<Role[]>('/roles');
  const users = useFetch<User[], PageMeta>('/users', {
    active: active || undefined,
    role: role || undefined,
    ...pager.query,
  });
  const { resetPage } = pager;

  const filter = useCallback(
    (apply: () => void) => {
      apply();
      resetPage();
    },
    [resetPage],
  );

  if (!roles.data) {
    return roles.error ? (
      <ErrorState error={roles.error} title="Could not load roles" onRetry={roles.reload} />
    ) : (
      <LoadingState label="Loading roles…" />
    );
  }

  const columns: Column<User>[] = [
    { key: 'full_name', header: 'Name', sortField: 'full_name' },
    { key: 'email', header: 'Email', sortField: 'email' },
    {
      key: 'roles',
      header: 'Roles',
      render: (u) => (
        <span className="flex flex-wrap gap-1">
          {u.roles.map((r) => (
            <Badge key={r} value={r} tone="grey" />
          ))}
        </span>
      ),
    },
    {
      key: 'active',
      header: 'Status',
      render: (u) =>
        u.active ? (
          <Badge value="active" label="Active" />
        ) : (
          <Badge value="inactive" label="Inactive" tone="red" />
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (u) => (
        <button
          type="button"
          onClick={() => {
            setSaved(null);
            setForm({ mode: 'edit', user: u });
          }}
          aria-label={`Edit ${u.full_name}`}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100"
        >
          Edit
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-40">
            <FormField label="Status">
              <select
                value={active}
                onChange={(e) => filter(() => setActive(e.target.value as '' | 'true' | 'false'))}
                className={fieldControlClass()}
              >
                <option value="">All</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </FormField>
          </div>
          <div className="w-56">
            <FormField label="Role">
              <select
                value={role}
                onChange={(e) => filter(() => setRole(e.target.value))}
                className={fieldControlClass()}
              >
                <option value="">All roles</option>
                {roles.data.map((r) => (
                  <option key={r.role_id} value={r.role_name}>
                    {humanize(r.role_name)}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        </div>
        {!form && (
          <button
            type="button"
            onClick={() => {
              setSaved(null);
              setForm({ mode: 'create' });
            }}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            New user
          </button>
        )}
      </div>

      {saved && (
        <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
          {saved}
        </p>
      )}
      {form && (
        <UserForm
          key={form.mode === 'edit' ? form.user.user_id : 'new'}
          roles={roles.data}
          user={form.mode === 'edit' ? form.user : undefined}
          currentUserId={me?.user_id ?? 0}
          onCancel={() => setForm(null)}
          onSaved={(u) => {
            setSaved(
              form.mode === 'edit' ? `Saved changes to ${u.full_name}.` : `Created ${u.full_name}.`,
            );
            setForm(null);
            users.reload();
          }}
        />
      )}

      <DataTable
        caption="Users"
        columns={columns}
        rows={users.data}
        rowKey={(u) => u.user_id}
        loading={users.status === 'loading'}
        error={users.error}
        onRetry={users.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={users.meta ? { meta: users.meta, onPageChange: pager.setPage } : null}
        emptyTitle="No users match these filters"
      />
    </div>
  );
}
