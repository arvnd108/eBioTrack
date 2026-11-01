// Owner: B (Frontend)
// Purpose: The UI permission matrix matches the API's, and `can` applies the same rules

import { describe, expect, it } from 'vitest';
import { PERMISSIONS, can, canAny, type Action } from './permissions';
import type { RoleName, User } from './types';

const user = (role: RoleName): User => ({
  user_id: 1,
  full_name: role,
  email: `${role}@ebiotrack.test`,
  roles: [role],
  active: true,
});

describe('PERMISSIONS mirrors backend/src/middleware/permissions.js', () => {
  it('has the same actions, roles, project scope and project roles', async () => {
    // Loaded at run time so a change on either side fails this test until both match.
    const backendPath = new URL('../../backend/src/middleware/permissions.js', import.meta.url)
      .href;
    const backend = (await import(/* @vite-ignore */ backendPath)) as {
      PERMISSIONS: Record<string, { roles: string[]; project?: boolean; projectRoles?: string[] }>;
    };

    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(backend.PERMISSIONS).sort());
    for (const [action, rule] of Object.entries(backend.PERMISSIONS)) {
      const mine = PERMISSIONS[action as Action];
      expect([...mine.roles].sort(), action).toEqual([...rule.roles].sort());
      expect(!!mine.project, action).toBe(!!rule.project);
      expect(mine.projectRoles ?? null, action).toEqual(rule.projectRoles ?? null);
    }
  });
});

describe('can', () => {
  it('lets an administrator do everything, in any project', () => {
    for (const action of Object.keys(PERMISSIONS) as Action[]) {
      expect(can(user('administrator'), action), action).toBe(true);
      expect(can(user('administrator'), action, null), action).toBe(true);
    }
  });

  it('follows the global role column (CONTRACT 9)', () => {
    expect(can(user('viewer'), 'read_project_data')).toBe(true);
    expect(can(user('viewer'), 'record_lab')).toBe(false);
    expect(can(user('lab_technician'), 'record_lab')).toBe(true);
    expect(can(user('lab_technician'), 'create_analysis')).toBe(false);
    expect(can(user('analyst'), 'create_analysis')).toBe(true);
    expect(can(user('analyst'), 'decide_analysis')).toBe(false);
    expect(can(user('principal_investigator'), 'decide_analysis')).toBe(true);
    expect(can(user('principal_investigator'), 'manage_users')).toBe(false);
    expect(can(user('field_researcher'), 'manage_sites')).toBe(true);
  });

  it('applies the project rules when a project role is given', () => {
    const lab = user('lab_technician');
    expect(can(lab, 'record_lab', 'contributor')).toBe(true);
    expect(can(lab, 'record_lab', null)).toBe(false); // not a member
    expect(can(lab, 'record_lab', 'viewer')).toBe(false); // project viewers are read-only
    expect(can(lab, 'read_project_data', 'viewer')).toBe(true); // reading is still allowed

    const pi = user('principal_investigator');
    expect(can(pi, 'edit_project', 'owner')).toBe(true);
    expect(can(pi, 'edit_project', 'manager')).toBe(true);
    expect(can(pi, 'edit_project', 'contributor')).toBe(false);
    expect(can(pi, 'read_audit_log', 'viewer')).toBe(true);
  });

  it('refuses nobody signed in and inactive users', () => {
    expect(can(null, 'read_project_data')).toBe(false);
    expect(can({ ...user('administrator'), active: false }, 'manage_users')).toBe(false);
  });

  it('canAny passes when one action is allowed', () => {
    expect(canAny(user('principal_investigator'), ['manage_users', 'read_audit_log'])).toBe(true);
    expect(canAny(user('lab_technician'), ['manage_users', 'read_audit_log'])).toBe(false);
  });
});
