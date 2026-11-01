// Owner: A (Backend)
// Purpose: Laboratory and sequencing routes: labs, markers, batches, extractions, QC results, runs
// (needs the seeded test database)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!available)('laboratory and sequencing', () => {
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

  const lt = () => as.lab_technician;
  const newExtraction = async (sampleId, batchId = 1, qc = 'pass') => {
    const made = await lt()
      .post('/api/extractions')
      .send({ sample_id: sampleId, batch_id: batchId });
    expect(made.status).toBe(201);
    if (qc) {
      const patched = await lt()
        .patch(`/api/extractions/${made.body.data.extraction_id}`)
        .send({ qc_status: qc });
      expect(patched.status).toBe(200);
    }
    return made.body.data.extraction_id;
  };
  const count = async (table) => Number((await query(`SELECT count(*) AS n FROM ${table}`))[0].n);

  describe('labs and markers', () => {
    it('list unpaginated for any signed-in user', async () => {
      const labs = await as.viewer.get('/api/labs');
      expect(labs.status).toBe(200);
      expect(labs.body.meta).toBeUndefined();
      expect(labs.body.data).toHaveLength(2);
      expect(Object.keys(labs.body.data[0]).sort()).toEqual(['lab_id', 'location', 'name']);
      const markers = await as.viewer.get('/api/markers');
      expect(markers.status).toBe(200);
      expect(Object.keys(markers.body.data[0]).sort()).toEqual([
        'marker_id',
        'marker_name',
        'target_region',
      ]);
    });
  });

  describe('extraction batches', () => {
    it('lists seeded batches to anyone, filtered by lab', async () => {
      const all = await as.viewer.get('/api/extraction-batches');
      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBe(3);
      expect(Object.keys(all.body.data[0]).sort()).toEqual([
        'batch_id',
        'created_at',
        'extraction_date',
        'kit_name',
        'lab_id',
        'notes',
        'operator_id',
      ]);
      const byLab = await as.viewer.get('/api/extraction-batches?lab_id=999');
      expect(byLab.body.meta.total).toBe(0);
    });
    it('creates a batch with the session user as operator', async () => {
      const res = await lt()
        .post('/api/extraction-batches')
        .send({ lab_id: 1, extraction_date: today, kit_name: 'Kit X' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        lab_id: 1,
        operator_id: 4,
        extraction_date: today,
        kit_name: 'Kit X',
        notes: null,
      });
    });
    it('refuses other roles (403), bad dates (422) and an unknown lab (422 invalid_reference)', async () => {
      expect(
        (
          await as.field_researcher
            .post('/api/extraction-batches')
            .send({ lab_id: 1, extraction_date: today })
        ).status,
      ).toBe(403);
      expect(
        (
          await as.viewer
            .post('/api/extraction-batches')
            .send({ lab_id: 1, extraction_date: today })
        ).status,
      ).toBe(403);
      expect(
        (
          await lt()
            .post('/api/extraction-batches')
            .send({ lab_id: 1, extraction_date: '1999-12-31' })
        ).status,
      ).toBe(422);
      expect(
        (
          await lt()
            .post('/api/extraction-batches')
            .send({ lab_id: 1, extraction_date: '2999-01-01' })
        ).status,
      ).toBe(422);
      expect(
        (
          await lt()
            .post('/api/extraction-batches')
            .send({ lab_id: 1, extraction_date: today, extra: 1 })
        ).status,
      ).toBe(422);
      const unknown = await lt()
        .post('/api/extraction-batches')
        .send({ lab_id: 999, extraction_date: today });
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('invalid_reference');
    });
  });

  describe('extractions', () => {
    it("limits the list to the caller's projects", async () => {
      const mine = await lt().get('/api/extractions?limit=100');
      expect(mine.status).toBe(200);
      expect(mine.body.meta.total).toBe(13);
      const admin = await as.administrator.get('/api/extractions?limit=100');
      expect(admin.body.meta.total).toBe(17);
      expect((await as.outsider.get('/api/extractions')).body.meta.total).toBe(0);
      expect((await lt().get('/api/extractions?sample_id=13')).status).toBe(404);
      expect((await lt().get('/api/extractions?sample_id=999')).status).toBe(404);
      const byBatch = await lt().get('/api/extractions?batch_id=2');
      expect(byBatch.body.meta.total).toBe(6);
      const row = byBatch.body.data[0];
      expect(Object.keys(row).sort()).toEqual([
        'attempt_number',
        'batch_id',
        'concentration_ng_ul',
        'created_at',
        'extraction_id',
        'purity_a260_280',
        'qc_status',
        'sample_id',
      ]);
      expect(typeof row.concentration_ng_ul).toBe('number');
    });
    it('numbers attempts per sample, also for simultaneous requests', async () => {
      const first = await lt()
        .post('/api/extractions')
        .send({ sample_id: 6, batch_id: 1, concentration_ng_ul: 12.5, purity_a260_280: 1.85 });
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({
        sample_id: 6,
        attempt_number: 2,
        qc_status: 'pending',
        concentration_ng_ul: 12.5,
        purity_a260_280: 1.85,
      });
      const both = await Promise.all([
        lt().post('/api/extractions').send({ sample_id: 7, batch_id: 1 }),
        as.principal_investigator.post('/api/extractions').send({ sample_id: 7, batch_id: 1 }),
      ]);
      expect(both.map((r) => r.status)).toEqual([201, 201]);
      expect(both.map((r) => r.body.data.attempt_number).sort()).toEqual([2, 3]);
    });
    it('refuses wrong roles, hidden samples, failed samples and unknown batches', async () => {
      expect(
        (await as.field_researcher.post('/api/extractions').send({ sample_id: 1, batch_id: 1 }))
          .status,
      ).toBe(403);
      expect(
        (await as.outsider.post('/api/extractions').send({ sample_id: 1, batch_id: 1 })).status,
      ).toBe(404);
      expect(
        (await lt().post('/api/extractions').send({ sample_id: 13, batch_id: 1 })).status,
      ).toBe(404);
      expect(
        (await lt().post('/api/extractions').send({ sample_id: 999, batch_id: 1 })).status,
      ).toBe(404);
      const failed = await lt().post('/api/extractions').send({ sample_id: 17, batch_id: 1 });
      expect(failed.status).toBe(422);
      expect(failed.body.error.code).toBe('rule_violation');
      const batch = await lt().post('/api/extractions').send({ sample_id: 1, batch_id: 999 });
      expect(batch.status).toBe(422);
      expect(batch.body.error.code).toBe('invalid_reference');
      expect(
        (
          await lt()
            .post('/api/extractions')
            .send({ sample_id: 1, batch_id: 1, purity_a260_280: -1 })
        ).status,
      ).toBe(422);
    });
    it('patches qc_status and measurements; other fields are refused', async () => {
      const id = await newExtraction(2, 1, null);
      const ok = await lt()
        .patch(`/api/extractions/${id}`)
        .send({ qc_status: 'pass', concentration_ng_ul: 20 });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ qc_status: 'pass', concentration_ng_ul: 20 });
      const back = await lt().patch(`/api/extractions/${id}`).send({ qc_status: 'fail' });
      expect(back.body.data.qc_status).toBe('fail');
      expect((await lt().patch(`/api/extractions/${id}`).send({})).status).toBe(422);
      expect(
        (await lt().patch(`/api/extractions/${id}`).send({ qc_status: 'pending' })).status,
      ).toBe(422);
      expect((await lt().patch(`/api/extractions/${id}`).send({ attempt_number: 9 })).status).toBe(
        422,
      );
      expect(
        (await as.outsider.patch(`/api/extractions/${id}`).send({ qc_status: 'pass' })).status,
      ).toBe(404);
      expect((await lt().patch('/api/extractions/9999').send({ qc_status: 'pass' })).status).toBe(
        404,
      );
      expect(
        (await as.analyst.patch(`/api/extractions/${id}`).send({ qc_status: 'pass' })).status,
      ).toBe(403);
    });
  });

  describe('QC results', () => {
    it('lists by visibility with filters, newest first', async () => {
      const mine = await lt().get('/api/qc-results?limit=100');
      expect(mine.status).toBe(200);
      const admin = await as.administrator.get('/api/qc-results?limit=100');
      expect(admin.body.meta.total).toBe(23);
      expect(mine.body.meta.total).toBeLessThan(23);
      expect((await as.outsider.get('/api/qc-results')).body.meta.total).toBe(0);
      const times = admin.body.data.map((r) => r.recorded_at);
      expect([...times].sort().reverse()).toEqual(times);
      expect((await lt().get('/api/qc-results?sample_id=13')).status).toBe(404);
      expect((await as.outsider.get('/api/qc-results?analysis_id=1')).status).toBe(404);
      expect((await lt().get('/api/qc-results?result=bogus')).status).toBe(422);
    });
    it('records a sample result with the session user as recorder', async () => {
      const res = await lt()
        .post('/api/qc-results')
        .send({ sample_id: 1, qc_type: 'concentration', result: 'warn', metric_value: 3.5 });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        sample_id: 1,
        analysis_id: null,
        recorded_by: 4,
        metric_value: 3.5,
      });
    });
    it('records an analysis-only result and shows it to project members only', async () => {
      const res = await lt()
        .post('/api/qc-results')
        .send({ analysis_id: 1, qc_type: 'read_quality', result: 'pass' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ sample_id: null, analysis_id: 1 });
      const seen = await lt().get('/api/qc-results?analysis_id=1');
      expect(seen.body.data.map((r) => r.qc_id)).toContain(res.body.data.qc_id);
      expect(
        (
          await as.outsider
            .post('/api/qc-results')
            .send({ analysis_id: 1, qc_type: 'read_quality', result: 'pass' })
        ).status,
      ).toBe(404);
    });
    it('refuses neither-parent, wrong roles and unknown parents', async () => {
      expect(
        (await lt().post('/api/qc-results').send({ qc_type: 'concentration', result: 'pass' }))
          .status,
      ).toBe(422);
      expect(
        (
          await as.field_researcher
            .post('/api/qc-results')
            .send({ sample_id: 1, qc_type: 'concentration', result: 'pass' })
        ).status,
      ).toBe(403);
      expect(
        (
          await as.outsider
            .post('/api/qc-results')
            .send({ sample_id: 1, qc_type: 'concentration', result: 'pass' })
        ).status,
      ).toBe(404);
      expect(
        (
          await lt()
            .post('/api/qc-results')
            .send({ sample_id: 999, qc_type: 'concentration', result: 'pass' })
        ).status,
      ).toBe(404);
      expect(
        (
          await lt()
            .post('/api/qc-results')
            .send({ analysis_id: 999, qc_type: 'concentration', result: 'pass' })
        ).status,
      ).toBe(404);
      expect(
        (
          await lt()
            .post('/api/qc-results')
            .send({ sample_id: 1, qc_type: 'bogus', result: 'pass' })
        ).status,
      ).toBe(422);
    });
  });

  describe('sequencing runs', () => {
    it('lists and shows seeded runs by visibility', async () => {
      const admin = await as.administrator.get('/api/sequencing-runs');
      expect(admin.body.meta.total).toBe(2);
      expect(Object.keys(admin.body.data[0]).sort()).toEqual([
        'created_at',
        'lab_id',
        'platform',
        'run_code',
        'run_date',
        'run_id',
        'status',
      ]);
      expect(admin.body.data[0].run_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const detail = await as.administrator.get('/api/sequencing-runs/2');
      expect(detail.body.data.libraries).toHaveLength(8);
      expect(Object.keys(detail.body.data.libraries[0]).sort()).toEqual([
        'created_at',
        'extraction_id',
        'library_code',
        'library_id',
        'run_id',
        'sample_code',
        'sample_id',
      ]);
      // lab technician is in project 1 only: run 2 shows just the project-1 libraries
      const mine = await lt().get('/api/sequencing-runs/2');
      expect(mine.status).toBe(200);
      expect(mine.body.data.libraries).toHaveLength(4);
      expect((await as.outsider.get('/api/sequencing-runs/1')).status).toBe(404);
      expect((await as.outsider.get('/api/sequencing-runs')).body.meta.total).toBe(0);
      expect((await lt().get('/api/sequencing-runs/999')).status).toBe(404);
    });
    it('creates a run with codes, libraries and 201', async () => {
      const a = await newExtraction(1);
      const b = await newExtraction(3);
      const res = await lt()
        .post('/api/sequencing-runs')
        .send({ lab_id: 1, platform: ' NovaSeq ', run_date: today, extraction_ids: [a, b] });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ lab_id: 1, platform: 'NovaSeq', status: 'planned' });
      expect(res.body.data.run_code).toMatch(/^RUN-/);
      expect(res.body.data.libraries).toHaveLength(2);
      expect(res.body.data.libraries[0].library_code).toMatch(/^LIB-/);
    });
    it('is all-or-nothing when an extraction cannot be booked', async () => {
      const good = await newExtraction(4);
      const pending = await newExtraction(5, 1, null);
      const runs = await count('sequencing_runs');
      const libs = await count('sequencing_libraries');
      for (const ids of [
        [good, pending],
        [good, 17],
        [good, good],
      ]) {
        const res = await lt()
          .post('/api/sequencing-runs')
          .send({ lab_id: 1, platform: 'x', run_date: today, extraction_ids: ids });
        expect([422, 404]).toContain(res.status);
      }
      const notPass = await lt()
        .post('/api/sequencing-runs')
        .send({ lab_id: 1, platform: 'x', run_date: today, extraction_ids: [good, pending] });
      expect(notPass.status).toBe(422);
      expect(notPass.body.error.code).toBe('rule_violation');
      expect(await count('sequencing_runs')).toBe(runs);
      expect(await count('sequencing_libraries')).toBe(libs);
    });
    it('books an extraction once even with simultaneous requests', async () => {
      const id = await newExtraction(8);
      const body = { lab_id: 1, platform: 'x', run_date: today, extraction_ids: [id] };
      const both = await Promise.all([
        lt().post('/api/sequencing-runs').send(body),
        as.principal_investigator.post('/api/sequencing-runs').send(body),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 422]);
    });
    it('validates the body and the caller', async () => {
      const ok = { lab_id: 1, platform: 'x', run_date: today, extraction_ids: [1] };
      expect(
        (
          await lt()
            .post('/api/sequencing-runs')
            .send({ ...ok, extraction_ids: [] })
        ).status,
      ).toBe(422);
      expect(
        (
          await lt()
            .post('/api/sequencing-runs')
            .send({ ...ok, extraction_ids: [1, 1] })
        ).status,
      ).toBe(422);
      expect(
        (
          await lt()
            .post('/api/sequencing-runs')
            .send({ ...ok, platform: '  ' })
        ).status,
      ).toBe(422);
      expect(
        (
          await lt()
            .post('/api/sequencing-runs')
            .send({ ...ok, run_date: undefined })
        ).status,
      ).toBe(422);
      expect((await as.analyst.post('/api/sequencing-runs').send(ok)).status).toBe(403);
      expect((await as.outsider.post('/api/sequencing-runs').send(ok)).status).toBe(404);
      expect(
        (
          await lt()
            .post('/api/sequencing-runs')
            .send({ ...ok, extraction_ids: [9999] })
        ).status,
      ).toBe(404);
      const e9 = await newExtraction(9);
      const lab = await lt()
        .post('/api/sequencing-runs')
        .send({ ...ok, lab_id: 999, extraction_ids: [e9] });
      expect(lab.status).toBe(422);
    });
    it('adds a library to a planned run only', async () => {
      const e10 = await newExtraction(10);
      const e12 = await newExtraction(12, 1, null);
      const e2b = await newExtraction(2);
      const runId = (
        await lt()
          .post('/api/sequencing-runs')
          .send({
            lab_id: 1,
            platform: 'x',
            run_date: today,
            extraction_ids: [e10],
          })
      ).body.data.run_id;
      const extra = await newExtraction(11);
      const added = await lt()
        .post(`/api/sequencing-runs/${runId}/libraries`)
        .send({ extraction_id: extra });
      expect(added.status).toBe(201);
      expect(added.body.data).toMatchObject({ extraction_id: extra, run_id: runId });
      expect(
        (await lt().post(`/api/sequencing-runs/${runId}/libraries`).send({ extraction_id: extra }))
          .status,
      ).toBe(422);
      expect(
        (await lt().post(`/api/sequencing-runs/${runId}/libraries`).send({ extraction_id: e12 }))
          .status,
      ).toBe(422);
      expect(
        (
          await as.outsider
            .post(`/api/sequencing-runs/${runId}/libraries`)
            .send({ extraction_id: extra })
        ).status,
      ).toBe(404);
      expect(
        (await lt().post('/api/sequencing-runs/999/libraries').send({ extraction_id: extra }))
          .status,
      ).toBe(404);
      await lt().patch(`/api/sequencing-runs/${runId}`).send({ status: 'running' });
      const late = await lt()
        .post(`/api/sequencing-runs/${runId}/libraries`)
        .send({ extraction_id: e2b });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('invalid_transition');
    });
    it('moves status through the trigger rules', async () => {
      const e2 = await newExtraction(2);
      const runId = (
        await lt()
          .post('/api/sequencing-runs')
          .send({
            lab_id: 1,
            platform: 'x',
            run_date: today,
            extraction_ids: [e2],
          })
      ).body.data.run_id;
      const patch = (status) => lt().patch(`/api/sequencing-runs/${runId}`).send({ status });
      const skip = await patch('completed');
      expect(skip.status).toBe(409);
      expect(skip.body.error.code).toBe('invalid_transition');
      expect((await patch('planned')).status).toBe(409);
      const running = await patch('running');
      expect(running.status).toBe(200);
      expect(running.body.data.status).toBe('running');
      expect(running.body.data.libraries).toBeUndefined();
      expect((await patch('running')).status).toBe(409);
      expect((await patch('completed')).status).toBe(200);
      expect((await patch('failed')).status).toBe(409);
      expect((await patch('bogus')).status).toBe(422);
      expect(
        (await as.outsider.patch(`/api/sequencing-runs/${runId}`).send({ status: 'failed' }))
          .status,
      ).toBe(404);
      expect(
        (await as.analyst.patch(`/api/sequencing-runs/${runId}`).send({ status: 'failed' })).status,
      ).toBe(403);
      expect(
        (await lt().patch('/api/sequencing-runs/999').send({ status: 'running' })).status,
      ).toBe(404);
    });
  });
});
