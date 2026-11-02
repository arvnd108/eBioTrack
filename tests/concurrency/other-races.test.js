// Owner: C (Testing & QA)
// Purpose: Access and Field races: same-title projects, owner deactivated mid-creation, parallel sample codes
//
// Claims proven (access_procedures.sql and field_procedures.sql headers, T18 access_transaction.sql
// Part 5, CONTRACT 7): two projects with one title -> one wins, the other 23505 (409 duplicate over
// HTTP); the owner row is locked FOR SHARE so the owner cannot be deactivated between the checks
// and the membership insert; register_sample() locks the event row FOR UPDATE so parallel calls get
// distinct, gapless sample codes and never 23505.
//
// The first block is the self-test of tests/setup/concurrency.js.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { assertNo5xx, loginAll, startApi, stopApi } from '../setup/api.js';
import {
  closeSessions,
  inTx,
  newEvent,
  openObserver,
  openSessions,
  prng,
  race,
  settle,
  shuffled,
  summarise,
  waitUntilBlocked,
  waitUntilQuiet,
} from '../setup/concurrency.js';
import { closeTestPool } from '../setup/testDb.js';
import { restoreIfCommitted } from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');

const R = 10; // iterations per race, each on fresh rows
const N = 15; // contenders

const createProject = (title, owner) => (db) =>
  db.query(
    "SELECT create_project_with_owner($1, 'T34', '2026-06-01'::date, $2)::int AS project_id",
    [title, owner],
  );
const registerSample = (eventId) => (db) =>
  db.query("SELECT register_sample($1, 1, 10.0, 1.0, 'T34 freezer', 3)::int AS sample_id", [
    eventId,
  ]);

/** A new active principal_investigator (the owner of the deactivation test). */
let piCounter = 0;
async function newPiUser() {
  piCounter += 1;
  return inTx(1, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, password_hash)
       VALUES ($1, $2, 'T34-not-a-real-hash') RETURNING user_id::int AS id`,
      [`T34 owner ${piCounter}`, `t34.owner${piCounter}@ebiotrack.test`],
    );
    await db.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, role_id FROM roles WHERE role_name = 'principal_investigator'`,
      [rows[0].id],
    );
    return rows[0].id;
  });
}

describe.skipIf(!dbAvailable)('access and field races', () => {
  let sessions;
  let observer;
  let users;

  beforeAll(async () => {
    await startApi();
    users = await loginAll();
    observer = await openObserver();
    await waitUntilQuiet(observer); // a previous file's closed sessions may still be finishing
    sessions = await openSessions(N);
  });
  afterEach(() => assertNo5xx());
  afterAll(async () => {
    assertNo5xx();
    if (sessions) await closeSessions(sessions);
    if (observer) {
      expect(await waitUntilQuiet(observer)).toBe(0);
      await observer.end();
    }
    await restoreIfCommitted();
    await stopApi();
    await closeTestPool();
  });

  // ---------------------------------------------------------------------------------------------
  describe('helper self-test (tests/setup/concurrency.js)', () => {
    it('race(): two inserts of the same unique key give exactly one 23505, the winner commits', async () => {
      const insert = (db) =>
        db.query(
          "INSERT INTO projects (title, created_by) VALUES ('T34 selftest', 2) RETURNING project_id",
        );
      const results = await race(sessions, [insert, insert], { actor: 2 });
      const s = summarise(results);
      expect(s).toMatchObject({ successes: 1, failureCodes: { 23505: 1 } });
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM projects WHERE title = 'T34 selftest'",
      );
      expect(rows[0].n).toBe(1);
      expect(sessions.every((x) => !x.open)).toBe(true);
    });

    it('race() starts every call after every session has begun (all pids are in a transaction first)', async () => {
      const seen = [];
      const results = await race(
        sessions,
        sessions.map(() => async (db) => {
          const { rows } = await db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
          );
          seen.push(rows[0].n);
        }),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(seen).toHaveLength(N);
    });

    it('waitUntilBlocked(): times out with a readable message when nothing blocks', async () => {
      const [a] = sessions;
      await a.begin(2);
      await a.query('SELECT 1');
      await expect(waitUntilBlocked(observer, a.pid, { timeoutMs: 150 })).rejects.toThrow(
        /did not block within 150 ms \(second call did not block\)/,
      );
      await a.rollback();
    });

    it('waitUntilBlocked(): reports the blocking session when there is one', async () => {
      const [a, b] = sessions;
      const id = await inTx(2, async (db) => {
        const { rows } = await db.query(
          "INSERT INTO projects (title, created_by) VALUES ('T34 selftest 2', 2) RETURNING project_id::int AS id",
        );
        return rows[0].id;
      });
      await a.begin(2);
      await a.query("UPDATE projects SET objectives = 'a' WHERE project_id = $1", [id]);
      const pending = settle(
        b
          .begin(2)
          .then(() => b.query("UPDATE projects SET objectives = 'b' WHERE project_id = $1", [id])),
      );
      const info = await waitUntilBlocked(observer, b.pid, { by: a.pid });
      expect(info.blockers).toEqual([a.pid]);
      await a.commit();
      expect((await pending).ok).toBe(true);
      await b.commit();
    });

    it('prng() and shuffled() are deterministic and a permutation', () => {
      const first = shuffled([1, 2, 3, 4, 5, 6], prng(7));
      expect(shuffled([1, 2, 3, 4, 5, 6], prng(7))).toEqual(first);
      expect([...first].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('Access: projects', () => {
    it(`${N} parallel create_project_with_owner with one title: 1 project id, ${N - 1} 23505, one owner membership (x${R})`, async () => {
      for (let i = 0; i < R; i++) {
        const title = `T34 race ${i}`;
        const results = await race(
          sessions,
          sessions.map(() => createProject(title, 2)),
          { actor: 2 },
        );
        const s = summarise(results);
        expect(s, s.messages.join(' | ')).toMatchObject({
          successes: 1,
          failureCodes: { 23505: N - 1 },
        });
        const { rows } = await observer.query(
          `SELECT p.project_id::int AS id,
                  (SELECT count(*)::int FROM project_members m WHERE m.project_id = p.project_id AND m.project_role = 'owner') AS owners,
                  (SELECT count(*)::int FROM project_members m WHERE m.project_id = p.project_id) AS members
             FROM projects p WHERE p.title = $1`,
          [title],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(results.find((r) => r.ok).value.rows[0].project_id);
        expect(rows[0]).toMatchObject({ owners: 1, members: 1 });
      }
    });

    it('hold: the same title blocks on the unique index, then 23505 after COMMIT', async () => {
      const [a, b] = sessions;
      await a.begin(2);
      await createProject('T34 hold commit', 2)(a.client);
      const pending = settle(b.begin(2).then(() => createProject('T34 hold commit', 2)(b.client)));
      const waiting = await waitUntilBlocked(observer, b.pid, { by: a.pid });
      expect(waiting.blockers).toContain(a.pid);
      await a.commit();
      const result = await pending;
      await b.rollback();
      expect(result).toMatchObject({ ok: false, code: '23505' });
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM projects WHERE title = 'T34 hold commit'",
      );
      expect(rows[0].n).toBe(1);
    });

    it('hold: when the first creation ROLLS BACK the same title succeeds', async () => {
      const [a, b] = sessions;
      await a.begin(2);
      await createProject('T34 hold rollback', 2)(a.client);
      const pending = settle(
        b.begin(2).then(() => createProject('T34 hold rollback', 2)(b.client)),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.rollback();
      const result = await pending;
      expect(result.ok, result.message).toBe(true);
      await b.commit();
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM projects WHERE title = 'T34 hold rollback'",
      );
      expect(rows[0].n).toBe(1);
    });

    it('different titles never interfere: all succeed in parallel', async () => {
      const results = await race(
        sessions,
        sessions.map((_, k) => createProject(`T34 distinct ${k}`, 2)),
        { actor: 2 },
      );
      expect(summarise(results)).toMatchObject({ successes: N, failures: 0 });
    });

    // The FOR SHARE claim: the owner cannot be deactivated between the checks and the membership insert.
    describe('owner deactivated while a project is created for them', () => {
      it('hold: creation holds, the deactivation blocks, COMMIT lets it through; the project keeps its owner', async () => {
        const [a, b] = sessions;
        const owner = await newPiUser();
        await a.begin(owner);
        await createProject('T34 owner share', owner)(a.client);
        const pending = settle(
          b
            .begin(1)
            .then(() => b.query('UPDATE users SET active = false WHERE user_id = $1', [owner])),
        );
        await waitUntilBlocked(observer, b.pid, { by: a.pid });
        await a.commit();
        expect((await pending).ok).toBe(true);
        await b.commit();
        const { rows } = await observer.query(
          `SELECT u.active, m.project_role FROM projects p
             JOIN project_members m ON m.project_id = p.project_id JOIN users u ON u.user_id = m.user_id
            WHERE p.title = 'T34 owner share'`,
        );
        expect(rows).toEqual([{ active: false, project_role: 'owner' }]);
      });

      it('reverse order: the deactivation commits first, the creation then fails EB002 and no project exists', async () => {
        const [a, b] = sessions;
        const owner = await newPiUser();
        await b.begin(1);
        await b.query('UPDATE users SET active = false WHERE user_id = $1', [owner]);
        await a.begin(owner);
        const pending = settle(createProject('T34 owner gone', owner)(a.client));
        // The creation only takes a shared lock on a row the other session has changed: it must wait.
        await waitUntilBlocked(observer, a.pid, { by: b.pid });
        await b.commit();
        const result = await pending;
        await a.rollback();
        expect(result).toMatchObject({ ok: false, code: 'EB002' });
        expect(result.message).toMatch(/deactivated/);
        const { rows } = await observer.query(
          "SELECT count(*)::int AS n FROM projects WHERE title = 'T34 owner gone'",
        );
        expect(rows[0].n).toBe(0);
      });

      it(`race: whenever the creation succeeds the project has its owner; whenever it fails it is EB002 and leaves nothing (x${R})`, async () => {
        const outcomes = { created: 0, refused: 0 };
        for (let i = 0; i < R; i++) {
          const owner = await newPiUser();
          const title = `T34 owner race ${i}`;
          const results = await race(
            sessions.slice(0, 2),
            [
              createProject(title, owner),
              (db) => db.query('UPDATE users SET active = false WHERE user_id = $1', [owner]),
            ],
            { actor: [owner, 1] },
          );
          expect(results[1].ok, results[1].message).toBe(true);
          const { rows } = await observer.query(
            `SELECT (SELECT count(*)::int FROM projects WHERE title = $1) AS projects,
                    (SELECT count(*)::int FROM project_members m JOIN projects p ON p.project_id = m.project_id
                      WHERE p.title = $1 AND m.user_id = $2 AND m.project_role = 'owner') AS owners,
                    (SELECT active FROM users WHERE user_id = $2) AS active`,
            [title, owner],
          );
          expect(rows[0].active).toBe(false);
          if (results[0].ok) {
            outcomes.created += 1;
            expect(rows[0]).toMatchObject({ projects: 1, owners: 1 });
          } else {
            outcomes.refused += 1;
            expect(results[0].code).toBe('EB002');
            expect(rows[0]).toMatchObject({ projects: 0, owners: 0 });
          }
        }
        expect(outcomes.created + outcomes.refused).toBe(R);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('Field: register_sample', () => {
    const codeOf = (eventDate, eventId, seq) =>
      `EB-${eventDate}-${String(eventId).padStart(4, '0')}-${String(seq).padStart(3, '0')}`;

    it(`${N} parallel register_sample on one event: distinct ids, gapless codes 001..${N}, no 23505, one 'collected' history row each (x5)`, async () => {
      for (let i = 0; i < 5; i++) {
        const event = await newEvent();
        const results = await race(
          sessions,
          sessions.map(() => registerSample(event)),
          { actor: 3 },
        );
        const s = summarise(results);
        expect(s, s.messages.join(' | ')).toMatchObject({ successes: N, failures: 0 });
        const ids = results.map((r) => r.value.rows[0].sample_id);
        expect(new Set(ids).size).toBe(N);
        const { rows } = await observer.query(
          'SELECT sample_id::int AS id, sample_code FROM samples WHERE event_id = $1 ORDER BY sample_code',
          [event],
        );
        expect(rows.map((r) => r.sample_code)).toEqual(
          Array.from({ length: N }, (_, k) => codeOf('20260520', event, k + 1)),
        );
        expect(rows.map((r) => r.id).sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
        const history = await observer.query(
          `SELECT sample_id::int AS id, old_status, new_status, changed_by::int AS changed_by
             FROM sample_status_history WHERE sample_id = ANY($1::bigint[])`,
          [ids],
        );
        expect(history.rows).toHaveLength(N);
        for (const h of history.rows) {
          expect(h).toMatchObject({ old_status: null, new_status: 'collected', changed_by: 3 });
        }
      }
    });

    it('an event that already has samples continues the sequence after them (gapless)', async () => {
      const { rows: before } = await observer.query(
        'SELECT count(*)::int AS n FROM samples WHERE event_id = 1',
      );
      const existing = before[0].n;
      const results = await race(
        sessions,
        sessions.map(() => registerSample(1)),
        { actor: 3 },
      );
      expect(summarise(results)).toMatchObject({ successes: N, failures: 0 });
      const { rows } = await observer.query(
        'SELECT right(sample_code, 3) AS seq FROM samples WHERE event_id = 1 ORDER BY sample_code',
      );
      expect(rows.map((r) => r.seq)).toEqual(
        Array.from({ length: existing + N }, (_, k) => String(k + 1).padStart(3, '0')),
      );
    });

    it('hold: the second registration waits on the event row, then gets the next sequence number', async () => {
      const [a, b] = sessions;
      const event = await newEvent();
      await a.begin(3);
      await registerSample(event)(a.client);
      const pending = settle(b.begin(3).then(() => registerSample(event)(b.client)));
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.commit();
      expect((await pending).ok).toBe(true);
      await b.commit();
      const { rows } = await observer.query(
        'SELECT right(sample_code, 3) AS seq FROM samples WHERE event_id = $1 ORDER BY sample_id',
        [event],
      );
      expect(rows.map((r) => r.seq)).toEqual(['001', '002']);
    });

    it('different events never wait on each other', async () => {
      const [a, b] = sessions;
      const [e1, e2] = [await newEvent(), await newEvent()];
      await a.begin(3);
      await registerSample(e1)(a.client);
      await b.begin(3);
      const result = await settle(registerSample(e2)(b.client)); // would hit lock_timeout (10 s) if it blocked
      expect(result.ok, result.message).toBe(true);
      await a.commit();
      await b.commit();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('API level', () => {
    it('parallel POST /api/projects with one title: one 201, the rest 409 duplicate', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          users.principal_investigator.post('/api/projects', { title: 'T34 api race' }),
        ),
      );
      const created = responses.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      expect(created[0].body.data).toMatchObject({ title: 'T34 api race', your_role: 'owner' });
      for (const r of responses.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('duplicate');
      }
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM projects WHERE title = 'T34 api race'",
      );
      expect(rows[0].n).toBe(1);
    });

    it('parallel POST /api/samples on one event: all 201 with distinct sample codes', async () => {
      const event = await newEvent();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          users.field_researcher.post('/api/samples', { event_id: event, sample_type_id: 1 }),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      const codes = responses.map((r) => r.body.data.sample_code);
      expect(new Set(codes).size).toBe(10);
      expect(codes.map((c) => c.slice(-3)).sort()).toEqual(
        Array.from({ length: 10 }, (_, k) => String(k + 1).padStart(3, '0')),
      );
    });

    it('parallel status changes of one sample to the SAME status: one 200, the rest 409 invalid_transition', async () => {
      const event = await newEvent();
      const sample = (
        await users.field_researcher.post('/api/samples', { event_id: event, sample_type_id: 1 })
      ).body.data.sample_id;
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          users.field_researcher.patch(`/api/samples/${sample}/status`, {
            new_status: 'discarded',
          }),
        ),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of responses.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('invalid_transition');
      }
    });

    it('parallel status changes to DIFFERENT valid states leave a history that is a valid chain ending at the sample status', async () => {
      const event = await newEvent();
      const sample = (
        await users.field_researcher.post('/api/samples', { event_id: event, sample_type_id: 1 })
      ).body.data.sample_id;
      const targets = ['stored', 'failed', 'discarded', 'stored', 'failed', 'discarded'];
      const responses = await Promise.all(
        targets.map((new_status) =>
          users.field_researcher.patch(`/api/samples/${sample}/status`, { new_status }),
        ),
      );
      for (const r of responses) expect([200, 409]).toContain(r.status);
      const { rows: history } = await observer.query(
        'SELECT old_status, new_status FROM sample_status_history WHERE sample_id = $1 ORDER BY history_id',
        [sample],
      );
      expect(history).toHaveLength(1 + responses.filter((r) => r.status === 200).length);
      for (let i = 1; i < history.length; i++)
        expect(history[i].old_status).toBe(history[i - 1].new_status);
      const { rows } = await observer.query('SELECT status FROM samples WHERE sample_id = $1', [
        sample,
      ]);
      expect(rows[0].status).toBe(history.at(-1).new_status);
    });
  });
});
