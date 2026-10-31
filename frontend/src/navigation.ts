// Owner: B (Frontend)
// Purpose: Sidebar links and role visibility (routes themselves are in routes.tsx)
//
// Visibility uses the permission matrix (src/permissions.ts, CONTRACT 9), the same rules the
// API enforces. Every role may read project data, so most pages are visible to everyone; a page
// whose only purpose is an action some roles cannot take is hidden from them.

import type { Action } from './permissions';

export interface NavItem {
  path: string;
  label: string;
  /** Visible when the user may perform ANY of these actions; omit for everyone. */
  anyOf?: readonly Action[];
}

/** Administration: users and roles (administrator) or the audit log (PI, own projects). */
export const ADMIN_ACTIONS: readonly Action[] = ['manage_users', 'read_audit_log'];

/** Analysis import: creating analyses and importing detections (PI, analyst). */
export const IMPORT_ACTIONS: readonly Action[] = ['create_analysis'];

export const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/projects', label: 'Projects' },
  { path: '/map', label: 'Sampling map' },
  { path: '/events', label: 'Collection events' },
  { path: '/samples', label: 'Samples' },
  { path: '/lab', label: 'Lab processing' },
  { path: '/analyses/import', label: 'Analysis import', anyOf: IMPORT_ACTIONS },
  { path: '/species', label: 'Species explorer' },
  { path: '/analytics', label: 'Biodiversity analytics' },
  { path: '/ml', label: 'ML insights' },
  { path: '/admin', label: 'Administration', anyOf: ADMIN_ACTIONS },
];
