// Owner: C (Testing & QA)
// Purpose: Query results vs known fixtures: Access, Projects & Audit
//
// Expected values are derived by hand from database/seeds/010_seed_access.sql and 020_seed_field.sql
// (derivation in the comment next to each literal), then compared with (a) the committed prepared
// statement, (b) an oracle written without CTEs or window functions, and (c) the result after a
// rolled-back change to the data. Types: bigint/numeric are strings, int4 is a number, dates are
// YYYY-MM-DD text, timestamptz is ISO UTC (see tests/setup/queries.js).
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newEvent, newProject, newSample, newUser, insertRow, unique } from '../setup/integrity.js';
import { acrossSettings, openQuerySession, TIME_ZONES } from '../setup/queries.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

// Seed facts (010): users 1..6 = Asha Admin (administrator), Pranav Investigator (PI, owns both
// projects), Farah Field, Lakshmi Lab, Anil Analyst, Vikram Viewer; user n holds role n.
// project_members: project 1 = {2 owner, 3 4 5 contributors, 6 viewer}; project 2 = {2 owner, 3 contributor}.
// project_sites (020): project 1 -> sites 1,2,3; project 2 -> sites 4,5.
const PROJECTS = {
  1: {
    title: 'Yamuna Biodiversity Survey',
    status: 'active',
    start_date: '2025-01-15',
    end_date: null,
    members: 5,
    sites: 3,
  },
  2: {
    title: 'Coastal Estuary Pilot',
    status: 'active',
    start_date: '2026-01-10',
    end_date: null,
    members: 2,
    sites: 2,
  },
};

const userProjectRow = (projectId, accessVia, projectRole, canEdit) => ({
  project_id: String(projectId),
  title: PROJECTS[projectId].title,
  status: PROJECTS[projectId].status,
  start_date: PROJECTS[projectId].start_date,
  end_date: PROJECTS[projectId].end_date,
  access_via: accessVia,
  project_role: projectRole,
  can_edit: canEdit,
  owner_name: 'Pranav Investigator',
  member_count: String(PROJECTS[projectId].members),
  site_count: String(PROJECTS[projectId].sites),
});

const USER_PROJECT_COLUMNS = [
  'project_id',
  'title',
  'status',
  'start_date',
  'end_date',
  'access_via',
  'project_role',
  'can_edit',
  'owner_name',
  'member_count',
  'site_count',
];

const MEMBER_COLUMNS = [
  'project_id',
  'title',
  'status',
  'member_count',
  'owner_count',
  'manager_count',
  'contributor_count',
  'viewer_count',
  'owner_name',
  'inactive_members',
  'members',
];

const AUDIT_COLUMNS = [
  'audit_id',
  'created_at',
  'action',
  'actor_id',
  'actor_name',
  'actor_email',
  'step_number',
  'previous_action',
  'since_previous',
  'changed_fields',
  'details',
];

const omit = (row, keys) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
describe.skipIf(!dbAvailable)('access queries', () => {
  let s;
  beforeAll(async () => {
    s = await openQuerySession('access');
  });
  afterAll(async () => {
    await s?.close();
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------
  describe('access: access_user_projects', () => {
    // Oracle: plain lookups on base tables, composed in JS (no CTE, no EXISTS, no CROSS JOIN).
    async function oracleUserProjects(userId, status) {
      const [user] = await s.sql(
        `SELECT u.user_id FROM users u WHERE u.user_id = $1 AND u.active = true`,
        [userId],
      );
      if (!user) return [];
      const admin = await s.sql(
        `SELECT count(*) AS n FROM user_roles ur, roles r
          WHERE r.role_id = ur.role_id AND ur.user_id = $1 AND r.role_name = 'administrator'`,
        [userId],
      );
      const isAdmin = Number(admin[0].n) > 0;
      const projects = await s.sql(
        `SELECT project_id, title, status, start_date, end_date FROM projects ORDER BY project_id`,
      );
      const memberships = await s.sql(
        `SELECT project_id, project_role FROM project_members WHERE user_id = $1`,
        [userId],
      );
      const out = [];
      for (const p of projects) {
        const m = memberships.find((x) => x.project_id === p.project_id);
        if (!isAdmin && !m) continue;
        if (status !== null && p.status !== status) continue;
        const [owner] = await s.sql(
          `SELECT u.full_name FROM users u, project_members o
            WHERE o.user_id = u.user_id AND o.project_id = $1 AND o.project_role = 'owner'`,
          [p.project_id],
        );
        const [members] = await s.sql(
          `SELECT count(*) AS n FROM project_members WHERE project_id = $1`,
          [p.project_id],
        );
        const [sites] = await s.sql(
          `SELECT count(*) AS n FROM project_sites WHERE project_id = $1`,
          [p.project_id],
        );
        out.push({
          project_id: p.project_id,
          title: p.title,
          status: p.status,
          start_date: p.start_date,
          end_date: p.end_date,
          access_via: isAdmin ? 'administrator' : 'membership',
          project_role: m ? m.project_role : null,
          can_edit: isAdmin || (m !== undefined && ['owner', 'manager'].includes(m.project_role)),
          owner_name: owner ? owner.full_name : null,
          member_count: members.n,
          site_count: sites.n,
        });
      }
      return out;
    }

    // A. golden (seed 010: see PROJECTS above)
    it.each([
      // administrator by global role: both projects, no membership row -> project_role NULL
      [
        1,
        null,
        [
          userProjectRow(1, 'administrator', null, true),
          userProjectRow(2, 'administrator', null, true),
        ],
      ],
      // owner of both -> membership + owner + can_edit
      [
        2,
        null,
        [
          userProjectRow(1, 'membership', 'owner', true),
          userProjectRow(2, 'membership', 'owner', true),
        ],
      ],
      // contributor on both -> cannot edit settings
      [
        3,
        null,
        [
          userProjectRow(1, 'membership', 'contributor', false),
          userProjectRow(2, 'membership', 'contributor', false),
        ],
      ],
      // contributors on project 1 only
      [4, null, [userProjectRow(1, 'membership', 'contributor', false)]],
      [5, null, [userProjectRow(1, 'membership', 'contributor', false)]],
      // viewer on project 1 only
      [6, null, [userProjectRow(1, 'membership', 'viewer', false)]],
    ])('user %i, status %s -> the documented rows', async (userId, status, expected) => {
      await acrossSettings(s, async () => {
        expect(await s.execute('access_user_projects', [userId, status])).toEqual(expected);
      });
    });

    it('user 3, status completed -> zero rows (both projects are active)', async () => {
      expect(await s.execute('access_user_projects', [3, 'completed'])).toEqual([]);
    });

    it('user 3, status active -> same rows as no filter', async () => {
      expect(await s.execute('access_user_projects', [3, 'active'])).toEqual(
        await s.execute('access_user_projects', [3, null]),
      );
    });

    it('user 999 (unknown), user 0 and a NULL user -> zero rows, no error', async () => {
      expect(await s.execute('access_user_projects', [999, null])).toEqual([]);
      expect(await s.execute('access_user_projects', [0, null])).toEqual([]);
      expect(await s.execute('access_user_projects', [null, null])).toEqual([]);
    });

    // B. oracle, every user and every status value
    it.each([1, 2, 3, 4, 5, 6, 999])(
      'user %i -> equals the oracle for every status filter',
      async (userId) => {
        for (const status of [null, 'planned', 'active', 'completed', 'archived']) {
          expect(await s.execute('access_user_projects', [userId, status])).toEqual(
            await oracleUserProjects(userId, status),
          );
        }
      },
    );

    // C. filter semantics
    it('the per-status results partition the unfiltered result', async () => {
      for (const userId of [1, 2, 3, 6]) {
        const all = await s.execute('access_user_projects', [userId, null]);
        const parts = [];
        for (const status of ['planned', 'active', 'completed', 'archived']) {
          parts.push(...(await s.execute('access_user_projects', [userId, status])));
        }
        expect(parts.map((r) => r.project_id).sort()).toEqual(all.map((r) => r.project_id).sort());
      }
    });

    // D. metamorphic
    it('deactivating a user -> zero rows for that user only (administrator too)', async () => {
      await s.rollback(async (db) => {
        await db.query('UPDATE users SET active = false WHERE user_id IN (1, 3)');
        expect(await s.execute('access_user_projects', [3, null])).toEqual([]);
        expect(await s.execute('access_user_projects', [1, null])).toEqual([]);
        expect(await s.execute('access_user_projects', [2, null])).toHaveLength(2);
        expect(await s.execute('access_user_projects', [4, null])).toHaveLength(1);
      });
      expect(await s.execute('access_user_projects', [3, null])).toHaveLength(2);
    });

    it('an administrator who is also a member appears once, with the real project_role', async () => {
      await s.rollback(async (db) => {
        await insertRow(db, 'project_members', {
          project_id: 1,
          user_id: 1,
          project_role: 'manager',
        });
        const rows = await s.execute('access_user_projects', [1, null]);
        expect(rows.map((r) => r.project_id)).toEqual(['1', '2']);
        expect(rows[0]).toMatchObject({
          access_via: 'administrator',
          project_role: 'manager',
          can_edit: true,
          member_count: '6',
        });
        expect(rows[1]).toMatchObject({ access_via: 'administrator', project_role: null });
      });
    });

    it('granting the administrator role to a contributor widens access and can_edit', async () => {
      await s.rollback(async (db) => {
        await insertRow(db, 'user_roles', { user_id: 4, role_id: 1 });
        const rows = await s.execute('access_user_projects', [4, null]);
        expect(rows).toEqual([
          { ...userProjectRow(1, 'administrator', 'contributor', true) },
          { ...userProjectRow(2, 'administrator', null, true) },
        ]);
      });
    });

    it('a new project is visible to administrators only until the user is added', async () => {
      await s.rollback(async (db) => {
        const p = await newProject(db, { status: 'planned' });
        const admin = await s.execute('access_user_projects', [1, null]);
        expect(admin.map((r) => r.project_id)).toEqual(['1', '2', p.project_id]);
        // memberless project: owner NULL, zero counts
        expect(admin[2]).toMatchObject({
          status: 'planned',
          owner_name: null,
          member_count: '0',
          site_count: '0',
          project_role: null,
        });
        expect(
          (await s.execute('access_user_projects', [3, null])).map((r) => r.project_id),
        ).toEqual(['1', '2']);
        expect(await s.execute('access_user_projects', [1, 'planned'])).toHaveLength(1);
        await insertRow(db, 'project_members', {
          project_id: p.project_id,
          user_id: 3,
          project_role: 'manager',
        });
        const after = await s.execute('access_user_projects', [3, 'planned']);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({
          project_role: 'manager',
          can_edit: true,
          member_count: '1',
        });
      });
    });

    it.each([
      ['owner', true],
      ['manager', true],
      ['contributor', false],
      ['viewer', false],
    ])('project role %s -> can_edit %s', async (role, canEdit) => {
      await s.rollback(async (db) => {
        const p = await newProject(db);
        const u = await newUser(db);
        await insertRow(db, 'project_members', {
          project_id: p.project_id,
          user_id: u.user_id,
          project_role: role,
        });
        const rows = await s.execute('access_user_projects', [u.user_id, null]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          project_role: role,
          can_edit: canEdit,
          access_via: 'membership',
        });
      });
    });

    it('a project status change moves the project between the status filters', async () => {
      await s.rollback(async (db) => {
        await db.query(`UPDATE projects SET status = 'completed' WHERE project_id = 2`);
        expect(
          (await s.execute('access_user_projects', [3, 'completed'])).map((r) => r.project_id),
        ).toEqual(['2']);
        expect(
          (await s.execute('access_user_projects', [3, 'active'])).map((r) => r.project_id),
        ).toEqual(['1']);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('access_user_projects', [3, null]);
      expect(cols.map((c) => c.name)).toEqual(USER_PROJECT_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        project_id: 'bigint',
        title: 'text',
        status: 'project_status',
        start_date: 'date',
        end_date: 'date',
        access_via: 'text',
        project_role: 'project_role',
        can_edit: 'boolean',
        owner_name: 'text',
        member_count: 'bigint',
        site_count: 'bigint',
      });
      for (const c of cols) expect(c.name).not.toMatch(/password|hash|secret/i);
    });

    // F. determinism
    it('two executions return identical ordered results; generic and custom plans agree', async () => {
      const first = await s.execute('access_user_projects', [1, null]);
      expect(await s.execute('access_user_projects', [1, null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('access_user_projects', [1, null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('access: access_project_members', () => {
    const ROLE_RANK = { owner: 1, manager: 2, contributor: 3, viewer: 4 };

    // Oracle: raw rows, grouped and formatted in JS; counts from one COUNT query per role.
    async function oracleMembers(projectId) {
      const projects = await s.sql(
        `SELECT project_id, title, status FROM projects
          WHERE ($1::bigint IS NULL OR project_id = $1) ORDER BY project_id`,
        [projectId],
      );
      const out = [];
      for (const p of projects) {
        const members = await s.sql(
          `SELECT u.user_id, u.full_name, u.active, pm.project_role
             FROM project_members pm, users u
            WHERE u.user_id = pm.user_id AND pm.project_id = $1`,
          [p.project_id],
        );
        for (const m of members) {
          const roles = await s.sql(
            `SELECT r.role_name FROM user_roles ur, roles r
              WHERE ur.role_id = r.role_id AND ur.user_id = $1 ORDER BY r.role_name`,
            [m.user_id],
          );
          m.global = roles.map((r) => r.role_name).join('/');
        }
        members.sort(
          (a, b) =>
            ROLE_RANK[a.project_role] - ROLE_RANK[b.project_role] ||
            (a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0) ||
            Number(a.user_id) - Number(b.user_id),
        );
        const count = (role) => String(members.filter((m) => m.project_role === role).length);
        const owner = members.find((m) => m.project_role === 'owner');
        out.push({
          project_id: p.project_id,
          title: p.title,
          status: p.status,
          member_count: String(members.length),
          owner_count: count('owner'),
          manager_count: count('manager'),
          contributor_count: count('contributor'),
          viewer_count: count('viewer'),
          owner_name: owner ? owner.full_name : null,
          inactive_members: String(members.filter((m) => !m.active).length),
          members: members.length
            ? members
                .map((m) => `${m.full_name} (${m.project_role}${m.global ? `; ${m.global}` : ''})`)
                .join(', ')
            : null,
        });
      }
      return out;
    }

    const PROJECT_1 = {
      // seed 010: owner 2, contributors 3 4 5, viewer 6; members sorted owner, then contributors by
      // name (Anil, Farah, Lakshmi), then the viewer; global role = the user's seeded role.
      project_id: '1',
      title: 'Yamuna Biodiversity Survey',
      status: 'active',
      member_count: '5',
      owner_count: '1',
      manager_count: '0',
      contributor_count: '3',
      viewer_count: '1',
      owner_name: 'Pranav Investigator',
      inactive_members: '0',
      members:
        'Pranav Investigator (owner; principal_investigator), Anil Analyst (contributor; analyst), ' +
        'Farah Field (contributor; field_researcher), Lakshmi Lab (contributor; lab_technician), ' +
        'Vikram Viewer (viewer; viewer)',
    };
    const PROJECT_2 = {
      project_id: '2',
      title: 'Coastal Estuary Pilot',
      status: 'active',
      member_count: '2',
      owner_count: '1',
      manager_count: '0',
      contributor_count: '1',
      viewer_count: '0',
      owner_name: 'Pranav Investigator',
      inactive_members: '0',
      members:
        'Pranav Investigator (owner; principal_investigator), Farah Field (contributor; field_researcher)',
    };

    // A. golden
    it('NULL -> both projects with the documented counts and member strings', async () => {
      expect(await s.execute('access_project_members', [null])).toEqual([PROJECT_1, PROJECT_2]);
    });
    it('1 -> only project 1; 2 -> only project 2', async () => {
      expect(await s.execute('access_project_members', [1])).toEqual([PROJECT_1]);
      expect(await s.execute('access_project_members', [2])).toEqual([PROJECT_2]);
    });

    // B. oracle
    it.each([null, 1, 2, 999])('project %s -> equals the oracle', async (projectId) => {
      expect(await s.execute('access_project_members', [projectId])).toEqual(
        await oracleMembers(projectId),
      );
    });

    // C. filters
    it('unknown project -> zero rows; the per-project results partition the unfiltered result', async () => {
      expect(await s.execute('access_project_members', [999])).toEqual([]);
      const all = await s.execute('access_project_members', [null]);
      const parts = [
        ...(await s.execute('access_project_members', [1])),
        ...(await s.execute('access_project_members', [2])),
      ];
      expect(parts).toEqual(all);
    });

    // D. metamorphic
    it.each(['manager', 'contributor', 'viewer'])(
      'adding one %s increases exactly that count and member_count by one',
      async (role) => {
        await s.rollback(async (db) => {
          const u = await newUser(db, { full_name: 'Zed Newcomer' });
          await insertRow(db, 'project_members', {
            project_id: 2,
            user_id: u.user_id,
            project_role: role,
          });
          const [row] = await s.execute('access_project_members', [2]);
          const expected = { ...PROJECT_2, member_count: '3' };
          expected[`${role}_count`] = String(Number(PROJECT_2[`${role}_count`]) + 1);
          // the new user has no global role -> no "; role" part; sorted after the others of the same role
          expect(row).toMatchObject({
            member_count: expected.member_count,
            owner_count: '1',
            manager_count: expected.manager_count,
            contributor_count: expected.contributor_count,
            viewer_count: expected.viewer_count,
          });
          expect(row.members).toContain(`Zed Newcomer (${role})`);
        });
      },
    );

    it('deactivating a member counts in inactive_members but not in member_count', async () => {
      await s.rollback(async (db) => {
        await db.query('UPDATE users SET active = false WHERE user_id = 3');
        const rows = await s.execute('access_project_members', [null]);
        expect(rows.map((r) => [r.member_count, r.inactive_members])).toEqual([
          ['5', '1'],
          ['2', '1'],
        ]);
        expect(rows[1]).toEqual({ ...PROJECT_2, inactive_members: '1' });
      });
    });

    it('a project without members still appears: zero counts, NULL owner and members', async () => {
      await s.rollback(async (db) => {
        const p = await newProject(db);
        const [row] = await s.execute('access_project_members', [p.project_id]);
        expect(row).toEqual({
          project_id: p.project_id,
          title: p.title,
          status: p.status,
          member_count: '0',
          owner_count: '0',
          manager_count: '0',
          contributor_count: '0',
          viewer_count: '0',
          owner_name: null,
          inactive_members: '0',
          members: null,
        });
        expect(await s.execute('access_project_members', [null])).toHaveLength(3);
        await insertRow(db, 'project_members', {
          project_id: p.project_id,
          user_id: 4,
          project_role: 'owner',
        });
        const [owned] = await s.execute('access_project_members', [p.project_id]);
        expect(owned).toMatchObject({
          owner_count: '1',
          owner_name: 'Lakshmi Lab',
          member_count: '1',
        });
      });
    });

    it('a user with several global roles still counts as one member', async () => {
      await s.rollback(async (db) => {
        await insertRow(db, 'user_roles', { user_id: 3, role_id: 5 });
        await insertRow(db, 'user_roles', { user_id: 3, role_id: 6 });
        const [row] = await s.execute('access_project_members', [2]);
        expect(row.member_count).toBe('2');
        expect(row.contributor_count).toBe('1');
        // roles are joined alphabetically
        expect(row.members).toBe(
          'Pranav Investigator (owner; principal_investigator), Farah Field (contributor; analyst/field_researcher/viewer)',
        );
      });
    });

    it('members are ordered owner, manager, contributor, viewer, then by name', async () => {
      await s.rollback(async (db) => {
        const a = await newUser(db, { full_name: 'Aaron Viewer' });
        const z = await newUser(db, { full_name: 'Zoe Manager' });
        await insertRow(db, 'project_members', {
          project_id: 2,
          user_id: a.user_id,
          project_role: 'viewer',
        });
        await insertRow(db, 'project_members', {
          project_id: 2,
          user_id: z.user_id,
          project_role: 'manager',
        });
        const [row] = await s.execute('access_project_members', [2]);
        expect(row.members).toBe(
          'Pranav Investigator (owner; principal_investigator), Zoe Manager (manager), ' +
            'Farah Field (contributor; field_researcher), Aaron Viewer (viewer)',
        );
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('access_project_members', [null]);
      expect(cols.map((c) => c.name)).toEqual(MEMBER_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        project_id: 'bigint',
        member_count: 'bigint',
        owner_count: 'bigint',
        inactive_members: 'bigint',
        owner_name: 'text',
        members: 'text',
      });
      for (const c of cols) expect(c.name).not.toMatch(/password|hash|secret/i);
    });

    // F. determinism
    it('two executions are identical; generic and custom plans agree', async () => {
      const first = await s.execute('access_project_members', [null]);
      expect(await s.execute('access_project_members', [null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('access_project_members', [null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('access: access_entity_audit_trail', () => {
    // The seed has no audit rows. The scratch trail uses its own entity_type values (not an audited
    // table, so no trigger writes into the same trail) and explicit audit ids in 9001-9012.
    const T = 'qa_t31_trail';
    const O = 'qa_t31_other';
    async function insertTrail(db) {
      const rows = [
        [9001, 3, T, 1, 'insert', '{"status": {"new": "collected"}}', '2026-01-10 09:00:00+00'],
        [
          9002,
          4,
          T,
          1,
          'update',
          '{"status": {"old": "collected", "new": "stored"}}',
          '2026-01-10 11:30:00+00',
        ],
        [9003, 3, T, 2, 'insert', '{"status": {"new": "collected"}}', '2026-01-10 09:00:30+00'],
        [9004, 2, O, 1, 'update', '{}', '2026-01-10 10:00:00+00'],
        [9005, 3, T, 1, 'update', null, '2026-01-11 08:00:00+00'],
        [
          9006,
          null,
          T,
          1,
          'update',
          '{"status": {"old": "stored", "new": "extracted"}, "note": "auto"}',
          '2026-01-12 00:00:00+00',
        ],
        [
          9007,
          null,
          T,
          2,
          'update',
          '{"status": {"old": "collected", "new": "stored"}}',
          '2026-01-13 00:00:00+00',
        ],
        // entity 3: same instant, inserted in the opposite order of audit_id (tie-break by audit_id)
        [9010, 2, T, 3, 'insert', '{"k": 1}', '2026-02-01 00:00:00+00'],
        [9008, 2, T, 3, 'update', '{"k": 2}', '2026-02-01 00:00:00+00'],
      ];
      for (const [id, actor, type, entity, action, details, at] of rows) {
        await db.query(
          `INSERT INTO audit_logs (audit_id, actor_id, entity_type, entity_id, action, details, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, actor, type, entity, action, details, at],
        );
      }
    }
    const trail = (entity, from = null, to = null) =>
      s.execute('access_entity_audit_trail', [T, entity, from, to]);

    // Oracle: correlated subqueries instead of window functions.
    async function oracleTrail(type, entity, from, to) {
      return s
        .sql(
          `SELECT a.audit_id, a.created_at, a.action, a.actor_id,
                (SELECT u.full_name FROM users u WHERE u.user_id = a.actor_id) AS actor_name,
                (SELECT u.email FROM users u WHERE u.user_id = a.actor_id)     AS actor_email,
                (SELECT count(*) FROM audit_logs b
                  WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id
                    AND (b.created_at < a.created_at
                         OR (b.created_at = a.created_at AND b.audit_id <= a.audit_id))) AS step_number,
                (SELECT b.action FROM audit_logs b
                  WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id
                    AND (b.created_at < a.created_at
                         OR (b.created_at = a.created_at AND b.audit_id < a.audit_id))
                  ORDER BY b.created_at DESC, b.audit_id DESC LIMIT 1) AS previous_action,
                a.created_at - (SELECT b.created_at FROM audit_logs b
                  WHERE b.entity_type = a.entity_type AND b.entity_id = a.entity_id
                    AND (b.created_at < a.created_at
                         OR (b.created_at = a.created_at AND b.audit_id < a.audit_id))
                  ORDER BY b.created_at DESC, b.audit_id DESC LIMIT 1) AS since_previous,
                COALESCE((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a.details) AS k),
                         ARRAY[]::text[]) AS changed_fields,
                a.details
           FROM audit_logs a
          WHERE a.entity_type = $1 AND a.entity_id = $2
            AND ($3::timestamptz IS NULL OR a.created_at >= $3)
            AND ($4::timestamptz IS NULL OR a.created_at <= $4)
          ORDER BY a.created_at, a.audit_id`,
          [type, entity, from, to],
        )
        .then((rows) => rows.map((r) => ({ ...r, step_number: Number(r.step_number) })));
    }

    // The query's step_number is bigint (row_number) -> string; align the oracle's type.
    const asQueryTypes = (rows) => rows.map((r) => ({ ...r, step_number: String(r.step_number) }));

    it('the seeded database has no audit rows -> zero rows for any entity', async () => {
      expect(await s.execute('access_entity_audit_trail', ['samples', 1, null, null])).toEqual([]);
    });

    // A. golden (derivation: the T14-C scratch trail above, timestamps and actors as inserted)
    it('(entity 1) -> 4 rows: audits 9001, 9002, 9005, 9006, steps 1-4, other entities excluded', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        await acrossSettings(s, async () => {
          const rows = await trail(1);
          expect(rows).toEqual([
            {
              audit_id: '9001',
              created_at: '2026-01-10T09:00:00.000Z',
              action: 'insert',
              actor_id: '3',
              actor_name: 'Farah Field',
              actor_email: 'field_researcher@ebiotrack.test',
              step_number: '1',
              previous_action: null,
              since_previous: null,
              changed_fields: ['status'],
              details: { status: { new: 'collected' } },
            },
            {
              audit_id: '9002',
              created_at: '2026-01-10T11:30:00.000Z',
              action: 'update',
              actor_id: '4',
              actor_name: 'Lakshmi Lab',
              actor_email: 'lab_technician@ebiotrack.test',
              step_number: '2',
              previous_action: 'insert',
              since_previous: '02:30:00', // 11:30 - 09:00
              changed_fields: ['status'],
              details: { status: { old: 'collected', new: 'stored' } },
            },
            {
              audit_id: '9005',
              created_at: '2026-01-11T08:00:00.000Z',
              action: 'update',
              actor_id: '3',
              actor_name: 'Farah Field',
              actor_email: 'field_researcher@ebiotrack.test',
              step_number: '3',
              previous_action: 'update',
              since_previous: '20:30:00', // 01-11 08:00 - 01-10 11:30
              changed_fields: [], // details is NULL
              details: null,
            },
            {
              audit_id: '9006',
              created_at: '2026-01-12T00:00:00.000Z',
              action: 'update',
              actor_id: null,
              actor_name: null,
              actor_email: null,
              step_number: '4',
              previous_action: 'update',
              since_previous: '16:00:00', // 01-12 00:00 - 01-11 08:00
              changed_fields: ['note', 'status'], // sorted top-level keys
              details: { status: { old: 'stored', new: 'extracted' }, note: 'auto' },
            },
          ]);
        });
      });
    });

    it('(entity 2) -> audits 9003 and 9007 with a system actor and a 2 day 14:59:30 gap', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const rows = await trail(2);
        expect(
          rows.map((r) => [r.audit_id, r.step_number, r.previous_action, r.since_previous]),
        ).toEqual([
          ['9003', '1', null, null],
          ['9007', '2', 'insert', '2 days 14:59:30'], // 01-13 00:00 - 01-10 09:00:30
        ]);
        expect(rows[1].actor_name).toBeNull();
      });
    });

    it('a trail of another entity_type is not mixed in (same entity_id 1)', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const rows = await s.execute('access_entity_audit_trail', [O, 1, null, null]);
        expect(rows.map((r) => [r.audit_id, r.step_number, r.changed_fields, r.details])).toEqual([
          ['9004', '1', [], {}],
        ]);
      });
    });

    // B. oracle
    it.each([
      [T, 1, null, null],
      [T, 2, null, null],
      [T, 3, null, null],
      [O, 1, null, null],
      [T, 1, '2026-01-10T11:30:00Z', null],
      [T, 1, null, '2026-01-11T08:00:00Z'],
      [T, 1, '2026-01-10T11:30:00Z', '2026-01-11T08:00:00Z'],
      [T, 4, null, null],
    ])(
      '(%s, %s, from %s, to %s) -> equals the window-free oracle',
      async (type, entity, from, to) => {
        await s.rollback(async (db) => {
          await insertTrail(db);
          const got = await s.execute('access_entity_audit_trail', [type, entity, from, to]);
          const expected = asQueryTypes(await oracleTrail(type, entity, from, to));
          expect(got).toEqual(expected);
        });
      },
    );

    // C. filters: bounds inclusive, windows over the FULL history
    it('from is inclusive and the windows still see the hidden earlier rows', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const rows = await trail(1, '2026-01-11T00:00:00Z');
        expect(
          rows.map((r) => [r.audit_id, r.step_number, r.previous_action, r.since_previous]),
        ).toEqual([
          ['9005', '3', 'update', '20:30:00'],
          ['9006', '4', 'update', '16:00:00'],
        ]);
        const exact = await trail(1, '2026-01-10T11:30:00Z');
        expect(exact.map((r) => [r.audit_id, r.step_number])).toEqual([
          ['9002', '2'],
          ['9005', '3'],
          ['9006', '4'],
        ]);
      });
    });

    it('to is inclusive and does not renumber', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        expect((await trail(1, null, '2026-01-10T11:30:00Z')).map((r) => r.audit_id)).toEqual([
          '9001',
          '9002',
        ]);
        expect((await trail(1, null, '2026-01-10T11:29:59Z')).map((r) => r.audit_id)).toEqual([
          '9001',
        ]);
        // both bounds: only the middle two, steps 2 and 3
        expect(
          (await trail(1, '2026-01-10T11:30:00Z', '2026-01-11T08:00:00Z')).map((r) => [
            r.audit_id,
            r.step_number,
          ]),
        ).toEqual([
          ['9002', '2'],
          ['9005', '3'],
        ]);
        // empty window -> zero rows
        expect(await trail(1, '2026-03-01T00:00:00Z', null)).toEqual([]);
        expect(await trail(1, '2026-01-12T00:00:00Z', '2026-01-10T00:00:00Z')).toEqual([]);
      });
    });

    it('unknown entity, unknown type and case-different type -> zero rows', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        expect(await trail(99)).toEqual([]);
        expect(await s.execute('access_entity_audit_trail', ['nothing', 1, null, null])).toEqual(
          [],
        );
        expect(
          await s.execute('access_entity_audit_trail', [T.toUpperCase(), 1, null, null]),
        ).toEqual([]);
      });
    });

    it('results are identical in every session time zone (timestamps are instants)', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const base = await trail(1, '2026-01-11T00:00:00Z');
        for (const tz of TIME_ZONES) {
          await s.withTimeZone(tz, async () => {
            expect(await trail(1, '2026-01-11T00:00:00Z')).toEqual(base);
          });
        }
        // the same instant written with an offset selects the same rows
        expect(await trail(1, '2026-01-11T05:30:00+05:30')).toEqual(base);
      });
    });

    // D. metamorphic
    it('a tie on created_at is broken by audit_id', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const rows = await trail(3);
        expect(
          rows.map((r) => [
            r.audit_id,
            r.action,
            r.step_number,
            r.previous_action,
            r.since_previous,
          ]),
        ).toEqual([
          ['9008', 'update', '1', null, null],
          ['9010', 'insert', '2', 'update', '00:00:00'],
        ]);
      });
    });

    it('adding an earlier row shifts every later step number by one', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        await db.query(
          `INSERT INTO audit_logs (audit_id, actor_id, entity_type, entity_id, action, details, created_at)
           VALUES (9011, 2, $1, 1, 'insert', '{}', '2026-01-01 00:00:00+00')`,
          [T],
        );
        const rows = await trail(1);
        expect(rows.map((r) => [r.audit_id, r.step_number])).toEqual([
          ['9011', '1'],
          ['9001', '2'],
          ['9002', '3'],
          ['9005', '4'],
          ['9006', '5'],
        ]);
        expect(rows[1].previous_action).toBe('insert');
        // a later window still sees all 5
        expect((await trail(1, '2026-01-12T00:00:00Z'))[0].step_number).toBe('5');
      });
    });

    it('a renamed actor shows the new name in every row of the trail', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        await db.query(`UPDATE users SET full_name = 'Farah Renamed' WHERE user_id = 3`);
        expect((await trail(1)).map((r) => r.actor_name)).toEqual([
          'Farah Renamed',
          'Lakshmi Lab',
          'Farah Renamed',
          null,
        ]);
      });
    });

    it('details with several keys: changed_fields is the sorted key set', async () => {
      await s.rollback(async (db) => {
        await db.query(
          `INSERT INTO audit_logs (audit_id, actor_id, entity_type, entity_id, action, details, created_at)
           VALUES (9020, 2, $1, 7, 'update', '{"zeta": 1, "alpha": {"x": 1}, "Mid": null}', '2026-03-01 00:00:00+00')`,
          [T],
        );
        const [row] = await trail(7);
        // jsonb_object_keys order is by length then bytes; the query sorts with the database collation
        expect([...row.changed_fields].sort()).toEqual(
          [...(await oracleTrail(T, 7, null, null))[0].changed_fields].sort(),
        );
        expect(row.changed_fields).toHaveLength(3);
        expect(new Set(row.changed_fields)).toEqual(new Set(['zeta', 'alpha', 'Mid']));
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const cols = await s.columns('access_entity_audit_trail', [T, 1, null, null]);
        expect(cols.map((c) => c.name)).toEqual(AUDIT_COLUMNS);
        expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
          audit_id: 'bigint',
          created_at: 'timestamp with time zone',
          action: 'audit_action',
          actor_id: 'bigint',
          step_number: 'bigint',
          since_previous: 'interval',
          changed_fields: 'text[]',
          details: 'jsonb',
        });
        for (const c of cols) expect(c.name).not.toMatch(/password|hash|secret/i);
      });
    });

    // F. determinism and plans
    it('two executions are identical; generic and custom plans agree', async () => {
      await s.rollback(async (db) => {
        await insertTrail(db);
        const first = await trail(1, '2026-01-10T11:30:00Z');
        expect(await trail(1, '2026-01-10T11:30:00Z')).toEqual(first);
        for (const mode of ['force_generic_plan', 'force_custom_plan']) {
          await s.withPlanMode(mode, async () => {
            expect(await trail(1, '2026-01-10T11:30:00Z')).toEqual(first);
          });
        }
      });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('access: v_user_project_access', () => {
    const toViewRow = (r, userId) => ({
      project_id: r.project_id,
      project_title: r.title,
      project_status: r.status,
      access_via: r.access_via,
      project_role: r.project_role,
      can_edit: r.can_edit,
      user_id: String(userId),
    });

    it('has 9 rows: 2 + 2 + 2 + 1 + 1 + 1 for users 1-6 (seed 010: 2 administrator rows, 7 memberships)', async () => {
      const rows = await s.queryView('v_user_project_access', { orderBy: 'user_id, project_id' });
      expect(rows).toHaveLength(9);
      const perUser = {};
      for (const r of rows) perUser[r.user_id] = (perUser[r.user_id] ?? 0) + 1;
      expect(perUser).toEqual({ 1: 2, 2: 2, 3: 2, 4: 1, 5: 1, 6: 1 });
    });

    it('user 1 is the administrator with NULL project_role; user 6 is a viewer; can_edit only for users 1 and 2', async () => {
      const rows = await s.queryView('v_user_project_access', { orderBy: 'user_id, project_id' });
      expect(rows.filter((r) => r.user_id === '1')).toEqual([
        {
          user_id: '1',
          full_name: 'Asha Admin',
          email: 'administrator@ebiotrack.test',
          project_id: '1',
          project_title: 'Yamuna Biodiversity Survey',
          project_status: 'active',
          access_via: 'administrator',
          project_role: null,
          can_edit: true,
        },
        {
          user_id: '1',
          full_name: 'Asha Admin',
          email: 'administrator@ebiotrack.test',
          project_id: '2',
          project_title: 'Coastal Estuary Pilot',
          project_status: 'active',
          access_via: 'administrator',
          project_role: null,
          can_edit: true,
        },
      ]);
      expect(rows.filter((r) => r.user_id === '6').map((r) => r.project_role)).toEqual(['viewer']);
      const editors = new Set(rows.filter((r) => r.can_edit).map((r) => r.user_id));
      expect(editors).toEqual(new Set(['1', '2']));
    });

    it.each([1, 2, 3, 4, 5, 6, 999])(
      'user %i -> same projects, roles and flags as access_user_projects',
      async (userId) => {
        const fromView = await s.queryView('v_user_project_access', {
          where: 'user_id = $1',
          params: [userId],
          orderBy: 'project_id',
        });
        const fromQuery = await s.execute('access_user_projects', [userId, null]);
        expect(fromView.map((row) => omit(row, ['user_id', 'full_name', 'email']))).toEqual(
          fromQuery.map((r) => {
            const v = toViewRow(r, userId);
            delete v.user_id;
            return v;
          }),
        );
      },
    );

    it('a deactivated user disappears from the view; a new administrator sees every project once', async () => {
      await s.rollback(async (db) => {
        await db.query('UPDATE users SET active = false WHERE user_id = 3');
        expect(await s.queryView('v_user_project_access', { where: 'user_id = 3' })).toEqual([]);
        expect(await s.queryView('v_user_project_access')).toHaveLength(7);
        await insertRow(db, 'user_roles', { user_id: 5, role_id: 1 });
        const analyst = await s.queryView('v_user_project_access', {
          where: 'user_id = 5',
          orderBy: 'project_id',
        });
        expect(
          analyst.map((r) => [r.project_id, r.access_via, r.project_role, r.can_edit]),
        ).toEqual([
          ['1', 'administrator', 'contributor', true],
          ['2', 'administrator', null, true],
        ]);
      });
    });

    it('returns exactly the documented columns, in order', async () => {
      const cols = await s.viewColumns('v_user_project_access');
      expect(cols.map((c) => c.name)).toEqual([
        'user_id',
        'full_name',
        'email',
        'project_id',
        'project_title',
        'project_status',
        'access_via',
        'project_role',
        'can_edit',
      ]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('access: v_project_summary', () => {
    // seed 020: events 1-6 belong to project 1 and events 7, 8 to project 2; samples 2n-1 and 2n on
    // event n, plus sample 17 on event 1 -> project 1: 12 + 1 = 13 samples; project 2: 4.
    const SUMMARY_COLUMNS = [
      'project_id',
      'title',
      'status',
      'start_date',
      'end_date',
      'created_by',
      'owner_id',
      'owner_name',
      'member_count',
      'manager_count',
      'contributor_count',
      'viewer_count',
      'site_count',
      'event_count',
      'sample_count',
    ];

    it('project 1: owner 2, 5 members (0 manager / 3 contributor / 1 viewer), 3 sites, 6 events, 13 samples', async () => {
      const [row] = await s.queryView('v_project_summary', { where: 'project_id = 1' });
      expect(row).toEqual({
        project_id: '1',
        title: 'Yamuna Biodiversity Survey',
        status: 'active',
        start_date: '2025-01-15',
        end_date: null,
        created_by: '2',
        owner_id: '2',
        owner_name: 'Pranav Investigator',
        member_count: '5',
        manager_count: '0',
        contributor_count: '3',
        viewer_count: '1',
        site_count: '3',
        event_count: '6',
        sample_count: '13',
      });
    });

    it('project 2: owner 2, 2 members (0 / 1 / 0), 2 sites, 2 events, 4 samples', async () => {
      const [row] = await s.queryView('v_project_summary', { where: 'project_id = 2' });
      expect(row).toMatchObject({
        owner_id: '2',
        member_count: '2',
        manager_count: '0',
        contributor_count: '1',
        viewer_count: '0',
        site_count: '2',
        event_count: '2',
        sample_count: '4',
      });
    });

    it('has one row per project and agrees with access_project_members on the member counts', async () => {
      const rows = await s.queryView('v_project_summary', { orderBy: 'project_id' });
      const members = await s.execute('access_project_members', [null]);
      expect(rows).toHaveLength(2);
      expect(
        rows.map((r) => [
          r.project_id,
          r.member_count,
          r.manager_count,
          r.contributor_count,
          r.viewer_count,
          r.owner_name,
        ]),
      ).toEqual(
        members.map((m) => [
          m.project_id,
          m.member_count,
          m.manager_count,
          m.contributor_count,
          m.viewer_count,
          m.owner_name,
        ]),
      );
    });

    it('oracle: base-table counts per project', async () => {
      for (const projectId of [1, 2]) {
        const [truth] = await s.sql(
          `SELECT (SELECT count(*) FROM project_sites WHERE project_id = $1) AS sites,
                  (SELECT count(*) FROM collection_events WHERE project_id = $1) AS events,
                  (SELECT count(*) FROM samples sa, collection_events ce
                    WHERE sa.event_id = ce.event_id AND ce.project_id = $1) AS samples`,
          [projectId],
        );
        const [row] = await s.queryView('v_project_summary', {
          where: 'project_id = $1',
          params: [projectId],
        });
        expect([row.site_count, row.event_count, row.sample_count]).toEqual([
          truth.sites,
          truth.events,
          truth.samples,
        ]);
      }
    });

    it('a memberless, empty project has zero counts and a NULL owner (not a missing row)', async () => {
      await s.rollback(async (db) => {
        const p = await newProject(db);
        const [row] = await s.queryView('v_project_summary', {
          where: 'project_id = $1',
          params: [p.project_id],
        });
        expect(row).toMatchObject({
          owner_id: null,
          owner_name: null,
          member_count: '0',
          manager_count: '0',
          contributor_count: '0',
          viewer_count: '0',
          site_count: '0',
          event_count: '0',
          sample_count: '0',
        });
      });
    });

    it('adding a manager, an event and a sample moves exactly those counts', async () => {
      await s.rollback(async (db) => {
        const u = await newUser(db);
        await insertRow(db, 'project_members', {
          project_id: 2,
          user_id: u.user_id,
          project_role: 'manager',
        });
        const event = await newEvent(db, {
          project_id: 2,
          site_id: 4,
          collected_at: '2026-05-01T00:00:00Z',
        });
        await newSample(db, { event_id: event.event_id, sample_code: unique('QA-S') });
        const [row] = await s.queryView('v_project_summary', { where: 'project_id = 2' });
        expect(row).toMatchObject({
          member_count: '3',
          manager_count: '1',
          contributor_count: '1',
          viewer_count: '0',
          event_count: '3',
          sample_count: '5',
          site_count: '2',
        });
        const [other] = await s.queryView('v_project_summary', { where: 'project_id = 1' });
        expect([other.member_count, other.event_count, other.sample_count]).toEqual([
          '5',
          '6',
          '13',
        ]);
      });
    });

    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_project_summary')).map((c) => c.name)).toEqual(
        SUMMARY_COLUMNS,
      );
    });
  });
});
