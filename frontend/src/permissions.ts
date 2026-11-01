// Owner: B (Frontend)
// Purpose: The permission matrix (CONTRACT section 9) for hiding what a role cannot do
//
// A copy of backend/src/middleware/permissions.js with the SAME action names and rules, so the
// UI hides exactly what the API would refuse. The API stays the authority: this only decides
// what to show. If the backend table changes, change this file in the same PR.
//
//   Action                         PI   field  lab   analyst viewer   project-scoped
//   manage_users                   —    —      —     —       —        no
//   read_audit_log                 own  —      —     —       —        yes
//   create_project                 ✓    —      —     —       —        no
//   edit_project                   own  —      —     —       —        yes, owner/manager
//   manage_sites                   ✓    own    —     —       —        no (global gate)
//   create_event_sample            own  own    —     —       —        yes
//   change_sample_status           own  own    own   —       —        yes
//   record_lab                     own  —      own   —       —        yes
//   create_analysis                own  —      —     own     —        yes
//   decide_analysis                own  —      —     —       —        yes
//   read_project_data              own  own    own   own     own      yes
//   read_unapproved_detections     own  —      —     own     —        yes
//
// Rules, as in backend/src/middleware/authorize.js:
//   - administrator passes every check, project-scoped ones included;
//   - otherwise the user needs one of the action's global roles;
//   - for a project-scoped action the user must be a member of the project, a project `viewer`
//     is read-only (no write actions), and `projectRoles` (owner/manager) apply when listed.

import type { ProjectRole, RoleName, User } from './types';

export type Action =
  | 'manage_users'
  | 'read_audit_log'
  | 'create_project'
  | 'edit_project'
  | 'manage_sites'
  | 'create_event_sample'
  | 'change_sample_status'
  | 'record_lab'
  | 'create_analysis'
  | 'decide_analysis'
  | 'read_project_data'
  | 'read_unapproved_detections';

interface Rule {
  /** Global roles allowed (administrator always is, so it is never listed). */
  roles: RoleName[];
  /** A non-administrator must also be a member of the target project. */
  project?: boolean;
  /** Project roles allowed; omit for any membership. */
  projectRoles?: ProjectRole[];
  /** Reads (GET routes) stay open to a project viewer; every other action is a write. */
  read?: boolean;
}

const PI: RoleName = 'principal_investigator';
const FR: RoleName = 'field_researcher';
const LT: RoleName = 'lab_technician';
const AN: RoleName = 'analyst';
const ALL: RoleName[] = ['administrator', PI, FR, LT, AN, 'viewer'];

export const PERMISSIONS: Readonly<Record<Action, Rule>> = Object.freeze({
  manage_users: { roles: [] },
  read_audit_log: { roles: [PI], project: true, read: true },
  create_project: { roles: [PI] },
  edit_project: { roles: [PI], project: true, projectRoles: ['owner', 'manager'] },
  manage_sites: { roles: [PI, FR] },
  create_event_sample: { roles: [PI, FR], project: true },
  change_sample_status: { roles: [PI, FR, LT], project: true },
  record_lab: { roles: [PI, LT], project: true },
  create_analysis: { roles: [PI, AN], project: true },
  decide_analysis: { roles: [PI], project: true },
  read_project_data: { roles: ALL, project: true, read: true },
  read_unapproved_detections: { roles: [PI, AN], project: true, read: true },
});

/**
 * Can this user perform the action?
 *
 * `projectRole` is the user's role in the project the action targets, e.g. `project.your_role`
 * from `GET /api/projects/:id` (null = not a member). Leave it out where no single project is
 * in play (navigation, a "New …" button on a list): the answer is then "does the user's global
 * role allow this at all", and the API applies the project check when the request is made.
 */
export function can(
  user: User | null | undefined,
  action: Action,
  projectRole?: ProjectRole | null,
): boolean {
  if (!user || !user.active) return false;
  if (user.roles.includes('administrator')) return true;

  const rule = PERMISSIONS[action];
  if (!rule.roles.some((role) => user.roles.includes(role))) return false;

  if (rule.project && projectRole !== undefined) {
    if (projectRole === null) return false; // not a member
    if (projectRole === 'viewer' && !rule.read) return false; // project viewers are read-only
    if (rule.projectRoles && !rule.projectRoles.includes(projectRole)) return false;
  }
  return true;
}

/** True when the user may perform at least one of the actions (see `can`). */
export function canAny(
  user: User | null | undefined,
  actions: readonly Action[],
  projectRole?: ProjectRole | null,
): boolean {
  return actions.some((action) => can(user, action, projectRole));
}
