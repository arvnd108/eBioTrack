// Owner: C (Testing & QA)
// Purpose: Leakage, cross-project ids (IDOR), mass assignment and hostile input through the real API
//
// Written from CONTRACT 8-10 and the data rules of section 9: project data is "own", detections
// that are not approved are readable only by administrator, principal_investigator and analyst,
// an export belongs to its requester, and the acting user is always the session user.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  addGlobalRole,
  anonymous,
  assertNo5xx,
  committed,
  loginAll,
  removeGlobalRole,
  restoreIfCommitted,
  setProjectRole,
  sql,
  startApi,
  stopApi,
} from '../setup/api.js';
import { closeTestPool } from '../setup/testDb.js';
import { readFixture } from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');
const PI = 'principal_investigator';
const OTHERS = { administrator: 1, field_researcher: 3, lab_technician: 4, analyst: 5, viewer: 6 };

/** A multipart upload the way a browser sends it. */
function csvForm(analysisId, csv) {
  const form = new FormData();
  form.set('analysis_id', String(analysisId));
  form.set('file', new Blob([csv], { type: 'text/csv' }), 'detections.csv');
  return form;
}
const upload = (c, analysisId, csv = readFixture('detections_valid.csv'), query = '') =>
  c.request('POST', `/api/analyses/import${query}`, undefined, { raw: csvForm(analysisId, csv) });

const count = async (table) => (await sql(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

describe.skipIf(!dbAvailable)('data scope: leakage, IDOR, mass assignment, hostile input', () => {
  let u;

  beforeAll(async () => {
    await startApi();
    u = await loginAll();
  });
  afterEach(() => assertNo5xx());
  afterAll(async () => {
    assertNo5xx();
    await restoreIfCommitted();
    await stopApi();
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------
  describe('IDOR: ids of project 2 are invisible to a member of project 1 only (user 4)', () => {
    it.each([
      ['GET /api/samples/13', '/api/samples/13'],
      ['GET /api/samples/16', '/api/samples/16'],
      ['GET /api/events/7', '/api/events/7'],
      ['GET /api/events/8', '/api/events/8'],
      ['GET /api/qc-results?sample_id=13', '/api/qc-results?sample_id=13'],
      ['GET /api/extractions?sample_id=13', '/api/extractions?sample_id=13'],
    ])('%s -> 404 (or an empty list), never the row', async (_label, path) => {
      const res = await u.lab_technician.get(path);
      if (res.status === 200) {
        expect(res.body.data).toEqual([]);
      } else {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
      }
    });

    it('filters cannot reach across: ?site_id of a project-2 site, ?event_id 7, ?batch_id 3 return no project-2 row', async () => {
      const paths = [
        '/api/samples?site_id=4',
        '/api/samples?event_id=7',
        '/api/events?site_id=5',
        '/api/extractions?batch_id=3',
      ];
      for (const path of paths) {
        const res = await u.lab_technician.get(`${path}&limit=100`);
        expect([200, 404], path).toContain(res.status);
        if (res.status === 200) expect(res.body.data, path).toEqual([]);
      }
    });

    it('the project-1 filter never returns a project-2 id', async () => {
      const samples = await u.lab_technician.get('/api/samples?project_id=1&limit=100');
      const ids = samples.body.data.map((s) => s.sample_id);
      for (const id of [13, 14, 15, 16]) expect(ids).not.toContain(id);
      const events = await u.lab_technician.get('/api/events?project_id=1&limit=100');
      expect(events.body.data.map((e) => e.event_id)).not.toContain(7);
    });

    it('writes aimed at a project-2 row are refused: status change of sample 13, qc for sample 13, library of extraction 13', async () => {
      const before = [await count('sample_status_history'), await count('quality_control_results')];
      await addGlobalRole(4, 'field_researcher');
      const status = await u.lab_technician.patch('/api/samples/13/status', {
        new_status: 'stored',
      });
      await removeGlobalRole(4, 'field_researcher');
      expect(status.status).toBe(404);
      const qc = await u.lab_technician.post('/api/qc-results', {
        sample_id: 13,
        qc_type: 'concentration',
        result: 'pass',
      });
      expect(qc.status).toBe(404);
      const ext = await u.lab_technician.patch('/api/extractions/13', { concentration_ng_ul: 1 });
      expect(ext.status).toBe(404);
      expect([
        await count('sample_status_history'),
        await count('quality_control_results'),
      ]).toEqual(before);
    });

    // CONTRACT GAP (owner: Arvind): sites belong to no project (permissions.js note), so every
    // signed-in user reads every site, including sites linked only to project 2.
    it('sites are global reference data: user 4 reads site 4 (documented behaviour)', async () => {
      const res = await u.lab_technician.get('/api/sites/4');
      expect(res.status).toBe(200);
      expect((await u.lab_technician.get('/api/sites')).body.meta.total).toBe(5);
    });

    // CONTRACT GAP (owner: Arvind): analysis 2 sits on run 2, which holds libraries of both
    // projects. A member of project 1 may read it, and assignment_counts counts every detection
    // of the analysis, project 2's included. The detections themselves are not returned.
    it('an analysis that spans both projects is readable, and exposes no project-2 sample', async () => {
      const res = await u.lab_technician.get('/api/analyses/2');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/EB-2026040[0-9]-000[78]/);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('exports belong to the requester', () => {
    let exportId;

    beforeAll(async () => {
      committed();
      const res = await u.principal_investigator.post('/api/exports', {
        export_type: 'samples_csv',
        project_id: 2,
      });
      expect(res.status).toBe(201);
      exportId = res.body.data.export_id;
    });

    it('the requester downloads a CSV with only the rows of the project', async () => {
      const res = await u.principal_investigator.get(`/api/exports/${exportId}/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/csv/);
      const lines = res.text.trim().split(/\r?\n/);
      const header = lines[0].split(',');
      const col = header.indexOf('project_id');
      expect(col).toBeGreaterThan(-1);
      expect(lines.length - 1).toBe(4); // samples 13-16
      for (const line of lines.slice(1)) expect(line.split(',')[col]).toBe('2');
    });

    it.each([['administrator'], ['field_researcher'], ['lab_technician'], ['analyst'], ['viewer']])(
      '%s is not the requester: 404, the same as an unknown export',
      async (role) => {
        const res = await u[role].get(`/api/exports/${exportId}/download`);
        const unknown = await u[role].get('/api/exports/999999/download');
        expect(res.status).toBe(404);
        expect(res.text).toBe(unknown.text);
      },
    );

    it("a detections export holds only approved, passing detections of the requester's projects", async () => {
      const made = await u.principal_investigator.post('/api/exports', {
        export_type: 'detections_csv',
        project_id: 1,
      });
      expect(made.status).toBe(201);
      const res = await u.principal_investigator.get(
        `/api/exports/${made.body.data.export_id}/download`,
      );
      expect(res.status).toBe(200);
      const [head, ...rows] = res.text.trim().split(/\r?\n/);
      const header = head.split(',');
      const at = (name) => header.indexOf(name);
      const project1Codes = new Set(
        (
          await sql(
            `SELECT s.sample_code FROM samples s JOIN collection_events e ON e.event_id = s.event_id WHERE e.project_id = 1`,
          )
        ).map((r) => r.sample_code),
      );
      expect(rows.length).toBe(made.body.data.row_count);
      expect(Number(res.headers.get('x-row-count'))).toBe(rows.length);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const cells = row.split(',');
        expect(project1Codes.has(cells[at('sample_code')]), row).toBe(true);
        expect(cells[at('qc_flag')]).toBe('pass');
        expect(['1', '2']).toContain(cells[at('analysis_id')]); // the approved analyses; 3 is imported
      }
    });

    it('a requester who left the project gets 404 at download time', async () => {
      const made = await u.lab_technician.post('/api/exports', {
        export_type: 'samples_csv',
        project_id: 1,
      });
      expect(made.status).toBe(201);
      const id = made.body.data.export_id;
      expect((await u.lab_technician.get(`/api/exports/${id}/download`)).status).toBe(200);
      expect((await u.principal_investigator.delete('/api/projects/1/members/4')).status).toBe(204);
      expect((await u.lab_technician.get(`/api/exports/${id}/download`)).status).toBe(404);
      await setProjectRole(1, 4, 'contributor');
      expect((await u.lab_technician.get(`/api/exports/${id}/download`)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('detections that are not approved', () => {
    // Project roles count (CONTRACT 9): contributors of project 1 (users 3-5) read unapproved work
    // through their project role; only the project viewer (user 6) is held back.
    const NO_UNAPPROVED = ['viewer'];
    const MAY_SEE = [
      'administrator',
      'principal_investigator',
      'analyst',
      'field_researcher',
      'lab_technician',
    ];

    it.each(NO_UNAPPROVED)(
      '%s: analysis 3 (imported) and 4 (draft) are 404 and absent from the list',
      async (role) => {
        for (const id of [3, 4]) {
          const res = await u[role].get(`/api/analyses/${id}`);
          expect(res.status, `${role} analysis ${id}`).toBe(404);
          expect(res.body.error.message).toBe(
            (await u[role].get('/api/analyses/999999')).body.error.message,
          );
        }
        const list = await u[role].get('/api/analyses?limit=100');
        expect(list.body.data.map((a) => a.analysis_id).sort()).toEqual([1, 2]);
        expect(list.body.data.every((a) => ['approved', 'superseded'].includes(a.status))).toBe(
          true,
        );
        expect((await u[role].get('/api/analyses?status=imported')).body.data).toEqual([]);
      },
    );

    it.each(MAY_SEE)('%s: sees analyses 3 and 4 with their counts', async (role) => {
      const list = await u[role].get('/api/analyses?limit=100');
      expect(list.body.data.map((a) => a.analysis_id).sort()).toEqual([1, 2, 3, 4]);
      const three = await u[role].get('/api/analyses/3');
      expect(three.status).toBe(200);
      const { pass, warn, fail } = three.body.data.assignment_counts;
      expect(pass + warn + fail).toBeGreaterThan(0);
    });

    it('taxon detections and analytics show approved, passing detections to everyone, never analysis 3', async () => {
      const taxa = await sql(
        `SELECT DISTINCT taxon_id::int AS id FROM taxon_assignments WHERE analysis_id = 3 ORDER BY 1`,
      );
      expect(taxa.length).toBeGreaterThan(0);
      for (const role of Object.keys(OTHERS).concat(PI)) {
        for (const { id } of taxa) {
          const res = await u[role].get(`/api/taxa/${id}/detections?limit=100`);
          expect(res.status, `${role} taxon ${id}`).toBe(200);
          for (const d of res.body.data) {
            expect([1, 2], `${role} taxon ${id}`).toContain(d.analysis_id);
            expect(d.qc_flag).toBe('pass');
          }
        }
      }
    });

    it('richness and the dashboard count the same approved detections for the analyst and the viewer', async () => {
      const viewer = await u.viewer.get('/api/analytics/richness?project_id=1&group_by=site');
      const analyst = await u.analyst.get('/api/analytics/richness?project_id=1&group_by=site');
      expect(analyst.body.data).toEqual(viewer.body.data);
      const a = await u.analyst.get('/api/dashboard/summary?project_id=1');
      const v = await u.viewer.get('/api/dashboard/summary?project_id=1');
      expect(a.body.data.approved_detections).toBe(v.body.data.approved_detections);
      const [{ n }] = await sql(
        `SELECT count(*)::int AS n FROM taxon_assignments ta
           JOIN analysis_runs ar ON ar.analysis_id = ta.analysis_id
          WHERE ar.status = 'approved' AND ta.qc_flag = 'pass'`,
      );
      expect(
        (await u.administrator.get('/api/dashboard/summary')).body.data.approved_detections,
      ).toBe(n);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('privilege escalation and mass assignment', () => {
    it.each(['principal_investigator', 'field_researcher', 'lab_technician', 'analyst', 'viewer'])(
      '%s cannot create users, change roles or flip active (on anyone, themselves included): 403, nothing changes',
      async (role) => {
        const me = u[role].user.user_id;
        const before = await sql(
          `SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM user_roles)::int AS roles,
                  (SELECT count(*) FROM users WHERE active)::int AS active`,
        );
        const attempts = [
          await u[role].post('/api/users', {
            full_name: 'T33 Intruder',
            email: 't33.intruder@ebiotrack.test',
            password: 'T33-correct-horse',
            role_ids: [1],
          }),
          await u[role].patch(`/api/users/${me}`, { role_ids: [1] }),
          await u[role].patch(`/api/users/${me}`, { active: false }),
          await u[role].patch('/api/users/6', { role_ids: [1, 2] }),
          await u[role].patch('/api/users/1', { active: false }),
          await u[role].get('/api/users'),
        ];
        for (const res of attempts) expect(res.status).toBe(403);
        const after = await sql(
          `SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM user_roles)::int AS roles,
                  (SELECT count(*) FROM users WHERE active)::int AS active`,
        );
        expect(after).toEqual(before);
        expect((await u[role].get('/api/auth/me')).body.data.roles).toEqual([role]);
      },
    );

    // Each body names an actor column as an extra key. Every request schema is strict, so the
    // contract-conforming answer is a rejection; if one ever accepts, the stored actor must be the caller.
    const FORGED = [
      [
        'field_researcher',
        'POST',
        '/api/events',
        { project_id: 1, site_id: 1, collected_at: '2026-06-01T09:00:00Z', collector_id: 6 },
        'collection_events',
      ],
      [
        'field_researcher',
        'POST',
        '/api/samples',
        { event_id: 1, sample_type_id: 1, created_by: 6, changed_by: 6 },
        'samples',
      ],
      [
        'field_researcher',
        'PATCH',
        '/api/samples/1/status',
        { new_status: 'discarded', changed_by: 6 },
        'sample_status_history',
      ],
      [
        'lab_technician',
        'POST',
        '/api/qc-results',
        { sample_id: 1, qc_type: 'concentration', result: 'pass', recorded_by: 6 },
        'quality_control_results',
      ],
      [
        'lab_technician',
        'POST',
        '/api/extraction-batches',
        { lab_id: 1, extraction_date: '2026-06-01', operator_id: 6 },
        'extraction_batches',
      ],
      [
        'lab_technician',
        'POST',
        '/api/extractions',
        { sample_id: 1, batch_id: 1, created_by: 6 },
        'dna_extractions',
      ],
      [
        'analyst',
        'POST',
        '/api/analyses',
        {
          run_id: 1,
          marker_id: 1,
          pipeline_name: 'T33',
          pipeline_version: '1',
          reference_db: 'T33',
          imported_by: 6,
        },
        'analysis_runs',
      ],
      [
        'principal_investigator',
        'POST',
        '/api/analyses/3/reject',
        { reason: 'T33', approved_by: 6, actor_id: 6 },
        'analysis_runs',
      ],
      [
        'principal_investigator',
        'POST',
        '/api/projects/1/members',
        { user_id: 1, project_role: 'viewer', actor_id: 6 },
        'project_members',
      ],
      [
        'principal_investigator',
        'POST',
        '/api/exports',
        { export_type: 'samples_csv', project_id: 1, requested_by: 6 },
        'data_exports',
      ],
      [
        'administrator',
        'POST',
        '/api/users',
        {
          full_name: 'T33 Forged',
          email: 't33.forged@ebiotrack.test',
          password: 'T33-correct-horse',
          role_ids: [6],
          user_id: 99,
          active: true,
        },
        'users',
      ],
    ];

    it.each(FORGED)(
      '%s %s %s with an actor key in the body is rejected, nothing is written',
      async (role, method, path, body, table) => {
        const before = await count(table);
        const audit = await count('audit_logs');
        const res = await u[role].request(method, path, body);
        expect([400, 422], `${method} ${path} -> ${res.status}`).toContain(res.status);
        expect(await count(table)).toBe(before);
        expect((await count('audit_logs')) - audit).toBe(0);
      },
    );

    it('with the actor keys removed the same requests succeed and the stored actor is the caller', async () => {
      committed();
      const lastAudit = async (entity) =>
        (
          await sql(
            `SELECT actor_id::int AS actor FROM audit_logs WHERE entity_type = $1 AND action <> 'login' ORDER BY audit_id DESC LIMIT 1`,
            [entity],
          )
        )[0]?.actor;

      const event = await u.field_researcher.post('/api/events', {
        project_id: 1,
        site_id: 1,
        collected_at: '2026-06-01T09:00:00Z',
      });
      expect(event.status).toBe(201);
      expect(event.body.data.collector_id).toBe(3);
      expect(await lastAudit('collection_events')).toBe(3);

      const qc = await u.lab_technician.post('/api/qc-results', {
        sample_id: 1,
        qc_type: 'concentration',
        result: 'pass',
      });
      expect(qc.status).toBe(201);
      expect(qc.body.data.recorded_by).toBe(4);

      const batch = await u.lab_technician.post('/api/extraction-batches', {
        lab_id: 1,
        extraction_date: '2026-06-01',
      });
      expect(batch.status).toBe(201);
      expect(batch.body.data.operator_id).toBe(4);

      const exp = await u.principal_investigator.post('/api/exports', {
        export_type: 'samples_csv',
        project_id: 1,
      });
      expect(exp.status).toBe(201);
      const [{ requested_by }] = await sql(
        'SELECT requested_by::int AS requested_by FROM data_exports WHERE export_id = $1',
        [exp.body.data.export_id],
      );
      expect(requested_by).toBe(2);

      const sample = await u.field_researcher.patch('/api/samples/1/status', {
        new_status: 'discarded',
      });
      if (sample.status === 200) expect(await lastAudit('samples')).toBe(3);
    });

    it('a password never comes back, not even to the administrator creating the account', async () => {
      committed();
      const res = await u.administrator.post('/api/users', {
        full_name: 'T33 Created',
        email: 't33.created@ebiotrack.test',
        password: 'T33-correct-horse',
        role_ids: [6],
      });
      expect(res.status).toBe(201);
      expect(Object.keys(res.body.data).sort()).toEqual([
        'active',
        'email',
        'full_name',
        'roles',
        'user_id',
      ]);
      const list = await u.administrator.get('/api/users?limit=100');
      expect(list.text).not.toMatch(/password|\$2[aby]\$/);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('approver rule (D17) through the API', () => {
    it('the importer cannot approve their own import, even holding the PI role; a different PI can', async () => {
      committed();
      const dry = await upload(u.analyst, 4, readFixture('detections_valid.csv'), '?dry_run=true');
      expect(dry.status).toBe(200);
      expect(dry.body.data.errors).toEqual([]);

      const imported = await upload(u.analyst, 4);
      expect(imported.status).toBe(201);
      expect(imported.body.data.inserted).toBe(14);
      const [{ imported_by, status }] = await sql(
        'SELECT imported_by::int AS imported_by, status FROM analysis_runs WHERE analysis_id = 4',
      );
      expect({ imported_by, status }).toEqual({ imported_by: 5, status: 'imported' });

      // as a plain analyst the role gate answers first
      expect((await u.analyst.post('/api/analyses/4/approve')).status).toBe(403);

      await addGlobalRole(5, PI);
      await setProjectRole(1, 5, 'contributor');
      const own = await u.analyst.post('/api/analyses/4/approve');
      expect(own.status).toBe(422);
      expect(own.body.error.code).toBe('rule_violation');
      const [still] = await sql(
        'SELECT status, approved_by FROM analysis_runs WHERE analysis_id = 4',
      );
      expect(still).toEqual({ status: 'imported', approved_by: null });
      await removeGlobalRole(5, PI);

      const other = await u.principal_investigator.post('/api/analyses/4/approve');
      expect(other.status).toBe(200);
      expect(other.body.data).toMatchObject({ status: 'approved', approved_by: 2, imported_by: 5 });
    });

    it('an approved analysis cannot be approved or rejected again: 409, no new audit row', async () => {
      const audit = await count('audit_logs');
      const again = await u.principal_investigator.post('/api/analyses/4/approve');
      expect(again.status).toBe(409);
      const reject = await u.principal_investigator.post('/api/analyses/4/reject', {
        reason: 'too late',
      });
      expect(reject.status).toBe(409);
      expect(await count('audit_logs')).toBe(audit);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('hostile input never reaches a 5xx', () => {
    const IDS = [
      'abc',
      '-1',
      '0',
      '1.5',
      '99999999999999999999',
      '1%20OR%201=1',
      'a'.repeat(5000),
      '__proto__',
      '%00',
      '1;DROP%20TABLE%20users',
      '%27%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    ];
    const ID_ROUTES = [
      '/api/projects/',
      '/api/samples/',
      '/api/events/',
      '/api/sites/',
      '/api/taxa/',
      '/api/taxa/%ID%/detections',
      '/api/analyses/',
      '/api/sequencing-runs/',
      '/api/exports/%ID%/download',
      '/api/users/',
    ];
    const withId = (route, id) =>
      route.includes('%ID%') ? route.replace('%ID%', id) : `${route}${id}`;

    it.each(ID_ROUTES.flatMap((r) => IDS.map((id) => [`${r} ${id.slice(0, 24)}`, r, id])))(
      'GET %s -> 400/404/422 as JSON',
      async (_n, route, id) => {
        for (const role of ['administrator', 'viewer']) {
          const res = await u[role].get(withId(route, id));
          expect([400, 403, 404, 422], `${role} ${route}`).toContain(res.status);
          expect(res.headers.get('content-type')).toMatch(/application\/json/);
          expect(res.text).not.toMatch(/<script|<html/i);
        }
      },
    );

    it.each([
      ['PATCH', '/api/projects/'],
      ['PATCH', '/api/sites/'],
      ['PATCH', '/api/samples/%ID%/status'],
      ['POST', '/api/analyses/%ID%/approve'],
      ['POST', '/api/analyses/%ID%/reject'],
      ['PATCH', '/api/sequencing-runs/'],
      ['PATCH', '/api/extractions/'],
    ])('%s %s with hostile ids changes nothing and answers 4xx', async (method, route) => {
      const audit = await count('audit_logs');
      for (const id of IDS) {
        const res = await u.administrator.request(method, withId(route, id), {
          reason: 'x',
          new_status: 'stored',
          status: 'failed',
          objectives: 'x',
          name: 'x',
        });
        expect(res.status, `${method} ${route} ${id.slice(0, 20)}`).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
      expect(await count('audit_logs')).toBe(audit);
    });

    const QUERY_VALUES = [
      "'",
      "' OR '1'='1",
      '1; DROP TABLE users;--',
      '%',
      '_',
      '\\',
      '<script>alert(1)</script>',
      'a'.repeat(3000),
      '%00',
      '${7*7}',
      '../../etc/passwd',
    ];
    const LIST_ROUTES = [
      '/api/samples',
      '/api/projects',
      '/api/events',
      '/api/taxa',
      '/api/analyses',
      '/api/extractions',
      '/api/qc-results',
      '/api/sequencing-runs',
      '/api/sites',
      '/api/audit',
      '/api/users',
    ];

    it.each(LIST_ROUTES)(
      '%s: SQL metacharacters in q, status, sort and habitat_type give 4xx or a plain list, never 5xx',
      async (route) => {
        const usersBefore = await count('users');
        for (const value of QUERY_VALUES) {
          const v = encodeURIComponent(value);
          for (const param of ['q', 'status', 'sort', 'habitat_type', 'rank', 'entity_type']) {
            const res = await u.administrator.get(`${route}?${param}=${v}`);
            expect(res.status, `${route}?${param}`).toBeLessThan(500);
            expect(res.headers.get('content-type')).toMatch(/application\/json/);
          }
        }
        expect(await count('users')).toBe(usersBefore);
      },
    );

    // DEFECT: GET /api/samples?page=99999999999999999999 answers 500 (OFFSET overflows bigint) instead of
    // 400/422 or a clamp (owner: A). The afterEach 5xx guard also trips, which is what keeps this red-by-design.
    it.fails('a page number beyond bigint is 400/422 or clamped, not a 500', async () => {
      const res = await u.administrator.get('/api/samples?page=99999999999999999999');
      expect(res.status).toBeLessThan(500);
    });

    it('huge, negative and non-numeric page and limit values are 400/422 or clamped, never 5xx', async () => {
      for (const q of [
        'page=-1',
        'page=0',
        'page=abc',
        'limit=1000000',
        'limit=-5',
        'limit=0',
        'limit=1e9',
        'page=1&limit=101',
        'page[]=1',
        'limit=1&limit=2',
      ]) {
        const res = await u.administrator.get(`/api/samples?${q}`);
        expect(res.status, q).toBeLessThan(500);
        if (res.status === 200) expect(res.body.meta.limit).toBeLessThanOrEqual(100);
      }
    });

    it('wrong content type, invalid JSON, JSON that is not an object and an oversized body are 4xx', async () => {
      const pi = u.principal_investigator;
      const cases = [
        [
          { raw: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
          [400, 415, 422],
        ],
        [{ raw: '{"title": "x"}', headers: { 'content-type': 'text/plain' } }, [400, 415, 422]],
        [{ raw: '{"title": ', headers: { 'content-type': 'application/json' } }, [400]],
        [{ raw: '[1,2,3]', headers: { 'content-type': 'application/json' } }, [400, 422]],
        [{ raw: '"just a string"', headers: { 'content-type': 'application/json' } }, [400, 422]],
        [{ raw: 'null', headers: { 'content-type': 'application/json' } }, [400, 422]],
        [
          {
            raw: JSON.stringify({ title: 'x'.repeat(2_000_000) }),
            headers: { 'content-type': 'application/json' },
          },
          [413],
        ],
        [
          {
            raw: '{"__proto__": {"admin": true}, "title": "T33 proto"}',
            headers: { 'content-type': 'application/json' },
          },
          [400, 422],
        ],
        [
          { raw: '{"a":'.repeat(5000), headers: { 'content-type': 'application/json' } },
          [400, 413],
        ],
      ];
      for (const [opts, expected] of cases) {
        const res = await pi.request('POST', '/api/projects', undefined, opts);
        expect(expected, `${opts.raw.slice(0, 30)} -> ${res.status}`).toContain(res.status);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(res.body.error).toBeDefined();
      }
      expect(await sql("SELECT 1 FROM projects WHERE title LIKE 'T33%'")).toEqual([]);
    });

    it('an unauthenticated hostile request is a 401/404 JSON envelope, not a crash', async () => {
      for (const path of [
        '/api/projects/__proto__',
        '/api/samples?q=%27',
        '/%2e%2e/%2e%2e/etc/passwd',
        '/api//projects',
        '/api/projects/1/../2',
      ]) {
        const res = await anonymous().get(path);
        expect([401, 404], path).toContain(res.status);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
      }
    });

    it('an upload that is not a CSV, is empty or has the wrong field name is a 4xx and imports nothing', async () => {
      const before = await count('taxon_assignments');
      const bad = [
        upload(u.administrator, 4, ''),
        upload(u.administrator, 4, '\u0000\u0001\u0002 not a csv'),
        upload(u.administrator, 4, 'a,b,c\n1,2,3\n'),
        upload(u.administrator, 4, '<?xml version="1.0"?><a/>'),
        u.administrator.request('POST', '/api/analyses/import', undefined, {
          raw: 'plain text',
          headers: { 'content-type': 'text/plain' },
        }),
      ];
      for (const res of await Promise.all(bad)) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
      expect(await count('taxon_assignments')).toBe(before);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('verbs and method overrides', () => {
    it.each([
      ['PUT', '/api/projects/1'],
      ['DELETE', '/api/projects/1'],
      ['DELETE', '/api/samples/1'],
      ['PUT', '/api/samples/1/status'],
      ['DELETE', '/api/events/1'],
      ['PATCH', '/api/events/1'],
      ['DELETE', '/api/analyses/1'],
      ['PUT', '/api/analyses/1'],
      ['PATCH', '/api/analyses/1'],
      ['DELETE', '/api/users/6'],
      ['PUT', '/api/users/6'],
      ['DELETE', '/api/sites/1'],
      ['DELETE', '/api/sequencing-runs/1'],
      ['DELETE', '/api/exports/1'],
      ['POST', '/api/audit'],
      ['DELETE', '/api/audit'],
      ['PUT', '/api/auth/me'],
    ])(
      'administrator %s %s -> 404/405 JSON, not a success, nothing deleted',
      async (method, path) => {
        const projects = await count('projects');
        const samples = await count('samples');
        const res = await u.administrator.request(
          method,
          path,
          ['PUT', 'POST', 'PATCH'].includes(method) ? {} : undefined,
        );
        expect([404, 405], `${method} ${path}`).toContain(res.status);
        expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
        expect([await count('projects'), await count('samples')]).toEqual([projects, samples]);
      },
    );

    it('X-HTTP-Method-Override and _method are ignored', async () => {
      const projects = await count('projects');
      const viaHeader = await u.administrator.post(
        '/api/projects/1',
        {},
        { headers: { 'x-http-method-override': 'DELETE' } },
      );
      expect([404, 405]).toContain(viaHeader.status);
      const viaQuery = await u.administrator.post('/api/projects/1?_method=DELETE', {});
      expect([404, 405]).toContain(viaQuery.status);
      expect(await count('projects')).toBe(projects);
    });
  });
});
