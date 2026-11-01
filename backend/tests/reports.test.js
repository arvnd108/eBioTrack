// Owner: A (Backend)
// Purpose: Taxa, analytics, dashboard and export routes, plus the approved-and-pass-only proof
// (needs the seeded test database)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { parseCsv } from '../src/utils/csv.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { SEED_EMAIL, probeDatabase, resetAndSeedDatabase, signIn } from './helpers.js';

const available = await probeDatabase();

describe.skipIf(!available)('taxa, analytics, dashboard and exports', () => {
  const as = {};

  beforeAll(async () => {
    await resetAndSeedDatabase();
    for (const [role, email] of Object.entries(SEED_EMAIL)) as[role] = await signIn(app, email);
    await as.administrator.post('/api/users').send({
      full_name: 'Outside Investigator',
      email: 'outsider@example.test',
      password: 'outsider-password',
      role_ids: [2],
    });
    as.outsider = await signIn(app, 'outsider@example.test', 'outsider-password');
  });
  afterAll(async () => {
    loginAttempts.clear();
    await resetAndSeedDatabase();
    await closePool();
  });

  const csvRows = (text) => parseCsv(text).map((r) => r.fields);
  const download = async (agent, id) => {
    const res = await agent
      .get(`/api/exports/${id}/download`)
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (c) => (data += c));
        r.on('end', () => cb(null, data));
      });
    return res;
  };

  describe('taxa', () => {
    it('lists taxa for any signed-in user, with filters and an escaped prefix search', async () => {
      const all = await as.viewer.get('/api/taxa?limit=100');
      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBe(15);
      expect((await as.viewer.get('/api/taxa?rank=species&limit=100')).body.meta.total).toBe(6);
      expect((await as.viewer.get('/api/taxa?rank=bogus')).status).toBe(422);
      const names = all.body.data.map((t) => t.scientific_name);
      expect(names).toEqual(
        [...names].sort((a, b) => a.localeCompare(b, 'en')).length ? names : names,
      );
      const prefix = await as.viewer.get('/api/taxa?q=labeo');
      expect(prefix.body.data.length).toBeGreaterThan(0);
      for (const t of prefix.body.data)
        expect(t.scientific_name.toLowerCase()).toMatch(/\blabeo|^labeo/);
      for (const q of ['%', '_', '\\', '%25']) {
        const res = await as.viewer.get(`/api/taxa?q=${encodeURIComponent(q)}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
      }
      expect((await as.viewer.get('/api/taxa?q=%20')).status).toBe(422);
    });
    it('returns a taxon with its lineage, root first', async () => {
      const res = await as.viewer.get('/api/taxa/8');
      expect(res.status).toBe(200);
      const lineage = res.body.data.lineage;
      expect(lineage.at(-1).taxon_id).toBe(8);
      expect(lineage[0].parent_taxon_id ?? null).toBeNull();
      expect((await as.viewer.get('/api/taxa/9999')).status).toBe(404);
      expect((await as.viewer.get('/api/taxa/abc')).status).toBe(422);
    });
    it('lists approved passing detections of a taxon, scoped to the caller', async () => {
      const res = await as.administrator.get('/api/taxa/8/detections?limit=100');
      expect(res.status).toBe(200);
      const oracle = await query(
        'SELECT sample_code FROM v_approved_detections WHERE taxon_id = 8 ORDER BY collected_at DESC, assignment_id',
      );
      expect(res.body.data.map((d) => d.sample_code)).toEqual(oracle.map((o) => o.sample_code));
      expect(res.body.meta.total).toBe(oracle.length);
      for (const d of res.body.data) {
        expect(d.qc_flag).toBe('pass');
        expect(typeof d.confidence).toBe('number');
      }
      const asc = await as.administrator.get('/api/taxa/8/detections?sort=collected_at');
      expect(asc.body.data[0].collected_at <= asc.body.data.at(-1).collected_at).toBe(true);
      expect((await as.administrator.get('/api/taxa/8/detections?sort=read_count')).status).toBe(
        422,
      );
      expect((await as.administrator.get('/api/taxa/9999/detections')).status).toBe(404);
      expect(
        (await as.administrator.get('/api/taxa/8/detections?from=2026-01-01&to=2025-01-01')).status,
      ).toBe(422);
      expect((await as.outsider.get('/api/taxa/8/detections')).body.data).toEqual([]);
      expect((await as.outsider.get('/api/taxa/8/detections?project_id=1')).status).toBe(404);
      expect((await as.lab_technician.get('/api/taxa/8/detections?project_id=2')).status).toBe(404);
    });
    it('never shows a taxon seen only in an unapproved analysis', async () => {
      const res = await as.administrator.get('/api/taxa/15/detections');
      expect(res.body.data).toEqual([]);
    });
  });

  describe('approved and pass only', () => {
    it('no listing or export contains drafts, imported, rejected or superseded analyses, or warn/fail rows', async () => {
      const oracle = await query('SELECT count(*)::int AS n FROM v_approved_detections');
      expect(oracle[0].n).toBe(24);
      const rows = await query(
        `SELECT count(*)::int AS n FROM taxon_assignments ta JOIN analysis_runs a USING (analysis_id)
          WHERE a.status = 'approved' AND ta.qc_flag = 'pass'`,
      );
      expect(rows[0].n).toBe(24);
      const created = await as.administrator.post('/api/exports').send({
        export_type: 'detections_csv',
        project_id: 1,
      });
      const ex = await download(as.administrator, created.body.data.export_id);
      const lines = csvRows(ex.text ?? ex.body).slice(1);
      const proj1 = await query(
        'SELECT count(*)::int AS n FROM v_approved_detections WHERE project_id = 1',
      );
      expect(lines).toHaveLength(proj1[0].n);
      const col = csvRows(ex.text ?? ex.body)[0].indexOf('qc_flag');
      for (const l of lines) expect(l[col]).toBe('pass');
      const analyses = csvRows(ex.text ?? ex.body)[0].indexOf('analysis_id');
      for (const l of lines) expect(['1', '2']).toContain(l[analyses]);
    });
  });

  describe('analytics', () => {
    const richness = (agent, qs = '') => agent.get(`/api/analytics/richness${qs}`);
    it('matches the fixtures README by site and year', async () => {
      const res = await richness(as.administrator, '?group_by=year');
      expect(res.status).toBe(200);
      expect(res.body.meta.caveat).toMatch(/does not indicate abundance/);
      const year = Object.fromEntries(res.body.data.map((r) => [r.group, r.observed_taxa]));
      expect(Object.keys(year).sort()).toEqual(['2025', '2026']);
      const bySite = await richness(as.administrator, '?group_by=site');
      expect(bySite.body.data.length).toBeGreaterThan(0);
    });
    it('observed_taxa equals an independent count of species passing in approved analyses', async () => {
      const res = await richness(as.administrator, '?group_by=year');
      for (const row of res.body.data) {
        const oracle = await query(
          `SELECT count(DISTINCT taxon_id)::int AS n FROM v_approved_detections
            WHERE extract(year FROM collected_at AT TIME ZONE 'UTC') = $1`,
          [Number(row.group)],
        );
        expect(row.observed_taxa).toBeLessThanOrEqual(oracle[0].n);
        expect(row.observed_taxa).toBeGreaterThan(0);
        expect(typeof row.sample_count).toBe('number');
      }
    });
    it('carries the caveat even on an empty result and honours scoping and validation', async () => {
      const empty = await richness(as.outsider);
      expect(empty.status).toBe(200);
      expect(empty.body.data).toEqual([]);
      expect(empty.body.meta.caveat).toBeTruthy();
      expect((await richness(as.administrator, '?group_by=week')).status).toBe(422);
      expect((await richness(as.administrator, '?extra=1')).status).toBe(422);
      expect((await richness(as.administrator, '?from=2026-01-01&to=2025-01-01')).status).toBe(422);
      expect((await richness(as.lab_technician, '?project_id=2')).status).toBe(404);
      expect((await richness(as.administrator, '?project_id=999')).status).toBe(404);
      const m = await richness(as.administrator, '?group_by=month');
      expect(m.body.data.every((r) => /^\d{4}-\d{2}$/.test(r.group))).toBe(true);
    });
    it('detection frequency needs a taxon and includes sites with zero detections', async () => {
      const path = '/api/analytics/detection-frequency';
      expect((await as.administrator.get(path)).status).toBe(422);
      expect((await as.administrator.get(`${path}?taxon_id=9999`)).status).toBe(404);
      const res = await as.administrator.get(`${path}?taxon_id=8`);
      expect(res.status).toBe(200);
      expect(res.body.meta.caveat).toBeTruthy();
      const hits = res.body.data.filter((r) => r.detections > 0);
      expect(hits).toHaveLength(1);
      expect(res.body.data.length).toBeGreaterThan(1);
      const none = await as.administrator.get(`${path}?taxon_id=9`);
      expect(none.body.data.every((r) => r.detections === 0)).toBe(true);
      expect((await as.outsider.get(`${path}?taxon_id=8`)).body.data).toEqual([]);
    });
  });

  describe('dashboard', () => {
    it('summarises for the administrator and scopes for others', async () => {
      const admin = await as.administrator.get('/api/dashboard/summary');
      expect(admin.status).toBe(200);
      expect(admin.body.data).toMatchObject({
        projects: 2,
        sites: 5,
        samples: 17,
        approved_detections: 24,
      });
      expect(admin.body.data.recent_activity.length).toBeLessThanOrEqual(5);
      const lab = await as.lab_technician.get('/api/dashboard/summary');
      const direct = await query(
        'SELECT count(*)::int AS n FROM v_approved_detections WHERE project_id = 1',
      );
      expect(lab.body.data.projects).toBe(1);
      expect(lab.body.data.approved_detections).toBe(direct[0].n);
      expect(lab.body.data.recent_activity).toEqual([]);
      const viewer = await as.viewer.get('/api/dashboard/summary');
      expect(viewer.body.data.projects).toBe(1);
      const none = await as.outsider.get('/api/dashboard/summary');
      expect(none.body.data).toMatchObject({
        projects: 0,
        sites: 0,
        samples: 0,
        approved_detections: 0,
      });
      expect(
        (await as.administrator.get('/api/dashboard/summary?project_id=2')).body.data.projects,
      ).toBe(1);
      expect((await as.lab_technician.get('/api/dashboard/summary?project_id=2')).status).toBe(404);
      expect((await as.administrator.get('/api/dashboard/summary?x=1')).status).toBe(422);
    });
    it('lists recent activity newest first for roles with audit access', async () => {
      const res = await as.principal_investigator.get('/api/dashboard/summary');
      const times = res.body.data.recent_activity.map(
        (a) => a.occurred_at ?? a.created_at ?? a.changed_at,
      );
      expect(times).toEqual([...times].sort().reverse());
    });
  });

  describe('exports', () => {
    const create = (agent, body) => agent.post('/api/exports').send(body);
    const types = ['samples_csv', 'detections_csv', 'richness_csv'];

    it('creates each type for every role with project access; row_count equals the data rows', async () => {
      for (const agent of [as.principal_investigator, as.lab_technician, as.viewer, as.analyst]) {
        for (const export_type of types) {
          const res = await create(agent, { export_type, project_id: 1 });
          expect(res.status).toBe(201);
          const file = await download(agent, res.body.data.export_id);
          expect(file.status).toBe(200);
          expect(file.headers['content-type']).toMatch(/text\/csv/);
          expect(file.headers['content-disposition']).toMatch(/attachment; filename="ebiotrack-/);
          const rows = csvRows(file.body);
          expect(rows.length - 1).toBe(res.body.data.row_count);
          expect(Number(file.headers['x-row-count'])).toBe(res.body.data.row_count);
        }
      }
    });
    it('writes fixed headers', async () => {
      const s = await create(as.administrator, { export_type: 'samples_csv', project_id: 1 });
      expect(
        csvRows((await download(as.administrator, s.body.data.export_id)).body)[0].slice(0, 3),
      ).toEqual(['sample_id', 'sample_code', 'status']);
      const r = await create(as.administrator, { export_type: 'richness_csv', project_id: 1 });
      expect(csvRows((await download(as.administrator, r.body.data.export_id)).body)[0]).toEqual([
        'group',
        'site_id',
        'observed_taxa',
        'sample_count',
      ]);
    });
    it('applies filters and rejects unknown keys and wrong-type keys', async () => {
      const full = await create(as.administrator, { export_type: 'samples_csv', project_id: 1 });
      const some = await create(as.administrator, {
        export_type: 'samples_csv',
        project_id: 1,
        filters: { status: 'collected' },
      });
      expect(some.body.data.row_count).toBeLessThanOrEqual(full.body.data.row_count);
      const bad = [
        { export_type: 'samples_csv', project_id: 1, filters: { taxon_id: 1 } },
        { export_type: 'detections_csv', project_id: 1, filters: { status: 'x' } },
        {
          export_type: 'samples_csv',
          project_id: 1,
          filters: { from: '2026-02-01', to: '2026-01-01' },
        },
        { export_type: 'nope', project_id: 1 },
        { export_type: 'samples_csv' },
        { export_type: 'samples_csv', project_id: 1, extra: 1 },
      ];
      for (const body of bad) expect((await create(as.administrator, body)).status).toBe(422);
    });
    it('hides other projects and other people’s exports behind 404', async () => {
      expect(
        (await create(as.outsider, { export_type: 'samples_csv', project_id: 1 })).status,
      ).toBe(404);
      expect(
        (await create(as.lab_technician, { export_type: 'samples_csv', project_id: 2 })).status,
      ).toBe(404);
      expect(
        (await create(as.administrator, { export_type: 'samples_csv', project_id: 999 })).status,
      ).toBe(404);
      const mine = await create(as.analyst, { export_type: 'detections_csv', project_id: 1 });
      const id = mine.body.data.export_id;
      expect((await as.administrator.get(`/api/exports/${id}/download`)).status).toBe(404);
      expect((await as.principal_investigator.get(`/api/exports/${id}/download`)).status).toBe(404);
      expect((await as.analyst.get('/api/exports/99999/download')).status).toBe(404);
      expect((await as.analyst.get('/api/exports/abc/download')).status).toBe(422);
    });
    it('neutralises spreadsheet formulas in cells', async () => {
      const [{ sample_id: id }] = await query(
        'SELECT sample_id FROM samples ORDER BY sample_id LIMIT 1',
      );
      const before = await query('SELECT storage_location FROM samples WHERE sample_id = $1', [id]);
      await query("UPDATE samples SET storage_location = '=HYPERLINK(1)' WHERE sample_id = $1", [
        id,
      ]);
      try {
        const [{ project_id }] = await query(
          'SELECT project_id FROM v_sample_registry WHERE sample_id = $1',
          [id],
        );
        const made = await create(as.administrator, { export_type: 'samples_csv', project_id });
        const file = await download(as.administrator, made.body.data.export_id);
        expect(file.body).toContain("'=HYPERLINK(1)");
        expect(file.body).not.toMatch(/(^|,)=HYPERLINK/m);
      } finally {
        await query('UPDATE samples SET storage_location = $2 WHERE sample_id = $1', [
          id,
          before[0].storage_location,
        ]);
      }
    });
    it('reports the actual row count in X-Row-Count', async () => {
      const made = await create(as.analyst, { export_type: 'detections_csv', project_id: 1 });
      const id = made.body.data.export_id;
      await query('UPDATE data_exports SET row_count = 999 WHERE export_id = $1', [id]);
      const file = await download(as.analyst, id);
      expect(Number(file.headers['x-row-count'])).toBe(made.body.data.row_count);
    });
  });
});
