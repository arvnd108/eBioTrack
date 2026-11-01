// Owner: A (Backend)
// Purpose: Sample type and sample routes: list, detail, create and status (needs the seeded test database)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const SAMPLE_KEYS = [
  'created_at',
  'depth_m',
  'event_id',
  'sample_code',
  'sample_id',
  'sample_type_id',
  'status',
  'storage_location',
  'volume_ml',
];

describe.skipIf(!available)('samples', () => {
  const as = {};

  beforeAll(async () => {
    await resetAndSeedDatabase();
    for (const [role, email] of Object.entries(SEED_EMAIL)) as[role] = await signIn(app, email);
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

  describe('GET /api/sample-types', () => {
    it('lists the types by id, unpaginated, to any signed-in user', async () => {
      const res = await as.viewer.get('/api/sample-types');
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeUndefined();
      expect(res.body.data).toEqual([
        { sample_type_id: 1, type_name: 'water' },
        { sample_type_id: 2, type_name: 'soil' },
        { sample_type_id: 3, type_name: 'sediment' },
        { sample_type_id: 4, type_name: 'air' },
      ]);
    });
  });

  describe('GET /api/samples', () => {
    it('limits each user to their projects; the administrator sees all 17', async () => {
      const admin = await as.administrator.get('/api/samples?limit=100');
      expect(admin.body.meta).toEqual({ page: 1, limit: 100, total: 17 });
      expect(admin.body.data.map((s) => s.sample_id)).toEqual(
        Array.from({ length: 17 }, (_, i) => i + 1),
      );
      expect(Object.keys(admin.body.data[0]).sort()).toEqual(SAMPLE_KEYS);
      expect(typeof admin.body.data[0].volume_ml).toBe('number');
      const lab = await as.lab_technician.get('/api/samples?limit=100');
      expect(lab.body.meta.total).toBe(13);
      expect(lab.body.data.every((s) => s.sample_id <= 12 || s.sample_id === 17)).toBe(true);
      expect((await as.outsider.get('/api/samples')).body).toMatchObject({
        data: [],
        meta: { total: 0 },
      });
    });
    it('filters by project, site, event and status', async () => {
      const ids = async (qs, agent = as.administrator) =>
        (await agent.get(`/api/samples?limit=100&${qs}`)).body.data.map((s) => s.sample_id);
      expect(await ids('project_id=2')).toEqual([13, 14, 15, 16]);
      expect(await ids('site_id=1')).toEqual([1, 2, 7, 8, 17]);
      expect(await ids('event_id=4')).toEqual([7, 8]);
      expect(await ids('status=failed')).toEqual([17]);
      expect(await ids('project_id=1&site_id=1&status=analyzed')).toEqual([1, 2, 7, 8]);
      expect(await ids('site_id=4', as.lab_technician)).toEqual([]);
      const page = await as.administrator.get('/api/samples?limit=5&page=2&sort=-sample_id');
      expect(page.body.data.map((s) => s.sample_id)).toEqual([12, 11, 10, 9, 8]);
    });
    it('404 for a project the caller is not in; 422 for bad filters', async () => {
      const denied = await as.lab_technician.get('/api/samples?project_id=2');
      expect(denied.status).toBe(404);
      for (const q of ['status=lost', 'event_id=0', 'q=', 'sort=volume_ml', 'project_id=x']) {
        expect((await as.administrator.get(`/api/samples?${q}`)).status, q).toBe(422);
      }
    });
    it('q is a case-insensitive prefix of the sample code, with % _ and \\ taken literally', async () => {
      const codes = async (q) =>
        (
          await as.administrator.get(`/api/samples?limit=100&q=${encodeURIComponent(q)}`)
        ).body.data.map((s) => s.sample_code);
      expect(await codes('EB-2026')).toHaveLength(10);
      expect(await codes('eb-202603')).toHaveLength(6);
      expect(await codes('EB-20260315-0006-001')).toEqual(['EB-20260315-0006-001']);
      expect(await codes('-0006')).toEqual([]); // prefix, not substring
      expect(await codes('%')).toEqual([]);
      expect(await codes('EB-2026%')).toEqual([]);
      expect(await codes('EB_20260315')).toEqual([]);
      expect(await codes('EB-2026\\')).toEqual([]);
      expect(await codes('EB-20250515-0001-00')).toHaveLength(3);
    });
  });

  describe('GET /api/samples/:id', () => {
    it('matches the contract example shape, history oldest first, extractions by attempt', async () => {
      const res = await as.lab_technician.get('/api/samples/8');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        sample_id: 8,
        sample_code: 'EB-20260310-0004-002',
        status: 'analyzed',
        sample_type: expect.any(String),
        event: { event_id: 4, collected_at: expect.any(String), project_id: 1 },
        site: { site_id: 1, name: 'Dakpathar Barrage' },
      });
      expect(Object.keys(res.body.data).sort()).toEqual(
        [
          'depth_m',
          'event',
          'extractions',
          'sample_code',
          'sample_id',
          'sample_type',
          'site',
          'status',
          'status_history',
          'volume_ml',
        ].sort(),
      );
      expect(Object.keys(res.body.data.event).sort()).toEqual([
        'collected_at',
        'event_id',
        'project_id',
      ]);
      expect(Object.keys(res.body.data.site).sort()).toEqual(['name', 'site_id']);
      const history = res.body.data.status_history;
      expect(history[0]).toMatchObject({
        old_status: null,
        new_status: 'collected',
        changed_by_name: 'Farah Field',
      });
      const times = history.map((h) => new Date(h.changed_at).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(Object.keys(history[0]).sort()).toEqual([
        'changed_at',
        'changed_by',
        'changed_by_name',
        'new_status',
        'note',
        'old_status',
      ]);
      expect(res.body.data.extractions[0]).toEqual({
        extraction_id: 8,
        attempt_number: 1,
        qc_status: 'pass',
      });
    });
    it('shows the failed extraction of sample 17', async () => {
      const res = await as.administrator.get('/api/samples/17');
      expect(res.body.data.status).toBe('failed');
      expect(res.body.data.extractions).toEqual([
        { extraction_id: 17, attempt_number: 1, qc_status: 'fail' },
      ]);
    });
    it('404 with one body for unknown and hidden samples; 422 for a bad id', async () => {
      const unknown = await as.lab_technician.get('/api/samples/9999');
      const hidden = await as.lab_technician.get('/api/samples/13');
      expect(unknown.status).toBe(404);
      expect(hidden.body).toEqual(unknown.body);
      expect((await as.administrator.get('/api/samples/13')).status).toBe(200);
      expect((await as.administrator.get('/api/samples/x')).status).toBe(422);
    });
  });

  describe('POST /api/samples', () => {
    it('registers through register_sample(): next code, collected, history row and audit actor', async () => {
      const res = await as.field_researcher.post('/api/samples').send({
        event_id: 4,
        sample_type_id: 2,
        volume_ml: 250.5,
        depth_m: 1.25,
        storage_location: 'Freezer B',
      });
      expect(res.status).toBe(201);
      expect(Object.keys(res.body.data).sort()).toEqual(SAMPLE_KEYS);
      expect(res.body.data).toMatchObject({
        event_id: 4,
        sample_type_id: 2,
        sample_code: 'EB-20260310-0004-003',
        volume_ml: 250.5,
        depth_m: 1.25,
        storage_location: 'Freezer B',
        status: 'collected',
      });
      const [history] = await query(
        'SELECT old_status, new_status, changed_by FROM sample_status_history WHERE sample_id = $1',
        [res.body.data.sample_id],
      );
      expect(history).toEqual({ old_status: null, new_status: 'collected', changed_by: 3 });
      const [audit] = await query(
        "SELECT actor_id FROM audit_logs WHERE entity_type = 'samples' AND entity_id = $1 AND action = 'insert'",
        [res.body.data.sample_id],
      );
      expect(audit.actor_id).toBe(3);
      const second = await as.principal_investigator
        .post('/api/samples')
        .send({ event_id: 4, sample_type_id: 1 });
      expect(second.body.data.sample_code).toBe('EB-20260310-0004-004');
      expect(second.body.data).toMatchObject({
        volume_ml: null,
        depth_m: null,
        storage_location: null,
      });
    });
    it('422 for a missing type, bad volume or depth, unknown keys and a client-chosen code', async () => {
      const post = (b) =>
        as.field_researcher.post('/api/samples').send({ event_id: 4, sample_type_id: 1, ...b });
      const type = await post({ sample_type_id: 999 });
      expect(type.status).toBe(422);
      expect(type.body.error.code).toBe('invalid_reference');
      for (const b of [
        { volume_ml: 0 },
        { volume_ml: -1 },
        { depth_m: -1 },
        { sample_code: 'X' },
        { status: 'stored' },
        { event_id: '4' },
      ]) {
        expect((await post(b)).status, JSON.stringify(b)).toBe(422);
      }
      const tiny = await post({ volume_ml: 0.001 }); // rounds to 0.00: the table CHECK refuses it
      expect(tiny.status).toBe(422);
    });
    it('404 for an unknown event or one in a project the caller is not in (same body); 403 per role', async () => {
      const unknown = await as.outsider
        .post('/api/samples')
        .send({ event_id: 9999, sample_type_id: 1 });
      const hidden = await as.outsider
        .post('/api/samples')
        .send({ event_id: 4, sample_type_id: 1 });
      expect(unknown.status).toBe(404);
      expect(hidden.body).toEqual(unknown.body);
      for (const role of ['lab_technician', 'analyst', 'viewer']) {
        expect(
          (await as[role].post('/api/samples').send({ event_id: 4, sample_type_id: 1 })).status,
          role,
        ).toBe(403);
      }
      await query('INSERT INTO user_roles (user_id, role_id) VALUES (6, 3)');
      try {
        const viewerMember = await signIn(app, SEED_EMAIL.viewer);
        expect(
          (await viewerMember.post('/api/samples').send({ event_id: 4, sample_type_id: 1 })).status,
        ).toBe(403);
      } finally {
        await query('DELETE FROM user_roles WHERE user_id = 6 AND role_id = 3');
      }
    });
    it('parallel requests for one event get distinct, consecutive codes', async () => {
      const before = await query('SELECT count(*)::int AS n FROM samples WHERE event_id = 5');
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? as.field_researcher : as.principal_investigator)
            .post('/api/samples')
            .send({ event_id: 5, sample_type_id: 1 }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      const codes = results.map((r) => r.body.data.sample_code);
      expect(new Set(codes).size).toBe(8);
      const sequences = codes.map((c) => Number(c.slice(-3))).sort((a, b) => a - b);
      const start = before[0].n + 1;
      expect(sequences).toEqual(Array.from({ length: 8 }, (_, i) => start + i));
    });
  });

  describe('PATCH /api/samples/:id/status', () => {
    let sampleId;
    beforeAll(async () => {
      const res = await as.field_researcher
        .post('/api/samples')
        .send({ event_id: 6, sample_type_id: 1 });
      sampleId = res.body.data.sample_id;
    });

    it('applies legal transitions; the trigger adds a history row with the actor', async () => {
      const stored = await as.field_researcher
        .patch(`/api/samples/${sampleId}/status`)
        .send({ new_status: 'stored' });
      expect(stored.status).toBe(200);
      expect(Object.keys(stored.body.data).sort()).toEqual(SAMPLE_KEYS);
      expect(stored.body.data.status).toBe('stored');
      const extracted = await as.lab_technician
        .patch(`/api/samples/${sampleId}/status`)
        .send({ new_status: 'extracted', note: 'ready for the lab' });
      expect(extracted.status).toBe(200);
      const detail = await as.administrator.get(`/api/samples/${sampleId}`);
      expect(
        detail.body.data.status_history.map((h) => [h.old_status, h.new_status, h.changed_by]),
      ).toEqual([
        [null, 'collected', 3],
        ['collected', 'stored', 3],
        ['stored', 'extracted', 4],
      ]);
      // The optional note is stored on its own history row; no note stores NULL.
      expect(detail.body.data.status_history.map((h) => [h.changed_by_name, h.note])).toEqual([
        ['Farah Field', null],
        ['Farah Field', null],
        ['Lakshmi Lab', 'ready for the lab'],
      ]);
    });
    it('409 invalid_transition with the trigger message for an illegal jump', async () => {
      const res = await as.field_researcher
        .patch(`/api/samples/${sampleId}/status`)
        .send({ new_status: 'collected' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'invalid_transition',
        message: 'Invalid sample status transition: extracted -> collected',
      });
      const analyzed = await as.field_researcher
        .patch(`/api/samples/${sampleId}/status`)
        .send({ new_status: 'analyzed' });
      expect(analyzed.status).toBe(409);
      const terminal = await as.field_researcher
        .patch('/api/samples/1/status')
        .send({ new_status: 'stored' });
      expect(terminal.status).toBe(409);
      const [{ n }] = await query(
        'SELECT count(*)::int AS n FROM sample_status_history WHERE sample_id = $1',
        [sampleId],
      );
      expect(n).toBe(3);
    });
    it('409 when the sample already has that status, writing no history row', async () => {
      const res = await as.field_researcher
        .patch(`/api/samples/${sampleId}/status`)
        .send({ new_status: 'extracted' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'invalid_transition',
        message: 'Sample is already extracted',
      });
      const [{ n }] = await query(
        'SELECT count(*)::int AS n FROM sample_status_history WHERE sample_id = $1',
        [sampleId],
      );
      expect(n).toBe(3);
    });
    it('422 for a bad body; 403 for analyst and viewer; 404 for hidden or unknown samples', async () => {
      const patch = (b, id = sampleId, agent = as.field_researcher) =>
        agent.patch(`/api/samples/${id}/status`).send(b);
      for (const b of [
        {},
        { new_status: 'lost' },
        { new_status: 'failed', extra: 1 },
        { new_status: 'failed', note: 5 },
      ]) {
        expect((await patch(b)).status, JSON.stringify(b)).toBe(422);
      }
      expect((await patch({ new_status: 'failed' }, 'abc')).status).toBe(422);
      for (const role of ['analyst', 'viewer']) {
        expect((await patch({ new_status: 'failed' }, sampleId, as[role])).status, role).toBe(403);
      }
      const hidden = await patch({ new_status: 'failed' }, 13, as.lab_technician);
      const unknown = await patch({ new_status: 'failed' }, 9999, as.lab_technician);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(unknown.body);
      const outside = await patch({ new_status: 'failed' }, sampleId, as.outsider);
      expect(outside.status).toBe(404);
    });
    it('a project viewer role is refused even with a permitted global role', async () => {
      await query('INSERT INTO user_roles (user_id, role_id) VALUES (6, 4)');
      try {
        const viewerMember = await signIn(app, SEED_EMAIL.viewer);
        const res = await viewerMember
          .patch(`/api/samples/${sampleId}/status`)
          .send({ new_status: 'failed' });
        expect(res.status).toBe(403);
      } finally {
        await query('DELETE FROM user_roles WHERE user_id = 6 AND role_id = 4');
      }
    });
    it('two identical concurrent changes: one wins, the other is refused, one history row', async () => {
      const created = await as.field_researcher
        .post('/api/samples')
        .send({ event_id: 6, sample_type_id: 1 });
      const id = created.body.data.sample_id;
      const results = await Promise.all([
        as.field_researcher.patch(`/api/samples/${id}/status`).send({ new_status: 'stored' }),
        as.principal_investigator.patch(`/api/samples/${id}/status`).send({ new_status: 'stored' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const [{ n }] = await query(
        'SELECT count(*)::int AS n FROM sample_status_history WHERE sample_id = $1',
        [id],
      );
      expect(n).toBe(2);
    });
  });
});
