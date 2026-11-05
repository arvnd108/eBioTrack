// Owner: A (Backend)
// Purpose: Regions and sites routes (needs the seeded test database)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();

describe.skipIf(!available)('regions and sites', () => {
  const as = {};
  const body = {
    region_id: 2,
    name: 'Test pool',
    latitude: 28.612345,
    longitude: 77.234567,
    habitat_type: 'lake',
  };

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

  describe('GET /api/regions', () => {
    it('lists regions by id to any signed-in user, optionally by region_type', async () => {
      const res = await as.viewer.get('/api/regions');
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeUndefined();
      expect(res.body.data.map((r) => r.region_id)).toEqual([1, 2, 3]);
      expect(Object.keys(res.body.data[1]).sort()).toEqual(
        ['name', 'parent_region_id', 'region_id', 'region_type'].sort(),
      );
      expect(res.body.data[1]).toMatchObject({ region_type: 'basin', parent_region_id: 1 });
      const basins = await as.viewer.get('/api/regions?region_type=basin');
      expect(basins.body.data.map((r) => r.region_id)).toEqual([2]);
      expect((await as.viewer.get('/api/regions?region_type=planet')).status).toBe(422);
    });
  });

  describe('GET /api/sites', () => {
    it('lists all sites with numeric fields, ordered by id, to every role', async () => {
      for (const role of Object.keys(as)) {
        const res = await as[role].get('/api/sites');
        expect(res.status, role).toBe(200);
        expect(res.body.data.map((s) => s.site_id)).toEqual([1, 2, 3, 4, 5]);
      }
      const res = await as.viewer.get('/api/sites');
      expect(res.body.meta).toEqual({ page: 1, limit: 25, total: 5 });
      expect(Object.keys(res.body.data[0]).sort()).toEqual(
        [
          'created_by',
          'description',
          'habitat_type',
          'latitude',
          'longitude',
          'name',
          'region_id',
          'site_id',
        ].sort(),
      );
      for (const key of ['site_id', 'region_id', 'latitude', 'longitude']) {
        expect(typeof res.body.data[0][key], key).toBe('number');
      }
    });
    it('filters by project (members only), region and habitat; paginates and sorts', async () => {
      const mine = await as.lab_technician.get('/api/sites?project_id=1');
      expect(mine.body.data.map((s) => s.site_id)).toEqual([1, 2, 3]);
      // lab technician 4 is not a member of project 2; the administrator may look
      const other = await as.lab_technician.get('/api/sites?project_id=2');
      expect(other.status).toBe(404);
      expect(other.body.error.message).toBe('Project not found');
      expect(
        (await as.administrator.get('/api/sites?project_id=2')).body.data.map((s) => s.site_id),
      ).toEqual([4, 5]);
      expect((await as.administrator.get('/api/sites?project_id=999')).status).toBe(404);
      const byRegion = await as.viewer.get('/api/sites?region_id=3');
      expect(byRegion.body.data.every((s) => s.region_id === 3)).toBe(true);
      const habitat = await as.viewer.get('/api/sites?habitat_type=river');
      expect(habitat.body.data.every((s) => s.habitat_type === 'river')).toBe(true);
      expect(habitat.body.meta.total).toBe(habitat.body.data.length);
      const page = await as.viewer.get('/api/sites?limit=2&page=2&sort=-site_id');
      expect(page.body.data.map((s) => s.site_id)).toEqual([3, 2]);
      expect(page.body.meta).toEqual({ page: 2, limit: 2, total: 5 });
      const byName = await as.viewer.get('/api/sites?sort=name');
      const names = byName.body.data.map((x) => x.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
    it('422 for bad filters and sort fields', async () => {
      for (const q of [
        'habitat_type=moon',
        'project_id=abc',
        'region_id=0',
        'sort=latitude',
        'limit=0',
      ]) {
        expect((await as.viewer.get(`/api/sites?${q}`)).status, q).toBe(422);
      }
    });
  });

  describe('GET /api/sites/:id', () => {
    it('returns one site; 404 unknown, 422 bad id', async () => {
      const res = await as.analyst.get('/api/sites/1');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ site_id: 1, region_id: 2 });
      expect(typeof res.body.data.latitude).toBe('number');
      const missing = await as.analyst.get('/api/sites/9999');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('not_found');
      expect((await as.analyst.get('/api/sites/abc')).status).toBe(422);
    });
  });

  describe('POST /api/sites', () => {
    it('lets a field researcher, investigator and administrator create; created_by is the session', async () => {
      const ids = [];
      for (const [role, userId] of [
        ['field_researcher', 3],
        ['principal_investigator', 2],
        ['administrator', 1],
      ]) {
        const res = await as[role].post('/api/sites').send({ ...body, name: `Created by ${role}` });
        expect(res.status, role).toBe(201);
        expect(res.body.data).toMatchObject({
          region_id: 2,
          name: `Created by ${role}`,
          habitat_type: 'lake',
          description: null,
        });
        // coordinates keep all six decimals
        expect(res.body.data.latitude).toBe(28.612345);
        expect(res.body.data.longitude).toBe(77.234567);
        expect(res.body.data.created_by).toBe(userId);
        ids.push([res.body.data.site_id, userId]);
      }
      for (const [siteId, userId] of ids) {
        const [row] = await query('SELECT created_by FROM sampling_sites WHERE site_id = $1', [
          siteId,
        ]);
        expect(row.created_by).toBe(userId);
      }
      const audit = await query(
        "SELECT actor_id FROM audit_logs WHERE entity_type = 'sampling_sites' AND entity_id = $1 AND action = 'insert'",
        [ids[0][0]],
      );
      expect(audit.map((a) => a.actor_id)).toEqual([3]);
    });
    it('trims the name and accepts a description', async () => {
      const res = await as.field_researcher
        .post('/api/sites')
        .send({ ...body, name: '  Padded name  ', description: ' near the weir ' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'Padded name', description: 'near the weir' });
    });
    it('any signed-in user (even a global viewer) can add a site and is recorded as its creator', async () => {
      const res = await as.viewer
        .post('/api/sites')
        .send({ ...body, name: 'Viewer lake', habitat_type: 'lake' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'Viewer lake', habitat_type: 'lake' });
      // the creator may correct it; a user who is only a project viewer may not edit it
      const id = res.body.data.site_id;
      expect((await as.viewer.patch(`/api/sites/${id}`).send({ description: 'mine' })).status).toBe(
        200,
      );
      const other = await as.analyst
        .post('/api/sites')
        .send({ ...body, name: 'Analyst pond', habitat_type: 'other' });
      expect(other.status).toBe(201);
      expect(
        (await as.viewer.patch(`/api/sites/${other.body.data.site_id}`).send({ description: 'x' }))
          .status,
      ).toBe(403);
    });
    it('422 names the field for out-of-range coordinates, blank names, bad enums and unknown keys', async () => {
      const post = (patch) =>
        as.field_researcher.post('/api/sites').send({ ...body, name: 'Valid', ...patch });
      const lat = await post({ latitude: 91 });
      expect(lat.status).toBe(422);
      expect(lat.body.error.code).toBe('validation_error');
      expect(lat.body.error.details).toEqual([
        { field: 'latitude', message: 'Latitude must be between -90 and 90' },
      ]);
      const lon = await post({ longitude: -180.5 });
      expect(lon.body.error.details[0]).toMatchObject({ field: 'longitude' });
      expect((await post({ name: '   ' })).status).toBe(422);
      expect((await post({ habitat_type: 'moon' })).status).toBe(422);
      expect((await post({ latitude: '28.6' })).status).toBe(422);
      expect((await post({ created_by: 1 })).status).toBe(422);
      expect((await post({ site_id: 99 })).status).toBe(422);
      const missing = await as.field_researcher.post('/api/sites').send({ name: 'x' });
      expect(missing.status).toBe(422);
    });
    it('409 for a duplicate name in the same region; same name in another region is fine', async () => {
      const first = await as.field_researcher.post('/api/sites').send({ ...body, name: 'Twin' });
      expect(first.status).toBe(201);
      const dup = await as.field_researcher.post('/api/sites').send({ ...body, name: 'Twin' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('duplicate');
      const other = await as.field_researcher
        .post('/api/sites')
        .send({ ...body, region_id: 3, name: 'Twin' });
      expect(other.status).toBe(201);
    });
    it('422 invalid_reference for an unknown region', async () => {
      const res = await as.field_researcher
        .post('/api/sites')
        .send({ ...body, region_id: 999, name: 'Nowhere' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_reference');
    });
  });

  describe('PATCH /api/sites/:id', () => {
    it('changes any subset of fields, including a site already used by events', async () => {
      const [before] = await query('SELECT created_by FROM sampling_sites WHERE site_id = 1');
      const res = await as.field_researcher
        .patch('/api/sites/1')
        .send({ description: 'Corrected', latitude: 28.5, habitat_type: 'estuary' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        site_id: 1,
        description: 'Corrected',
        latitude: 28.5,
        habitat_type: 'estuary',
        name: 'Dakpathar Barrage',
      });
      const clear = await as.principal_investigator
        .patch('/api/sites/1')
        .send({ description: null });
      expect(clear.body.data.description).toBeNull();
      const [row] = await query('SELECT created_by FROM sampling_sites WHERE site_id = 1');
      expect(row.created_by).toBe(before.created_by);
      const audit = await query(
        "SELECT actor_id FROM audit_logs WHERE entity_type = 'sampling_sites' AND entity_id = 1 AND action = 'update' ORDER BY audit_id",
      );
      expect(audit.map((a) => a.actor_id)).toEqual([3, 2]);
    });
    it('is strict: empty body, unknown keys and created_by are 422; bad values are 422', async () => {
      const patch = (b) => as.field_researcher.patch('/api/sites/2').send(b);
      expect((await patch({})).status).toBe(422);
      expect((await patch({ created_by: 3 })).status).toBe(422);
      expect((await patch({ site_id: 9 })).status).toBe(422);
      const lat = await patch({ latitude: -91 });
      expect(lat.status).toBe(422);
      expect(lat.body.error.details[0].field).toBe('latitude');
      expect((await patch({ name: ' ' })).status).toBe(422);
      expect((await patch({ region_id: 999 })).body.error.code).toBe('invalid_reference');
      expect((await patch({ name: 'Okhla Barrage' })).status).toBe(200);
    });
    it('409 duplicate name in the region; 404 unknown; 403 other roles; 422 bad id', async () => {
      const dup = await as.field_researcher
        .patch('/api/sites/2')
        .send({ name: 'Dakpathar Barrage' });
      expect(dup.status).toBe(409);
      expect((await as.field_researcher.patch('/api/sites/9999').send({ name: 'x' })).status).toBe(
        404,
      );
      for (const role of ['viewer']) {
        expect((await as[role].patch('/api/sites/2').send({ name: 'z' })).status, role).toBe(403);
      }
      expect((await as.field_researcher.patch('/api/sites/abc').send({ name: 'z' })).status).toBe(
        422,
      );
    });
  });
});
