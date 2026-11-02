// Owner: C (Testing & QA)
// Purpose: Simultaneous approval attempts
//
// Claims proven (database/procedures/analysis_procedures.sql header, T18 analysis_transaction.sql
// Part 6, CONTRACT 3 and 7): every function starts with SELECT ... FOR UPDATE on the analysis row
// and re-reads the status after the lock, so of N simultaneous approvals exactly one wins and the
// others get EB003 (HTTP 409 conflict); approve vs reject: the loser finds a final status (EB001);
// the detection trigger takes FOR SHARE on the parent run so an approved result never changes
// under the approver; a correction locks itself first and the run it replaces second.
//
// Each database-level race uses its own pg.Client per contender (tests/setup/concurrency.js),
// a barrier start and fresh rows per iteration. Assertions are invariants, never "who wins".
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  addGlobalRole,
  assertNo5xx,
  loginAll,
  removeGlobalRole,
  startApi,
  stopApi,
} from '../setup/api.js';
import {
  activeSessionCount,
  analysisState,
  auditRows,
  closeSessions,
  detectionRows,
  forbiddenCodes,
  inTx,
  newApprovedAnalysis,
  newDraftAnalysis,
  newImportedAnalysis,
  openObserver,
  openSessions,
  race,
  settle,
  summarise,
  waitUntilBlocked,
} from '../setup/concurrency.js';
import { closeTestPool, getPool } from '../setup/testDb.js';
import { readFixture, restoreIfCommitted } from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');

const R = 10; // iterations per race, each on fresh rows
const N = 20; // contenders

const approve =
  (id, actor = 2) =>
  (db) =>
    db.query('SELECT approve_analysis($1, $2)', [id, actor]);
const reject =
  (id, actor = 2, reason = 'T34 race') =>
  (db) =>
    db.query('SELECT reject_analysis($1, $2, $3)', [id, actor, reason]);

/** Audit rows by action for one analysis, as counts. */
async function footprint(db, id) {
  const counts = {};
  for (const row of await auditRows(db, 'analysis_runs', id)) {
    counts[row.action] = (counts[row.action] ?? 0) + 1;
  }
  return counts;
}
const delta = (after, before) => {
  const out = {};
  for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
    const d = (after[key] ?? 0) - (before[key] ?? 0);
    if (d !== 0) out[key] = d;
  }
  return out;
};

function csvForm(analysisId, csv) {
  const form = new FormData();
  form.set('analysis_id', String(analysisId));
  form.set('file', new Blob([csv], { type: 'text/csv' }), 'detections.csv');
  return form;
}

describe.skipIf(!dbAvailable)('double approval and the other analysis races', () => {
  let sessions;
  let observer;
  let users;
  let serialApproval; // audit footprint of ONE ordinary approval (the reference for "one approval")

  beforeAll(async () => {
    await startApi();
    users = await loginAll();
    observer = await openObserver();
    sessions = await openSessions(N);
    // Reference: what exactly one approval writes to the audit log.
    const id = await newImportedAnalysis();
    const before = await footprint(observer, id);
    await inTx(2, approve(id));
    serialApproval = delta(await footprint(observer, id), before);
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
    it('the sessions really run at READ COMMITTED', async () => {
      await sessions[0].begin(2);
      expect(await sessions[0].isolationLevel()).toBe('read committed');
      await sessions[0].rollback();
      expect(serialApproval.approve).toBe(1);
    });

    // A. T18 promise: "20 simultaneous attempts: 1 success, the rest EB003".
    it(`A. ${N} simultaneous approve_analysis: 1 success, ${N - 1} EB003, one approval on record (x${R})`, async () => {
      for (let i = 0; i < R; i++) {
        const id = await newImportedAnalysis({ rows: 3 });
        const before = await footprint(observer, id);
        const results = await race(
          sessions,
          sessions.map(() => approve(id)),
          { actor: 2 },
        );
        const s = summarise(results);
        expect(s, `iteration ${i}: ${s.messages.join(' | ')}`).toMatchObject({
          successes: 1,
          failureCodes: { EB003: N - 1 },
        });
        expect(forbiddenCodes(results)).toEqual([]);

        const state = await analysisState(observer, id);
        expect(state).toMatchObject({
          status: 'approved',
          approved_by: 2,
          imported_by: 5,
          detections: 3,
        });
        expect(state.approved_at).not.toBeNull();
        expect((await analysisState(observer, id)).approved_at).toEqual(state.approved_at);

        // the audit footprint equals that of ONE serial approval: one 'approve' entry, and the
        // row-level trigger entries of one status change
        expect(delta(await footprint(observer, id), before)).toEqual(serialApproval);
        const [entry] = await auditRows(observer, 'analysis_runs', id, 'approve');
        expect(entry.actor_id).toBe(2);
        expect(entry.details).toMatchObject({
          detection_count: 3,
          importer_id: 5,
          to_status: 'approved',
        });
      }
    });

    // B. hold pattern: the second call really waits on the first one's lock.
    it('B. hold: the second approval blocks on the first, then EB003 after COMMIT (not 40001, not EB001)', async () => {
      const [a, b] = sessions;
      const id = await newImportedAnalysis();
      await a.begin(2);
      await a.query('SELECT approve_analysis($1, 2)', [id]);
      const pending = settle(
        b.begin(2).then(() => b.query('SELECT approve_analysis($1, 2)', [id])),
      );
      const waiting = await waitUntilBlocked(observer, b.pid, { by: a.pid });
      expect(waiting.blockers).toContain(a.pid);
      await a.commit();
      const result = await pending;
      await b.rollback();
      expect(result).toMatchObject({ ok: false, code: 'EB003' });
      expect(result.message).toMatch(/already approved/);
      expect(await auditRows(observer, 'analysis_runs', id, 'approve')).toHaveLength(1);
    });

    it('B. hold: when the first approval ROLLS BACK the second succeeds, exactly one approval', async () => {
      const [a, b] = sessions;
      const id = await newImportedAnalysis();
      await a.begin(2);
      await a.query('SELECT approve_analysis($1, 2)', [id]);
      const pending = settle(
        b.begin(2).then(() => b.query('SELECT approve_analysis($1, 2)', [id])),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.rollback();
      const result = await pending;
      expect(result.ok, result.message).toBe(true);
      await b.commit();
      expect(await analysisState(observer, id)).toMatchObject({
        status: 'approved',
        approved_by: 2,
      });
      expect(await auditRows(observer, 'analysis_runs', id, 'approve')).toHaveLength(1);
    });

    // C. approve vs reject
    it(`C. approve vs reject, ${N / 2} each: one winner, the losers EB001/EB003, status matches the winner's audit entry (x${R})`, async () => {
      const seen = new Set();
      for (let i = 0; i < R; i++) {
        const id = await newImportedAnalysis();
        const calls = sessions.map((_, k) => (k % 2 === 0 ? approve(id) : reject(id)));
        const results = await race(sessions, calls, { actor: 2 });
        const s = summarise(results);
        expect(s.successes, s.messages.join(' | ')).toBe(1);
        expect(Object.keys(s.failureCodes).every((c) => ['EB001', 'EB003'].includes(c))).toBe(true);
        expect(forbiddenCodes(results)).toEqual([]);

        const winnerIndex = results.findIndex((r) => r.ok);
        const winner = winnerIndex % 2 === 0 ? 'approved' : 'rejected';
        seen.add(winner);
        expect((await analysisState(observer, id)).status).toBe(winner);
        const approves = await auditRows(observer, 'analysis_runs', id, 'approve');
        const rejects = await auditRows(observer, 'analysis_runs', id, 'reject');
        expect([approves.length, rejects.length]).toEqual(winner === 'approved' ? [1, 0] : [0, 1]);
        // the loser of the other kind is told the status is final (EB001), the same kind EB003
        for (const [k, r] of results.entries()) {
          if (r.ok) continue;
          const sameKind = k % 2 === winnerIndex % 2;
          expect(r.code, `${sameKind ? 'same' : 'other'} kind loser`).toBe(
            sameKind ? 'EB003' : 'EB001',
          );
        }
      }
      expect(seen.size).toBeGreaterThanOrEqual(1); // both orders are forced by the hold tests below
    });

    it('C. hold: approve holds, reject blocks, then EB001 (an approved result is never rejected)', async () => {
      const [a, b] = sessions;
      const id = await newImportedAnalysis();
      await a.begin(2);
      await a.query('SELECT approve_analysis($1, 2)', [id]);
      const pending = settle(
        b.begin(2).then(() => b.query('SELECT reject_analysis($1, 2, $2)', [id, 'T34'])),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.commit();
      const result = await pending;
      await b.rollback();
      expect(result).toMatchObject({ ok: false, code: 'EB001' });
      expect((await analysisState(observer, id)).status).toBe('approved');
      expect(await auditRows(observer, 'analysis_runs', id, 'reject')).toHaveLength(0);
    });

    it('C. hold: reject holds, approve blocks, then EB001 (a rejected analysis is never approved)', async () => {
      const [a, b] = sessions;
      const id = await newImportedAnalysis();
      await a.begin(2);
      await a.query('SELECT reject_analysis($1, 2, $2)', [id, 'T34']);
      const pending = settle(
        b.begin(2).then(() => b.query('SELECT approve_analysis($1, 2)', [id])),
      );
      await waitUntilBlocked(observer, b.pid, { by: a.pid });
      await a.commit();
      const result = await pending;
      await b.rollback();
      expect(result).toMatchObject({ ok: false, code: 'EB001' });
      expect((await analysisState(observer, id)).status).toBe('rejected');
      expect(await auditRows(observer, 'analysis_runs', id, 'approve')).toHaveLength(0);
    });

    // D. approve vs insert of a detection: the FOR SHARE lock of trg_taxon_assignments_immutable
    describe('D. approve vs insert of a detection (FOR SHARE on the parent run)', () => {
      const insertDetection = async (db, id, offset) => {
        const [row] = await detectionRows(1, 1, { offset });
        return db.query(
          `INSERT INTO taxon_assignments (analysis_id, library_id, taxon_id, read_count, confidence, qc_flag)
           SELECT $1, library_id, $3, 7, 0.9, 'pass' FROM sequencing_libraries WHERE library_code = $2`,
          [id, row.library_code, row.taxon_id],
        );
      };

      it('(i) approve holds, the insert blocks, then EB002: an approved result never changes', async () => {
        const [a, b] = sessions;
        const id = await newImportedAnalysis({ rows: 3 });
        await a.begin(2);
        await a.query('SELECT approve_analysis($1, 2)', [id]);
        const pending = settle(b.begin(2).then(() => insertDetection(b, id, 30)));
        await waitUntilBlocked(observer, b.pid, { by: a.pid });
        await a.commit();
        const result = await pending;
        await b.rollback();
        expect(result).toMatchObject({ ok: false, code: 'EB002' });
        expect(result.message).toMatch(/approved and its detections cannot be added to/);
        expect((await analysisState(observer, id)).detections).toBe(3);
      });

      it('(ii) the insert holds, approve blocks, then approves INCLUDING the new row', async () => {
        const [a, b] = sessions;
        const id = await newImportedAnalysis({ rows: 3 });
        await b.begin(2);
        await insertDetection(b, id, 30);
        await a.begin(2);
        const pending = settle(a.query('SELECT approve_analysis($1, 2)', [id]));
        await waitUntilBlocked(observer, a.pid, { by: b.pid });
        await b.commit();
        const result = await pending;
        expect(result.ok, result.message).toBe(true);
        await a.commit();
        expect(await analysisState(observer, id)).toMatchObject({
          status: 'approved',
          detections: 4,
        });
        const [entry] = await auditRows(observer, 'analysis_runs', id, 'approve');
        expect(entry.details.detection_count).toBe(4);
      });

      it(`parallel: 1 approve + ${N - 1} inserts of distinct detections never change an approved result (x${R})`, async () => {
        for (let i = 0; i < R; i++) {
          const id = await newImportedAnalysis({ rows: 3 });
          const calls = sessions.map((_, k) =>
            k === 0 ? approve(id) : (db) => insertDetection(db, id, 40 + k),
          );
          const results = await race(sessions, calls, { actor: 2 });
          expect(forbiddenCodes(results)).toEqual([]);
          expect(results[0].ok, results[0].message).toBe(true);
          const state = await analysisState(observer, id);
          const [entry] = await auditRows(observer, 'analysis_runs', id, 'approve');
          // whatever was committed before the approval is counted, nothing is added afterwards
          expect(state.detections).toBe(entry.details.detection_count);
          expect(state.detections).toBe(3 + results.slice(1).filter((r) => r.ok).length);
          for (const r of results.slice(1).filter((x) => !x.ok)) expect(r.code).toBe('EB002');
        }
      });
    });

    // E. double import
    it(`E. ${6} parallel imports into one draft analysis: 1 success, the rest EB003, the rows are the winner's alone (x${R})`, async () => {
      const contenders = sessions.slice(0, 6);
      for (let i = 0; i < R; i++) {
        const id = await newDraftAnalysis();
        const payloads = await Promise.all(
          contenders.map((_, k) => detectionRows(1, 3, { offset: k * 4, qcFlag: 'pass' })),
        );
        const calls = payloads.map(
          (p) => (db) =>
            db.query('SELECT import_detections($1, $2::jsonb, 5)', [id, JSON.stringify(p)]),
        );
        const results = await race(contenders, calls, { actor: 5 });
        const s = summarise(results);
        expect(s, s.messages.join(' | ')).toMatchObject({
          successes: 1,
          failureCodes: { EB003: 5 },
        });
        const winner = results.findIndex((r) => r.ok);
        const { rows } = await getPool().query(
          `SELECT l.library_code, ta.taxon_id::int AS taxon_id, ta.read_count
             FROM taxon_assignments ta JOIN sequencing_libraries l ON l.library_id = ta.library_id
            WHERE ta.analysis_id = $1 ORDER BY l.library_code, ta.taxon_id`,
          [id],
        );
        const expected = payloads[winner]
          .map((p) => ({
            library_code: p.library_code,
            taxon_id: p.taxon_id,
            read_count: p.read_count,
          }))
          .sort((x, y) => x.library_code.localeCompare(y.library_code) || x.taxon_id - y.taxon_id);
        expect(rows).toEqual(expected);
        expect((await analysisState(observer, id)).status).toBe('imported');
      }
    });

    // F. supersession
    describe('F. supersession', () => {
      it(`${N} parallel approvals of a correction: 1 success, the rest EB003, the old run superseded exactly once (x${R})`, async () => {
        for (let i = 0; i < R; i++) {
          const original = await newApprovedAnalysis();
          const correction = await newImportedAnalysis({ supersedes: original });
          const results = await race(
            sessions,
            sessions.map(() => approve(correction)),
            { actor: 2 },
          );
          const s = summarise(results);
          expect(s, s.messages.join(' | ')).toMatchObject({
            successes: 1,
            failureCodes: { EB003: N - 1 },
          });
          expect((await analysisState(observer, original)).status).toBe('superseded');
          expect((await analysisState(observer, correction)).status).toBe('approved');
          const superseded = (
            await auditRows(observer, 'analysis_runs', original, 'update')
          ).filter((e) => e.details?.to_status === 'superseded');
          expect(superseded).toHaveLength(1);
          expect(superseded[0].details.superseded_by).toBe(correction);
          expect(await auditRows(observer, 'analysis_runs', correction, 'approve')).toHaveLength(1);
        }
      });

      it('two corrections of the same analysis cannot both exist: one 23505 (uq_analysis_runs_supersedes_analysis_id)', async () => {
        for (let i = 0; i < R; i++) {
          const original = await newApprovedAnalysis();
          const create = (db) =>
            db.query(
              `INSERT INTO analysis_runs (run_id, marker_id, pipeline_name, pipeline_version, reference_db, supersedes_analysis_id)
               VALUES (1, 1, 'T34 correction', '2', 'T34-db', $1)`,
              [original],
            );
          const results = await race(sessions, [create, create], { actor: 5 });
          const s = summarise(results);
          expect(s, s.messages.join(' | ')).toMatchObject({
            successes: 1,
            failureCodes: { 23505: 1 },
          });
          const { rows } = await getPool().query(
            'SELECT count(*)::int AS n FROM analysis_runs WHERE supersedes_analysis_id = $1',
            [original],
          );
          expect(rows[0].n).toBe(1);
        }
      });

      // Races such as "approve the correction while another session rejects the approved original" are
      // not stated by the spec: an approved analysis cannot be rejected (EB001, "corrected by a new
      // run, never rejected"), so there is no concurrent outcome to assert beyond what H covers.
    });

    // G. isolation guard
    it('G. READ COMMITTED never yields 40001; REPEATABLE READ loses with EB003 or 40001 (observation)', async () => {
      const readCommitted = await newImportedAnalysis();
      const rc = await race(
        sessions.slice(0, 10),
        sessions.slice(0, 10).map(() => approve(readCommitted)),
        { actor: 2 },
      );
      expect(rc.filter((r) => !r.ok && r.code === '40001')).toEqual([]);
      expect(summarise(rc).failureCodes).toEqual({ EB003: 9 });

      const repeatable = await newImportedAnalysis();
      const rr = await race(
        sessions.slice(0, 10),
        sessions.slice(0, 10).map(() => approve(repeatable)),
        {
          actor: 2,
          isolation: 'REPEATABLE READ',
        },
      );
      const s = summarise(rr);
      expect(s.successes, s.messages.join(' | ')).toBe(1);
      expect(Object.keys(s.failureCodes).every((c) => ['EB003', '40001'].includes(c))).toBe(true);
      // observation: the T18 script and the procedure header say the loser gets 40001 here
      expect((await analysisState(observer, repeatable)).status).toBe('approved');
      expect(await auditRows(observer, 'analysis_runs', repeatable, 'approve')).toHaveLength(1);
    });

    // H. no deadlock between the correction (locks C then O) and callers that lock only O
    it(`H. approve(C) racing approve(O) and reject(O): exactly one winner, no deadlock (x${R})`, async () => {
      for (let i = 0; i < R; i++) {
        const original = await newApprovedAnalysis();
        const correction = await newImportedAnalysis({ supersedes: original });
        const calls = sessions
          .slice(0, 12)
          .map((_, k) =>
            k < 4 ? approve(correction) : k < 8 ? approve(original) : reject(original),
          );
        const results = await race(sessions, calls, { actor: 2 });
        expect(forbiddenCodes(results), 'deadlock or serialization failure').toEqual([]);
        const s = summarise(results);
        expect(s.successes, s.messages.join(' | ')).toBe(1);
        expect(results.findIndex((r) => r.ok)).toBeLessThan(4); // only the correction can win
        expect(Object.keys(s.failureCodes).every((c) => ['EB001', 'EB003'].includes(c))).toBe(true);
        expect((await analysisState(observer, original)).status).toBe('superseded');
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('API level (POST /api/analyses/:id/approve, /reject, /import)', () => {
    const post = (client, path, body) => client.post(path, body);

    it('10 parallel approves by the same PI: one 200 with the approver, nine 409 conflict', async () => {
      const id = await newImportedAnalysis();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          post(users.principal_investigator, `/api/analyses/${id}/approve`),
        ),
      );
      const ok = responses.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      expect(ok[0].body.data).toMatchObject({
        analysis_id: id,
        status: 'approved',
        approved_by: 2,
      });
      expect(ok[0].body.data.approved_at).toBeTruthy();
      expect(ok[0].body.data.approved_by_name).toBeTruthy();
      const losers = responses.filter((r) => r.status !== 200);
      expect(losers.map((r) => r.status)).toEqual(Array(9).fill(409));
      for (const r of losers) {
        expect(r.body.error.code).toBe('conflict');
        expect(r.body.error.message).toMatch(/already approved/);
      }
      expect((await analysisState(observer, id)).status).toBe('approved');
    });

    it('two different approvers (administrator and PI), 5 requests each: one 200, nine 409', async () => {
      const id = await newImportedAnalysis();
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          post(
            i % 2 ? users.administrator : users.principal_investigator,
            `/api/analyses/${id}/approve`,
          ),
        ),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(9);
      expect(await auditRows(observer, 'analysis_runs', id, 'approve')).toHaveLength(1);
    });

    // CONTRACT 9 / D17: the importer never approves their own work, whoever else races them
    it('the importer holding the PI role never wins against a legitimate approver (D17)', async () => {
      const id = await newImportedAnalysis({ importer: 5 });
      await addGlobalRole(5, 'principal_investigator');
      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            post(
              i % 2 ? users.analyst : users.principal_investigator,
              `/api/analyses/${id}/approve`,
            ),
          ),
        );
        const byImporter = responses.filter((_, i) => i % 2 === 1);
        const byPi = responses.filter((_, i) => i % 2 === 0);
        expect(byImporter.map((r) => r.status).every((s) => s === 422 || s === 409)).toBe(true);
        expect(
          byImporter.every((r) => ['rule_violation', 'conflict'].includes(r.body.error.code)),
        ).toBe(true);
        expect(byPi.filter((r) => r.status === 200)).toHaveLength(1);
        expect((await analysisState(observer, id)).approved_by).toBe(2);
      } finally {
        await removeGlobalRole(5, 'principal_investigator');
      }
    });

    it('approve vs reject over HTTP: one 200, every other answer 409, never a 500', async () => {
      for (let i = 0; i < 3; i++) {
        const id = await newImportedAnalysis();
        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, k) =>
            k % 2 === 0
              ? post(users.principal_investigator, `/api/analyses/${id}/approve`)
              : post(users.administrator, `/api/analyses/${id}/reject`, { reason: 'T34 race' }),
          ),
        );
        expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
        for (const r of responses.filter((x) => x.status !== 200)) {
          expect(r.status).toBe(409);
          expect(['conflict', 'invalid_transition']).toContain(r.body.error.code);
        }
        const status = (await analysisState(observer, id)).status;
        expect(['approved', 'rejected']).toContain(status);
      }
    });

    it('4 parallel CSV imports into one draft analysis: one 201, the rest 409 conflict', async () => {
      const id = await newDraftAnalysis({ markerId: 2 });
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          users.analyst.request('POST', '/api/analyses/import', undefined, {
            raw: csvForm(id, readFixture('detections_valid.csv')),
          }),
        ),
      );
      expect(responses.filter((r) => r.status === 201 || r.status === 200)).toHaveLength(1);
      for (const r of responses.filter((x) => ![200, 201].includes(x.status))) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('conflict');
      }
      expect((await analysisState(observer, id)).status).toBe('imported');
    });
  });
});
