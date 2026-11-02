// Owner: B (Frontend)
// Purpose: Plain-language lines for the dashboard's recent activity (audit entries)
//
// An audit entry (CONTRACT 7 and 10) records who did what to which row: insert, update and delete
// come from the audit trigger with the changed columns in `details`; approve and reject from the
// analysis procedures; login from signing in. This turns one into "Farah Field changed sample
// #1000" plus a short detail ("status: collected → stored") and, where a page shows that record,
// a link to it.

import type { AuditEntry } from '../../types';
import { formatDateTime } from '../../utils/format';

/** What each audited table holds, in the words a page uses. */
const ENTITY_LABELS: Record<string, string> = {
  projects: 'project',
  project_members: 'the members of project',
  project_sites: 'the sites of project',
  users: 'user',
  user_roles: 'the roles of user',
  sampling_sites: 'site',
  collection_events: 'collection event',
  samples: 'sample',
  dna_extractions: 'extraction',
  sequencing_libraries: 'library',
  sequencing_runs: 'sequencing run',
  quality_control_results: 'QC result',
  analysis_runs: 'analysis',
  taxon_assignments: 'detection',
  taxa: 'taxon',
  dna_markers: 'marker',
  data_exports: 'export',
};

const VERBS: Record<AuditEntry['action'], string> = {
  insert: 'created',
  update: 'changed',
  delete: 'removed',
  approve: 'approved',
  reject: 'rejected',
  login: 'signed in',
  export: 'exported',
};

/** Columns that name a new row better than its id ("sample EB-20261030-1000-001"). */
const NAME_COLUMNS = ['sample_code', 'run_code', 'library_code', 'title', 'name', 'full_name'];

export const entityLabel = (entityType: string) =>
  ENTITY_LABELS[entityType] ?? entityType.replace(/_/g, ' ');

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A changed value: timestamps in local time, objects as JSON, nothing as "none". */
const show = (value: unknown) =>
  value === null || value === undefined
    ? 'none'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : typeof value === 'string' && TIMESTAMP.test(value)
        ? formatDateTime(value)
        : String(value);

/** Rows that link two things read better as their own phrase ("added a member to project #2"). */
const LINK_PHRASES: Record<string, Partial<Record<AuditEntry['action'], string>>> = {
  project_members: {
    insert: 'added a member to project',
    update: "changed a member's role in project",
    delete: 'removed a member from project',
  },
  project_sites: {
    insert: 'added a site to project',
    delete: 'removed a site from project',
  },
  user_roles: {
    insert: 'gave a role to user',
    delete: 'took a role from user',
  },
};

/** "changed sample #1000" (the actor is added by the page, which may say "You"). */
export function describeAction(entry: AuditEntry): string {
  if (entry.action === 'login') return VERBS.login;
  const phrase = LINK_PHRASES[entry.entity_type]?.[entry.action];
  if (phrase) return `${phrase} #${entry.entity_id}`;
  return `${VERBS[entry.action]} ${entityLabel(entry.entity_type)} #${entry.entity_id}`;
}

/**
 * A short detail: the changed columns of an update, the name of a new row, a reason.
 * `personName` turns a user id into a name for membership rows; without it they read "user #3".
 */
export function describeDetail(
  entry: AuditEntry,
  personName?: (userId: number) => string,
): string | null {
  const details = entry.details;
  if (!details) return null;
  if (entry.action === 'reject' && typeof details.reason === 'string') {
    return `Reason: ${details.reason}`;
  }
  if (entry.action === 'approve' && typeof details.detection_count === 'number') {
    return `${details.detection_count} detections`;
  }
  const columns = details as Record<string, { old?: unknown; new?: unknown } | undefined>;
  if (entry.action === 'update') {
    // A status change from a procedure carries from_status / to_status instead of columns.
    if ('from_status' in details && 'to_status' in details) {
      return `status: ${show(details.from_status)} → ${show(details.to_status)}`;
    }
    const keys = Object.keys(columns);
    const shown = keys
      .slice(0, 2)
      .map((k) => `${k}: ${show(columns[k]?.old)} → ${show(columns[k]?.new)}`);
    const more = keys.length - shown.length;
    return shown.length === 0 ? null : `${shown.join('; ')}${more > 0 ? ` and ${more} more` : ''}`;
  }
  const side = entry.action === 'delete' ? 'old' : 'new';
  const value = (key: string) => columns[key]?.[side];
  if (entry.entity_type === 'project_members' && value('user_id') !== undefined) {
    const who = value('user_id');
    const person = typeof who === 'number' && personName ? personName(who) : `user #${show(who)}`;
    return `${person} as ${show(value('project_role'))}`;
  }
  if (entry.entity_type === 'project_sites' && value('site_id') !== undefined) {
    return `site #${show(value('site_id'))}`;
  }
  if (entry.entity_type === 'user_roles' && value('role_id') !== undefined) {
    return `role #${show(value('role_id'))}`;
  }
  const name = NAME_COLUMNS.map((k) => columns[k]?.[side]).find((v) => typeof v === 'string');
  return typeof name === 'string' ? name : null;
}

/**
 * The page that shows the record, or null when none does. `canOpenAnalyses` is whether the user
 * may open the Analysis import page (create_analysis); `canManageUsers` the Users tab.
 */
export function activityLink(
  entry: AuditEntry,
  { canOpenAnalyses, canManageUsers }: { canOpenAnalyses: boolean; canManageUsers: boolean },
): string | null {
  if (entry.action === 'delete' || entry.action === 'login') return null;
  const id = entry.entity_id;
  switch (entry.entity_type) {
    case 'projects':
    case 'project_members':
    case 'project_sites':
      return `/projects/${id}`;
    case 'collection_events':
      return `/events/${id}`;
    case 'samples':
      return `/samples/${id}`;
    case 'sampling_sites':
      return `/map?site_id=${id}`;
    case 'sequencing_runs':
      return `/lab/runs/${id}`;
    case 'quality_control_results':
      return '/lab?tab=qc';
    case 'analysis_runs':
      return canOpenAnalyses ? `/analyses/import?analysis_id=${id}` : null;
    case 'users':
    case 'user_roles':
      return canManageUsers ? '/admin' : null;
    default:
      return null;
  }
}

/**
 * An approval is audited twice: the trigger's column change (status -> approved) and the
 * procedure's own `approve` / `reject` entry. The feed keeps the procedure's entry, which says
 * more, and drops the status change it caused.
 */
export function withoutDuplicateDecisions(entries: AuditEntry[]): AuditEntry[] {
  const decided = new Set(
    entries
      .filter(
        (e) =>
          e.entity_type === 'analysis_runs' && (e.action === 'approve' || e.action === 'reject'),
      )
      .map((e) => e.entity_id),
  );
  return entries.filter((e) => {
    if (e.entity_type !== 'analysis_runs' || e.action !== 'update' || !decided.has(e.entity_id)) {
      return true;
    }
    const status = (e.details as { status?: { new?: unknown } } | null)?.status?.new;
    return status !== 'approved' && status !== 'rejected';
  });
}
