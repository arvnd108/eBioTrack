// Owner: C (Testing & QA)
// Purpose: Project plus members atomic creation
//
// Real transactions judged from a second connection. Scenario of
// database/transactions/access_transaction.sql: user 2 (principal investigator) onboards
// "T32 onboarding": create_project_with_owner, members 3 and 4 as contributor and 6 as viewer,
// sites 1 and 4 linked.
//
// Audit expectation, derived from database/triggers/access_triggers.sql (audit_row_change() is
// attached AFTER INSERT/UPDATE/DELETE to projects, project_members and project_sites, key column
// project_id) and the procedure header: one audit row per inserted row, actor = the transaction's
// app.current_user_id, entity_id = the project id:
//   projects 1 + project_members 4 (owner + 3) + project_sites 2 = 7.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeTestPool } from '../setup/testDb.js';
import {
  applyGrants,
  assertGlobalInvariants,
  caught,
  committed,
  observer,
  restoreIfCommitted,
  runTransaction,
  seededCounts,
  snapshot,
} from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');

const PI = 2;
const TITLE = 'T32 onboarding';
const create = async (db, title, owner = PI) =>
  (
    await db.query(
      `SELECT create_project_with_owner($1, 'T32 objectives', DATE '2026-06-01', $2) AS id`,
      [title, owner],
    )
  ).rows[0].id;
const addMembers = (
  db,
  id,
  rows = [
    [3, 'contributor'],
    [4, 'contributor'],
    [6, 'viewer'],
  ],
) =>
  db.query(
    `INSERT INTO project_members (project_id, user_id, project_role)
     SELECT $1, v.u, v.r::project_role FROM unnest($2::bigint[], $3::text[]) AS v(u, r)`,
    [id, rows.map((r) => r[0]), rows.map((r) => r[1])],
  );
const addSites = (db, id, sites = [1, 4]) =>
  db.query(
    `INSERT INTO project_sites (project_id, site_id) SELECT $1, s FROM unnest($2::bigint[]) AS s`,
    [id, sites],
  );
const onboard = async (db, title = TITLE) => {
  const id = await create(db, title);
  await addMembers(db, id);
  await addSites(db, id);
  return id;
};

let watcher;
const titleCount = async (title) =>
  Number(
    (await watcher.query('SELECT count(*) AS n FROM projects WHERE title = $1', [title])).rows[0].n,
  );
const auditMax = async () =>
  Number((await watcher.query('SELECT COALESCE(max(audit_id), 0) AS m FROM audit_logs')).rows[0].m);
const auditAfter = async (baseline) =>
  (
    await watcher.query(
      `SELECT audit_id::int AS audit_id, actor_id::int AS actor_id, entity_type,
              entity_id::int AS entity_id, action
         FROM audit_logs WHERE audit_id > $1 ORDER BY audit_id`,
      [baseline],
    )
  ).rows;
const project = async (title) =>
  (
    await watcher.query(
      `SELECT project_id::int AS id, status, created_by::int AS created_by, title FROM projects WHERE title = $1`,
      [title],
    )
  ).rows[0];
const members = async (id) =>
  (
    await watcher.query(
      `SELECT user_id::int AS user_id, project_role FROM project_members WHERE project_id = $1 ORDER BY user_id`,
      [id],
    )
  ).rows;
const sites = async (id) =>
  (
    await watcher.query(
      `SELECT site_id::int AS site_id FROM project_sites WHERE project_id = $1 ORDER BY site_id`,
      [id],
    )
  ).rows.map((r) => r.site_id);
const tally = (rows) => {
  const out = {};
  for (const r of rows)
    out[`${r.entity_type}/${r.action}`] = (out[`${r.entity_type}/${r.action}`] ?? 0) + 1;
  return out;
};

describe.skipIf(!dbAvailable)('access: project creation transactions', () => {
  beforeAll(async () => {
    watcher = await observer();
  });
  afterEach(() => assertGlobalInvariants(watcher));
  afterAll(async () => {
    await restoreIfCommitted();
    expect(await seededCounts(watcher)).toEqual({
      projects: 2,
      samples: 17,
      detections: 43,
      audit: 0,
    });
    watcher.release();
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------
  // Commit paths: A, D, E, F, G in one sequence of real commits, one reseed at the end.
  describe('access: create_project_with_owner commit paths', () => {
    const a = {};
    const d = {};
    const e = {};
    const f = {};
    const g = {};

    beforeAll(async () => {
      committed();
      await applyGrants(); // grants.sql is not run by migrate or CI (contract gap, see README)

      // A. onboarding, everything in one transaction
      a.baseline = await auditMax();
      a.before = await snapshot(watcher);
      a.id = await runTransaction(
        async (db) => {
          const id = await onboard(db);
          a.insideCount = await titleCount(TITLE); // the observer, mid-transaction
          a.insideAudit = (await auditAfter(a.baseline)).length;
          a.insideRows = (
            await db.query('SELECT count(*)::int AS n FROM project_members WHERE project_id = $1', [
              id,
            ])
          ).rows[0].n;
          return id;
        },
        { actorId: PI },
      );
      a.audit = await auditAfter(a.baseline);

      // D. savepoint: one bad member does not cost the project
      d.baseline = await auditMax();
      d.id = await runTransaction(
        async (db) => {
          const id = await create(db, 'T32 savepoint');
          await db.query('SAVEPOINT m');
          d.failure = await caught(() => addMembers(db, id, [[999, 'contributor']]));
          await db.query('ROLLBACK TO SAVEPOINT m');
          await addMembers(db, id, [[3, 'contributor']]);
          return id;
        },
        { actorId: PI },
      );
      d.audit = await auditAfter(d.baseline);

      // E. acting user scope
      e.baselineNone = await auditMax();
      e.idNone = await runTransaction((db) => create(db, 'T32 no actor'));
      e.auditNone = await auditAfter(e.baselineNone);
      e.baselineCaller = await auditMax();
      e.idCaller = await runTransaction((db) => create(db, 'T32 caller wins'), { actorId: 1 });
      e.auditCaller = await auditAfter(e.baselineCaller);
      e.pids = [];
      for (const actorId of [PI, undefined]) {
        e.pids.push(
          await runTransaction(
            async (db) => {
              const { rows } = await db.query(
                `SELECT pg_backend_pid() AS pid, current_setting('app.current_user_id', true) AS actor`,
              );
              return rows[0];
            },
            { actorId },
          ),
        );
      }

      // F. a rolled-back creation consumes an identity value
      f.failedId = null;
      const injected = new Error('injected');
      await caught(() =>
        runTransaction(
          async (db) => {
            f.failedId = Number(await create(db, 'T32 will roll back'));
            throw injected;
          },
          { actorId: PI },
        ),
      );
      f.nextId = Number(
        await runTransaction((db) => create(db, 'T32 after the failure'), { actorId: PI }),
      );

      // G. the same commit path under the application role
      g.baseline = await auditMax();
      g.id = await runTransaction(
        async (db) => {
          await db.query('SET LOCAL ROLE ebiotrack_app');
          return onboard(db, 'T32 as app role');
        },
        { actorId: PI },
      );
      g.audit = await auditAfter(g.baseline);
    });
    afterAll(() => restoreIfCommitted());

    // A. commit path
    it('the observer sees nothing until COMMIT (no project, no audit row) while the transaction sees its 4 members', () => {
      expect(a.insideCount).toBe(0);
      expect(a.insideAudit).toBe(0);
      expect(a.insideRows).toBe(4);
    });
    it('after COMMIT: one planned project created by user 2 with id >= 1000', async () => {
      expect(await project(TITLE)).toEqual({
        id: Number(a.id),
        status: 'planned',
        created_by: PI,
        title: TITLE,
      });
      expect(Number(a.id)).toBeGreaterThanOrEqual(1000);
    });
    it('after COMMIT: 4 members with exactly one owner (user 2) and the other roles as given', async () => {
      expect(await members(a.id)).toEqual([
        { user_id: 2, project_role: 'owner' },
        { user_id: 3, project_role: 'contributor' },
        { user_id: 4, project_role: 'contributor' },
        { user_id: 6, project_role: 'viewer' },
      ]);
    });
    it('after COMMIT: sites 1 and 4 are linked', async () => {
      expect(await sites(a.id)).toEqual([1, 4]);
    });
    it('audit: 7 rows (projects 1, project_members 4, project_sites 2), all actor 2, entity_id = the project', () => {
      expect(a.audit).toHaveLength(7);
      expect(tally(a.audit)).toEqual({
        'projects/insert': 1,
        'project_members/insert': 4,
        'project_sites/insert': 2,
      });
      expect(a.audit.every((r) => r.actor_id === PI && r.entity_id === Number(a.id))).toBe(true);
    });
    it('only the new project differs from the seeded world (2 seeded projects untouched)', async () => {
      const now = await snapshot(watcher);
      expect(now.counts.projects).toBe(a.before.counts.projects + 6); // A, D, E x2, F, G (F's failed one is gone)
      const { rows } = await watcher.query(
        `SELECT project_id::int AS id FROM projects WHERE project_id < 1000 ORDER BY 1`,
      );
      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    });

    // B. durability
    it('durable: after the pool is closed and a fresh one opened, the project is still there', async () => {
      watcher.release();
      await closeTestPool();
      watcher = await observer();
      expect(await project(TITLE)).toMatchObject({ id: Number(a.id), status: 'planned' });
      expect(await members(a.id)).toHaveLength(4);
      expect(await sites(a.id)).toEqual([1, 4]);
    });

    // D. savepoint
    it('savepoint: the bad member (999) fails 23503 and is undone; project, owner and user 3 survive', async () => {
      expect(d.failure.code).toBe('23503');
      expect(await members(d.id)).toEqual([
        { user_id: 2, project_role: 'owner' },
        { user_id: 3, project_role: 'contributor' },
      ]);
    });
    it('savepoint audit: rows exist for the successful inserts (project, owner, member 3) and none for the failed one', () => {
      expect(tally(d.audit)).toEqual({ 'projects/insert': 1, 'project_members/insert': 2 });
      expect(d.audit.every((r) => r.actor_id === PI && r.entity_id === Number(d.id))).toBe(true);
    });

    // E. acting user scope
    it('no actorId -> the function takes the acting user from p_owner_id: audit actor 2', () => {
      expect(tally(e.auditNone)).toEqual({ 'projects/insert': 1, 'project_members/insert': 1 });
      expect(e.auditNone.every((r) => r.actor_id === PI)).toBe(true);
    });
    it('actorId 1 with owner 2 -> the caller wins: audit actor 1', () => {
      expect(e.auditCaller).toHaveLength(2);
      expect(e.auditCaller.every((r) => r.actor_id === 1)).toBe(true);
    });
    it('the acting user is transaction-local: the next transaction on the same connection has none', () => {
      const [withActor, without] = e.pids;
      expect(withActor.actor).toBe('2');
      expect(without.pid).toBe(withActor.pid); // same connection, sequential use of the pool
      expect(without.actor ?? '').toBe('');
    });

    // F. identity values
    it('a rolled-back creation consumes an identity value: the next project id is strictly larger', async () => {
      expect(f.failedId).toBeGreaterThanOrEqual(1000);
      expect(f.nextId).toBeGreaterThan(f.failedId);
      expect(await titleCount('T32 will roll back')).toBe(0);
    });

    // G. role boundary
    it('under SET LOCAL ROLE ebiotrack_app the commit path works and writes the same 7 audit rows', async () => {
      expect(await project('T32 as app role')).toMatchObject({ id: Number(g.id), created_by: PI });
      expect(await members(g.id)).toHaveLength(4);
      expect(g.audit).toHaveLength(7);
    });
    it.each([
      [
        'UPDATE',
        `UPDATE audit_logs SET entity_id = entity_id WHERE audit_id = (SELECT min(audit_id) FROM audit_logs)`,
      ],
      ['DELETE', `DELETE FROM audit_logs WHERE audit_id = (SELECT min(audit_id) FROM audit_logs)`],
    ])('the app role cannot %s audit_logs rows -> 42501', async (_verb, sql) => {
      const before = await snapshot(watcher, ['audit_logs']);
      const err = await caught(() =>
        runTransaction(async (db) => {
          await db.query('SET LOCAL ROLE ebiotrack_app');
          await db.query(sql);
        }),
      );
      expect(err.code).toBe('42501');
      expect(await snapshot(watcher, ['audit_logs'])).toEqual(before);
    });
  });

  // ------------------------------------------------------------------------------------------
  // C. Rollback cases: each in its own runTransaction; snapshot equality and no title afterwards.
  describe('access: create_project_with_owner rolls back everything', () => {
    let before;
    let baseline;
    beforeAll(async () => {
      before = await snapshot(watcher);
      baseline = await auditMax();
    });
    afterEach(async () => {
      expect(await snapshot(watcher)).toEqual(before);
      expect(await auditAfter(baseline)).toEqual([]);
      expect(await titleCount(TITLE)).toBe(0);
    });
    const fails = (fn) => caught(() => runTransaction(fn, { actorId: PI }));

    it('a second owner after the members were added -> 23505 on uq_project_members_owner', async () => {
      const err = await fails(async (db) => {
        const id = await create(db, TITLE);
        await addMembers(db, id);
        await addMembers(db, id, [[5, 'owner']]);
      });
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('uq_project_members_owner');
    });
    it('an unknown site (999) after project and members -> 23503 on fk_project_sites_site_id', async () => {
      const err = await fails(async (db) => {
        const id = await create(db, TITLE);
        await addMembers(db, id);
        await addSites(db, id, [1, 999]);
      });
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('fk_project_sites_site_id');
    });
    it('an unknown member user (999) -> 23503 on a project_members foreign key', async () => {
      const err = await fails(async (db) => {
        const id = await create(db, TITLE);
        await addMembers(db, id, [
          [3, 'contributor'],
          [999, 'viewer'],
        ]);
      });
      expect(err.code).toBe('23503');
      expect(err.constraint).toMatch(/^fk_project_members_/);
    });
    it('a viewer as owner (user 6) -> EB002 "may not create projects"', async () => {
      const err = await fails((db) => create(db, TITLE, 6));
      expect(err.code).toBe('EB002');
      expect(err.message).toMatch(/^User 6 may not create projects/);
    });
    it('a deactivated owner (deactivated in the same transaction) -> EB002', async () => {
      const err = await fails(async (db) => {
        await db.query('UPDATE users SET active = false WHERE user_id = $1', [PI]);
        await create(db, TITLE);
      });
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('User 2 is deactivated and cannot own a project');
    });
    it('a NULL owner -> EB002', async () => {
      const err = await fails((db) => create(db, TITLE, null));
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('A project owner is required');
    });
    it('an unknown owner (999) -> 23503 on fk_projects_created_by', async () => {
      const err = await fails((db) => create(db, TITLE, 999));
      expect(err.code).toBe('23503');
      expect(err.constraint).toBe('fk_projects_created_by');
    });
    it("the seeded title 'Yamuna Biodiversity Survey' -> 23505 on uq_projects_title", async () => {
      const err = await fails((db) => create(db, 'Yamuna Biodiversity Survey'));
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('uq_projects_title');
    });
    it.each([
      ['blank', '   '],
      ['NULL', null],
    ])('a %s title -> 23514 on ck_projects_title_not_blank', async (_n, title) => {
      const err = await fails((db) => create(db, title));
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('ck_projects_title_not_blank');
    });
    it('an injected non-database error after the whole sequence succeeded -> everything rolled back, the same error object', async () => {
      const injected = new Error('injected after onboarding');
      let inside;
      const err = await fails(async (db) => {
        const id = await onboard(db);
        inside = (
          await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1', [id])
        ).rows[0].n;
        throw injected;
      });
      expect(err).toBe(injected);
      expect(inside).toBe(7);
    });
    it('every failure leaves the 2 seeded projects each with exactly one owner (no ownerless project survives)', async () => {
      await fails(async (db) => {
        await create(db, TITLE);
        throw new Error('stop');
      });
      const { rows } = await watcher.query(
        `SELECT p.project_id::int AS id, count(*) FILTER (WHERE m.project_role = 'owner')::int AS owners
           FROM projects p LEFT JOIN project_members m USING (project_id) GROUP BY 1 ORDER BY 1`,
      );
      expect(rows).toEqual([
        { id: 1, owners: 1 },
        { id: 2, owners: 1 },
      ]);
    });
  });
});
