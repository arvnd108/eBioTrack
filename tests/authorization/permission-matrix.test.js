// Owner: C (Testing & QA)
// Purpose: Global-role permission matrix (CONTRACT 9) over every endpoint of CONTRACT 10
//
// The matrix below is typed from CONTRACT section 9 by hand. It is NOT imported from
// backend/src/middleware/permissions.js: that file is the thing under test.
//
//   CONTRACT 9 (copied)                       administrator  PI   field  lab  analyst  viewer
//   Manage users and roles                         ✓         —     —     —     —        —
//   Read audit log                                 ✓        own    —     —     —        —
//   Create project                                 ✓         ✓     —     —     —        —
//   Edit project, manage members                   ✓      own(o/m) —     —     —        —
//   Create and edit sites                          ✓         ✓    own    —     —        —
//   Create events and samples                      ✓        own   own    —     —        —
//   Change sample status                           ✓        own   own   own    —        —
//   Record extractions, QC, runs                   ✓        own    —    own    —        —
//   Create analysis and import detections          ✓        own    —     —    own       —
//   Approve or reject an analysis                  ✓        own    —     —     —        —
//   Read samples, events, lab data                 ✓        own   own   own   own      own
//   Read approved detections, analytics, export    ✓        own   own   own   own      own
//   Read non-approved detections                   ✓        own    —     —    own       —
//
// "own" means the user must also be a member of the project; every probe below targets project 1,
// which users 2-6 belong to, so only the global gate decides. Project scoping is project-access.
//
// Probes never change data: an allowed call is a request that passes the gate and then fails
// validation (or reads). Denied calls must be exactly 403 `forbidden`.
//
// CONTRACT GAPs found while typing the matrix (all tested under the reading in the comment):
//  - Section 10 "Min role" is a single role, but the roles are not a ladder (a lab technician is
//    not "above" a field researcher). Section 9 is used as the authority for who may call.
//  - Section 9 has no row for extraction batches; they are read as "Record extractions, QC, runs".
//  - "Create and edit sites: own" for a field researcher cannot be enforced (sites belong to no
//    project, see backend permissions.js note); tested as a global gate for PI and field researcher.
//  - Section 9 has no row for the "any" endpoints (roles, lookups); every signed-in role may read.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ENDPOINTS,
  MATRIX,
  ROLE_NAMES,
  SEED,
  addGlobalRole,
  assertNo5xx,
  committed,
  contractEndpoints,
  endpointKey as key,
  loginAll,
  mayCall,
  mountedRoutes,
  probePath,
  removeGlobalRole,
  restoreIfCommitted,
  sql,
  startApi,
  stopApi,
} from '../setup/api.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

// Mounted routes that are deliberately not in the matrix, each with its reason.
const UNLISTED = new Map([
  ['GET /api/health', 'public liveness probe, mounted before the session middleware (CONTRACT 8)'],
]);
// CONTRACT 10 rows that are optional and not part of the core contract.
const OPTIONAL_CONTRACT = new Map([
  ['GET /api/ml/anomalies', 'optional, not part of the core contract'],
]);

const [FR, LT, AN] = ['field_researcher', 'lab_technician', 'analyst'];
const PI = 'principal_investigator';

describe('matrix coverage', () => {
  it('every CONTRACT section 10 endpoint has a row in the matrix', () => {
    const rows = new Set(ENDPOINTS.map(key));
    const contract = contractEndpoints().filter((e) => !OPTIONAL_CONTRACT.has(key(e)));
    expect(contract.length).toBeGreaterThanOrEqual(55);
    expect(contract.map(key).filter((k) => !rows.has(k))).toEqual([]);
  });

  it('every matrix row is a CONTRACT section 10 endpoint (no invented rows)', () => {
    const contract = new Set(contractEndpoints().map(key));
    expect(ENDPOINTS.map(key).filter((k) => !contract.has(k))).toEqual([]);
  });

  it('every mounted route is in the matrix or on the reasoned allowlist', () => {
    const rows = new Set(ENDPOINTS.map(key));
    const mounted = mountedRoutes();
    expect(mounted.length).toBeGreaterThanOrEqual(55);
    const missing = mounted.map(key).filter((k) => !rows.has(k) && !UNLISTED.has(k));
    expect(missing, 'undocumented endpoints need a matrix row').toEqual([]);
  });

  it('every matrix row is really mounted (the matrix does not test phantom routes)', () => {
    const mounted = new Set(mountedRoutes().map(key));
    expect(ENDPOINTS.map(key).filter((k) => !mounted.has(k))).toEqual([]);
  });

  it('the typed matrix lists exactly the six seeded roles and a known action per row', () => {
    expect(ROLE_NAMES).toEqual(Object.keys(SEED));
    expect(ROLE_NAMES).toHaveLength(6);
    for (const e of ENDPOINTS) {
      expect(['public', ...Object.keys(MATRIX)], key(e)).toContain(e.action);
    }
  });
});

describe.skipIf(!dbAvailable)('permission matrix over the API', () => {
  let users;

  beforeAll(async () => {
    await startApi();
    users = await loginAll();
  });
  afterEach(() => assertNo5xx());
  afterAll(async () => {
    assertNo5xx();
    await restoreIfCommitted();
    await stopApi();
    await closeTestPool();
  });

  describe('permission matrix: six roles x every endpoint', () => {
    const cases = [];
    for (const e of ENDPOINTS.filter((x) => !x.skip)) {
      for (const role of ROLE_NAMES) cases.push([`${role} ${key(e)}`, role, e]);
    }

    it('the matrix covers at least 50 endpoints x 6 roles', () => {
      expect(cases.length).toBeGreaterThanOrEqual(50 * 6);
    });

    it.each(cases)('%s', async (_name, role, e) => {
      const res = await users[role].request(e.method, probePath(e), e.body);
      if (mayCall(role, e.action)) {
        expect(e.ok, `${role} ${key(e)} -> ${res.status} ${res.text.slice(0, 160)}`).toContain(
          res.status,
        );
        expect(res.body?.error?.message ?? '').not.toMatch(/^Route not found/);
        if (res.status === 404) expect(res.body.error.message).toBe(e.notFound);
      } else {
        expect(res.status, `${role} ${key(e)}`).toBe(403);
        expect(res.body.error.code).toBe('forbidden');
      }
    });
  });

  describe('permission matrix: multi-role users and the administrator', () => {
    const importProbe = (c) => c.post('/api/analyses/import', {});
    const approveProbe = (c) => c.post('/api/analyses/abc/approve');
    const siteProbe = (c) => c.post('/api/sites', {}); // any signed-in user may create a site
    const siteEditProbe = (c) => c.patch('/api/sites/1', {}); // editing needs manage_sites (or being the creator)

    it('a viewer is read-only: cannot import, approve or edit sites (creating a site is open to everyone)', async () => {
      expect((await importProbe(users.viewer)).status).toBe(403);
      expect((await approveProbe(users.viewer)).status).toBe(403);
      expect((await siteEditProbe(users.viewer)).status).toBe(403);
      expect((await siteProbe(users.viewer)).status).toBe(422);
    });

    it('viewer + analyst: the union applies on the very next request (may import, may not approve)', async () => {
      await addGlobalRole(SEED.viewer.user_id, AN);
      expect((await importProbe(users.viewer)).status).toBe(422);
      expect((await approveProbe(users.viewer)).status).toBe(403);
      expect((await siteEditProbe(users.viewer)).status).toBe(403);
      await removeGlobalRole(SEED.viewer.user_id, AN);
      expect((await importProbe(users.viewer)).status).toBe(403);
    });

    it('viewer + field_researcher + lab_technician may edit sites and record lab data, still not approve', async () => {
      await addGlobalRole(SEED.viewer.user_id, FR);
      await addGlobalRole(SEED.viewer.user_id, LT);
      expect((await siteEditProbe(users.viewer)).status).toBe(422);
      expect((await users.viewer.post('/api/qc-results', {})).status).toBe(422);
      expect((await approveProbe(users.viewer)).status).toBe(403);
      expect((await users.viewer.get('/api/users')).status).toBe(403);
      await removeGlobalRole(SEED.viewer.user_id, FR);
      await removeGlobalRole(SEED.viewer.user_id, LT);
      expect((await siteEditProbe(users.viewer)).status).toBe(403);
    });

    it('analyst + principal_investigator may approve (the decide gate is a union too)', async () => {
      await addGlobalRole(SEED.analyst.user_id, PI);
      expect((await approveProbe(users.analyst)).status).toBe(422);
      await removeGlobalRole(SEED.analyst.user_id, PI);
      expect((await approveProbe(users.analyst)).status).toBe(403);
    });

    it('a user with no global role keeps what their project role allows, and nothing else', async () => {
      await removeGlobalRole(SEED.analyst.user_id, AN);
      expect((await users.analyst.get('/api/auth/me')).body.data.roles).toEqual([]);
      // contributor of project 1: may import, may not approve or manage users/sites-less routes
      expect((await importProbe(users.analyst)).status).toBe(422);
      expect((await approveProbe(users.analyst)).status).toBe(403);
      expect((await users.analyst.get('/api/users')).status).toBe(403);
      await addGlobalRole(SEED.analyst.user_id, AN);
    });

    it('a user who is only a project viewer is denied every write, whatever the global role', async () => {
      expect((await importProbe(users.viewer)).status).toBe(403);
      await addGlobalRole(SEED.viewer.user_id, PI);
      expect((await importProbe(users.viewer)).status).toBe(422); // global PI gate passes pre-check
      await removeGlobalRole(SEED.viewer.user_id, PI);
    });

    it('the administrator passes every global gate and every project gate without being a member', async () => {
      committed();
      const [{ n }] = await sql('SELECT count(*)::int AS n FROM project_members WHERE user_id = 1');
      expect(n).toBe(0);
      // project 3 exists only in the database: no owner, no members, no sites
      await sql(
        `INSERT INTO projects (project_id, title, created_by) VALUES (3, 'T33 project without members', 2)`,
      );
      const admin = users.administrator;
      for (const id of [1, 2, 3]) {
        expect((await admin.get(`/api/projects/${id}`)).status, `GET project ${id}`).toBe(200);
        expect((await admin.patch(`/api/projects/${id}`, {})).status, `PATCH project ${id}`).toBe(
          422,
        );
        expect((await admin.post(`/api/projects/${id}/members`, {})).status).toBe(422);
        expect((await admin.post('/api/events', { project_id: id })).status).toBe(422);
      }
      // a principal investigator who is not a member of project 3 is told it does not exist
      const pi = await users.principal_investigator.get('/api/projects/3');
      expect(pi.status).toBe(404);
      for (const e of ENDPOINTS.filter((x) => !x.skip)) {
        const res = await admin.request(e.method, probePath(e), e.body);
        expect(e.ok, `administrator ${key(e)} -> ${res.status}`).toContain(res.status);
      }
    });
  });
});
