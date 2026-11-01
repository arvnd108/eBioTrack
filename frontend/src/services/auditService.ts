// Owner: B (Frontend)
// Purpose: API calls for audit
//
// GET /api/audit (CONTRACT 10; backend routes/audit.routes.js, T20): administrators see every
// entry, principal investigators the entries about their own projects, newest first. The page
// reads it with useFetch('/audit', auditQuery(filters)). Not sortable (the API rejects `sort`).

import type { Query } from './apiClient';

export interface AuditFilters {
  entity_type?: string;
  entity_id?: string;
  actor_id?: string;
  /** First day to include, `YYYY-MM-DD`, in the user's time zone. */
  from_date?: string;
  /** Last day to include, `YYYY-MM-DD`, in the user's time zone. */
  to_date?: string;
}

/**
 * The API's `from` / `to` are ISO timestamps with an offset. A day picked in the browser runs from
 * local midnight to the last millisecond before the next local midnight (D20: show local time).
 */
export function dayStart(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

export function dayEnd(date: string): string {
  const end = new Date(`${date}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return new Date(end.getTime() - 1).toISOString();
}

/** Query parameters for GET /api/audit from the filter form (empty values are left out). */
export function auditQuery(filters: AuditFilters): Query {
  return {
    entity_type: filters.entity_type?.trim() || undefined,
    entity_id: filters.entity_id?.trim() || undefined,
    actor_id: filters.actor_id?.trim() || undefined,
    from: filters.from_date ? dayStart(filters.from_date) : undefined,
    to: filters.to_date ? dayEnd(filters.to_date) : undefined,
  };
}
