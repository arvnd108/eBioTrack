// Owner: A (Backend)
// Purpose: The permission matrix (CONTRACT section 9) as data, in one place for auditing
//
// Mirror of section 9. "administrator" passes every action, so it is never listed in `roles`.
//
// Two ways to be allowed an action (either is enough):
//   1. a GLOBAL role listed in `roles`;
//   2. a PROJECT role listed in `projectRoles` in the project the action targets.
// So a user whose only global role is `viewer` can still own a project, or be invited into another
// one as contributor, and do there what that project role allows. A project `viewer` is read-only
// whatever the global role.
//
//   Action                      global roles        project roles that also allow it   scoped
//   manage_users                —                   —                                  no
//   read_audit_log              PI (own)            owner (own projects)               yes
//   create_site                 everyone            —                                  no
//   create_project              everyone            —                                  no
//   edit_project (members,sites)—                   owner, manager                     yes
//   manage_sites (create/edit)  PI, field           owner, manager, contributor (any)  no
//   create_event_sample         PI, field           owner, manager, contributor        yes
//   change_sample_status        PI, field, lab      owner, manager, contributor        yes
//   record_lab                  PI, lab             owner, manager, contributor        yes
//   create_analysis             PI, analyst         owner, manager, contributor        yes
//   decide_analysis             PI                  owner, manager                     yes
//   read_project_data           everyone            everyone (any member)              yes
//   read_unapproved_detections  PI, analyst         owner, manager, contributor        yes
// Note: sites belong to no single project, so manage_sites is allowed when the user holds a
// granting project role in ANY project (or a global role); it is not tied to one project.
// Every project-scoped action also requires membership of the project (404 otherwise).

export const ROLES = Object.freeze({
  ADMINISTRATOR: 'administrator',
  PRINCIPAL_INVESTIGATOR: 'principal_investigator',
  FIELD_RESEARCHER: 'field_researcher',
  LAB_TECHNICIAN: 'lab_technician',
  ANALYST: 'analyst',
  VIEWER: 'viewer',
});

const { PRINCIPAL_INVESTIGATOR: PI, FIELD_RESEARCHER: FR, LAB_TECHNICIAN: LT, ANALYST: AN } = ROLES;

const WRITERS = ['owner', 'manager', 'contributor'];
const MANAGERS = ['owner', 'manager'];

/**
 * roles: global roles that may perform the action (administrator always may).
 * projectRoles: project roles that may perform it in a project, whatever the global role.
 * project: true when a non-administrator must be a member of the target project.
 * anyProject: true when the project roles count in ANY project (the action has no single project).
 * read: true for reads, which a project `viewer` may do.
 */
export const PERMISSIONS = Object.freeze({
  manage_users: { roles: [] },
  read_audit_log: { roles: [PI], projectRoles: ['owner'], project: true, read: true },
  create_site: { roles: Object.values(ROLES) },
  create_project: { roles: Object.values(ROLES) },
  edit_project: { roles: [], projectRoles: MANAGERS, project: true },
  manage_sites: { roles: [PI, FR], projectRoles: WRITERS, anyProject: true },
  create_event_sample: { roles: [PI, FR], projectRoles: WRITERS, project: true },
  change_sample_status: { roles: [PI, FR, LT], projectRoles: WRITERS, project: true },
  record_lab: { roles: [PI, LT], projectRoles: WRITERS, project: true },
  create_analysis: { roles: [PI, AN], projectRoles: WRITERS, project: true },
  decide_analysis: { roles: [PI], projectRoles: MANAGERS, project: true },
  read_project_data: {
    roles: Object.values(ROLES),
    projectRoles: [...WRITERS, 'viewer'],
    project: true,
    read: true,
  },
  read_unapproved_detections: { roles: [PI, AN], projectRoles: WRITERS, project: true, read: true },
});

/** Does the user's global role list allow the action? (Administrator always does.) */
export function globalRoleAllows(user, action) {
  const rule = PERMISSIONS[action];
  return (
    user.roles.includes(ROLES.ADMINISTRATOR) || rule.roles.some((role) => user.roles.includes(role))
  );
}

/** Does this project role allow the action in its project? (A project viewer only reads.) */
export function projectRoleAllows(action, projectRole) {
  const rule = PERMISSIONS[action];
  if (!projectRole || !rule.projectRoles) return false;
  if (projectRole === 'viewer' && !rule.read) return false;
  return rule.projectRoles.includes(projectRole);
}
