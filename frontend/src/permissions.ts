// Owner: B (Frontend)
// Purpose: The permission matrix (CONTRACT section 9) for hiding what a role cannot do
//
// A copy of backend/src/middleware/permissions.js with the SAME action names and rules, so the
// UI hides exactly what the API would refuse. The API stays the authority: this only decides
// what to show. If the backend table changes, change this file in the same PR.
//
// Two ways to be allowed an action in a project (either is enough): a GLOBAL role in `roles`, or
// the user's PROJECT role in `projectRoles`. A project `viewer` is read-only whatever the global role.
//
//   Action                      global roles      project roles that also allow it   scoped
//   manage_users                —                 —                                  no
//   read_audit_log              PI (own)          owner (own projects)               yes
//   create_site                 everyone          —                                  no
//   create_project              everyone          —                                  no
//   edit_project                —                 owner, manager                     yes
//   manage_sites                PI, field         owner, manager, contributor (any)  no
//   create_event_sample         PI, field         owner, manager, contributor        yes
//   change_sample_status        PI, field, lab    owner, manager, contributor        yes
//   record_lab                  PI, lab           owner, manager, contributor        yes
//   create_analysis             PI, analyst       owner, manager, contributor        yes
//   decide_analysis             PI                owner, manager                     yes
//   read_project_data           everyone          every member                       yes
//   read_unapproved_detections  PI, analyst       owner, manager, contributor        yes
//
// Rules, as in backend/src/middleware/authorize.js:
//   - administrator passes every check, project-scoped ones included;
//   - for a project-scoped action the user must be a member of the project and a project `viewer`
//     is read-only; then a global role OR the project role must allow the action;
//   - without a project (`projectRole` left out) the answer is "could this user do it somewhere":
//     a global role allows it, or the user holds a granting project role in some project
//     (the roles in `GET /projects`).

import type { ProjectRole, RoleName, User } from './types';

export type Action =
  | 'manage_users'
  | 'read_audit_log'
  | 'create_site'
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
  /** Project roles that allow the action in that project, whatever the global role. */
  projectRoles?: ProjectRole[];
  /** Reads (GET routes) stay open to a project viewer; every other action is a write. */
  read?: boolean;
}

const PI: RoleName = 'principal_investigator';
const FR: RoleName = 'field_researcher';
const LT: RoleName = 'lab_technician';
const AN: RoleName = 'analyst';
const ALL: RoleName[] = ['administrator', PI, FR, LT, AN, 'viewer'];
const WRITERS: ProjectRole[] = ['owner', 'manager', 'contributor'];
const MANAGERS: ProjectRole[] = ['owner', 'manager'];

export const PERMISSIONS: Readonly<Record<Action, Rule>> = Object.freeze({
  manage_users: { roles: [] },
  read_audit_log: { roles: [PI], projectRoles: ['owner'], project: true, read: true },
  create_site: { roles: ALL },
  create_project: { roles: ALL },
  edit_project: { roles: [], projectRoles: MANAGERS, project: true },
  manage_sites: { roles: [PI, FR], projectRoles: WRITERS },
  create_event_sample: { roles: [PI, FR], projectRoles: WRITERS, project: true },
  change_sample_status: { roles: [PI, FR, LT], projectRoles: WRITERS, project: true },
  record_lab: { roles: [PI, LT], projectRoles: WRITERS, project: true },
  create_analysis: { roles: [PI, AN], projectRoles: WRITERS, project: true },
  decide_analysis: { roles: [PI], projectRoles: MANAGERS, project: true },
  read_project_data: {
    roles: ALL,
    projectRoles: [...WRITERS, 'viewer'],
    project: true,
    read: true,
  },
  read_unapproved_detections: {
    roles: [PI, AN],
    projectRoles: WRITERS,
    project: true,
    read: true,
  },
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
  /** Without a single project: the project roles the user holds somewhere (from `GET /projects`). */
  heldProjectRoles: readonly ProjectRole[] = [],
): boolean {
  if (!user || !user.active) return false;
  if (user.roles.includes('administrator')) return true;

  const rule = PERMISSIONS[action];
  const globalOk = rule.roles.some((role) => user.roles.includes(role));

  if (rule.project && projectRole !== undefined) {
    if (projectRole === null) return false; // not a member
    if (projectRole === 'viewer' && !rule.read) return false; // project viewers are read-only
    return globalOk || !!rule.projectRoles?.includes(projectRole);
  }
  return (
    globalOk ||
    heldProjectRoles.some(
      (r) => !!rule.projectRoles?.includes(r) && (r !== 'viewer' || !!rule.read),
    )
  );
}

/** True when the user may perform at least one of the actions (see `can`). */
export function canAny(
  user: User | null | undefined,
  actions: readonly Action[],
  projectRole?: ProjectRole | null,
  heldProjectRoles: readonly ProjectRole[] = [],
): boolean {
  return actions.some((action) => can(user, action, projectRole, heldProjectRoles));
}
