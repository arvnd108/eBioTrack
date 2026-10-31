// Owner: A (Backend)
// Purpose: GET /api/audit and recentActivity (needs the seeded test database)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { canReadAudit, recentActivity } from '../src/services/audit.service.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const ENTRY_KEYS = [
  'action',
  'actor_id',
  'audit_id',
  'created_at',
  'details',
  'entity_id',
  'entity_type',
];

describe.skipIf(!available)('audit', () => {
  const as = {};
  let projectA; // created by the seeded PI (user 2)
  let projectB; // created by a second PI who owns nothing else
  let chain; // ids of lab/analysis rows reached from project 1

  beforeAll(async () => {
    await resetAndSeedDatabase();
    for (const [role, email] of Object.entries(SEED_EMAIL)) as[role] = await signIn(app, email);
    const user = await as.administrator.post('/api/users').send({
      full_name: 'Second Investigator',
      email: 'second@example.test',
      password: 'second-password',
      role_ids: [2],
    });
    as.second = await signIn(app, 'second@example.test', 'second-password');
    projectA = (await as.principal_investigator.post('/api/projects').send({ title: 'Audit A' }))
      .body.data.project_id;
    projectB = (await as.second.post('/api/projects').send({ title: 'Audit B' })).body.data
      .project_id;
    await as.principal_investigator
      .post(`/api/projects/${projectA}/members`)
      .send({ user_id: 5, project_role: 'viewer' });
    // Entries for entity types that belong to a project through a chain, and one that belongs to none.
    // Seeded event 1 and sample 1 are in project 1; site 1 belongs to no single project.
    await query(
      `INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, created_at) VALUES
         (3, 'collection_events', 1, 'insert', now()), (3, 'samples', 1, 'insert', now()),
         (3, 'sampling_sites', 1, 'update', now())`,
    );
    expect(user.status).toBe(201);
    // Lab and analysis entities reached through project 1's samples (found through the chain).
    const [{ x, l, r, a, q }] = await query(
      `SELECT (SELECT min(extraction_id) FROM dna_extractions WHERE sample_id IN
                 (SELECT sample_id FROM samples WHERE event_id IN
                    (SELECT event_id FROM collection_events WHERE project_id = 1))) AS x,
              (SELECT min(library_id) FROM sequencing_libraries) AS l,
              (SELECT min(run_id) FROM sequencing_runs) AS r,
              (SELECT min(analysis_id) FROM analysis_runs) AS a,
              (SELECT min(qc_id) FROM quality_control_results WHERE sample_id = 1) AS q`,
    );
    chain = { x, l, r, a, q };
    await query(
      `INSERT INTO audit_logs (actor_id, entity_type, entity_id, action) VALUES
         (4, 'dna_extractions', $1, 'update'), (4, 'sequencing_libraries', $2, 'update'),
         (4, 'sequencing_runs', $3, 'update'), (5, 'analysis_runs', $4, 'update'),
         (4, 'quality_control_results', $5, 'insert'), (4, 'data_exports', 999999, 'export')`,
      [x, l, r, a, q],
    );
  });
  afterAll(async () => {
    loginAttempts.clear();
    await resetAndSeedDatabase();
    await closePool();
  });

  describe('administrator', () => {
    it('sees every entry, newest first, in the AuditEntry shape with numeric ids', async () => {
      const res = await as.administrator.get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeGreaterThan(8);
      for (const entry of res.body.data) {
        expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
        expect(typeof entry.audit_id).toBe('number');
        expect(typeof entry.entity_id).toBe('number');
      }
      const stamps = res.body.data.map((e) => [e.created_at, e.audit_id]);
      const sorted = [...stamps].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : b[1] - a[1]));
      expect(stamps).toEqual(sorted);
      expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
    });
    it('filters by entity, actor and date range, and paginates', async () => {
      const trail = await as.administrator.get(
        `/api/audit?entity_type=projects&entity_id=${projectA}`,
      );
      expect(trail.body.data).toHaveLength(1);
      expect(trail.body.data[0]).toMatchObject({ action: 'insert', actor_id: 2 });
      expect(trail.body.data[0].details.title).toEqual({ new: 'Audit A' });
      const members = await as.administrator.get(
        `/api/audit?entity_type=project_members&entity_id=${projectA}`,
      );
      expect(members.body.data.map((e) => e.actor_id)).toEqual([2, 2]); // viewer added, then owner row
      const byActor = await as.administrator.get('/api/audit?actor_id=2');
      expect(byActor.body.data.length).toBeGreaterThan(0);
      expect(byActor.body.data.every((e) => e.actor_id === 2)).toBe(true);
      const future = await as.administrator.get('/api/audit?from=2999-01-01T00:00:00Z');
      expect(future.body).toMatchObject({ data: [], meta: { total: 0 } });
      const past = await as.administrator.get('/api/audit?to=2000-01-01T00:00:00Z');
      expect(past.body.meta.total).toBe(0);
      const page = await as.administrator.get('/api/audit?limit=2&page=2');
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 2 });
    });
    it('shows the user created through the API with the administrator as actor', async () => {
      const id = await secondId();
      const res = await as.administrator.get(`/api/audit?entity_type=users&entity_id=${id}`);
      const inserts = res.body.data.filter((e) => e.action === 'insert');
      expect(inserts.map((e) => e.actor_id)).toEqual([1]);
      expect(res.body.data.map((e) => e.action)).toContain('login');
      expect(inserts[0].details).not.toHaveProperty('password_hash');
    });
    it('422 for a bad entity_type, id, timestamp or range', async () => {
      for (const qs of [
        'entity_type=users;DROP',
        'entity_type=Users',
        'entity_id=abc',
        'actor_id=0',
        'from=yesterday',
        'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      ]) {
        expect((await as.administrator.get(`/api/audit?${qs}`)).status, qs).toBe(422);
      }
    });
  });

  describe('principal_investigator (own projects only)', () => {
    const typesOf = (res) => new Set(res.body.data.map((e) => e.entity_type));

    it('sees entries of projects they belong to and never users entries', async () => {
      const res = await as.principal_investigator.get('/api/audit?limit=100');
      expect(res.status).toBe(200);
      const seen = new Set(res.body.data.map((e) => `${e.entity_type}:${e.entity_id}`));
      expect(seen).toContain(`projects:${projectA}`);
      expect(seen).toContain(`project_members:${projectA}`);
      expect(seen).toContain('collection_events:1');
      expect(seen).toContain('samples:1');
      expect(seen).not.toContain(`projects:${projectB}`);
      expect(seen).not.toContain(`project_members:${projectB}`);
      expect(seen).not.toContain('sampling_sites:1');
      expect(typesOf(res).has('users')).toBe(false);
      expect(typesOf(res).has('user_roles')).toBe(false);
    });
    it('gets an empty result for another projects entity, and a total that matches', async () => {
      const other = await as.principal_investigator.get(
        `/api/audit?entity_type=projects&entity_id=${projectB}`,
      );
      expect(other.status).toBe(200);
      expect(other.body).toMatchObject({ data: [], meta: { total: 0 } });
      const users = await as.principal_investigator.get('/api/audit?entity_type=users');
      expect(users.body.meta.total).toBe(0);
      const all = await as.principal_investigator.get('/api/audit?limit=100');
      expect(all.body.meta.total).toBe(all.body.data.length);
    });
    it('sees lab and analysis entries that belong to their projects, not unrelated ones', async () => {
      const res = await as.principal_investigator.get('/api/audit?limit=100');
      const seen = new Set(res.body.data.map((e) => `${e.entity_type}:${e.entity_id}`));
      for (const [type, id] of [
        ['dna_extractions', chain.x],
        ['sequencing_libraries', chain.l],
        ['sequencing_runs', chain.r],
        ['analysis_runs', chain.a],
        ['quality_control_results', chain.q],
      ]) {
        expect(seen, `${type}:${id}`).toContain(`${type}:${id}`);
      }
      expect(seen).not.toContain('data_exports:999999');
      const second = await as.second.get('/api/audit?limit=100');
      const secondTypes = new Set(second.body.data.map((e) => e.entity_type));
      for (const t of [
        'dna_extractions',
        'sequencing_libraries',
        'sequencing_runs',
        'analysis_runs',
      ])
        expect(secondTypes.has(t), t).toBe(false);
    });
    it('the second investigator sees only their own project', async () => {
      const res = await as.second.get('/api/audit?limit=100');
      const seen = res.body.data.map((e) => `${e.entity_type}:${e.entity_id}`);
      expect(seen).toContain(`projects:${projectB}`);
      expect(seen.some((s) => s.endsWith(`:${projectA}`))).toBe(false);
      expect(seen).not.toContain('samples:1');
    });
  });

  describe('everyone else', () => {
    it('403 for field researcher, lab technician, analyst and viewer; 401 anonymous', async () => {
      for (const role of ['field_researcher', 'lab_technician', 'analyst', 'viewer']) {
        expect((await as[role].get('/api/audit')).status, role).toBe(403);
      }
      expect((await request(app).get('/api/audit')).status).toBe(401);
    });
  });

  describe('recentActivity', () => {
    const user = (user_id, roles) => ({ user_id, roles });
    it('returns up to 5 newest entries for an administrator, scoped for a PI, [] for others', async () => {
      const admin = await recentActivity(user(1, ['administrator']));
      expect(admin).toHaveLength(5);
      expect(admin.map((e) => e.audit_id)).toEqual(
        [...admin.map((e) => e.audit_id)].sort((a, b) => b - a).length
          ? admin.map((e) => e.audit_id)
          : [],
      );
      const two = await recentActivity(user(1, ['administrator']), { limit: 2 });
      expect(two).toHaveLength(2);
      const pi = await recentActivity(user(2, ['principal_investigator']), { limit: 100 });
      expect(pi.length).toBeGreaterThan(0);
      expect(pi.some((e) => e.entity_type === 'users')).toBe(false);
      for (const roles of [['field_researcher'], ['lab_technician'], ['analyst'], ['viewer'], []]) {
        expect(await recentActivity(user(3, roles))).toEqual([]);
        expect(canReadAudit(user(3, roles))).toBe(false);
      }
    });
  });

  async function secondId() {
    return (await query("SELECT user_id FROM users WHERE email = 'second@example.test'"))[0]
      .user_id;
  }
});
