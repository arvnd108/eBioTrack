// Owner: A (Backend)
// Purpose: requireRole, requireProjectAccess and authorize on a throwaway router (needs the seeded test DB)
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { auth } from '../src/middleware/auth.js';
import {
  accessibleProjectIds,
  authorize,
  requireProjectAccess,
  requireRole,
} from '../src/middleware/authorize.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { sessionMiddleware } from '../src/middleware/session.js';
import authRoutes from '../src/routes/auth.routes.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { devPassword, probeDatabase, resetAndSeedDatabase } from './helpers.js';

const available = await probeDatabase();

const ok = (req, res) =>
  res.json({ ok: true, project_id: req.projectId ?? null, project_role: req.projectRole ?? null });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use('/api/auth', authRoutes);
  const t = express.Router();
  t.use(auth);
  t.get('/roles/analyst', requireRole('analyst'), ok);
  t.get('/roles/multi', requireRole('analyst', 'lab_technician'), ok);
  t.get('/projects/:id', requireProjectAccess(), ok);
  t.post('/projects/:id/notes', requireProjectAccess(), ok);
  t.patch('/projects/:id', requireProjectAccess({ projectRoles: ['owner', 'manager'] }), ok);
  t.get('/by-body', requireProjectAccess({ source: 'body.project_id' }), ok);
  t.get('/by-query', requireProjectAccess({ source: 'query.project_id' }), ok);
  t.get('/matrix/create-project', authorize('create_project'), ok);
  t.get('/matrix/manage-users', authorize('manage_users'), ok);
  t.patch('/matrix/edit-project/:id', authorize('edit_project'), ok);
  t.post('/matrix/record-lab/:id', authorize('record_lab'), ok);
  t.get('/matrix/read/:id', authorize('read_project_data'), ok);
  app.use('/api/t', t);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!available)('authorize', () => {
  const app = buildApp();
  const agents = {};
  const asUser = [
    'administrator',
    'principal_investigator',
    'field_researcher',
    'lab_technician',
    'analyst',
    'viewer',
  ];

  beforeAll(async () => {
    await resetAndSeedDatabase();
    const password = await devPassword();
    for (const role of asUser) {
      const agent = request.agent(app);
      const res = await agent
        .post('/api/auth/login')
        .send({ email: `${role}@ebiotrack.test`, password });
      expect(res.status).toBe(200);
      agents[role] = agent;
    }
  });
  afterEach(() => loginAttempts.clear());
  afterAll(async () => {
    await query('UPDATE users SET last_login_at = NULL');
    await query("DELETE FROM audit_logs WHERE action = 'login'");
    await query('DELETE FROM session');
    await closePool();
  });

  it('401 without a session', async () => {
    const res = await request(app).get('/api/t/roles/analyst');
    expect(res.status).toBe(401);
  });

  describe('requireRole', () => {
    it('lets the administrator through everything', async () => {
      expect((await agents.administrator.get('/api/t/roles/analyst')).status).toBe(200);
      expect((await agents.administrator.get('/api/t/matrix/manage-users')).status).toBe(200);
    });

    it('403 forbidden for the wrong global role', async () => {
      const res = await agents.viewer.get('/api/t/roles/analyst');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it('passes when any listed role matches, including a multi-role user', async () => {
      expect((await agents.lab_technician.get('/api/t/roles/multi')).status).toBe(200);
      // Give the viewer a second role and re-read: the user is loaded on every request.
      await query('INSERT INTO user_roles (user_id, role_id) VALUES (6, 5)');
      try {
        expect((await agents.viewer.get('/api/t/roles/analyst')).status).toBe(200);
      } finally {
        await query('DELETE FROM user_roles WHERE user_id = 6 AND role_id = 5');
      }
    });

    it('throws at definition time for an unknown role name', () => {
      expect(() => requireRole('superuser')).toThrow(/unknown role/);
      expect(() => authorize('no_such_action')).toThrow(/unknown action/);
      expect(() => requireProjectAccess({ source: 'headers.x' })).toThrow();
    });
  });

  describe('requireProjectAccess', () => {
    it('lets a member through and exposes the project role', async () => {
      const res = await agents.principal_investigator.get('/api/t/projects/1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, project_id: 1, project_role: 'owner' });
    });

    it('404 not_found for a non-member and for a missing project, with identical bodies', async () => {
      const nonMember = await agents.analyst.get('/api/t/projects/2');
      const missing = await agents.analyst.get('/api/t/projects/999999');
      expect(nonMember.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(nonMember.body).toEqual(missing.body);
      expect(nonMember.body.error.code).toBe('not_found');
    });

    it('lets the administrator in without membership', async () => {
      const res = await agents.administrator.get('/api/t/projects/2');
      expect(res.status).toBe(200);
      expect(res.body.project_role).toBeNull();
    });

    it('treats a project viewer as read-only', async () => {
      expect((await agents.viewer.get('/api/t/projects/1')).status).toBe(200);
      const write = await agents.viewer.post('/api/t/projects/1/notes');
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe('forbidden');
    });

    it('403 for a contributor on an owner/manager-only route, 200 for the owner', async () => {
      expect((await agents.field_researcher.patch('/api/t/projects/1')).status).toBe(403);
      expect((await agents.principal_investigator.patch('/api/t/projects/1')).status).toBe(200);
    });

    it('denies a missing, malformed or unknown project parameter', async () => {
      for (const path of [
        '/api/t/projects/abc',
        '/api/t/projects/0',
        '/api/t/projects/-1',
        '/api/t/projects/1.5',
      ]) {
        const res = await agents.analyst.get(path);
        expect(res.status, path).toBe(404);
      }
      expect((await agents.analyst.get('/api/t/by-body')).status).toBe(404);
      expect((await agents.analyst.get('/api/t/by-query')).status).toBe(404);
    });

    it('reads the project id from the body or query when asked to', async () => {
      const body = await agents.principal_investigator
        .get('/api/t/by-body')
        .send({ project_id: 1 });
      expect(body.status).toBe(200);
      const queryRes = await agents.principal_investigator.get('/api/t/by-query?project_id=2');
      expect(queryRes.status).toBe(200);
      expect((await agents.analyst.get('/api/t/by-query?project_id=2')).status).toBe(404);
    });
  });

  describe('authorize (matrix actions)', () => {
    it('create_project: PI and administrator only', async () => {
      expect((await agents.principal_investigator.get('/api/t/matrix/create-project')).status).toBe(
        200,
      );
      expect((await agents.administrator.get('/api/t/matrix/create-project')).status).toBe(200);
      expect((await agents.field_researcher.get('/api/t/matrix/create-project')).status).toBe(403);
    });

    it('manage_users: administrator only', async () => {
      expect((await agents.principal_investigator.get('/api/t/matrix/manage-users')).status).toBe(
        403,
      );
    });

    it('edit_project: global role first (403), then membership (404), then project role', async () => {
      expect((await agents.analyst.patch('/api/t/matrix/edit-project/1')).status).toBe(403);
      expect(
        (await agents.principal_investigator.patch('/api/t/matrix/edit-project/1')).status,
      ).toBe(200);
    });

    it('record_lab: lab technician is a member of project 1 but not 2', async () => {
      expect((await agents.lab_technician.post('/api/t/matrix/record-lab/1')).status).toBe(200);
      expect((await agents.lab_technician.post('/api/t/matrix/record-lab/2')).status).toBe(404);
      expect((await agents.analyst.post('/api/t/matrix/record-lab/1')).status).toBe(403);
    });

    it('read_project_data: any global role, still scoped to membership', async () => {
      expect((await agents.viewer.get('/api/t/matrix/read/1')).status).toBe(200);
      expect((await agents.viewer.get('/api/t/matrix/read/2')).status).toBe(404);
      expect((await agents.administrator.get('/api/t/matrix/read/2')).status).toBe(200);
    });
  });

  describe('accessibleProjectIds', () => {
    it('is null for an administrator and the member projects otherwise', async () => {
      expect(await accessibleProjectIds({ user_id: 1, roles: ['administrator'] })).toBeNull();
      expect(await accessibleProjectIds({ user_id: 3, roles: ['field_researcher'] })).toEqual(
        expect.arrayContaining([1, 2]),
      );
      expect(await accessibleProjectIds({ user_id: 5, roles: ['analyst'] })).toEqual([1]);
      expect(await accessibleProjectIds({ user_id: 999, roles: ['viewer'] })).toEqual([]);
    });
  });
});
