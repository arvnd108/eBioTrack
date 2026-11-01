// Owner: A (Backend)
// Purpose: Analysis routes: read, create, CSV import (dry run and real), approve, reject, races
// (needs the seeded test database)
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const fixture = (name) => readFile(new URL(`../../tests/fixtures/${name}`, import.meta.url));
const HEADER = 'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag';
const ANALYSIS_KEYS = [
  'analysis_id',
  'approved_at',
  'approved_by',
  'created_at',
  'imported_by',
  'marker_id',
  'parameters',
  'pipeline_name',
  'pipeline_version',
  'reference_db',
  'reference_db_version',
  'run_id',
  'status',
];

describe.skipIf(!available)('analyses', () => {
  const as = {};
  let valid;

  beforeAll(async () => {
    valid = await fixture('detections_valid.csv');
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

  const count = async (sql, params = []) => Number((await query(sql, params))[0].n);
  const assignments = (id) =>
    count('SELECT count(*) AS n FROM taxon_assignments WHERE analysis_id = $1', [id]);
  const statusOf = async (id) =>
    (await query('SELECT status FROM analysis_runs WHERE analysis_id = $1', [id]))[0].status;
  const upload = (agent, id, content, { dry = false, name = 'd.csv' } = {}) =>
    agent
      .post(`/api/analyses/import${dry ? '?dry_run=true' : ''}`)
      .field('analysis_id', String(id))
      .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  const newAnalysis = async (agent = as.analyst, body = {}) => {
    const res = await agent.post('/api/analyses').send({
      run_id: 1,
      marker_id: 2,
      pipeline_name: 'qiime2',
      pipeline_version: '2024.5',
      reference_db: 'MitoFish',
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body.data.analysis_id;
  };
  const importValid = async (id, agent = as.analyst) => {
    const res = await upload(agent, id, valid);
    expect(res.status).toBe(201);
  };

  describe('reading', () => {
    it('shows unapproved analyses only to administrator, PI and analyst', async () => {
      const ids = async (agent) =>
        (await agent.get('/api/analyses?limit=100')).body.data.map((a) => a.analysis_id);
      expect(await ids(as.administrator)).toEqual([1, 2, 3, 4]);
      expect(await ids(as.principal_investigator)).toEqual([1, 2, 3, 4]);
      expect(await ids(as.analyst)).toEqual([1, 2, 3, 4]);
      expect(await ids(as.lab_technician)).toEqual([1, 2]);
      expect(await ids(as.viewer)).toEqual([1, 2]);
      expect(await ids(as.field_researcher)).toEqual([1, 2]);
      expect(await ids(as.outsider)).toEqual([]);
      expect((await as.lab_technician.get('/api/analyses/3')).status).toBe(404);
      expect((await as.lab_technician.get('/api/analyses/4')).status).toBe(404);
      expect((await as.outsider.get('/api/analyses/1')).status).toBe(404);
      expect((await as.analyst.get('/api/analyses/999')).status).toBe(404);
    });
    it('filters, validates filters and paginates', async () => {
      const approved = await as.analyst.get('/api/analyses?status=approved');
      expect(approved.body.data.map((a) => a.analysis_id)).toEqual([1, 2]);
      expect((await as.analyst.get('/api/analyses?run_id=2')).body.meta.total).toBe(2);
      expect((await as.analyst.get('/api/analyses?marker_id=2')).body.meta.total).toBe(2);
      expect((await as.analyst.get('/api/analyses?status=bogus')).status).toBe(422);
      const page = await as.analyst.get('/api/analyses?limit=2&page=2&sort=-analysis_id');
      expect(page.body.data.map((a) => a.analysis_id)).toEqual([2, 1]);
      expect(page.body.meta).toEqual({ page: 2, limit: 2, total: 4 });
    });
    it('returns the contract fields, parameters as an object and counts with all keys', async () => {
      const one = await as.analyst.get('/api/analyses/1');
      expect(one.status).toBe(200);
      expect(Object.keys(one.body.data).sort()).toEqual(
        [...ANALYSIS_KEYS, 'assignment_counts'].sort(),
      );
      expect(one.body.data.assignment_counts).toEqual({ pass: 14, warn: 2, fail: 1 });
      const direct = await query(
        `SELECT qc_flag::text AS f, count(*)::int AS n FROM taxon_assignments WHERE analysis_id = 1 GROUP BY 1`,
      );
      for (const row of direct) expect(one.body.data.assignment_counts[row.f]).toBe(row.n);
      expect(typeof one.body.data.parameters).toBe('object');
      expect(typeof one.body.data.run_id).toBe('number');
      expect((await as.analyst.get('/api/analyses/4')).body.data.assignment_counts).toEqual({
        pass: 0,
        warn: 0,
        fail: 0,
      });
      const list = await as.analyst.get('/api/analyses');
      expect(Object.keys(list.body.data[0]).sort()).toEqual(ANALYSIS_KEYS);
    });
  });

  describe('creating', () => {
    it('creates a draft for analyst, PI and administrator', async () => {
      for (const agent of [as.analyst, as.principal_investigator, as.administrator]) {
        const res = await agent.post('/api/analyses').send({
          run_id: 1,
          marker_id: 1,
          pipeline_name: ' dada2 ',
          pipeline_version: '1.30',
          reference_db: 'MitoFish',
          parameters: { min_len: 100 },
        });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
          status: 'draft',
          pipeline_name: 'dada2',
          imported_by: null,
          approved_by: null,
          reference_db_version: null,
          parameters: { min_len: 100 },
        });
      }
    });
    it('refuses other roles, non-members, unknown parents and bad bodies', async () => {
      const body = {
        run_id: 1,
        marker_id: 1,
        pipeline_name: 'p',
        pipeline_version: '1',
        reference_db: 'r',
      };
      for (const agent of [as.lab_technician, as.field_researcher, as.viewer]) {
        expect((await agent.post('/api/analyses').send(body)).status).toBe(403);
      }
      expect((await as.outsider.post('/api/analyses').send(body)).status).toBe(404);
      expect((await as.analyst.post('/api/analyses').send({ ...body, run_id: 999 })).status).toBe(
        404,
      );
      const marker = await as.analyst.post('/api/analyses').send({ ...body, marker_id: 999 });
      expect(marker.status).toBe(422);
      expect(marker.body.error.code).toBe('invalid_reference');
      expect(
        (await as.analyst.post('/api/analyses').send({ ...body, status: 'approved' })).status,
      ).toBe(422);
      expect(
        (await as.analyst.post('/api/analyses').send({ ...body, pipeline_name: '  ' })).status,
      ).toBe(422);
      expect(
        (await as.analyst.post('/api/analyses').send({ ...body, parameters: [] })).status,
      ).toBe(422);
    });
    it('refuses a project viewer even with the analyst role', async () => {
      await query('INSERT INTO user_roles (user_id, role_id) VALUES (6, 5)');
      try {
        const viewerAnalyst = await signIn(app, SEED_EMAIL.viewer);
        const res = await viewerAnalyst.post('/api/analyses').send({
          run_id: 1,
          marker_id: 1,
          pipeline_name: 'p',
          pipeline_version: '1',
          reference_db: 'r',
        });
        expect(res.status).toBe(403);
      } finally {
        await query('DELETE FROM user_roles WHERE user_id = 6 AND role_id = 5');
      }
    });
    it('accepts a correction of an approved analysis, once', async () => {
      const base = {
        run_id: 2,
        marker_id: 1,
        pipeline_name: 'p',
        pipeline_version: '1',
        reference_db: 'r',
      };
      const first = await as.analyst
        .post('/api/analyses')
        .send({ ...base, supersedes_analysis_id: 2 });
      expect(first.status).toBe(201);
      const again = await as.analyst
        .post('/api/analyses')
        .send({ ...base, supersedes_analysis_id: 2 });
      expect(again.status).toBe(409);
      const notApproved = await as.analyst
        .post('/api/analyses')
        .send({ ...base, supersedes_analysis_id: 4 });
      expect(notApproved.status).toBe(422);
      expect(notApproved.body.error.code).toBe('rule_violation');
      expect(
        (await as.analyst.post('/api/analyses').send({ ...base, supersedes_analysis_id: 999 }))
          .status,
      ).toBe(404);
    });
  });

  describe('CSV import', () => {
    it('dry run: valid file lists no errors and writes nothing', async () => {
      const res = await upload(as.analyst, 4, valid, { dry: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { valid_rows: 14, errors: [] } });
      expect(await assignments(4)).toBe(0);
      expect(await statusOf(4)).toBe('draft');
    });
    it('dry run: the invalid fixture has exactly one error at row 8, field library_code', async () => {
      const res = await upload(as.analyst, 4, await fixture('detections_invalid_row.csv'), {
        dry: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.valid_rows).toBe(13);
      expect(res.body.data.errors).toHaveLength(1);
      expect(res.body.data.errors[0]).toMatchObject({ row: 8, field: 'library_code' });
      expect(res.body.data.errors[0].message).toMatch(/another sequencing run/);
    });
    it('dry run: BOM, CRLF and quoted commas are accepted', async () => {
      const text = `${String.fromCharCode(0xfeff)}${HEADER}\r\nLIB-0001,"Labeo rohita",species,"14250",0.9712,pass\r\n`;
      const res = await upload(as.analyst, 4, text, { dry: true });
      expect(res.body.data).toEqual({ valid_rows: 1, errors: [] });
    });
    it('dry run: the demo dataset is valid', async () => {
      const demo = await readFile(new URL('../../datasets/sample_detections.csv', import.meta.url));
      const res = await upload(as.analyst, 4, demo, { dry: true });
      expect(res.body.data.errors).toEqual([]);
    });
    it('reports header problems, unknown taxa, repeats and bad numbers with row numbers', async () => {
      const missing = await upload(as.analyst, 4, 'library_code,scientific_name\nLIB-0001,x\n', {
        dry: true,
      });
      expect(missing.body.data.errors.map((e) => `${e.row}:${e.field}`)).toEqual([
        '1:taxon_rank',
        '1:read_count',
        '1:confidence',
        '1:qc_flag',
      ]);
      const extra = await upload(
        as.analyst,
        4,
        `${HEADER},color\nLIB-0001,Labeo rohita,species,1,0.5,pass,red\n`,
        {
          dry: true,
        },
      );
      expect(extra.body.data.errors).toEqual([
        { row: 1, field: 'color', message: 'unexpected column' },
      ]);
      const rows = [
        'LIB-0001,Labeo rohita,species,5,0.5,pass',
        'LIB-0001,Labeo rohita,species,6,0.5,pass',
        'LIB-0001,No such fish,species,1,0.5,pass',
        'LIB-0002,Labeo rohita,species,12.5,2,maybe',
        'LIB-9999,Labeo rohita,species,1,0.5,pass',
      ];
      const res = await upload(as.analyst, 4, `${HEADER}\n${rows.join('\n')}\n`, { dry: true });
      const list = res.body.data.errors.map((e) => `${e.row}:${e.field}`);
      expect(list).toEqual([
        '3:library_code',
        '4:scientific_name',
        '5:read_count',
        '5:confidence',
        '5:qc_flag',
        '6:library_code',
      ]);
      expect(res.body.data.errors[0].message).toMatch(/row 2/);
      expect(res.body.data.valid_rows).toBe(1);
    });
    it('caps the listed errors and says so', async () => {
      const rows = Array.from({ length: 150 }, () => 'LIB-0001,Labeo rohita,species,x,0.5,pass');
      const res = await upload(as.analyst, 4, `${HEADER}\n${rows.join('\n')}\n`, { dry: true });
      expect(res.body.data.errors).toHaveLength(100);
      expect(res.body.meta).toEqual({ total_errors: 150, errors_shown: 100 });
    });
    it('rejects missing, empty, oversize and non-UTF-8 files and stray fields with 422', async () => {
      const none = await as.analyst.post('/api/analyses/import').field('analysis_id', '4');
      expect(none.status).toBe(422);
      expect(none.body.error.details[0]).toMatchObject({ field: 'file' });
      expect((await upload(as.analyst, 4, '')).status).toBe(422);
      const big = await upload(as.analyst, 4, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
      expect(big.status).toBe(422);
      expect(big.body.error.details).toEqual([{ field: 'file', message: 'maximum size is 10 MB' }]);
      expect((await upload(as.analyst, 4, Buffer.from([0xff, 0xfe, 0x41]))).status).toBe(422);
      const stray = await as.analyst
        .post('/api/analyses/import')
        .field('analysis_id', '4')
        .field('status', 'approved')
        .attach('file', Buffer.from(`${HEADER}\n`), 'd.csv');
      expect(stray.status).toBe(422);
      const wrongField = await as.analyst
        .post('/api/analyses/import')
        .field('analysis_id', '4')
        .attach('upload', Buffer.from(`${HEADER}\n`), 'd.csv');
      expect(wrongField.status).toBe(422);
      expect((await upload(as.analyst, 'abc', valid)).status).toBe(422);
    });
    it('gates by role and project', async () => {
      for (const agent of [as.lab_technician, as.field_researcher, as.viewer]) {
        expect((await upload(agent, 4, valid)).status).toBe(403);
      }
      expect((await upload(as.outsider, 4, valid)).status).toBe(404);
      expect((await upload(as.analyst, 999, valid)).status).toBe(404);
      expect(await assignments(4)).toBe(0);
    });
    it('a file with an error imports nothing (422, same error shape)', async () => {
      const res = await upload(as.analyst, 4, await fixture('detections_invalid_row.csv'));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.details).toEqual([
        expect.objectContaining({ row: 8, field: 'library_code' }),
      ]);
      expect(await assignments(4)).toBe(0);
      expect(await statusOf(4)).toBe('draft');
    });
    it('imports a valid file all at once, then refuses a second import', async () => {
      const res = await upload(as.analyst, 4, valid);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ data: { inserted: 14 } });
      expect(await assignments(4)).toBe(14);
      const row = (
        await query('SELECT status, imported_by FROM analysis_runs WHERE analysis_id = 4')
      )[0];
      expect(row).toEqual({ status: 'imported', imported_by: 5 });
      const audit = await count(
        "SELECT count(*) AS n FROM audit_logs WHERE entity_type = 'analysis_runs' AND entity_id = 4 AND actor_id = 5",
      );
      expect(audit).toBeGreaterThan(0);
      const again = await upload(as.analyst, 4, valid);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('conflict');
      const dry = await upload(as.analyst, 4, valid, { dry: true });
      expect(dry.status).toBe(409);
      const approved = await upload(as.analyst, 1, valid);
      expect(approved.status).toBe(409);
      expect(await assignments(4)).toBe(14);
    });
    it('confidence keeps four decimals', async () => {
      const detail = await query(
        'SELECT confidence::float8 AS c FROM taxon_assignments WHERE analysis_id = 4',
      );
      expect(detail.map((d) => d.c)).toContain(0.9712);
    });
    it('two simultaneous imports into one draft: exactly one succeeds', async () => {
      const id = await newAnalysis();
      const results = await Promise.all([
        upload(as.analyst, id, valid),
        upload(as.principal_investigator, id, valid),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await assignments(id)).toBe(14);
    });
  });

  describe('approving and rejecting', () => {
    it('another PI approves an analyst import; twice is 409', async () => {
      const id = await newAnalysis();
      await importValid(id);
      expect((await as.analyst.post(`/api/analyses/${id}/approve`)).status).toBe(403);
      for (const agent of [as.lab_technician, as.field_researcher, as.viewer]) {
        expect((await agent.post(`/api/analyses/${id}/approve`)).status).toBe(403);
      }
      expect((await as.outsider.post(`/api/analyses/${id}/approve`)).status).toBe(404);
      const ok = await as.principal_investigator.post(`/api/analyses/${id}/approve`);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ analysis_id: id, status: 'approved', approved_by: 2 });
      expect(ok.body.data.approved_at).toMatch(/Z$/);
      const twice = await as.principal_investigator.post(`/api/analyses/${id}/approve`);
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe('conflict');
    });
    it('a PI cannot approve their own import (422)', async () => {
      const id = await newAnalysis(as.principal_investigator);
      await importValid(id, as.principal_investigator);
      const res = await as.principal_investigator.post(`/api/analyses/${id}/approve`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('rule_violation');
      expect(await statusOf(id)).toBe('imported');
    });
    it('approving a draft is 409 invalid_transition; an unknown id is 404', async () => {
      const id = await newAnalysis();
      const res = await as.principal_investigator.post(`/api/analyses/${id}/approve`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_transition');
      expect((await as.principal_investigator.post('/api/analyses/999/approve')).status).toBe(404);
    });
    it('rejects with a reason; reason required; after approval 409', async () => {
      const id = await newAnalysis();
      await importValid(id);
      expect(
        (await as.principal_investigator.post(`/api/analyses/${id}/reject`).send({})).status,
      ).toBe(422);
      expect(
        (await as.principal_investigator.post(`/api/analyses/${id}/reject`).send({ reason: '   ' }))
          .status,
      ).toBe(422);
      expect(
        (await as.analyst.post(`/api/analyses/${id}/reject`).send({ reason: 'no' })).status,
      ).toBe(403);
      const ok = await as.principal_investigator
        .post(`/api/analyses/${id}/reject`)
        .send({ reason: 'Wrong reference database' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('rejected');
      const twice = await as.principal_investigator
        .post(`/api/analyses/${id}/reject`)
        .send({ reason: 'again' });
      expect(twice.status).toBe(409);
      const approvedOne = await as.principal_investigator
        .post('/api/analyses/1/reject')
        .send({ reason: 'x' });
      expect(approvedOne.status).toBe(409);
      // rejected -> draft exists in the status table but no endpoint exposes it
      expect((await as.principal_investigator.post(`/api/analyses/${id}/approve`)).status).toBe(
        409,
      );
    });
    it('two simultaneous approvals: one 200, one 409; approve against reject: one wins', async () => {
      const a = await newAnalysis();
      await importValid(a);
      const both = await Promise.all([
        as.principal_investigator.post(`/api/analyses/${a}/approve`),
        as.administrator.post(`/api/analyses/${a}/approve`),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const b = await newAnalysis();
      await importValid(b);
      const mixed = await Promise.all([
        as.principal_investigator.post(`/api/analyses/${b}/approve`),
        as.administrator.post(`/api/analyses/${b}/reject`).send({ reason: 'race' }),
      ]);
      expect(mixed.map((r) => r.status).sort()).toEqual([200, 409]);
    });
    it('a correction supersedes the approved analysis it replaces', async () => {
      const before = await count(
        'SELECT count(*) AS n FROM v_approved_detections WHERE analysis_id = 2',
      );
      expect(before).toBeGreaterThan(0);
      const fix = await newAnalysis(as.analyst, {
        run_id: 1,
        marker_id: 1,
        supersedes_analysis_id: 1,
      });
      const rows =
        'LIB-0001,Labeo rohita,species,100,0.9,pass\nLIB-0002,Labeo rohita,species,100,0.9,pass\n';
      const imp = await upload(as.analyst, fix, `${HEADER}\n${rows}`);
      expect(imp.status).toBe(201);
      const ok = await as.principal_investigator.post(`/api/analyses/${fix}/approve`);
      expect(ok.status).toBe(200);
      expect(await statusOf(1)).toBe('superseded');
      expect(
        await count('SELECT count(*) AS n FROM v_approved_detections WHERE analysis_id = 1'),
      ).toBe(0);
      expect((await as.lab_technician.get('/api/analyses/1')).body.data.status).toBe('superseded');
    });
  });
});
