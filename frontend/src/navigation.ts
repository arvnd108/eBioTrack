// Owner: B (Frontend)
// Purpose: Sidebar links and role visibility (routes themselves are in routes.tsx)

import type { RoleName } from './types';

export interface NavItem {
  path: string;
  label: string;
  /** Global roles that see this item; omit for everyone (CONTRACT section 9). */
  roles?: RoleName[];
}

/** Roles allowed on the Administration page: users (administrator) and audit (PI, own). */
export const ADMIN_ROLES: RoleName[] = ['administrator', 'principal_investigator'];

export const navItems: NavItem[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/projects', label: 'Projects' },
  { path: '/map', label: 'Sampling map' },
  { path: '/events', label: 'Collection events' },
  { path: '/samples', label: 'Samples' },
  { path: '/lab', label: 'Lab processing' },
  { path: '/analyses/import', label: 'Analysis import' },
  { path: '/species', label: 'Species explorer' },
  { path: '/analytics', label: 'Biodiversity analytics' },
  { path: '/ml', label: 'ML insights' },
  { path: '/admin', label: 'Administration', roles: ADMIN_ROLES },
];
