// Owner: B (Frontend)
// Purpose: Audit log (GET /api/audit): administrators see everything, principal investigators
//          the entries about their own projects, newest first
//
// Each entry is one row change written by the audit trigger (database/triggers/access_triggers.sql):
// insert -> { column: { new } }, delete -> { column: { old } }, update -> changed columns
// { column: { old, new } }; a sign-in has no details. The table summarises the change and the
// full details open underneath. Actor names come from GET /api/users, which only an
// administrator may read; others see the user ID.

import { useMemo, useState, type FormEvent } from 'react';
import { Badge } from '../../components/common/Badge';
import { DataTable, type Column } from '../../components/common/DataTable';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useAuth } from '../../hooks/useAuth';
import { useFetch } from '../../hooks/useFetch';
import { usePagination } from '../../hooks/usePagination';
import { auditQuery, type AuditFilters } from '../../services/auditService';
import type { AuditEntry, PageMeta, User } from '../../types';
import { formatDateTime, humanize, todayLocal } from '../../utils/format';

/** Tables with an audit trigger (database/triggers/*.sql). */
const ENTITY_TYPES = [
  'projects',
  'project_members',
  'project_sites',
  'users',
  'user_roles',
  'sampling_sites',
  'collection_events',
  'samples',
  'dna_extractions',
  'sequencing_libraries',
  'sequencing_runs',
  'quality_control_results',
  'analysis_runs',
  'taxon_assignments',
  'taxa',
  'dna_markers',
  'data_exports',
];

const show = (value: unknown) =>
  value === null || value === undefined
    ? '∅'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

/** One line describing an entry's details. */
export function summarizeChange(entry: AuditEntry): string {
  if (entry.action === 'login') return 'Signed in';
  const details = entry.details as Record<string, { old?: unknown; new?: unknown }> | null;
  if (!details || Object.keys(details).length === 0) return '—';
  const keys = Object.keys(details);
  if (entry.action === 'update') {
    return keys.map((k) => `${k}: ${show(details[k].old)} → ${show(details[k].new)}`).join('; ');
  }
  return keys
    .map((k) => `${k}: ${show(entry.action === 'delete' ? details[k].old : details[k].new)}`)
    .join('; ');
}

const EMPTY: AuditFilters = {};

export function AuditPanel() {
  const { user, can } = useAuth();
  const isAdmin = can('manage_users');
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY);
  const [dateError, setDateError] = useState<string | null>(null);
  const pager = usePagination();
  const entries = useFetch<AuditEntry[], PageMeta>('/audit', {
    ...auditQuery(applied),
    ...pager.query,
  });
  const users = useFetch<User[], PageMeta>(isAdmin ? '/users' : null, {
    limit: 100,
    sort: 'full_name',
  });

  const names = useMemo(
    () => new Map((users.data ?? []).map((u) => [u.user_id, u.full_name])),
    [users.data],
  );
  // Only administrators can list users; anyone else sees their own actions as "You" and the
  // rest by user ID.
  const actorName = (id: number | null) =>
    id === null ? 'System' : (names.get(id) ?? (id === user?.user_id ? 'You' : `User ${id}`));

  function set<K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from_date && draft.to_date && draft.from_date > draft.to_date) {
      setDateError('The "from" day must not be after the "to" day.');
      return;
    }
    setDateError(null);
    setApplied(draft);
    pager.resetPage();
  }

  function clear() {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setDateError(null);
    pager.resetPage();
  }

  const columns: Column<AuditEntry>[] = [
    { key: 'created_at', header: 'When', render: (e) => formatDateTime(e.created_at) },
    { key: 'actor_id', header: 'Who', render: (e) => actorName(e.actor_id) },
    { key: 'action', header: 'Action', render: (e) => <Badge value={e.action} /> },
    {
      key: 'entity',
      header: 'Record',
      render: (e) => `${humanize(e.entity_type)} #${e.entity_id}`,
    },
    {
      key: 'details',
      header: 'Change',
      render: (e) => {
        const summary = summarizeChange(e);
        return e.details ? (
          <details>
            <summary className="max-w-md cursor-pointer truncate text-slate-700">{summary}</summary>
            <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">
              {JSON.stringify(e.details, null, 2)}
            </pre>
          </details>
        ) : (
          summary
        );
      },
    },
  ];

  const anyFilter = Object.values(applied).some(Boolean);

  return (
    <div className="space-y-4">
      {!isAdmin && (
        <p className="text-sm text-slate-600">
          You see changes to records in projects you belong to.
        </p>
      )}
      <form
        onSubmit={apply}
        noValidate
        aria-label="Filter audit log"
        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6"
      >
        <FormField label="Record type">
          <select
            value={draft.entity_type ?? ''}
            onChange={(e) => set('entity_type', e.target.value)}
            className={fieldControlClass()}
          >
            <option value="">Any</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Record ID">
          <input
            inputMode="numeric"
            value={draft.entity_id ?? ''}
            onChange={(e) => set('entity_id', e.target.value.replace(/[^\d]/g, ''))}
            className={fieldControlClass()}
          />
        </FormField>
        <FormField label="Who">
          {isAdmin && users.data ? (
            <select
              value={draft.actor_id ?? ''}
              onChange={(e) => set('actor_id', e.target.value)}
              className={fieldControlClass()}
            >
              <option value="">Anyone</option>
              {users.data.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          ) : (
            <input
              inputMode="numeric"
              placeholder="User ID"
              value={draft.actor_id ?? ''}
              onChange={(e) => set('actor_id', e.target.value.replace(/[^\d]/g, ''))}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        <FormField label="From day" error={dateError}>
          <input
            type="date"
            value={draft.from_date ?? ''}
            max={todayLocal()}
            onChange={(e) => set('from_date', e.target.value)}
            className={fieldControlClass(!!dateError)}
          />
        </FormField>
        <FormField label="To day">
          <input
            type="date"
            value={draft.to_date ?? ''}
            onChange={(e) => set('to_date', e.target.value)}
            className={fieldControlClass()}
          />
        </FormField>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={clear}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            Clear
          </button>
        </div>
      </form>

      <DataTable
        caption="Audit entries"
        columns={columns}
        rows={entries.data}
        rowKey={(e) => e.audit_id}
        loading={entries.status === 'loading'}
        error={entries.error}
        onRetry={entries.reload}
        pagination={entries.meta ? { meta: entries.meta, onPageChange: pager.setPage } : null}
        emptyTitle={anyFilter ? 'No entries match these filters' : 'No audit entries yet'}
      />
    </div>
  );
}
