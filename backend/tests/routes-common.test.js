// Owner: A (Backend)
// Purpose: Cross-cutting checks for the T20 routes: 401 everywhere, error envelope, numeric ids
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();

const ROUTES = [
  ['get', '/api/roles'],
  ['get', '/api/users'],
  ['post', '/api/users'],
  ['patch', '/api/users/3'],
  ['get', '/api/projects'],
  ['post', '/api/projects'],
  ['get', '/api/projects/1'],
  ['patch', '/api/projects/1'],
  ['post', '/api/projects/1/members'],
  ['delete', '/api/projects/1/members/3'],
  ['post', '/api/projects/1/sites'],
  ['delete', '/api/projects/1/sites/1'],
  ['get', '/api/audit'],
];

describe.skipIf(!available)('T20 routes, cross-cutting', () => {
  beforeAll(resetAndSeedDatabase);
  afterAll(async () => {
    loginAttempts.clear();
    await closePool();
  });

  it.each(ROUTES)('%s %s is 401 without a session, in the error envelope', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'unauthenticated', message: 'Authentication required' },
    });
  });

  it('validation errors use the envelope with field details', async () => {
    const admin = await signIn(app, SEED_EMAIL.administrator);
    const res = await admin.post('/api/users').send({ full_name: '', email: 'x', unknown: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.length).toBeGreaterThan(1);
    for (const detail of res.body.error.details) {
      expect(detail).toEqual({ field: expect.any(String), message: expect.any(String) });
    }
  });

  it('ids and counts reach the client as numbers (bigint parsing)', async () => {
    const admin = await signIn(app, SEED_EMAIL.administrator);
    const projects = await admin.get('/api/projects/1');
    const numbers = [
      projects.body.data.project_id,
      projects.body.data.created_by,
      projects.body.data.members[0].user_id,
      projects.body.data.sites[0].site_id,
      projects.body.data.sites[0].region_id,
    ];
    for (const value of numbers) expect(typeof value).toBe('number');
    const list = await admin.get('/api/users');
    expect(typeof list.body.meta.total).toBe('number');
  });

  it('rejects malformed JSON with 400 and an unknown route with 404', async () => {
    const admin = await signIn(app, SEED_EMAIL.administrator);
    const bad = await admin
      .post('/api/projects')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(bad.status).toBe(400);
    expect((await admin.get('/api/projects/1/unknown')).status).toBe(404);
  });
});
