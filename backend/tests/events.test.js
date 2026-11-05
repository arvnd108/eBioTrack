// Owner: A (Backend)
// Purpose: Collection event routes: list, detail and the atomic create (needs the seeded test database)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const EVENT_KEYS = [
  'collected_at',
  'collector_id',
  'collector_name',
  'created_at',
  'event_id',
  'notes',
  'project_id',
  'site_id',
];

const counts = async () => {
  const [row] = await query(
    `SELECT (SELECT count(*) FROM collection_events) AS events,
            (SELECT count(*) FROM samples) AS samples,
            (SELECT count(*) FROM environmental_measurements) AS measurements,
            (SELECT count(*) FROM sample_status_history) AS history,
            (SELECT count(*) FROM audit_logs) AS audit`,
  );
  return row;
};

describe.skipIf(!available)('events', () => {
  const as = {};
  const payload = (extra = {}) => ({
    project_id: 1,
    site_id: 1,
    collected_at: '2026-03-12T09:30:00Z',
    notes: 'Clear water',
    measurements: [
      { parameter: 'ph', value: 7.4, unit: 'pH' },
      { parameter: 'temperature_c', value: 18.25, unit: 'C' },
    ],
    samples: [
      { sample_type_id: 1, volume_ml: 1000, depth_m: 0.5, storage_location: 'Freezer A' },
      { sample_type_id: 3 },
    ],
    ...extra,
  });

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

  describe('GET /api/events', () => {
    it('limits each user to their projects; the administrator sees all, newest first', async () => {
      const admin = await as.administrator.get('/api/events');
      expect(admin.status).toBe(200);
      expect(admin.body.meta).toEqual({ page: 1, limit: 25, total: 8 });
      expect(admin.body.data.map((e) => e.event_id)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(Object.keys(admin.body.data[0]).sort()).toEqual(EVENT_KEYS);
      expect(typeof admin.body.data[0].event_id).toBe('number');
      expect(admin.body.data[0].collected_at).toBe('2026-04-08T11:30:00.000Z');

      const lab = await as.lab_technician.get('/api/events');
      expect(lab.body.data.map((e) => e.event_id)).toEqual([6, 5, 4, 3, 2, 1]);
      const field = await as.field_researcher.get('/api/events');
      expect(field.body.meta.total).toBe(8);
      const none = await as.outsider.get('/api/events');
      expect(none.body).toMatchObject({ data: [], meta: { total: 0 } });
    });
    it('filters by project, site and an inclusive date range; paginates and re-sorts', async () => {
      const bySite = await as.administrator.get('/api/events?site_id=1');
      expect(bySite.body.data.map((e) => e.event_id)).toEqual([4, 1]);
      const byProject = await as.administrator.get('/api/events?project_id=2');
      expect(byProject.body.data.map((e) => e.event_id)).toEqual([8, 7]);
      // a date-only bound covers the whole UTC day
      const day = await as.administrator.get('/api/events?from=2026-03-10&to=2026-03-10');
      expect(day.body.data.map((e) => e.event_id)).toEqual([4]);
      const range = await as.administrator.get(
        '/api/events?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z',
      );
      expect(range.body.data.map((e) => e.event_id)).toEqual([6, 5, 4]);
      const both = await as.administrator.get('/api/events?site_id=1&from=2026-01-01');
      expect(both.body.data.map((e) => e.event_id)).toEqual([4]);
      const page = await as.administrator.get('/api/events?limit=3&page=2');
      expect(page.body.data.map((e) => e.event_id)).toEqual([5, 4, 3]);
      const oldest = await as.administrator.get('/api/events?sort=collected_at&limit=2');
      expect(oldest.body.data.map((e) => e.event_id)).toEqual([1, 2]);
    });
    it('404 for a project the user cannot access, 422 for bad filters', async () => {
      const denied = await as.lab_technician.get('/api/events?project_id=2');
      expect(denied.status).toBe(404);
      expect(denied.body.error.message).toBe('Project not found');
      expect((await as.administrator.get('/api/events?project_id=999')).status).toBe(404);
      for (const q of [
        'from=yesterday',
        'to=2026-02-30',
        'from=2026-04-01&to=2026-03-01',
        'site_id=x',
        'sort=notes',
      ]) {
        expect((await as.administrator.get(`/api/events?${q}`)).status, q).toBe(422);
      }
    });
  });

  describe('GET /api/events/:id', () => {
    it('returns the event with samples and measurements, ordered by id', async () => {
      const res = await as.lab_technician.get('/api/events/4');
      expect(res.status).toBe(200);
      const { samples, measurements, ...event } = res.body.data;
      expect(event).toMatchObject({
        event_id: 4,
        project_id: 1,
        site_id: 1,
        collector_id: 3,
        collector_name: 'Farah Field',
      });
      expect(samples.map((s) => s.sample_id)).toEqual([7, 8]);
      expect(samples[0]).toMatchObject({ sample_code: 'EB-20260310-0004-001', status: 'analyzed' });
      expect(measurements.length).toBeGreaterThan(0);
      expect(measurements.map((m) => m.measurement_id)).toEqual(
        [...measurements.map((m) => m.measurement_id)].sort((a, b) => a - b),
      );
      expect(Object.keys(measurements[0]).sort()).toEqual([
        'event_id',
        'measurement_id',
        'parameter',
        'unit',
        'value',
      ]);
      expect(typeof measurements[0].value).toBe('number');
      expect(typeof samples[0].volume_ml).toBe('number');
    });
    it('404 with one body for an unknown event and for a project the caller is not in', async () => {
      const unknown = await as.lab_technician.get('/api/events/9999');
      const hidden = await as.lab_technician.get('/api/events/7');
      expect(unknown.status).toBe(404);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(unknown.body);
      expect((await as.administrator.get('/api/events/7')).status).toBe(200);
      expect((await as.administrator.get('/api/events/abc')).status).toBe(422);
    });
  });

  describe('POST /api/events', () => {
    it('creates the event, measurements and samples with generated codes in one transaction', async () => {
      const before = await counts();
      const res = await as.field_researcher.post('/api/events').send(payload());
      expect(res.status).toBe(201);
      const { samples, measurements, ...event } = res.body.data;
      expect(event).toMatchObject({
        project_id: 1,
        site_id: 1,
        collector_id: 3,
        notes: 'Clear water',
        collected_at: '2026-03-12T09:30:00.000Z',
      });
      const code = (n) => `EB-20260312-${String(event.event_id).padStart(4, '0')}-00${n}`;
      expect(samples.map((s) => [s.sample_code, s.status])).toEqual([
        [code(1), 'collected'],
        [code(2), 'collected'],
      ]);
      expect(samples[0]).toMatchObject({
        volume_ml: 1000,
        depth_m: 0.5,
        storage_location: 'Freezer A',
      });
      expect(samples[1]).toMatchObject({ volume_ml: null, depth_m: null, storage_location: null });
      expect(measurements.map((m) => [m.parameter, m.value, m.unit])).toEqual([
        ['ph', 7.4, 'pH'],
        ['temperature_c', 18.25, 'C'],
      ]);
      const after = await counts();
      expect(after.events - before.events).toBe(1);
      expect(after.samples - before.samples).toBe(2);
      expect(after.measurements - before.measurements).toBe(2);
      expect(after.history - before.history).toBe(2);
      const audit = await query(
        `SELECT entity_type, actor_id FROM audit_logs WHERE action = 'insert'
          AND ((entity_type = 'collection_events' AND entity_id = $1)
            OR (entity_type = 'samples' AND entity_id = ANY($2::bigint[]))) ORDER BY audit_id`,
        [event.event_id, samples.map((s) => s.sample_id)],
      );
      expect(audit.map((a) => [a.entity_type, a.actor_id])).toEqual([
        ['collection_events', 3],
        ['samples', 3],
        ['samples', 3],
      ]);
      const history = await query(
        'SELECT old_status, new_status, changed_by FROM sample_status_history WHERE sample_id = ANY($1::bigint[])',
        [samples.map((s) => s.sample_id)],
      );
      expect(history).toEqual([
        { old_status: null, new_status: 'collected', changed_by: 3 },
        { old_status: null, new_status: 'collected', changed_by: 3 },
      ]);
      // readable straight away through GET
      const read = await as.field_researcher.get(`/api/events/${event.event_id}`);
      expect(read.body.data).toEqual(res.body.data);
    });
    it('creates an event with no measurements or samples; the collector is never taken from the client', async () => {
      const res = await as.principal_investigator
        .post('/api/events')
        .send({ project_id: 2, site_id: 4, collected_at: '2026-04-20T00:00:00Z' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        collector_id: 2,
        notes: null,
        samples: [],
        measurements: [],
      });
      const forged = await as.field_researcher
        .post('/api/events')
        .send(payload({ collector_id: 5 }));
      expect(forged.status).toBe(422);
      const admin = await as.administrator
        .post('/api/events')
        .send(payload({ project_id: 2, site_id: 4, samples: [] }));
      expect(admin.status).toBe(201);
      expect(admin.body.data.collector_id).toBe(1);
    });
    it('a failed request leaves no trace: bad sample type after good ones', async () => {
      const before = await counts();
      const res = await as.field_researcher.post('/api/events').send(
        payload({
          samples: [{ sample_type_id: 1 }, { sample_type_id: 2 }, { sample_type_id: 999 }],
        }),
      );
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_reference');
      expect(await counts()).toEqual(before);
    });
    it('422 for a duplicate parameter in the request, naming the field, writing nothing', async () => {
      const before = await counts();
      const res = await as.field_researcher.post('/api/events').send(
        payload({
          measurements: [
            { parameter: 'ph', value: 7, unit: 'pH' },
            { parameter: 'ph', value: 8, unit: 'pH' },
          ],
        }),
      );
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.details[0].field).toBe('measurements[1].parameter');
      expect(await counts()).toEqual(before);
    });
    it('422 invalid_reference when the site is not attached to the project, or the project is unknown', async () => {
      const before = await counts();
      const detached = await as.field_researcher.post('/api/events').send(payload({ site_id: 4 }));
      expect(detached.status).toBe(422);
      expect(detached.body.error.code).toBe('invalid_reference');
      expect(detached.body.error.message).toBe('Site is not attached to this project');
      const noProject = await as.administrator
        .post('/api/events')
        .send(payload({ project_id: 999 }));
      expect(noProject.status).toBe(422);
      expect(noProject.body.error.code).toBe('invalid_reference');
      expect(await counts()).toEqual(before);
    });
    it('validates time, sizes and numbers', async () => {
      const post = (extra) => as.field_researcher.post('/api/events').send(payload(extra));
      const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
      const soon = new Date(Date.now() + 3600 * 1000).toISOString();
      const far = await post({ collected_at: future });
      expect(far.status).toBe(422);
      expect(far.body.error.details[0].field).toBe('collected_at');
      expect((await post({ collected_at: soon, samples: [] })).status).toBe(201);
      for (const extra of [
        { collected_at: 'yesterday' },
        { collected_at: '2026-03-12' },
        { samples: [{ sample_type_id: 1, volume_ml: 0 }] },
        { samples: [{ sample_type_id: 1, volume_ml: -5 }] },
        { samples: [{ sample_type_id: 1, depth_m: -0.1 }] },
        { samples: [{ sample_type_id: 1, status: 'stored' }] },
        { samples: [{ volume_ml: 5 }] },
        { measurements: [{ parameter: 'ph', value: '7.4', unit: 'pH' }] },
        { measurements: [{ parameter: ' ', value: 7, unit: 'pH' }] },
        { measurements: [{ parameter: 'ph', value: 7, unit: '' }] },
        {
          measurements: Array.from({ length: 51 }, (_, i) => ({
            parameter: `p${i}`,
            value: 1,
            unit: 'u',
          })),
        },
        { samples: Array.from({ length: 101 }, () => ({ sample_type_id: 1 })) },
        { unknown_key: true },
      ]) {
        expect((await post(extra)).status, JSON.stringify(extra).slice(0, 60)).toBe(422);
      }
      const max = await post({
        samples: Array.from({ length: 100 }, () => ({ sample_type_id: 1 })),
        measurements: Array.from({ length: 50 }, (_, i) => ({
          parameter: `p${i}`,
          value: i,
          unit: 'u',
        })),
      });
      expect(max.status).toBe(201);
      expect(max.body.data.samples).toHaveLength(100);
      expect(max.body.data.samples[99].sample_code.endsWith('-100')).toBe(true);
    });
    it('authorization: 403 for a viewer project role (contributors may write); 404 for non-members', async () => {
      for (const role of ['viewer']) {
        expect((await as[role].post('/api/events').send(payload())).status, role).toBe(403);
      }
      // project 1 has user 6 as viewer; give that user the field researcher role to isolate the project check
      await query('INSERT INTO user_roles (user_id, role_id) VALUES (6, 3)');
      try {
        const viewerMember = await signIn(app, SEED_EMAIL.viewer);
        expect((await viewerMember.post('/api/events').send(payload())).status).toBe(403);
      } finally {
        await query('DELETE FROM user_roles WHERE user_id = 6 AND role_id = 3');
      }
      const outsider = await as.outsider.post('/api/events').send(payload());
      expect(outsider.status).toBe(404);
      expect(outsider.body.error.message).toBe('Project not found');
      // field researcher 3 is a contributor of both projects, so a PI outside project 2 is the 404 case
      const unknownProject = await as.outsider
        .post('/api/events')
        .send(payload({ project_id: 999 }));
      expect(unknownProject.body).toEqual(outsider.body);
    });
  });
});
