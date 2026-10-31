// Owner: A (Backend)
// Purpose: The project routes: list, detail, create, patch, members and sites (needs the seeded test database)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const NOT_FOUND = { error: { code: 'not_found', message: 'Project not found' } };

describe.skipIf(!available)('projects', () => {
  const as = {};

  beforeAll(async () => {
    await resetAndSeedDatabase();
    for (const [role, email] of Object.entries(SEED_EMAIL)) as[role] = await signIn(app, email);
    // A principal_investigator who belongs to no project: passes the role gate, so the project
    // check answers 404 (the other global roles are stopped by the role gate with 403 first).
    const created = await as.administrator.post('/api/users').send({
      full_name: 'Outside Investigator',
      email: 'outsider@example.test',
      password: 'outsider-password',
      role_ids: [2],
    });
    expect(created.status).toBe(201);
    as.outsider = await signIn(app, 'outsider@example.test', 'outsider-password');
  });
  afterAll(async () => {
    loginAttempts.clear();
    await resetAndSeedDatabase();
    await closePool();
  });

  describe('GET /api/projects', () => {
    it('lists what each user can access, with your_role', async () => {
      const ids = async (agent) => (await agent.get('/api/projects')).body.data;
      const admin = await ids(as.administrator);
      expect(admin.map((p) => [p.project_id, p.your_role])).toEqual([
        [1, null],
        [2, null],
      ]);
      expect((await ids(as.principal_investigator)).map((p) => p.your_role)).toEqual([
        'owner',
        'owner',
      ]);
      expect((await ids(as.field_researcher)).map((p) => [p.project_id, p.your_role])).toEqual([
        [1, 'contributor'],
        [2, 'contributor'],
      ]);
      expect((await ids(as.lab_technician)).map((p) => p.project_id)).toEqual([1]);
      expect((await ids(as.analyst)).map((p) => p.project_id)).toEqual([1]);
      expect((await ids(as.viewer)).map((p) => [p.project_id, p.your_role])).toEqual([
        [1, 'viewer'],
      ]);
    });
    it('returns the Project shape: numbers, plain dates, no extra fields', async () => {
      const res = await as.viewer.get('/api/projects');
      expect(res.body.data[0]).toEqual({
        project_id: 1,
        title: 'Yamuna Biodiversity Survey',
        objectives: expect.any(String),
        start_date: '2025-01-15',
        end_date: null,
        status: 'active',
        created_by: 2,
        your_role: 'viewer',
      });
      expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 1 });
    });
    it('filters by status, paginates and sorts; rejects bad values', async () => {
      expect((await as.administrator.get('/api/projects?status=planned')).body.meta.total).toBe(0);
      expect((await as.administrator.get('/api/projects?status=active')).body.meta.total).toBe(2);
      const page = await as.administrator.get('/api/projects?limit=1&page=2&sort=-project_id');
      expect(page.body.data.map((p) => p.project_id)).toEqual([1]);
      expect(page.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
      expect((await as.administrator.get('/api/projects?status=bogus')).status).toBe(422);
      expect((await as.administrator.get('/api/projects?sort=owner')).status).toBe(422);
      expect((await request(app).get('/api/projects')).status).toBe(401);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns ProjectDetail with members and sites to a member', async () => {
      const res = await as.viewer.get('/api/projects/1');
      expect(res.status).toBe(200);
      const { members, sites, ...project } = res.body.data;
      expect(project).toMatchObject({ project_id: 1, your_role: 'viewer' });
      expect(members.map((m) => [m.user_id, m.project_role])).toEqual([
        [2, 'owner'],
        [5, 'contributor'],
        [3, 'contributor'],
        [4, 'contributor'],
        [6, 'viewer'],
      ]);
      expect(Object.keys(members[0]).sort()).toEqual(
        ['email', 'full_name', 'joined_at', 'project_id', 'project_role', 'user_id'].sort(),
      );
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
      expect(sites.map((s) => s.site_id)).toEqual([1, 2, 3]);
      expect(Object.keys(sites[0]).sort()).toEqual(
        [
          'description',
          'habitat_type',
          'latitude',
          'longitude',
          'name',
          'region_id',
          'site_id',
        ].sort(),
      );
      expect(typeof sites[0].latitude).toBe('number');
    });
    it('gives non-members and unknown ids the identical 404, and the admin sees any project', async () => {
      const nonMember = await as.analyst.get('/api/projects/2');
      const missing = await as.analyst.get('/api/projects/99999');
      const adminMissing = await as.administrator.get('/api/projects/99999');
      for (const res of [nonMember, missing, adminMissing]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      expect((await as.administrator.get('/api/projects/2')).status).toBe(200);
      expect((await as.administrator.get('/api/projects/abc')).status).toBe(422);
      expect((await request(app).get('/api/projects/1')).status).toBe(401);
    });
  });

  describe('POST /api/projects', () => {
    it('creates a planned project owned by the caller and audits it with the caller as actor', async () => {
      const res = await as.principal_investigator
        .post('/api/projects')
        .send({ title: '  New Survey  ', objectives: 'Test', start_date: '2026-06-01' });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        project_id: expect.any(Number),
        title: 'New Survey',
        objectives: 'Test',
        start_date: '2026-06-01',
        end_date: null,
        status: 'planned',
        created_by: 2,
        your_role: 'owner',
      });
      expect(res.body.data.project_id).toBeGreaterThanOrEqual(1000);
      const id = res.body.data.project_id;
      const audit = await query(
        `SELECT entity_type, action, actor_id, details FROM audit_logs
          WHERE entity_id = $1 AND entity_type IN ('projects', 'project_members') ORDER BY audit_id`,
        [id],
      );
      expect(audit.map((a) => [a.entity_type, a.action, a.actor_id])).toEqual([
        ['projects', 'insert', 2],
        ['project_members', 'insert', 2],
      ]);
      expect(audit[0].details.title).toEqual({ new: 'New Survey' });
    });
    it('lets an administrator create one (owner is the administrator)', async () => {
      const res = await as.administrator.post('/api/projects').send({ title: 'Admin Survey' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ created_by: 1, your_role: 'owner', objectives: null });
    });
    it('403 for other roles, 401 anonymous', async () => {
      for (const role of ['field_researcher', 'lab_technician', 'analyst', 'viewer']) {
        expect((await as[role].post('/api/projects').send({ title: 'X' })).status, role).toBe(403);
      }
      expect((await request(app).post('/api/projects').send({ title: 'X' })).status).toBe(401);
    });
    it('422 for blank title, bad dates and unknown keys (owner_id is not accepted); 409 for a duplicate', async () => {
      const post = (body) => as.principal_investigator.post('/api/projects').send(body);
      expect((await post({ title: '   ' })).status).toBe(422);
      expect((await post({})).status).toBe(422);
      expect((await post({ title: 'Dates', start_date: '2025-02-30' })).status).toBe(422);
      expect((await post({ title: 'Dates', start_date: '01/02/2025' })).status).toBe(422);
      expect((await post({ title: 'Owned', owner_id: 3 })).status).toBe(422);
      const dup = await post({ title: 'Yamuna Biodiversity Survey' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('duplicate');
      expect(
        (await query("SELECT count(*) AS n FROM projects WHERE title IN ('Owned', 'Dates')"))[0].n,
      ).toBe(0);
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('lets the owner and the administrator change fields and returns the Project', async () => {
      const res = await as.principal_investigator
        .patch('/api/projects/2')
        .send({ objectives: 'Updated', status: 'completed', end_date: '2026-12-31' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        project_id: 2,
        objectives: 'Updated',
        status: 'completed',
        end_date: '2026-12-31',
        your_role: 'owner',
      });
      const cleared = await as.administrator
        .patch('/api/projects/2')
        .send({ end_date: null, status: 'active' });
      expect(cleared.body.data).toMatchObject({
        end_date: null,
        status: 'active',
        your_role: null,
      });
      const audit = await query(
        "SELECT actor_id FROM audit_logs WHERE entity_type = 'projects' AND entity_id = 2 AND action = 'update' ORDER BY audit_id",
      );
      expect(audit.map((a) => a.actor_id)).toEqual([2, 1]);
    });
    it('403 for a contributor and a viewer member, 404 for a non-member, 401 anonymous', async () => {
      expect(
        (await as.field_researcher.patch('/api/projects/1').send({ status: 'archived' })).status,
      ).toBe(403);
      expect((await as.viewer.patch('/api/projects/1').send({ status: 'archived' })).status).toBe(
        403,
      );
      const nonMember = await as.principal_investigator
        .patch('/api/projects/99999')
        .send({ status: 'archived' });
      expect(nonMember.status).toBe(404);
      expect(nonMember.body).toEqual(NOT_FOUND);
      expect(
        (await request(app).patch('/api/projects/1').send({ status: 'archived' })).status,
      ).toBe(401);
    });
    it('422 for a bad range, empty body, unknown keys and bad status; 409 for a duplicate title', async () => {
      const patch = (body) => as.principal_investigator.patch('/api/projects/1').send(body);
      const range = await patch({ end_date: '2024-01-01' });
      expect(range.status).toBe(422);
      expect(range.body.error.details[0].field).toBe('end_date');
      expect((await patch({})).status).toBe(422);
      expect((await patch({ created_by: 3 })).status).toBe(422);
      expect((await patch({ start_date: '2025-01-01' })).status).toBe(422);
      expect((await patch({ status: 'paused' })).status).toBe(422);
      expect((await patch({ title: '  ' })).status).toBe(422);
      const dup = await patch({ title: 'Coastal Estuary Pilot' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('duplicate');
    });
  });

  describe('members', () => {
    it('adds a member (201, Member shape), 409 on a duplicate, and removes it (204)', async () => {
      const add = await as.principal_investigator
        .post('/api/projects/2/members')
        .send({ user_id: 5, project_role: 'manager' });
      expect(add.status).toBe(201);
      expect(add.body.data).toEqual({
        project_id: 2,
        user_id: 5,
        full_name: 'Anil Analyst',
        email: 'analyst@ebiotrack.test',
        project_role: 'manager',
        joined_at: expect.any(String),
      });
      const dup = await as.principal_investigator
        .post('/api/projects/2/members')
        .send({ user_id: 5, project_role: 'viewer' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('duplicate');
      const audit = await query(
        "SELECT actor_id FROM audit_logs WHERE entity_type = 'project_members' AND entity_id = 2 AND action = 'insert'",
      );
      expect(audit.map((a) => a.actor_id)).toEqual([2]);
      // the new manager (global role analyst) still cannot edit: the matrix needs a PI/administrator
      expect((await as.analyst.delete('/api/projects/2/members/5')).status).toBe(403);
      const del = await as.principal_investigator.delete('/api/projects/2/members/5');
      expect(del.status).toBe(204);
      expect(del.text).toBe('');
      expect((await as.principal_investigator.delete('/api/projects/2/members/5')).status).toBe(
        404,
      );
    });
    it('cannot assign owner or remove the owner; rejects unknown, inactive and bad input', async () => {
      const post = (body) => as.principal_investigator.post('/api/projects/2/members').send(body);
      const owner = await post({ user_id: 4, project_role: 'owner' });
      expect(owner.status).toBe(422);
      expect(owner.body.error.code).toBe('rule_violation');
      const removeOwner = await as.principal_investigator.delete('/api/projects/2/members/2');
      expect(removeOwner.status).toBe(422);
      expect(removeOwner.body.error.code).toBe('rule_violation');
      const unknown = await post({ user_id: 9999, project_role: 'viewer' });
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('invalid_reference');
      await query('UPDATE users SET active = false WHERE user_id = 6');
      const inactive = await post({ user_id: 6, project_role: 'viewer' });
      await query('UPDATE users SET active = true WHERE user_id = 6');
      expect(inactive.status).toBe(422);
      expect(inactive.body.error.code).toBe('rule_violation');
      expect((await post({ user_id: 4, project_role: 'boss' })).status).toBe(422);
      expect((await post({ user_id: 4, project_role: 'viewer', extra: 1 })).status).toBe(422);
      expect((await post({ user_id: '4', project_role: 'viewer' })).status).toBe(422);
      expect(
        (await query('SELECT count(*) AS n FROM project_members WHERE project_id = 2'))[0].n,
      ).toBe(2);
    });
    it('is 403 for a viewer or contributor, 404 for a non-member, 401 anonymous', async () => {
      const body = { user_id: 4, project_role: 'viewer' };
      expect((await as.viewer.post('/api/projects/1/members').send(body)).status).toBe(403);
      expect((await as.field_researcher.post('/api/projects/1/members').send(body)).status).toBe(
        403,
      );
      expect((await as.outsider.post('/api/projects/2/members').send(body)).status).toBe(404);
      expect((await request(app).post('/api/projects/1/members').send(body)).status).toBe(401);
      expect((await as.viewer.delete('/api/projects/1/members/3')).status).toBe(403);
    });
  });

  describe('sites', () => {
    it('links a site (201 {project_id, site_id}), 409 on a duplicate, unlinks it (204)', async () => {
      const add = await as.principal_investigator
        .post('/api/projects/1/sites')
        .send({ site_id: 4 });
      expect(add.status).toBe(201);
      expect(add.body).toEqual({ data: { project_id: 1, site_id: 4 } });
      const dup = await as.principal_investigator
        .post('/api/projects/1/sites')
        .send({ site_id: 4 });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('duplicate');
      const del = await as.principal_investigator.delete('/api/projects/1/sites/4');
      expect(del.status).toBe(204);
      expect((await as.principal_investigator.delete('/api/projects/1/sites/4')).status).toBe(404);
    });
    it('422 for an unknown site, 409 with a clear message when events use the link', async () => {
      const unknown = await as.principal_investigator
        .post('/api/projects/1/sites')
        .send({ site_id: 9999 });
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('invalid_reference');
      const used = await as.principal_investigator.delete('/api/projects/1/sites/1');
      expect(used.status).toBe(409);
      expect(used.body.error.message).toMatch(/collection events in this project/);
      expect(
        (await query('SELECT count(*) AS n FROM project_sites WHERE project_id = 1'))[0].n,
      ).toBe(3);
      expect((await as.principal_investigator.post('/api/projects/1/sites').send({})).status).toBe(
        422,
      );
    });
    it('is 403 for a viewer, 404 for a non-member and 401 anonymous', async () => {
      expect((await as.viewer.post('/api/projects/1/sites').send({ site_id: 4 })).status).toBe(403);
      expect((await as.viewer.delete('/api/projects/1/sites/1')).status).toBe(403);
      expect((await as.outsider.post('/api/projects/2/sites').send({ site_id: 1 })).status).toBe(
        404,
      );
      expect((await request(app).delete('/api/projects/1/sites/1')).status).toBe(401);
    });
  });
});
