// Owner: A (Backend)
// Purpose: Self-registered users: own projects, and project roles decide what they can do in each
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { probeDatabase, resetAndSeedDatabase } from './helpers.js';

const available = await probeDatabase();

describe.skipIf(!available)('project roles for self-registered users', () => {
  let ana; // registers, creates a project (owner)
  let ben; // registers, invited as contributor
  let cat; // registers, never invited
  let projectId;
  const register = async (name) => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/register').send({
      full_name: name,
      email: `${name.toLowerCase()}@example.org`,
      password: 'a-long-password',
    });
    expect(res.status).toBe(201);
    return { agent, id: res.body.data.user_id };
  };

  beforeAll(async () => {
    await resetAndSeedDatabase();
    ana = await register('Ana');
    ben = await register('Ben');
    cat = await register('Cat');
  });
  afterAll(async () => {
    await resetAndSeedDatabase();
    await closePool();
  });

  it('a new user (global viewer) creates a project and owns it', async () => {
    const res = await ana.agent.post('/api/projects').send({ title: 'Ana River Survey' });
    expect(res.status).toBe(201);
    expect(res.body.data.your_role).toBe('owner');
    projectId = res.body.data.project_id;
  });

  it('the owner adds a site and invites another user; others cannot see the project', async () => {
    expect(
      (await ana.agent.post(`/api/projects/${projectId}/sites`).send({ site_id: 1 })).status,
    ).toBe(201);
    expect((await cat.agent.get(`/api/projects/${projectId}`)).status).toBe(404);
    expect((await ben.agent.get(`/api/projects/${projectId}`)).status).toBe(404);

    const add = await ana.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ user_id: ben.id, project_role: 'contributor' });
    expect(add.status).toBe(201);
    expect((await ben.agent.get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await cat.agent.get(`/api/projects/${projectId}`)).status).toBe(404);
  });

  const event = (id) => ({
    project_id: id,
    site_id: 1,
    collected_at: '2026-03-12T09:30:00Z',
    samples: [{ sample_type_id: 1 }],
  });

  it('a contributor can record field data in that project only', async () => {
    expect((await ben.agent.post('/api/events').send(event(projectId))).status).toBe(201);
    // project 1 exists but Ben is not a member there: same 404 as an unknown project
    expect((await ben.agent.post('/api/events').send(event(1))).status).toBe(404);
    // Cat is not a member of Ana's project
    expect((await cat.agent.post('/api/events').send(event(projectId))).status).toBe(404);
  });

  it('a contributor cannot manage the project or its members', async () => {
    const edit = await ben.agent.patch(`/api/projects/${projectId}`).send({ objectives: 'x' });
    expect(edit.status).toBe(403);
    const invite = await ben.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ user_id: cat.id, project_role: 'viewer' });
    expect(invite.status).toBe(403);
  });

  it('a project viewer is read-only', async () => {
    await ana.agent
      .post(`/api/projects/${projectId}/members`)
      .send({ user_id: cat.id, project_role: 'viewer' });
    expect((await cat.agent.get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await cat.agent.post('/api/events').send(event(projectId))).status).toBe(403);
  });

  it('roles are per project: the same user is owner in one and viewer in another', async () => {
    const mine = await cat.agent.post('/api/projects').send({ title: 'Cat Lake Survey' });
    expect(mine.body.data.your_role).toBe('owner');
    // her own project: she may write there (it only lacks a site, so the body is refused, not her)
    const own = await cat.agent.post('/api/events').send(event(mine.body.data.project_id));
    expect(own.status).toBe(422);
    // Ana's project: still a viewer
    expect((await cat.agent.post('/api/events').send(event(projectId))).status).toBe(403);
  });
});
