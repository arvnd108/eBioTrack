// Owner: C (Testing & QA)
// Purpose: Same extraction assigned to two runs at once
//
// Claims proven (database/procedures/lab_procedures.sql header, T18 lab_transaction.sql Part 5,
// CONTRACT 4.3 and 7): an extraction is in only ONE planned or running run; both procedures lock
// the extraction rows FOR UPDATE in ascending id order, so the loser waits and then gets EB002 and
// two callers can never deadlock; a failed call leaves no run and no library behind;
// REPEATABLE READ is refused with EB002, SERIALIZABLE is safe; assigning to a run that already
// left 'planned' is EB001.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { assertNo5xx, loginAll, startApi, stopApi } from '../setup/api.js';
import {
  activeSessionCount,
  closeSessions,
  forbiddenCodes,
  librariesOf,
  newPassedExtractions,
  openObserver,
  openSessions,
  prng,
  race,
  settle,
  shuffled,
  summarise,
  waitUntilBlocked,
} from '../setup/concurrency.js';
import { closeTestPool, getPool } from '../setup/testDb.js';
import { restoreIfCommitted } from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');

const R = 10; // iterations per race, each on fresh rows
const N = 15; // contenders

const createRun =
  (tag, ids, actor = 4) =>
  (db) =>
    db.query(
      "SELECT create_sequencing_run(1, $1, '2026-06-01'::date, $2::bigint[], $3) AS run_id",
      [tag, ids, actor],
    );
const assign =
  (runId, extractionId, actor = 4) =>
  (db) =>
    db.query('SELECT assign_extraction_to_run($1, $2, $3) AS library_id', [
      runId,
      extractionId,
      actor,
    ]);

/** Runs created with one platform tag, with their libraries. */
async function runsOfTag(db, tag) {
  const { rows } = await db.query(
    `SELECT r.run_id::int AS run_id, r.run_code, r.status,
            array_agg(l.extraction_id::int ORDER BY l.extraction_id) FILTER (WHERE l.library_id IS NOT NULL) AS extractions,
            array_agg(l.library_code ORDER BY l.library_id) FILTER (WHERE l.library_id IS NOT NULL) AS library_codes
       FROM sequencing_runs r LEFT JOIN sequencing_libraries l ON l.run_id = r.run_id
      WHERE r.platform = $1 GROUP BY r.run_id ORDER BY r.run_id`,
    [tag],
  );
  return rows;
}

const pad = (prefix, id, width) => `${prefix}${String(id).padStart(width, '0')}`;

describe.skipIf(!dbAvailable)('run assignment races', () => {
  let sessions;
  let observer;
  let users;

  beforeAll(async () => {
    await startApi();
    users = await loginAll();
    observer = await openObserver();
    sessions = await openSessions(N);
  });
  afterEach(() => assertNo5xx());
  afterAll(async () => {
    assertNo5xx();
    if (sessions) await closeSessions(sessions);
    if (observer) {
      expect(await activeSessionCount(observer)).toBe(0);
      await observer.end();
    }
    await restoreIfCommitted();
    await stopApi();
    await closeTestPool();
  });

  // ---------------------------------------------------------------------------------------------
  describe('database level', () => {
    // A. same extraction, N runs
    it(`A. ${N} runs book the same extraction at once: 1 success, ${N - 1} EB002, all-or-nothing (x${R})`, async () => {
      for (let i = 0; i < R; i++) {
        const tag = `T34-A-${i}`;
        const [shared, ...privates] = await newPassedExtractions(N + 1);
        const calls = privates.map((p) => createRun(tag, [shared, p]));
        const results = await race(sessions, calls, { actor: 4 });
        const s = summarise(results);
        expect(s, `iteration ${i}: ${s.messages.join(' | ')}`).toMatchObject({
          successes: 1,
          failureCodes: { EB002: N - 1 },
        });
        expect(forbiddenCodes(results)).toEqual([]);

        const winner = results.findIndex((r) => r.ok);
        expect(await librariesOf(observer, shared, { activeOnly: true })).toHaveLength(1);
        const runs = await runsOfTag(observer, tag);
        expect(runs, 'a failed call leaves no run row').toHaveLength(1);
        expect(runs[0].extractions).toEqual([shared, privates[winner]].sort((a, b) => a - b));
        for (const [k, p] of privates.entries()) {
          if (k !== winner) expect(await librariesOf(observer, p)).toEqual([]);
        }
        // codes follow the ids and are unique
        expect(runs[0].run_code).toBe(pad('RUN-', runs[0].run_id, 3));
        const { rows: libs } = await observer.query(
          'SELECT library_id::int AS id, library_code FROM sequencing_libraries WHERE run_id = $1',
          [runs[0].run_id],
        );
        for (const l of libs) expect(l.library_code).toBe(pad('LIB-', l.id, 4));
        expect(new Set(libs.map((l) => l.library_code)).size).toBe(libs.length);
      }
    });

    // B. overlapping lists in opposite order: the ascending-id locking claim
    it(`B. ${N} callers with the SAME extractions in shuffled orders: exactly 1 success, no deadlock (x${R})`, async () => {
      const random = prng(34);
      for (let i = 0; i < R; i++) {
        const tag = `T34-B-${i}`;
        const ids = await newPassedExtractions(6);
        const calls = sessions.map(() => createRun(tag, shuffled(ids, random)));
        const results = await race(sessions, calls, { actor: 4 });
        expect(forbiddenCodes(results), 'deadlock or serialization failure').toEqual([]);
        const s = summarise(results);
        expect(s, s.messages.join(' | ')).toMatchObject({
          successes: 1,
          failureCodes: { EB002: N - 1 },
        });
        const runs = await runsOfTag(observer, tag);
        expect(runs).toHaveLength(1);
        expect(runs[0].extractions).toEqual(ids);
      }
    });

    it(`B. ${N} callers with random OVERLAPPING subsets: no deadlock, no extraction booked twice, libraries = sum of the winners (x${R})`, async () => {
      const random = prng(3434);
      for (let i = 0; i < R; i++) {
        const tag = `T34-B2-${i}`;
        const pool = await newPassedExtractions(8);
        const subsets = sessions.map(() =>
          shuffled(pool, random).slice(0, 2 + Math.floor(random() * 4)),
        );
        const results = await race(
          sessions,
          subsets.map((ids) => createRun(tag, ids)),
          { actor: 4 },
        );
        expect(forbiddenCodes(results), 'deadlock or serialization failure').toEqual([]);
        const s = summarise(results);
        expect(Object.keys(s.failureCodes).every((c) => c === 'EB002')).toBe(true);
        expect(s.successes).toBeGreaterThanOrEqual(1);
        const winners = subsets.filter((_, k) => results[k].ok);
        const booked = winners.flat();
        expect(new Set(booked).size, 'two winners share an extraction').toBe(booked.length);
        for (const id of pool) {
          expect((await librariesOf(observer, id, { activeOnly: true })).length).toBe(
            booked.includes(id) ? 1 : 0,
          );
        }
        expect(await runsOfTag(observer, tag)).toHaveLength(s.successes);
      }
    });

    // C. hold pattern
    it('C. hold: the second booking blocks on the extraction row, then EB002 after COMMIT', async () => {
      const [a, b] = sessions;
      const [e] = await newPassedExtractions(1);
      await a.begin(4);
      await a.query('SELECT create_sequencing_run(1, $1, $2::date, $3::bigint[], 4)', [
        'T34-C',
        '2026-06-01',
        [e],
      ]);
      const pending = settle(
        b
          .begin(4)
          .then(() =>
            b.query('SELECT create_sequencing_run(1, $1, $2::date, $3::bigint[], 4)', [
              'T34-C2',
              '2026-06-01',
              [e],
            ]),
          ),
      );
      const waiting = await waitUntilBlocked(observer, b.pid, { by: a.pid });
      expect(waiting.blockers).toContain(a.pid);
      await a.commit();
      const result = await pending;
      await b.rollback();
      expect(result).toMatchObject({ ok: false, code: 'EB002' });
      expect(result.message).toMatch(/already booked on run/);
      expect(await librariesOf(observer, e, { activeOnly: true })).toHaveLength(1);
      expect(await runsOfTag(observer, 'T34-C2')).toEqual([]);
    });

    it('C. hold: when the first booking ROLLS BACK the second succeeds', async () => {
      const [a, b] = sessions;
      const [e] = await newPassedExtractions(1);
      await a.begin(4);
      await a.query('SELECT create_sequencing_run(1, $1, $2::date, $3::bigint[], 4)', [
        'T34-C3',
        '2026-06-01',
        [e],
      ]);
      const pending = settle(
        b
          .begin(4)
          .then(() =>
            b.query('SELECT create_sequencing_run(1, $1, $2::date, $3::bigint[], 4)', [
              'T34-C4',
              '2026-06-01',
              [e],
            ]),
          ),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.rollback();
      const result = await pending;
      expect(result.ok, result.message).toBe(true);
      await b.commit();
      expect(await runsOfTag(observer, 'T34-C3')).toEqual([]);
      expect(await librariesOf(observer, e, { activeOnly: true })).toHaveLength(1);
    });

    // D. create_sequencing_run vs assign_extraction_to_run
    it(`D. create_sequencing_run vs assign_extraction_to_run for the same extraction: exactly one library (x${R})`, async () => {
      for (let i = 0; i < R; i++) {
        const [anchor, e] = await newPassedExtractions(2);
        const { rows } = await getPool().query(
          "SELECT create_sequencing_run(1, $1, '2026-06-01'::date, $2::bigint[], 4)::int AS run_id",
          [`T34-D-planned-${i}`, [anchor]],
        );
        const planned = rows[0].run_id;
        const results = await race(
          sessions.slice(0, 2),
          [createRun(`T34-D-${i}`, [e]), assign(planned, e)],
          { actor: 4 },
        );
        const s = summarise(results);
        expect(s, s.messages.join(' | ')).toMatchObject({
          successes: 1,
          failureCodes: { EB002: 1 },
        });
        expect(await librariesOf(observer, e, { activeOnly: true })).toHaveLength(1);
      }
    });

    it('D. assign to a run that was concurrently moved out of planned: EB001 (run is not planned)', async () => {
      const [a, b] = sessions;
      const [anchor, e] = await newPassedExtractions(2);
      const { rows } = await getPool().query(
        "SELECT create_sequencing_run(1, 'T34-D2', '2026-06-01'::date, $1::bigint[], 4)::int AS run_id",
        [[anchor]],
      );
      const runId = rows[0].run_id;
      await a.begin(4);
      await a.query("UPDATE sequencing_runs SET status = 'running' WHERE run_id = $1", [runId]);
      const pending = settle(
        b.begin(4).then(() => b.query('SELECT assign_extraction_to_run($1, $2, 4)', [runId, e])),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.commit();
      const result = await pending;
      await b.rollback();
      expect(result).toMatchObject({ ok: false, code: 'EB001' });
      expect(await librariesOf(observer, e)).toEqual([]);
    });

    it('D. the reverse order: the assignment holds the run, the status change waits and then succeeds', async () => {
      const [a, b] = sessions;
      const [anchor, e] = await newPassedExtractions(2);
      const { rows } = await getPool().query(
        "SELECT create_sequencing_run(1, 'T34-D3', '2026-06-01'::date, $1::bigint[], 4)::int AS run_id",
        [[anchor]],
      );
      const runId = rows[0].run_id;
      await a.begin(4);
      await a.query('SELECT assign_extraction_to_run($1, $2, 4)', [runId, e]);
      const pending = settle(
        b
          .begin(4)
          .then(() =>
            b.query("UPDATE sequencing_runs SET status = 'running' WHERE run_id = $1", [runId]),
          ),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.commit();
      expect((await pending).ok).toBe(true);
      await b.commit();
      expect((await librariesOf(observer, e, { activeOnly: true })).map((l) => l.status)).toEqual([
        'running',
      ]);
    });

    // E. QC verdict vs booking. The trigger allows only pending -> pass | fail and a verdict is final.
    describe('E. QC verdict vs booking', () => {
      const verdict = (id, value) => (db) =>
        db.query('UPDATE dna_extractions SET qc_status = $2::qc_status WHERE extraction_id = $1', [
          id,
          value,
        ]);

      it(`pending extraction: verdict 'pass' racing the booking never leaves a library on a non-passed extraction (x${R})`, async () => {
        const outcomes = new Set();
        for (let i = 0; i < R; i++) {
          const [x] = await newPassedExtractions(1, { qc: 'pending' });
          const results = await race(
            sessions.slice(0, 2),
            [verdict(x, 'pass'), createRun(`T34-E-${i}`, [x])],
            { actor: 4 },
          );
          expect(forbiddenCodes(results)).toEqual([]);
          expect(results[0].ok, results[0].message).toBe(true);
          if (!results[1].ok) expect(results[1].code).toBe('EB002');
          outcomes.add(results[1].ok ? 'booked' : 'refused');
          const libs = await librariesOf(observer, x);
          const { rows } = await observer.query(
            'SELECT qc_status FROM dna_extractions WHERE extraction_id = $1',
            [x],
          );
          expect(rows[0].qc_status).toBe('pass');
          expect(libs).toHaveLength(results[1].ok ? 1 : 0);
        }
        expect(outcomes.size).toBeGreaterThanOrEqual(1); // both orders are forced by the hold tests below
      });

      it("hold: a 'pass' verdict is committed first, the waiting booking then SUCCEEDS", async () => {
        const [a, b] = sessions;
        const [x] = await newPassedExtractions(1, { qc: 'pending' });
        await a.begin(4);
        await verdict(x, 'pass')(a);
        const pending = settle(b.begin(4).then(() => createRun('T34-E-hold-pass', [x])(b)));
        await waitUntilBlocked(observer, b.pid, { by: a.pid });
        await a.commit();
        const result = await pending;
        expect(result.ok, result.message).toBe(true);
        await b.commit();
        expect(await librariesOf(observer, x, { activeOnly: true })).toHaveLength(1);
      });

      it("hold: a 'fail' verdict is committed first, the waiting booking is refused EB002 and no library exists", async () => {
        const [a, b] = sessions;
        const [x] = await newPassedExtractions(1, { qc: 'pending' });
        await a.begin(4);
        await verdict(x, 'fail')(a);
        const pending = settle(b.begin(4).then(() => createRun('T34-E-hold-fail', [x])(b)));
        await waitUntilBlocked(observer, b.pid, { by: a.pid });
        await a.commit();
        const result = await pending;
        await b.rollback();
        expect(result).toMatchObject({ ok: false, code: 'EB002' });
        expect(result.message).toMatch(/has not passed QC/);
        expect(await librariesOf(observer, x)).toEqual([]);
      });

      it("a passed extraction cannot be turned into 'fail' while it is being booked: EB001, and the booking stands", async () => {
        for (let i = 0; i < R; i++) {
          const [x] = await newPassedExtractions(1);
          const results = await race(
            sessions.slice(0, 2),
            [verdict(x, 'fail'), createRun(`T34-E2-${i}`, [x])],
            { actor: 4 },
          );
          expect(results[0]).toMatchObject({ ok: false, code: 'EB001' });
          expect(results[1].ok, results[1].message).toBe(true);
          const { rows } = await observer.query(
            'SELECT qc_status FROM dna_extractions WHERE extraction_id = $1',
            [x],
          );
          expect(rows[0].qc_status).toBe('pass');
          expect(await librariesOf(observer, x, { activeOnly: true })).toHaveLength(1);
        }
      });
    });

    // F. isolation guards
    describe('F. isolation levels', () => {
      it('REPEATABLE READ is refused with EB002 by both procedures and nothing is created', async () => {
        const [a] = sessions;
        const [x, y] = await newPassedExtractions(2);
        const { rows } = await getPool().query(
          "SELECT create_sequencing_run(1, 'T34-F-anchor', '2026-06-01'::date, $1::bigint[], 4)::int AS run_id",
          [[y]],
        );
        await a.begin(4, 'REPEATABLE READ');
        expect(await a.isolationLevel()).toBe('repeatable read');
        const created = await settle(createRun('T34-F-rr', [x])(a.client));
        await a.rollback();
        expect(created).toMatchObject({ ok: false, code: 'EB002' });
        expect(created.message).toMatch(/READ COMMITTED or SERIALIZABLE/);
        await a.begin(4, 'REPEATABLE READ');
        const assigned = await settle(assign(rows[0].run_id, x)(a.client));
        await a.rollback();
        expect(assigned).toMatchObject({ ok: false, code: 'EB002' });
        expect(await runsOfTag(observer, 'T34-F-rr')).toEqual([]);
        expect(await librariesOf(observer, x)).toEqual([]);
      });

      it('SERIALIZABLE: at most one booking of the same extraction commits; the others fail with 40001 or EB002', async () => {
        for (let i = 0; i < 3; i++) {
          const [x] = await newPassedExtractions(1);
          const six = sessions.slice(0, 6);
          const results = await race(
            six,
            six.map((_, k) => createRun(`T34-F-ser-${i}-${k}`, [x])),
            {
              actor: 4,
              isolation: 'SERIALIZABLE',
            },
          );
          const s = summarise(results);
          expect(s.successes, s.messages.join(' | ')).toBeLessThanOrEqual(1);
          expect(Object.keys(s.failureCodes).every((c) => ['40001', 'EB002'].includes(c))).toBe(
            true,
          );
          expect(await librariesOf(observer, x, { activeOnly: true })).toHaveLength(s.successes);
        }
      });
    });

    // G. the call really waits on a lock
    it("G. with lock_timeout 300 ms the blocked call fails with 55P03; the holder's booking is untouched", async () => {
      const [a] = sessions;
      const [short] = await openSessions(1, { lockTimeout: '300ms' });
      try {
        const [e] = await newPassedExtractions(1);
        await a.begin(4);
        await createRun('T34-G', [e])(a.client);
        await short.begin(4);
        const result = await settle(createRun('T34-G2', [e])(short.client));
        await short.rollback();
        expect(result).toMatchObject({ ok: false, code: '55P03' });
        await a.commit();
        expect(await librariesOf(observer, e, { activeOnly: true })).toHaveLength(1);
        expect(await runsOfTag(observer, 'T34-G2')).toEqual([]);
      } finally {
        await closeSessions([short]);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('API level (POST /api/sequencing-runs, /api/sequencing-runs/:id/libraries)', () => {
    const body = (platform, ids) => ({
      lab_id: 1,
      platform,
      run_date: '2026-06-01',
      extraction_ids: ids,
    });

    it('10 parallel requests by the lab technician book the same extraction: one 201, nine 422 rule_violation', async () => {
      const [shared, ...privates] = await newPassedExtractions(11);
      const responses = await Promise.all(
        privates.map((p) =>
          users.lab_technician.post('/api/sequencing-runs', body('T34-api-A', [shared, p])),
        ),
      );
      const created = responses.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      for (const r of responses.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('rule_violation');
        expect(r.body.error.message).toMatch(/already booked on run/);
      }
      const runs = await runsOfTag(observer, 'T34-api-A');
      expect(runs).toHaveLength(1);
      expect(runs[0].extractions).toContain(shared);
      // the run list shows exactly one run containing the extraction
      const list = await users.lab_technician.get('/api/sequencing-runs?limit=100');
      expect(list.status).toBe(200);
      const withShared = list.body.data.filter((r) => r.run_id === runs[0].run_id);
      expect(withShared).toHaveLength(1);
    });

    it('parallel library additions of one extraction to two planned runs: one 201, the rest 422', async () => {
      const [a1, a2, e] = await newPassedExtractions(3);
      const mk = async (id, tag) =>
        (await users.lab_technician.post('/api/sequencing-runs', body(tag, [id]))).body.data.run_id;
      const runA = await mk(a1, 'T34-api-B1');
      const runB = await mk(a2, 'T34-api-B2');
      const responses = await Promise.all(
        [runA, runB, runA, runB, runA, runB].map((run) =>
          users.lab_technician.post(`/api/sequencing-runs/${run}/libraries`, { extraction_id: e }),
        ),
      );
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of responses.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('rule_violation');
      }
      expect(await librariesOf(observer, e, { activeOnly: true })).toHaveLength(1);
    });

    it('parallel status changes of one run to the same status: one 200, the rest 409 (never 500)', async () => {
      const [e] = await newPassedExtractions(1);
      const run = (await users.lab_technician.post('/api/sequencing-runs', body('T34-api-C', [e])))
        .body.data.run_id;
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          users.lab_technician.patch(`/api/sequencing-runs/${run}`, { status: 'running' }),
        ),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of responses.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('invalid_transition');
      }
    });
  });
});
