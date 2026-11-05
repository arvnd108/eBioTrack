// Owner: C (Testing & QA)
// Purpose: Constraint and trigger tests: Access, Projects & Audit
//
// Written from CONTRACT 4.1 and migrations 010/090/095. Every case runs in withRollback(); negative
// cases run in a savepoint (inSavepoint) so one test can check several violations.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  asAppRole,
  enumValues,
  expectViolation,
  inSavepoint,
  insertRow,
  newProject,
  newUser,
  unique,
} from '../setup/integrity.js';
import { closeTestPool, getPool, withRollback } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HASH = '$2b$12$integrityhashintegrityhashintegrityhashintegrityhash';
const ABSENT = 999999999;

// A fresh valid row for each table (parents created on demand).
const makers = {
  roles: async () => ({ role_name: unique('qa_role') }),
  users: async () => ({
    full_name: 'QA User',
    email: `${unique('qa')}@example.test`,
    password_hash: HASH,
  }),
  user_roles: async (c) => ({ user_id: (await newUser(c)).user_id, role_id: 1 }),
  projects: async () => ({ title: unique('QA Project'), created_by: 2 }),
  project_members: async (c) => ({
    project_id: (await newProject(c)).project_id,
    user_id: 3,
    project_role: 'viewer',
  }),
  project_sites: async (c) => ({ project_id: (await newProject(c)).project_id, site_id: 1 }),
  audit_logs: async () => ({ entity_type: 'projects', entity_id: 1, action: 'insert' }),
};

const insertValid = async (c, table, over = {}) =>
  insertRow(c, table, { ...(await makers[table](c)), ...over });

describe.skipIf(!dbAvailable)('access: setup', () => {
  beforeAll(async () => {
    // A schema reset drops the role grants; grants.sql is idempotent and needed for app-role cases.
    await getPool().query(readFileSync(path.join(root, 'database/roles/grants.sql'), 'utf8'));
  });
  afterAll(() => closeTestPool());

  describe('NOT NULL (23502)', () => {
    const cases = [
      ['roles', ['role_name']],
      ['users', ['full_name', 'email', 'password_hash']],
      ['user_roles', ['user_id', 'role_id']],
      ['projects', ['title', 'status', 'created_by']],
      ['project_members', ['project_id', 'user_id', 'project_role']],
      ['project_sites', ['project_id', 'site_id']],
      ['audit_logs', ['entity_type', 'entity_id', 'action']],
    ].flatMap(([table, columns]) => columns.map((column) => [table, column]));

    it.each(cases)('%s.%s: NULL -> 23502', (table, column) =>
      withRollback(async (c) => {
        const row = { ...(await makers[table](c)), [column]: null };
        const err = await expectViolation(
          inSavepoint(c, () => insertRow(c, table, row)),
          '23502',
        );
        expect(err.column).toBe(column);
      }),
    );

    it('a valid row of every table is accepted (the negative cases break exactly one column)', () =>
      withRollback(async (c) => {
        for (const table of Object.keys(makers)) await insertValid(c, table);
      }));
  });

  describe('primary keys and UNIQUE (23505)', () => {
    it('pk_users: duplicate user_id -> 23505', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'users', { user_id: 1 })),
          '23505',
          'pk_users',
        );
      }));

    it('uq_users_email: duplicate email -> 23505; a different email is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'users', { email: 'viewer@ebiotrack.test' })),
          '23505',
          'uq_users_email',
        );
        await insertValid(c, 'users', { email: 'viewer2@ebiotrack.test' });
      }));

    it('ck_users_email_lower: the same email in mixed case is rejected, never stored', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'users', { email: 'Viewer@ebiotrack.test' })),
          '23514',
          'ck_users_email_lower',
        );
        const { rows } = await c.query(
          'SELECT count(*)::int AS n FROM users WHERE email <> lower(email)',
        );
        expect(rows[0].n).toBe(0);
      }));

    it('pk_roles: duplicate role_id -> 23505', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'roles', { role_id: 1 })),
          '23505',
          'pk_roles',
        );
      }));

    it('uq_roles_role_name: duplicate role name -> 23505; a new name is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'roles', { role_name: 'viewer' })),
          '23505',
          'uq_roles_role_name',
        );
        await insertValid(c, 'roles', { role_name: 'visitor' });
      }));

    it('pk_user_roles: the same (user, role) twice -> 23505; the same user with another role is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertRow(c, 'user_roles', { user_id: 6, role_id: 6 })),
          '23505',
          'pk_user_roles',
        );
        await insertRow(c, 'user_roles', { user_id: 6, role_id: 5 });
      }));

    it('pk_projects: duplicate project_id -> 23505', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'projects', { project_id: 1 })),
          '23505',
          'pk_projects',
        );
      }));

    it('uq_projects_title: duplicate title -> 23505; a different title is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'projects', { title: 'Yamuna Biodiversity Survey' })),
          '23505',
          'uq_projects_title',
        );
        await insertValid(c, 'projects', { title: 'Yamuna Biodiversity Survey 2' });
      }));

    it('pk_project_members: the same (project, user) twice -> 23505; the user in another project is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () =>
            insertRow(c, 'project_members', { project_id: 1, user_id: 3, project_role: 'viewer' }),
          ),
          '23505',
          'pk_project_members',
        );
        await insertValid(c, 'project_members', { user_id: 3 });
      }));

    it('uq_project_members_owner: a second owner of a project -> 23505; several non-owners and owners of other projects are accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () =>
            insertRow(c, 'project_members', { project_id: 1, user_id: 1, project_role: 'owner' }),
          ),
          '23505',
          'uq_project_members_owner',
        );
        // Promoting an existing member to owner is the same second owner.
        await expectViolation(
          inSavepoint(c, () =>
            c.query(
              `UPDATE project_members SET project_role = 'owner' WHERE project_id = 1 AND user_id = 3`,
            ),
          ),
          '23505',
          'uq_project_members_owner',
        );
        await insertRow(c, 'project_members', {
          project_id: 1,
          user_id: 1,
          project_role: 'manager',
        });
        const other = await newProject(c);
        await insertRow(c, 'project_members', {
          project_id: other.project_id,
          user_id: 2,
          project_role: 'owner',
        });
      }));

    it('pk_project_sites: the same (project, site) twice -> 23505; the site for another project is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertRow(c, 'project_sites', { project_id: 1, site_id: 1 })),
          '23505',
          'pk_project_sites',
        );
        await insertRow(c, 'project_sites', { project_id: 2, site_id: 1 });
      }));

    it('pk_audit_logs: duplicate audit_id -> 23505', () =>
      withRollback(async (c) => {
        await insertValid(c, 'audit_logs', { audit_id: 5000 });
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'audit_logs', { audit_id: 5000 })),
          '23505',
          'pk_audit_logs',
        );
      }));

    it('pk_session: duplicate sid -> 23505 (session store, infrastructure)', () =>
      withRollback(async (c) => {
        const row = { sid: 'integrity-sid', sess: '{}', expire: '2030-01-01T00:00:00' };
        await insertRow(c, 'session', row);
        await expectViolation(
          inSavepoint(c, () => insertRow(c, 'session', row)),
          '23505',
          'pk_session',
        );
      }));
  });

  describe('FOREIGN KEY (23503)', () => {
    const fks = [
      ['fk_user_roles_user_id', 'user_roles', 'user_id'],
      ['fk_user_roles_role_id', 'user_roles', 'role_id'],
      ['fk_projects_created_by', 'projects', 'created_by'],
      ['fk_project_members_project_id', 'project_members', 'project_id'],
      ['fk_project_members_user_id', 'project_members', 'user_id'],
      ['fk_project_sites_project_id', 'project_sites', 'project_id'],
      ['fk_project_sites_site_id', 'project_sites', 'site_id'],
      ['fk_audit_logs_actor_id', 'audit_logs', 'actor_id'],
    ];

    it.each(fks)('%s: unknown %s.%s -> 23503', (constraint, table, column) =>
      withRollback(async (c) => {
        const row = { ...(await makers[table](c)), [column]: ABSENT };
        await expectViolation(
          inSavepoint(c, () => insertRow(c, table, row)),
          '23503',
          constraint,
        );
      }),
    );

    it('audit_logs.actor_id may be NULL (a system action) but not an unknown user', () =>
      withRollback(async (c) => {
        const row = await insertValid(c, 'audit_logs', { actor_id: null });
        expect(row.actor_id).toBeNull();
      }));

    it('the owner cannot delete a referenced row: users, roles, projects -> 23503 (NO ACTION / RESTRICT)', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => c.query('DELETE FROM users WHERE user_id = 2')),
          '23503',
        );
        await expectViolation(
          inSavepoint(c, () => c.query('DELETE FROM roles WHERE role_id = 1')),
          '23503',
          'fk_user_roles_role_id',
        );
        await expectViolation(
          inSavepoint(c, () => c.query('DELETE FROM projects WHERE project_id = 1')),
          '23503',
        );
      }));

    it('an unreferenced project can be deleted by the table owner, but not by the app role (42501)', () =>
      withRollback(async (c) => {
        const project = await newProject(c);
        await expectViolation(
          inSavepoint(c, () =>
            asAppRole(c, () =>
              c.query('DELETE FROM projects WHERE project_id = $1', [project.project_id]),
            ),
          ),
          '42501',
        );
        const { rowCount } = await c.query('DELETE FROM projects WHERE project_id = $1', [
          project.project_id,
        ]);
        expect(rowCount).toBe(1);
      }));
  });

  describe('CHECK (23514), both sides of every boundary', () => {
    const checks = [
      [
        'ck_roles_role_name_lower',
        'roles',
        [{ role_name: 'lower_ok' }],
        [{ role_name: 'Lower_Bad' }],
      ],
      [
        'ck_roles_role_name_not_blank',
        'roles',
        [{ role_name: 'x' }],
        [{ role_name: '' }, { role_name: '   ' }],
      ],
      [
        'ck_users_full_name_not_blank',
        'users',
        [{ full_name: 'X' }],
        [{ full_name: '' }, { full_name: '   ' }],
      ],
      [
        'ck_users_organization_not_blank',
        'users',
        [{ organization: 'Lab' }],
        [{ organization: '' }, { organization: '  ' }],
      ],
      [
        'ck_users_job_title_not_blank',
        'users',
        [{ job_title: 'Postdoc' }],
        [{ job_title: '' }, { job_title: '  ' }],
      ],
      [
        'ck_users_phone_not_blank',
        'users',
        [{ phone: '+1 555' }],
        [{ phone: '' }, { phone: '  ' }],
      ],
      [
        'ck_users_email_lower',
        'users',
        [{ email: 'a@b.test' }],
        [{ email: 'A@b.test' }, { email: 'a@B.test' }],
      ],
      [
        'ck_users_email_format',
        'users',
        [{ email: 'a@b' }, { email: 'a.b+c@d.e' }],
        [
          { email: 'ab' },
          { email: '@b' },
          { email: 'a@' },
          { email: 'a@@b' },
          { email: 'a b@c' },
          { email: 'a@b c' },
        ],
      ],
      [
        'ck_users_password_hash_not_blank',
        'users',
        [{ password_hash: 'x' }],
        [{ password_hash: '' }, { password_hash: '  ' }],
      ],
      [
        'ck_projects_title_not_blank',
        'projects',
        [{ title: 'x' }],
        [{ title: '' }, { title: '   ' }],
      ],
      [
        'ck_projects_dates',
        'projects',
        [
          { start_date: '2026-03-01', end_date: '2026-03-01' },
          { start_date: '2026-03-01', end_date: '2026-03-02' },
          { start_date: '2026-03-01', end_date: null },
          { start_date: null, end_date: '2026-03-01' },
        ],
        [{ start_date: '2026-03-02', end_date: '2026-03-01' }],
      ],
      [
        'ck_audit_logs_entity_type_not_blank',
        'audit_logs',
        [{ entity_type: 'x' }],
        [{ entity_type: '' }, { entity_type: '   ' }],
      ],
      [
        'ck_audit_logs_details_object',
        'audit_logs',
        [{ details: null }, { details: '{}' }, { details: '{"a": [1, 2]}' }],
        [{ details: '[]' }, { details: '"text"' }, { details: '1' }, { details: 'null' }],
      ],
    ];

    for (const [constraint, table, good, bad] of checks) {
      it(`${constraint}: ${good.length} valid value(s) pass, ${bad.length} invalid value(s) -> 23514`, () =>
        withRollback(async (c) => {
          for (const over of good) {
            await inSavepoint(c, async () => insertValid(c, table, over), { keep: false });
          }
          for (const over of bad) {
            await expectViolation(
              inSavepoint(c, () => insertValid(c, table, over)),
              '23514',
              constraint,
            );
          }
        }));
    }

    it('ck_projects_dates also guards UPDATE: moving end_date before start_date -> 23514', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () =>
            c.query(
              `UPDATE projects SET end_date = '2000-01-01', start_date = '2001-01-01' WHERE project_id = 1`,
            ),
          ),
          '23514',
          'ck_projects_dates',
        );
      }));
  });

  describe('enum values (22P02)', () => {
    it('project_status: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'projects', { status: 'paused' })),
          '22P02',
        );
        const values = await enumValues(c, 'project_status');
        expect(values).toEqual(['planned', 'active', 'completed', 'archived']);
        for (const status of values) await insertValid(c, 'projects', { status });
      }));

    it('project_role: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        const project = await newProject(c);
        await expectViolation(
          inSavepoint(c, () =>
            insertRow(c, 'project_members', {
              project_id: project.project_id,
              user_id: 3,
              project_role: 'guest',
            }),
          ),
          '22P02',
        );
        const values = await enumValues(c, 'project_role');
        expect(values).toEqual(['owner', 'manager', 'contributor', 'viewer']);
        for (const project_role of values) {
          const user = await newUser(c);
          await insertRow(c, 'project_members', {
            project_id: project.project_id,
            user_id: user.user_id,
            project_role,
          });
        }
      }));

    it('audit_action: unknown value rejected, every documented value accepted (the enum is lower case)', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'audit_logs', { action: 'INSERT' })),
          '22P02',
        );
        const values = await enumValues(c, 'audit_action');
        expect(values).toEqual([
          'insert',
          'update',
          'delete',
          'approve',
          'reject',
          'login',
          'export',
        ]);
        for (const action of values) await insertValid(c, 'audit_logs', { action });
      }));
  });

  describe('audit_logs is append-only and users are never hard-deleted (D19)', () => {
    it('the app role can INSERT into audit_logs but not UPDATE or DELETE (42501)', () =>
      withRollback(async (c) => {
        const row = await asAppRole(c, () => insertValid(c, 'audit_logs'));
        await expectViolation(
          inSavepoint(c, () =>
            asAppRole(c, () =>
              c.query(`UPDATE audit_logs SET entity_type = 'x' WHERE audit_id = $1`, [
                row.audit_id,
              ]),
            ),
          ),
          '42501',
        );
        await expectViolation(
          inSavepoint(c, () =>
            asAppRole(c, () =>
              c.query('DELETE FROM audit_logs WHERE audit_id = $1', [row.audit_id]),
            ),
          ),
          '42501',
        );
      }));

    it('the app role cannot DELETE users, roles or projects (42501) but can remove link rows', () =>
      withRollback(async (c) => {
        for (const sql of [
          'DELETE FROM users WHERE user_id = 6',
          'DELETE FROM roles WHERE role_id = 6',
          'DELETE FROM projects WHERE project_id = 2',
        ]) {
          await expectViolation(
            inSavepoint(c, () => asAppRole(c, () => c.query(sql))),
            '42501',
          );
        }
        const removed = await asAppRole(c, () =>
          c.query('DELETE FROM project_members WHERE project_id = 1 AND user_id = 6'),
        );
        expect(removed.rowCount).toBe(1);
      }));

    it('users.email is stored exactly as lower case (all seeded and new rows)', () =>
      withRollback(async (c) => {
        const user = await newUser(c, { email: 'new.person@example.test' });
        expect(user.email).toBe('new.person@example.test');
        const { rows } = await c.query(
          'SELECT count(*)::int AS n FROM users WHERE email <> lower(email)',
        );
        expect(rows[0].n).toBe(0);
      }));
  });

  describe('audit triggers of the Access slice exist and write a row', () => {
    const triggers = [
      ['trg_users_audit', 'users'],
      ['trg_user_roles_audit', 'user_roles'],
      ['trg_projects_audit', 'projects'],
      ['trg_project_members_audit', 'project_members'],
      ['trg_project_sites_audit', 'project_sites'],
    ];

    it.each(triggers)('%s is enabled on %s', async (name, table) => {
      const { rows } = await getPool().query(
        `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`,
        [name, table],
      );
      expect(rows).toEqual([{ tgenabled: 'O' }]);
    });

    it('an INSERT into projects writes one audit row for the project', () =>
      withRollback(async (c) => {
        const project = await newProject(c);
        const { rows } = await c.query(
          `SELECT action FROM audit_logs WHERE entity_type = 'projects' AND entity_id = $1`,
          [project.project_id],
        );
        expect(rows).toEqual([{ action: 'insert' }]);
      }));
  });
});
