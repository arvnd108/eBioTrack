// Owner: A (Backend)
// Purpose: The permission matrix (CONTRACT section 9) as data, in one place for auditing
//
// Mirror of section 9. "administrator" passes every action, so it is never listed in `roles`.
//   Action                                 PI   field  lab   analyst viewer   project-scoped
//   manage_users                           —    —      —     —       —        no
//   read_audit_log                         own  —      —     —       —        yes
//   create_project                         ✓    —      —     —       —        no
//   edit_project (and members, sites)      own  —      —     —       —        yes, owner/manager
//   manage_sites (create and edit)         ✓    own    —     —       —        see note
//   create_event_sample                    own  own    —     —       —        yes
//   change_sample_status                   own  own    own   —       —        yes
//   record_lab (extractions, QC, runs)     own  —      own   —       —        yes
//   create_analysis (import detections)    own  —      —     own     —        yes
//   decide_analysis (approve or reject)    own  —      —     —       —        yes
//   read_project_data (samples, lab,
//     approved detections, analytics)      own  own    own   own     own      yes
//   read_unapproved_detections             own  —      —     own     —        yes
// Note: sites belong to no single project, so manage_sites is a global role gate only; the
// "own" limit for field researchers is the service's concern when it knows the project.
// Project role `viewer` is read-only on any non-GET route, whatever the global role.

export const ROLES = Object.freeze({
  ADMINISTRATOR: 'administrator',
  PRINCIPAL_INVESTIGATOR: 'principal_investigator',
  FIELD_RESEARCHER: 'field_researcher',
  LAB_TECHNICIAN: 'lab_technician',
  ANALYST: 'analyst',
  VIEWER: 'viewer',
});

const { PRINCIPAL_INVESTIGATOR: PI, FIELD_RESEARCHER: FR, LAB_TECHNICIAN: LT, ANALYST: AN } = ROLES;

/**
 * roles: global roles that may perform the action (administrator always may).
 * project: true when a non-administrator must also be a member of the target project.
 * projectRoles: project roles allowed (omit for any membership).
 */
export const PERMISSIONS = Object.freeze({
  manage_users: { roles: [] },
  read_audit_log: { roles: [PI], project: true },
  create_project: { roles: [PI] },
  edit_project: { roles: [PI], project: true, projectRoles: ['owner', 'manager'] },
  manage_sites: { roles: [PI, FR] },
  create_event_sample: { roles: [PI, FR], project: true },
  change_sample_status: { roles: [PI, FR, LT], project: true },
  record_lab: { roles: [PI, LT], project: true },
  create_analysis: { roles: [PI, AN], project: true },
  decide_analysis: { roles: [PI], project: true },
  read_project_data: { roles: Object.values(ROLES), project: true },
  read_unapproved_detections: { roles: [PI, AN], project: true },
});
