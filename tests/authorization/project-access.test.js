// Owner: C (Testing & QA)
// Purpose: Unauthorized users cannot read or edit restricted projects
//
// Project scoping and project roles through the real API, written from CONTRACT 8 ("project data
// of a project the user is not a member of returns 404"), 9 ("own", project role viewer is
// read-only, owner/manager edit) and 10. Fixture world (CONTRACT 6): user 2 owns projects 1 and 2;
// user 3 contributes to both; users 4 and 5 contribute to project 1; user 6 is a viewer of project
// 1; user 1 (administrator) is a member of nothing.
//
// Cookies: each user logs in once in beforeAll. reseed() (afterAll) is the only cleanup; it kills
// the cookies, so nothing here reseeds mid-file. Mutations are undone by hand where a later test
// needs the seeded memberships.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  SEED,
  addGlobalRole,
  assertNo5xx,
  committed,
  login,
  loginAll,
  removeGlobalRole,
  restoreIfCommitted,
  setProjectRole,
  sql,
  startApi,
  stopApi,
} from '../setup/api.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

const NON_MEMBERS = ['lab_technician', 'analyst', 'viewer']; // users 4, 5, 6: project 1 only
const PI = 'principal_investigator';

/** CONTRACT 6: project memberships of the seeded world. */
const PROJECTS_OF = {
  administrator: [1, 2], // sees every project without being a member
  principal_investigator: [1, 2],
  field_researcher: [1, 2],
  lab_technician: [1],
  analyst: [1],
  viewer: [1],
};

const notFoundBody = (res) => ({
  status: res.status,
  code: res.body?.error?.code,
  message: res.body?.error?.message,
});

describe.skipIf(!dbAvailable)('project access: scoping and project roles', () => {
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
  describe('non-members get 404, not 403, on every project-scoped read', () => {
    // [label, path] - every route that carries a project id the caller does not belong to
    const READS = (id) => [
      ['GET project', `/api/projects/${id}`],
      ['GET events of the project', `/api/events?project_id=${id}`],
      ['GET samples of the project', `/api/samples?project_id=${id}`],
      ['GET richness of the project', `/api/analytics/richness?project_id=${id}`],
      ['GET detection frequency', `/api/analytics/detection-frequency?taxon_id=1&project_id=${id}`],
      ['GET dashboard of the project', `/api/dashboard/summary?project_id=${id}`],
      ['GET taxon detections of the project', `/api/taxa/1/detections?project_id=${id}`],
    ];

    it.each(NON_MEMBERS.flatMap((role) => READS(2).map(([label, path]) => [role, label, path])))(
      '%s: %s of project 2 -> 404 not_found',
      async (role, _label, path) => {
        const res = await u[role].get(path);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
      },
    );

    it.each(NON_MEMBERS.flatMap((role) => READS(1).map(([label, path]) => [role, label, path])))(
      '%s: %s of project 1 -> 200 (the control: they are members of project 1)',
      async (role, _label, path) => {
        const res = await u[role].get(path);
        expect(res.status).toBe(200);
      },
    );

    it.each(NON_MEMBERS)(
      '%s: an export for project 2 -> 404, for project 1 -> 201',
      async (role) => {
        const denied = await u[role].post('/api/exports', {
          export_type: 'samples_csv',
          project_id: 2,
        });
        expect(denied.status).toBe(404);
        expect(denied.body.error.code).toBe('not_found');
        const own = await u[role].post('/api/exports', {
          export_type: 'samples_csv',
          project_id: 1,
        });
        expect(own.status).toBe(201);
      },
    );

    it('the 404 of an existing-but-forbidden project and of a missing one are identical (no existence oracle)', async () => {
      for (const role of NON_MEMBERS) {
        for (const [label, forbidden] of READS(2)) {
          const missing = READS(999999).find(([l]) => l === label)[1];
          const a = await u[role].get(forbidden);
          const b = await u[role].get(missing);
          expect(notFoundBody(a), `${role} ${label}`).toEqual(notFoundBody(b));
          expect(a.text).toBe(b.text);
        }
        const post = { export_type: 'samples_csv' };
        const x = await u[role].post('/api/exports', { ...post, project_id: 2 });
        const y = await u[role].post('/api/exports', { ...post, project_id: 999999 });
        expect(x.text).toBe(y.text);
      }
    });

    it('rows reached by id behave the same: event 7 / sample 13 (project 2) answer like a missing id', async () => {
      for (const role of NON_MEMBERS) {
        const pairs = [
          ['/api/events/7', '/api/events/999999'],
          ['/api/events/8', '/api/events/999999'],
          ['/api/samples/13', '/api/samples/999999'],
          ['/api/samples/16', '/api/samples/999999'],
        ];
        for (const [real, missing] of pairs) {
          const a = await u[role].get(real);
          const b = await u[role].get(missing);
          expect(a.status, `${role} ${real}`).toBe(404);
          expect(a.text).toBe(b.text);
        }
      }
    });

    it('the administrator, a member of nothing, reads both projects; a missing project is still 404', async () => {
      expect((await u.administrator.get('/api/projects/1')).status).toBe(200);
      expect((await u.administrator.get('/api/projects/2')).status).toBe(200);
      expect((await u.administrator.get('/api/projects/999999')).status).toBe(404);
      expect((await u.administrator.get('/api/events?project_id=2')).status).toBe(200);
      expect((await u.administrator.get('/api/events?project_id=999999')).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('non-members cannot edit: 404 from the project gate once the global role allows it', () => {
    // The global gate answers first (403), so give users 4-6 the principal_investigator role to
    // prove it is the *project* check that stops them.
    beforeAll(async () => {
      for (const id of [4, 5, 6]) await addGlobalRole(id, PI);
    });
    afterAll(async () => {
      for (const id of [4, 5, 6]) await removeGlobalRole(id, PI);
    });

    const WRITES = [
      ['PATCH project', (c) => c.patch('/api/projects/2', { objectives: 'T33' })],
      [
        'POST member',
        (c) => c.post('/api/projects/2/members', { user_id: 1, project_role: 'viewer' }),
      ],
      ['DELETE member', (c) => c.delete('/api/projects/2/members/3')],
      ['POST site', (c) => c.post('/api/projects/2/sites', { site_id: 1 })],
      ['DELETE site', (c) => c.delete('/api/projects/2/sites/4')],
    ];

    it.each(NON_MEMBERS.flatMap((role) => WRITES.map(([label, call]) => [role, label, call])))(
      '%s + principal_investigator: %s on project 2 -> 404, nothing changed',
      async (role, _label, call) => {
        const before = await sql(
          `SELECT (SELECT count(*) FROM project_members WHERE project_id = 2)::int AS members,
                  (SELECT count(*) FROM project_sites WHERE project_id = 2)::int AS sites,
                  (SELECT objectives FROM projects WHERE project_id = 2) AS objectives`,
        );
        const res = await call(u[role]);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
        const after = await sql(
          `SELECT (SELECT count(*) FROM project_members WHERE project_id = 2)::int AS members,
                  (SELECT count(*) FROM project_sites WHERE project_id = 2)::int AS sites,
                  (SELECT objectives FROM projects WHERE project_id = 2) AS objectives`,
        );
        expect(after).toEqual(before);
      },
    );

    it('the same call on a project that does not exist is the identical 404', async () => {
      const real = await u.lab_technician.patch('/api/projects/2', { objectives: 'T33' });
      const missing = await u.lab_technician.patch('/api/projects/999999', { objectives: 'T33' });
      expect(real.text).toBe(missing.text);
    });

    it('a principal_investigator who is not a member of the project cannot edit it, the administrator can', async () => {
      // user 4 (now PI) belongs to project 1 only
      expect(
        (await u.lab_technician.patch('/api/projects/2', { objectives: 'by a stranger' })).status,
      ).toBe(404);
      const [{ objectives }] = await sql('SELECT objectives FROM projects WHERE project_id = 2');
      expect(objectives).not.toBe('by a stranger');
      committed();
      const admin = await u.administrator.patch('/api/projects/2', {
        objectives: 'edited by the administrator',
      });
      expect(admin.status).toBe(200);
      expect(admin.body.data.objectives).toBe('edited by the administrator');
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("list endpoints are scoped to the caller's projects", () => {
    it.each(Object.entries(PROJECTS_OF))(
      'GET /api/projects as %s lists exactly its projects',
      async (role, ids) => {
        const res = await u[role].get('/api/projects');
        expect(res.status).toBe(200);
        expect(res.body.data.map((p) => p.project_id).sort()).toEqual(ids);
        expect(res.body.meta.total).toBe(ids.length);
        // re-derived from the memberships in the database
        const rows = await sql(
          role === 'administrator'
            ? 'SELECT project_id::int AS id FROM projects ORDER BY 1'
            : 'SELECT project_id::int AS id FROM project_members WHERE user_id = $1 ORDER BY 1',
          role === 'administrator' ? [] : [SEED[role].user_id],
        );
        expect(rows.map((r) => r.id)).toEqual(ids);
      },
    );

    it.each(Object.entries(PROJECTS_OF))(
      '?status= never widens the list (%s)',
      async (role, ids) => {
        const active = await u[role].get('/api/projects?status=active');
        expect(active.body.data.map((p) => p.project_id).sort()).toEqual(ids);
        for (const status of ['planned', 'completed', 'archived']) {
          const res = await u[role].get(`/api/projects?status=${status}`);
          expect(res.body.data, `${role} ${status}`).toEqual([]);
          expect(res.body.meta.total).toBe(0);
        }
      },
    );

    it("your_role in the project list is the caller's own role", async () => {
      const mine = async (role) =>
        Object.fromEntries(
          (await u[role].get('/api/projects')).body.data.map((p) => [p.project_id, p.your_role]),
        );
      expect(await mine('principal_investigator')).toEqual({ 1: 'owner', 2: 'owner' });
      expect(await mine('field_researcher')).toEqual({ 1: 'contributor', 2: 'contributor' });
      expect(await mine('viewer')).toEqual({ 1: 'viewer' });
      expect((await mine('administrator'))[1]).not.toBe('owner');
    });

    // samples of project 2 are 13-16 (events 7 and 8); project 1 holds 13 of the 17 (CONTRACT 6)
    it.each(['lab_technician', 'analyst', 'viewer'])(
      '%s: samples, events, extractions and QC never include project 2',
      async (role) => {
        const samples = await u[role].get('/api/samples?limit=100');
        expect(samples.body.meta.total).toBe(13);
        expect(
          samples.body.data.map((s) => s.sample_id).filter((id) => id >= 13 && id <= 16),
        ).toEqual([]);
        const events = await u[role].get('/api/events?limit=100');
        expect(events.body.data.map((e) => e.event_id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
        expect(events.body.data.every((e) => e.project_id === 1)).toBe(true);
        const extractions = await u[role].get('/api/extractions?limit=100');
        expect(extractions.body.meta.total).toBe(13);
        expect(extractions.body.data.every((x) => x.project_id === 1)).toBe(true);
        const qc = await u[role].get('/api/qc-results?limit=100');
        const hidden = await sql(
          `SELECT count(*)::int AS n FROM quality_control_results q
           JOIN samples s ON s.sample_id = q.sample_id
           JOIN collection_events e ON e.event_id = s.event_id
          WHERE e.project_id = 2`,
        );
        expect(hidden[0].n).toBeGreaterThan(0);
        expect(qc.body.meta.total).toBe(23 - hidden[0].n);
      },
    );

    it('the unfiltered counts of a project-1-only user equal the administrator filtered to project 1', async () => {
      const admin = await u.administrator.get('/api/dashboard/summary?project_id=1');
      const all = await u.administrator.get('/api/dashboard/summary');
      expect(all.body.data).toMatchObject({ projects: 2, sites: 5, samples: 17 });
      for (const role of NON_MEMBERS) {
        const mine = await u[role].get('/api/dashboard/summary');
        for (const k of ['projects', 'sites', 'samples', 'approved_detections']) {
          expect(mine.body.data[k], `${role} ${k}`).toBe(admin.body.data[k]);
        }
        expect(mine.body.data.samples).toBe(13);
        expect(mine.body.data.projects).toBe(1);
      }
    });

    it("sequencing runs and libraries show only the caller's projects (run 2 spans both projects)", async () => {
      const runs = await u.lab_technician.get('/api/sequencing-runs');
      expect(runs.status).toBe(200);
      const run2 = await u.lab_technician.get('/api/sequencing-runs/2');
      expect(run2.status).toBe(200);
      expect(run2.body.data.libraries.every((l) => l.project_id === 1)).toBe(true);
      expect(run2.body.data.libraries.map((l) => l.library_id).sort((a, b) => a - b)).toEqual([
        9, 10, 11, 12,
      ]);
      const full = await u.administrator.get('/api/sequencing-runs/2');
      expect(full.body.data.libraries).toHaveLength(8);
    });

    // CONTRACT GAP (owner: Arvind): extraction batches carry no project. Batch 3 holds only
    // project-2 extractions, yet GET /api/extraction-batches lists all three batches to a
    // project-1-only user. Section 9 says lab data is "own" but does not say how a batch is owned.
    it('extraction batches are listed globally (documented behaviour, see CONTRACT GAP above)', async () => {
      const res = await u.lab_technician.get('/api/extraction-batches');
      expect(res.body.meta.total).toBe(3);
      expect(JSON.stringify(res.body)).not.toMatch(/EB-2026040[0-9]-000[78]/); // no project-2 sample codes
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('project roles apply whatever the global role is', () => {
    // A write per project-scoped route, each with a body that is VALID, so it reaches the check
    // that decides (a validation error would hide a missing check behind a 422).
    const WRITES = [
      [
        'POST /api/events',
        (c) =>
          c.post('/api/events', {
            project_id: 1,
            site_id: 1,
            collected_at: '2026-06-01T09:00:00Z',
          }),
      ],
      ['POST /api/samples', (c) => c.post('/api/samples', { event_id: 1, sample_type_id: 1 })],
      [
        'PATCH /api/samples/:id/status',
        (c) => c.patch('/api/samples/1/status', { new_status: 'discarded' }),
      ],
      ['POST /api/extractions', (c) => c.post('/api/extractions', { sample_id: 1, batch_id: 1 })],
      [
        'PATCH /api/extractions/:id',
        (c) => c.patch('/api/extractions/1', { concentration_ng_ul: 12.5 }),
      ],
      [
        'POST /api/qc-results',
        (c) =>
          c.post('/api/qc-results', { sample_id: 1, qc_type: 'concentration', result: 'pass' }),
      ],
      [
        'POST /api/sequencing-runs',
        (c) =>
          c.post('/api/sequencing-runs', {
            lab_id: 1,
            platform: 'T33',
            run_date: '2026-06-01',
            extraction_ids: [1],
          }),
      ],
      [
        'POST /api/sequencing-runs/:id/libraries',
        (c) => c.post('/api/sequencing-runs/1/libraries', { extraction_id: 1 }),
      ],
      [
        'PATCH /api/sequencing-runs/:id',
        (c) => c.patch('/api/sequencing-runs/1', { status: 'failed' }),
      ],
      [
        'POST /api/analyses',
        (c) =>
          c.post('/api/analyses', {
            run_id: 1,
            marker_id: 1,
            pipeline_name: 'T33',
            pipeline_version: '1',
            reference_db: 'T33',
          }),
      ],
      ['POST /api/analyses/:id/approve', (c) => c.post('/api/analyses/3/approve')],
      ['POST /api/analyses/:id/reject', (c) => c.post('/api/analyses/3/reject', { reason: 'T33' })],
      ['PATCH /api/projects/:id', (c) => c.patch('/api/projects/1', { objectives: 'T33' })],
      [
        'POST /api/projects/:id/members',
        (c) => c.post('/api/projects/1/members', { user_id: 1, project_role: 'viewer' }),
      ],
      ['DELETE /api/projects/:id/members/:userId', (c) => c.delete('/api/projects/1/members/5')],
      ['POST /api/projects/:id/sites', (c) => c.post('/api/projects/1/sites', { site_id: 4 })],
      ['DELETE /api/projects/:id/sites/:siteId', (c) => c.delete('/api/projects/1/sites/3')],
    ];

    describe('viewer of project 1 (user 6) holding every write-capable global role', () => {
      beforeAll(async () => {
        for (const role of [PI, 'field_researcher', 'lab_technician', 'analyst']) {
          await addGlobalRole(6, role);
        }
      });
      afterAll(async () => {
        for (const role of [PI, 'field_researcher', 'lab_technician', 'analyst']) {
          await removeGlobalRole(6, role);
        }
      });

      it.each(WRITES)(
        '%s -> 403 forbidden (the project role blocks, the global role would allow)',
        async (_label, call) => {
          const before = await sql(
            `SELECT (SELECT count(*) FROM audit_logs WHERE action <> 'login')::int AS n`,
          );
          const res = await call(u.viewer);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('forbidden');
          const after = await sql(
            `SELECT (SELECT count(*) FROM audit_logs WHERE action <> 'login')::int AS n`,
          );
          expect(after[0].n).toBe(before[0].n); // no write reached the database
        },
      );

      it('reads stay open to the same user', async () => {
        for (const path of [
          '/api/projects/1',
          '/api/samples?project_id=1',
          '/api/events?project_id=1',
          '/api/sequencing-runs',
        ]) {
          expect((await u.viewer.get(path)).status, path).toBe(200);
        }
      });

      it('the project viewer may still request an export (an export is a read)', async () => {
        const res = await u.viewer.post('/api/exports', {
          export_type: 'samples_csv',
          project_id: 1,
        });
        expect(res.status).toBe(201);
      });
    });

    describe('contributor of project 1 (user 3) with principal_investigator added', () => {
      beforeAll(() => addGlobalRole(3, PI));
      afterAll(() => removeGlobalRole(3, PI));

      it.each(WRITES.filter(([label]) => /projects/.test(label)))(
        '%s -> 403: a contributor cannot edit the project, its members or its sites',
        async (_label, call) => {
          const res = await call(u.field_researcher);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('forbidden');
        },
      );

      it('but can do the data work the global role allows (event with a sample and a measurement)', async () => {
        committed();
        const res = await u.field_researcher.post('/api/events', {
          project_id: 1,
          site_id: 1,
          collected_at: '2026-06-01T09:00:00Z',
          notes: 'T33 contributor event',
          measurements: [{ parameter: 'ph', value: 7.1, unit: 'pH' }],
          samples: [{ sample_type_id: 1, volume_ml: 500 }],
        });
        expect(res.status).toBe(201);
        expect(res.body.data.project_id).toBe(1);
        expect(res.body.data.collector_id).toBe(3);
      });
    });

    describe('manager (a new principal_investigator added to project 1 by the owner through the API)', () => {
      let manager;
      let managerId;
      let guestId;

      beforeAll(async () => {
        committed();
        const create = async (name) =>
          u.administrator.post('/api/users', {
            full_name: name,
            email: `${name.toLowerCase().replace(/\s+/g, '.')}@ebiotrack.test`,
            password: 'T33-correct-horse-battery',
            role_ids: [2],
          });
        const m = await create('T33 Manager');
        const g = await create('T33 Guest');
        expect([m.status, g.status]).toEqual([201, 201]);
        managerId = m.body.data.user_id;
        guestId = g.body.data.user_id;
        const add = await u.principal_investigator.post('/api/projects/1/members', {
          user_id: managerId,
          project_role: 'manager',
        });
        expect(add.status).toBe(201);
        manager = await login('t33.manager@ebiotrack.test', 'T33-correct-horse-battery');
      });

      it('the owner added the manager through the API and the membership says manager', async () => {
        const [row] = await sql(
          'SELECT project_role FROM project_members WHERE project_id = 1 AND user_id = $1',
          [managerId],
        );
        expect(row.project_role).toBe('manager');
        const project = await manager.get('/api/projects/1');
        expect(project.body.data.your_role).toBe('manager');
      });

      it('can edit the project, add and remove members and sites', async () => {
        const edit = await manager.patch('/api/projects/1', {
          objectives: 'edited by the manager',
        });
        expect(edit.status).toBe(200);
        expect(edit.body.data.objectives).toBe('edited by the manager');
        const add = await manager.post('/api/projects/1/members', {
          user_id: guestId,
          project_role: 'viewer',
        });
        expect(add.status).toBe(201);
        expect((await manager.delete(`/api/projects/1/members/${guestId}`)).status).toBe(204);
        expect((await manager.post('/api/projects/1/sites', { site_id: 4 })).status).toBe(201);
        expect((await manager.delete('/api/projects/1/sites/4')).status).toBe(204);
      });

      it("cannot remove the owner, add a second owner, or change the owner's role", async () => {
        const remove = await manager.delete('/api/projects/1/members/2');
        expect([409, 422]).toContain(remove.status);
        expect(remove.body.error.code).toBe('rule_violation');
        const second = await manager.post('/api/projects/1/members', {
          user_id: guestId,
          project_role: 'owner',
        });
        expect([409, 422]).toContain(second.status);
        // re-adding the owner under a different role is a duplicate, never a demotion
        const demote = await manager.post('/api/projects/1/members', {
          user_id: 2,
          project_role: 'viewer',
        });
        expect([409, 422]).toContain(demote.status);
        const owners = await sql(
          "SELECT user_id::int AS id FROM project_members WHERE project_id = 1 AND project_role = 'owner'",
        );
        expect(owners).toEqual([{ id: 2 }]);
      });

      it('has no authority over project 2 (not a member): 404', async () => {
        expect((await manager.patch('/api/projects/2', { objectives: 'T33' })).status).toBe(404);
      });
    });

    describe('owner', () => {
      it('has full project edit; the owner cannot be removed even by the owner', async () => {
        committed();
        const owner = u.principal_investigator;
        expect(
          (await owner.patch('/api/projects/2', { objectives: 'owner edit', status: 'active' }))
            .status,
        ).toBe(200);
        expect((await owner.delete('/api/projects/2/members/2')).status).toBe(422);
      });

      it('exactly one owner: adding a second owner member is refused (409/422), never a 500', async () => {
        const res = await u.principal_investigator.post('/api/projects/1/members', {
          user_id: 5,
          project_role: 'owner',
        });
        expect([409, 422]).toContain(res.status);
        expect(res.status).toBeLessThan(500);
        const [{ n }] = await sql(
          "SELECT count(*)::int AS n FROM project_members WHERE project_id = 1 AND project_role = 'owner'",
        );
        expect(n).toBe(1);
      });

      it('a duplicate membership is a 409 duplicate', async () => {
        const res = await u.principal_investigator.post('/api/projects/1/members', {
          user_id: 5,
          project_role: 'viewer',
        });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('duplicate');
      });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('changing membership changes access immediately', () => {
    it('removed from project 1 -> the next request is 404; re-added as viewer -> reads work, writes are 403', async () => {
      committed();
      expect((await u.lab_technician.get('/api/projects/1')).status).toBe(200);
      expect((await u.principal_investigator.delete('/api/projects/1/members/4')).status).toBe(204);
      for (const path of [
        '/api/projects/1',
        '/api/samples?project_id=1',
        '/api/events?project_id=1',
      ]) {
        expect((await u.lab_technician.get(path)).status, path).toBe(404);
      }
      expect((await u.lab_technician.get('/api/samples')).body.meta.total).toBe(0);
      const back = await u.principal_investigator.post('/api/projects/1/members', {
        user_id: 4,
        project_role: 'viewer',
      });
      expect(back.status).toBe(201);
      expect((await u.lab_technician.get('/api/projects/1')).status).toBe(200);
      const write = await u.lab_technician.post('/api/qc-results', {
        sample_id: 1,
        qc_type: 'concentration',
        result: 'pass',
      });
      expect(write.status).toBe(403);
      await setProjectRole(1, 4, 'contributor'); // put the fixture membership back
      const ok = await u.lab_technician.post('/api/qc-results', {
        sample_id: 1,
        qc_type: 'concentration',
        result: 'pass',
      });
      expect(ok.status).toBe(201);
    });

    it('a promotion to manager is seen on the next request, a demotion likewise', async () => {
      await addGlobalRole(5, PI);
      expect((await u.analyst.patch('/api/projects/1', { objectives: 'T33' })).status).toBe(403);
      await setProjectRole(1, 5, 'manager');
      expect(
        (await u.analyst.patch('/api/projects/1', { objectives: 'T33 as manager' })).status,
      ).toBe(200);
      await setProjectRole(1, 5, 'contributor');
      expect((await u.analyst.patch('/api/projects/1', { objectives: 'T33 again' })).status).toBe(
        403,
      );
      await removeGlobalRole(5, PI);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('project creation', () => {
    it('principal_investigator creates a project and becomes its owner (your_role: owner)', async () => {
      committed();
      const res = await u.principal_investigator.post('/api/projects', {
        title: 'T33 created project',
        objectives: 'created through the API',
        start_date: '2026-06-01',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        title: 'T33 created project',
        created_by: 2,
        your_role: 'owner',
      });
      const id = res.body.data.project_id;
      expect(id).toBeGreaterThanOrEqual(1000);
      const owners = await sql(
        "SELECT user_id::int AS id FROM project_members WHERE project_id = $1 AND project_role = 'owner'",
        [id],
      );
      expect(owners).toEqual([{ id: 2 }]);
      // the new project is the PI's, not anyone else's
      expect((await u.field_researcher.get(`/api/projects/${id}`)).status).toBe(404);
      expect((await u.principal_investigator.get(`/api/projects/${id}`)).status).toBe(200);
    });

    it('the administrator creates one and is the owner of it', async () => {
      const res = await u.administrator.post('/api/projects', { title: 'T33 admin project' });
      expect(res.status).toBe(201);
      expect(res.body.data.created_by).toBe(1);
    });

    it.each([
      ['created_by', { created_by: 6 }],
      ['owner_id', { owner_id: 6 }],
      ['status', { status: 'archived' }],
      ['project_id', { project_id: 5 }],
    ])('a body that sets %s is rejected, not honoured', async (_key, extra) => {
      const res = await u.principal_investigator.post('/api/projects', {
        title: `T33 tampered ${_key}`,
        ...extra,
      });
      expect(res.status).toBe(422);
      const rows = await sql('SELECT 1 FROM projects WHERE title = $1', [`T33 tampered ${_key}`]);
      expect(rows).toEqual([]);
    });

    it('a duplicate title -> 409, a blank title -> 422, a missing title -> 422', async () => {
      const dup = await u.principal_investigator.post('/api/projects', {
        title: 'Yamuna Biodiversity Survey',
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('duplicate');
      expect((await u.principal_investigator.post('/api/projects', { title: '   ' })).status).toBe(
        422,
      );
      expect((await u.principal_investigator.post('/api/projects', {})).status).toBe(422);
    });

    it.each(['field_researcher', 'lab_technician', 'analyst', 'viewer'])(
      '%s cannot create a project: 403',
      async (role) => {
        const res = await u[role].post('/api/projects', { title: `T33 by ${role}` });
        expect(res.status).toBe(403);
      },
    );
  });

  // ------------------------------------------------------------------------------------------
  describe('audit access', () => {
    let evidence;

    beforeAll(async () => {
      committed();
      // real API writes: an audited change in project 2 and one in project 1
      expect(
        (
          await u.principal_investigator.patch('/api/projects/2', {
            objectives: 'audit evidence 2',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await u.principal_investigator.patch('/api/projects/1', {
            objectives: 'audit evidence 1',
          })
        ).status,
      ).toBe(200);
      evidence = await sql(
        `SELECT audit_id::int AS id, entity_type, entity_id::int AS entity_id FROM audit_logs
          WHERE entity_type = 'projects' AND entity_id IN (1, 2) ORDER BY audit_id`,
      );
      await addGlobalRole(4, PI); // a principal investigator who belongs to project 1 only
    });
    afterAll(() => removeGlobalRole(4, PI));

    const entries = (res) => res.body.data.map((a) => `${a.entity_type}:${a.entity_id}`);

    it('the evidence exists: the writes were audited', () => {
      expect([...new Set(evidence.map((e) => e.entity_id))].sort()).toEqual([1, 2]);
    });

    it('administrator reads everything, including logins of users', async () => {
      const res = await u.administrator.get('/api/audit?limit=100');
      expect(res.status).toBe(200);
      expect(entries(res)).toEqual(expect.arrayContaining(['projects:1', 'projects:2']));
      expect(entries(res).some((e) => e.startsWith('users:'))).toBe(true);
    });

    it('a principal_investigator sees the entries of the projects they belong to, and no user entries', async () => {
      const res = await u.principal_investigator.get('/api/audit?limit=100');
      expect(res.status).toBe(200);
      expect(entries(res)).toEqual(expect.arrayContaining(['projects:1', 'projects:2']));
      expect(entries(res).filter((e) => e.startsWith('users:'))).toEqual([]);
      expect(res.body.data[0]).toHaveProperty('actor_name');
    });

    it('a principal_investigator of project 1 only gets nothing for an entity of project 2 and the project-1 entries', async () => {
      // docs/slices/access.md: the scope is a filter, so an out-of-scope entity answers an empty list
      const other = await u.lab_technician.get('/api/audit?entity_type=projects&entity_id=2');
      expect(other.status).toBe(200);
      expect(other.body.data).toEqual([]);
      expect(other.body.meta.total).toBe(0);
      const own = await u.lab_technician.get('/api/audit?entity_type=projects&entity_id=1');
      expect(own.body.data.length).toBeGreaterThan(0);
      const all = await u.lab_technician.get('/api/audit?limit=100');
      expect(entries(all)).not.toContain('projects:2');
      expect(entries(all).filter((e) => e.startsWith('users:'))).toEqual([]);
    });

    it.each(['field_researcher', 'analyst', 'viewer'])(
      '%s -> 403 on the audit log',
      async (role) => {
        const res = await u[role].get('/api/audit');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('forbidden');
      },
    );

    it('recent_activity on the dashboard: entries for the audit readers, an empty array for everyone else', async () => {
      const admin = await u.administrator.get('/api/dashboard/summary');
      expect(admin.body.data.recent_activity.length).toBeGreaterThan(0);
      expect(admin.body.data.recent_activity.length).toBeLessThanOrEqual(5);
      expect(Object.keys(admin.body.data.recent_activity[0]).sort()).toEqual(
        [
          'action',
          'actor_id',
          'actor_name',
          'audit_id',
          'created_at',
          'details',
          'entity_id',
          'entity_type',
        ].sort(),
      );
      const pi = await u.principal_investigator.get('/api/dashboard/summary');
      expect(pi.body.data.recent_activity.length).toBeGreaterThan(0);
      for (const role of ['field_researcher', 'analyst', 'viewer']) {
        const res = await u[role].get('/api/dashboard/summary');
        expect(res.body.data.recent_activity, role).toEqual([]);
      }
    });
  });
});
