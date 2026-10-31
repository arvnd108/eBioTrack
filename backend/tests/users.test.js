// Owner: A (Backend)
// Purpose: GET /api/roles and the users administration routes (needs the seeded test database)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { updateUser } from '../src/services/users.service.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, devPassword, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const USER_KEYS = ['active', 'email', 'full_name', 'roles', 'user_id'];

describe.skipIf(!available)('roles and users', () => {
  let admin;
  let pi;
  let viewer;
  let password;

  beforeAll(async () => {
    await resetAndSeedDatabase();
    password = await devPassword();
    admin = await signIn(app, SEED_EMAIL.administrator);
    pi = await signIn(app, SEED_EMAIL.principal_investigator);
    viewer = await signIn(app, SEED_EMAIL.viewer);
  });
  afterAll(async () => {
    loginAttempts.clear();
    await resetAndSeedDatabase();
    await closePool();
  });

  describe('GET /api/roles', () => {
    it('returns the six roles ordered by role_id, as numbers, for any signed-in user', async () => {
      const res = await viewer.get('/api/roles');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(6);
      expect(res.body.data.map((r) => r.role_id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(res.body.data[0]).toEqual({
        role_id: 1,
        role_name: 'administrator',
        description: expect.any(String),
      });
      expect(res.body.meta).toBeUndefined();
    });
    it('is 401 without a session', async () => {
      expect((await request(app).get('/api/roles')).status).toBe(401);
    });
  });

  describe('GET /api/users', () => {
    it('lists users in the User shape with pagination meta and no secrets', async () => {
      const res = await admin.get('/api/users');
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 6 });
      expect(res.body.data.map((u) => u.user_id)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const user of res.body.data) {
        expect(Object.keys(user).sort()).toEqual(USER_KEYS);
        expect(typeof user.user_id).toBe('number');
      }
      expect(res.body.data[1].roles).toEqual(['principal_investigator']);
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|\$2[aby]\$/i);
    });
    it('filters by role and by active, and paginates and sorts', async () => {
      const byRole = await admin.get('/api/users?role=analyst');
      expect(byRole.body.data.map((u) => u.user_id)).toEqual([5]);
      expect(byRole.body.meta.total).toBe(1);
      expect((await admin.get('/api/users?active=false')).body.meta.total).toBe(0);
      expect((await admin.get('/api/users?active=true')).body.meta.total).toBe(6);
      const page = await admin.get('/api/users?limit=2&page=2&sort=-user_id');
      expect(page.body.data.map((u) => u.user_id)).toEqual([4, 3]);
      expect(page.body.meta).toEqual({ page: 2, limit: 2, total: 6 });
    });
    it('rejects an unknown role, a bad flag and a bad sort field with 422', async () => {
      for (const qs of ['role=wizard', 'active=maybe', 'sort=password_hash', 'limit=0']) {
        const res = await admin.get(`/api/users?${qs}`);
        expect(res.status, qs).toBe(422);
        expect(res.body.error.code).toBe('validation_error');
      }
    });
    it('is 403 for a principal_investigator and 401 anonymous', async () => {
      expect((await pi.get('/api/users')).status).toBe(403);
      expect((await request(app).get('/api/users')).status).toBe(401);
    });
  });

  describe('POST /api/users', () => {
    const body = (over = {}) => ({
      full_name: '  Nina New  ',
      email: 'Nina.New@Example.TEST',
      password: 'a-good-password',
      role_ids: [5],
      ...over,
    });

    it('creates a user (trimmed, lower-cased), who can then sign in; writes an audit entry', async () => {
      const res = await admin.post('/api/users').send(body());
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({
        user_id: expect.any(Number),
        full_name: 'Nina New',
        email: 'nina.new@example.test',
        roles: ['analyst'],
        active: true,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nina.new@example.test', password: 'a-good-password' });
      expect(login.status).toBe(200);
      const audit = await query(
        `SELECT actor_id, action FROM audit_logs WHERE entity_type = 'users' AND entity_id = $1 AND action = 'insert'`,
        [res.body.data.user_id],
      );
      expect(audit).toEqual([{ actor_id: 1, action: 'insert' }]);
    });
    it('409 duplicate for a repeated email, whatever its case', async () => {
      const res = await admin.post('/api/users').send(body({ email: 'NINA.new@example.test' }));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('duplicate');
    });
    it('422 for short and over-long (73 byte) passwords, unknown role ids and bad bodies', async () => {
      const cases = [
        body({ email: 'a1@example.test', password: 'short' }),
        body({ email: 'a2@example.test', password: 'x'.repeat(73) }),
        body({ email: 'a3@example.test', role_ids: [] }),
        body({ email: 'a4@example.test', role_ids: [5, 5] }),
        body({ email: 'a5@example.test', full_name: '   ' }),
        body({ email: 'not-an-email' }),
        body({ email: 'a6@example.test', is_admin: true }),
      ];
      for (const payload of cases) {
        const res = await admin.post('/api/users').send(payload);
        expect(res.status, JSON.stringify(payload)).toBe(422);
      }
      const unknown = await admin
        .post('/api/users')
        .send(body({ email: 'a7@example.test', role_ids: [999] }));
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('invalid_reference');
      const created = await query(
        "SELECT count(*) AS n FROM users WHERE email LIKE 'a_@example.test'",
      );
      expect(created[0].n).toBe(0);
    });
    it('is 403 for a principal_investigator and 401 anonymous', async () => {
      expect((await pi.post('/api/users').send(body())).status).toBe(403);
      expect((await request(app).post('/api/users').send(body())).status).toBe(401);
    });
  });

  describe('PATCH /api/users/:id', () => {
    it('changes name and roles (the role set is replaced) and returns the User', async () => {
      const res = await admin
        .patch('/api/users/3')
        .send({ full_name: ' Farah F ', role_ids: [3, 4] });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        user_id: 3,
        full_name: 'Farah F',
        roles: ['field_researcher', 'lab_technician'],
      });
      const back = await admin.patch('/api/users/3').send({ role_ids: [3] });
      expect(back.body.data.roles).toEqual(['field_researcher']);
    });
    it('deactivates a user, whose open session stops working at the next request', async () => {
      const session = await signIn(app, SEED_EMAIL.lab_technician);
      expect((await session.get('/api/auth/me')).status).toBe(200);
      const res = await admin.patch('/api/users/4').send({ active: false });
      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
      expect((await session.get('/api/auth/me')).status).toBe(401);
      expect(
        (
          await request(app)
            .post('/api/auth/login')
            .send({ email: SEED_EMAIL.lab_technician, password })
        ).status,
      ).toBe(401);
      await admin.patch('/api/users/4').send({ active: true });
    });
    it('422 rule_violation when an administrator deactivates themselves or drops their own role', async () => {
      const self = await admin.patch('/api/users/1').send({ active: false });
      expect(self.status).toBe(422);
      expect(self.body.error.code).toBe('rule_violation');
      const role = await admin.patch('/api/users/1').send({ role_ids: [2] });
      expect(role.status).toBe(422);
      expect(role.body.error.code).toBe('rule_violation');
      expect((await admin.patch('/api/users/1').send({ full_name: 'Asha Admin' })).status).toBe(
        200,
      );
      expect((await admin.patch('/api/users/1').send({ role_ids: [1, 2] })).status).toBe(200);
      await admin.patch('/api/users/1').send({ role_ids: [1] });
    });
    it('never leaves the system without an active administrator', async () => {
      // A non-administrator actor (service level) tries to deactivate the only administrator.
      await expect(
        updateUser(1, { active: false }, { user_id: 2, roles: [] }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'rule_violation',
      });
      await expect(
        updateUser(1, { role_ids: [2] }, { user_id: 2, roles: [] }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'rule_violation',
      });
      expect((await query('SELECT active FROM users WHERE user_id = 1'))[0].active).toBe(true);
    });
    it('lets one administrator demote another while one stays', async () => {
      await admin.patch('/api/users/2').send({ role_ids: [1, 2] });
      const second = await signIn(app, SEED_EMAIL.principal_investigator);
      const res = await second.patch('/api/users/1').send({ active: false });
      expect(res.status).toBe(200);
      expect((await admin.get('/api/auth/me')).status).toBe(401);
      await query('UPDATE users SET active = true WHERE user_id = 1');
      await query('DELETE FROM user_roles WHERE user_id = 2 AND role_id = 1');
      admin = await signIn(app, SEED_EMAIL.administrator); // its session was destroyed above
    });
    it('404 for an unknown user, 422 for empty, unknown-key and bad bodies, 403 for a PI', async () => {
      expect((await admin.patch('/api/users/9999').send({ active: true })).status).toBe(404);
      expect((await admin.patch('/api/users/3').send({})).status).toBe(422);
      expect((await admin.patch('/api/users/3').send({ email: 'x@example.test' })).status).toBe(
        422,
      );
      expect((await admin.patch('/api/users/3').send({ role_ids: [] })).status).toBe(422);
      expect((await admin.patch('/api/users/3').send({ role_ids: [999] })).status).toBe(422);
      expect((await admin.patch('/api/users/abc').send({ active: true })).status).toBe(422);
      expect((await pi.patch('/api/users/3').send({ active: true })).status).toBe(403);
      expect((await request(app).patch('/api/users/3').send({ active: true })).status).toBe(401);
    });
  });
});
