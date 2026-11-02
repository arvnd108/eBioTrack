// Owner: B (Frontend)
// Purpose: Users, roles, audit records
//
// Two tabs, each shown only to roles that may use it (CONTRACT 9):
//  - Users (manage_users): administrators only;
//  - Audit log (read_audit_log): administrators, and principal investigators for their own
//    projects.
// The route itself is limited to those roles (ProtectedRoute in routes.tsx). The chosen tab is
// kept in the URL (?tab=audit).

import { useAuth } from '../hooks/useAuth';
import { useQueryFilters } from '../hooks/useQueryFilters';
import { AuditPanel } from './admin/AuditPanel';
import { UsersPanel } from './admin/UsersPanel';

type Tab = 'users' | 'audit';

export default function AdministrationPage() {
  const { can } = useAuth();
  const tabs: { id: Tab; label: string }[] = [
    ...(can('manage_users') ? [{ id: 'users' as const, label: 'Users' }] : []),
    ...(can('read_audit_log') ? [{ id: 'audit' as const, label: 'Audit log' }] : []),
  ];
  // The tab is in the URL (?tab=audit), so the dashboard can link to the audit log.
  const [filters, setFilters] = useQueryFilters(['tab'] as const);
  const current = tabs.find((t) => t.id === filters.tab)?.id ?? tabs[0]?.id;

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Administration</h1>
        <p className="mt-1 text-slate-600">
          {can('manage_users')
            ? 'Users, roles and the audit log.'
            : 'The audit log for your projects.'}
        </p>
      </div>

      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Administration sections"
          className="flex gap-1 border-b border-slate-200"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={current === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() =>
                setFilters({ tab: t.id === tabs[0]?.id ? '' : t.id }, { keepOthers: false })
              }
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                current === t.id
                  ? 'border-emerald-700 text-emerald-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        id={`panel-${current}`}
        aria-labelledby={tabs.length > 1 ? `tab-${current}` : undefined}
      >
        {current === 'users' && <UsersPanel />}
        {current === 'audit' && <AuditPanel />}
      </div>
    </section>
  );
}
