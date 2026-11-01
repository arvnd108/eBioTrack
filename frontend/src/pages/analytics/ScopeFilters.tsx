// Owner: B (Frontend)
// Purpose: Project, site and date filters shared by the species and analytics pages
//
// The values live in the URL (useQueryFilters) as project_id, site_id, from and to. Dates are
// whole days (the API reads a date as the start or end of that UTC day, both inclusive). A
// `from` after `to` is reported here and the pages send no request until it is fixed.

import type { ReactNode } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useProjectIndex, useSiteIndex } from '../../hooks/useLookups';
import { idParam } from '../../hooks/useQueryFilters';
import { isCalendarDate } from '../projects/projectRules';

export const SCOPE_KEYS = ['project_id', 'site_id', 'from', 'to'] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];
export type Scope = Record<ScopeKey, string>;

/** The scope as API query values; `invalid` when the dates cannot be sent. */
export function scopeQuery(scope: Scope): {
  project_id?: string;
  site_id?: string;
  from?: string;
  to?: string;
  invalid: string | null;
} {
  const from = isCalendarDate(scope.from) ? scope.from : undefined;
  const to = isCalendarDate(scope.to) ? scope.to : undefined;
  return {
    project_id: idParam(scope.project_id),
    site_id: idParam(scope.site_id),
    from,
    to,
    invalid: from && to && from > to ? 'The start date is after the end date.' : null,
  };
}

interface ScopeFiltersProps {
  scope: Scope;
  onChange: (changes: Partial<Scope>) => void;
  /** Extra controls in the same row (for example "Group by"). */
  children?: ReactNode;
  /** Hide the site filter (a view that does not take one). */
  withSite?: boolean;
  withDates?: boolean;
}

export function ScopeFilters({
  scope,
  onChange,
  children,
  withSite = true,
  withDates = true,
}: ScopeFiltersProps) {
  const projects = useProjectIndex();
  const projectId = idParam(scope.project_id);
  const sites = useSiteIndex(projectId ? Number(projectId) : null, withSite);
  const { invalid } = scopeQuery(scope);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-60">
          <FormField label="Project">
            <select
              value={projectId ?? ''}
              // A site of another project would match nothing: changing project clears it.
              onChange={(e) => onChange({ project_id: e.target.value, site_id: '' })}
              className={fieldControlClass()}
            >
              <option value="">All my projects</option>
              {projects.list.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.title}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {withSite && (
          <div className="w-56">
            <FormField label="Site">
              <select
                value={idParam(scope.site_id) ?? ''}
                onChange={(e) => onChange({ site_id: e.target.value })}
                className={fieldControlClass()}
              >
                <option value="">All sites</option>
                {sites.list.map((s) => (
                  <option key={s.site_id} value={s.site_id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        {withDates && (
          <>
            <div className="w-44">
              <FormField label="From">
                <input
                  type="date"
                  value={scope.from}
                  onChange={(e) => onChange({ from: e.target.value })}
                  className={fieldControlClass(!!invalid)}
                />
              </FormField>
            </div>
            <div className="w-44">
              <FormField label="To">
                <input
                  type="date"
                  value={scope.to}
                  onChange={(e) => onChange({ to: e.target.value })}
                  className={fieldControlClass(!!invalid)}
                />
              </FormField>
            </div>
          </>
        )}
        {children}
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-red-700">
          {invalid}
        </p>
      )}
    </div>
  );
}
