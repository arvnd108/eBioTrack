// Owner: C (Testing & QA)
// Purpose: Helpers for the concurrency suites (T34): real parallel sessions, barrier start, hold pattern
//
// Every contender is its OWN pg.Client (never the pool), at READ COMMITTED, with lock_timeout and
// statement_timeout set so a locking bug is a failure and never a hang.
//
//   const sessions = await openSessions(20);
//   try {
//     const results = await race(sessions, sessions.map(() => (db) => db.query('SELECT approve_analysis($1, 2)', [id])), { actor: 2 });
//     expect(summarise(results).failureCodes).toEqual({ EB003: 19 });
//   } finally { await closeSessions(sessions); }
//
// race(): all sessions BEGIN and set the acting user first; only then one shared promise is
// released, so every call is sent in the same tick. Each call is followed by COMMIT (success) or
// ROLLBACK (error) inside its own session.
//
// Hold pattern (deterministic lock order, proves that B really waited on A):
//   await a.begin(2); await a.query('SELECT approve_analysis($1, 2)', [id]);   // A holds its locks
//   const pending = settle(b.begin(2).then(() => b.query('SELECT approve_analysis($1, 2)', [id])));
//   await waitUntilBlocked(observerClient, b.pid, { by: a.pid });               // B is waiting on A
//   await a.commit();                                                          // or a.rollback()
//   const result = await pending;                                              // { ok, code, ... }
//
// Fixture factories create FRESH committed rows per call (analyses, extractions, events), through
// the real procedures and constraints (no trigger is disabled). A file ends with restoreIfCommitted().
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { assertSafeTarget, getPool, getTestDatabaseUrl } from './testDb.js';
import { committed } from './transactions.js';

export const SESSION_LOCK_TIMEOUT = '10s';
export const SESSION_STATEMENT_TIMEOUT = '20s';

/** Deterministic PRNG (mulberry32) for shuffles; Math.random is not allowed in the suites. */
export function prng(seed = 20260601) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with the seeded PRNG; returns a new array. */
export function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Normalise a thrown value: { ok: false, code, message, detail }. */
function failure(err) {
  return {
    ok: false,
    code: err?.code ?? 'UNKNOWN',
    message: err?.message ?? String(err),
    detail: err?.detail ?? null,
  };
}

/** Turn a promise into one that never rejects: { ok: true, value } or the failure shape. */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return failure(err);
  }
}

export class Session {
  constructor(client, pid, isolation) {
    this.client = client;
    this.pid = pid;
    this.isolation = isolation;
    this.open = false;
  }

  /** BEGIN, optionally with the acting user (transaction-local, like withTransaction). */
  async begin(actor = null, isolation = null) {
    await this.client.query(`BEGIN${isolation ? ` ISOLATION LEVEL ${isolation}` : ''}`);
    this.open = true;
    if (actor != null) {
      await this.client.query("SELECT set_config('app.current_user_id', $1, true)", [
        String(actor),
      ]);
    }
  }

  query(text, params) {
    return this.client.query(text, params);
  }

  async commit() {
    this.open = false;
    await this.client.query('COMMIT');
  }

  async rollback() {
    this.open = false;
    await this.client.query('ROLLBACK');
  }

  /** The isolation level the current transaction really runs at. */
  async isolationLevel() {
    return (await this.client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  }
}

/**
 * Open n dedicated connections. All of them are connected (and their pids known) before any
 * contender is released.
 * @returns {Promise<Session[]>}
 */
export async function openSessions(n, { lockTimeout = SESSION_LOCK_TIMEOUT } = {}) {
  const url = getTestDatabaseUrl();
  assertSafeTarget(url);
  const sessions = [];
  try {
    for (let i = 0; i < n; i++) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      client.on('error', () => {});
      await client.query(`SET lock_timeout = '${lockTimeout}'`);
      await client.query(`SET statement_timeout = '${SESSION_STATEMENT_TIMEOUT}'`);
      const { rows } = await client.query(
        'SELECT pg_backend_pid() AS pid, current_setting($1) AS iso',
        ['default_transaction_isolation'],
      );
      if (rows[0].iso !== 'read committed') {
        throw new Error(`Session default isolation is ${rows[0].iso}, expected read committed`);
      }
      sessions.push(new Session(client, rows[0].pid, rows[0].iso));
    }
  } catch (err) {
    await closeSessions(sessions);
    throw err;
  }
  return sessions;
}

/** Roll back anything open and close every connection; safe to call twice. */
export async function closeSessions(sessions) {
  await Promise.all(
    sessions.map(async (s) => {
      try {
        if (s.open) await s.rollback();
      } catch {
        // the connection may already be gone
      }
      try {
        await s.client.end();
      } catch {
        // already closed
      }
    }),
  );
}

/**
 * Start all calls together. calls[i] = (client) => Promise, run on sessions[i].
 * Phase 1: every session BEGINs and sets its actor. Phase 2: one shared promise releases every
 * call in the same tick. Phase 3: COMMIT after a success, ROLLBACK after an error.
 * @param {Session[]} sessions
 * @param {Array<(db: pg.Client) => Promise<unknown>>} calls
 * @param {{actor?: number | number[] | null, isolation?: string | null}} [options]
 */
export async function race(sessions, calls, { actor = null, isolation = null } = {}) {
  if (calls.length > sessions.length) throw new Error('race(): more calls than sessions');
  const used = sessions.slice(0, calls.length);
  await Promise.all(
    used.map((s, i) => s.begin(Array.isArray(actor) ? actor[i] : actor, isolation)),
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = used.map(async (s, i) => {
    await gate;
    try {
      const value = await calls[i](s.client);
      await s.commit();
      return { ok: true, value };
    } catch (err) {
      const out = failure(err);
      try {
        await s.rollback();
      } catch {
        // the session is unusable; closeSessions() will cope
      }
      return out;
    }
  });
  release();
  return Promise.all(running);
}

/** Counts of successes and failure codes, for assertions and failure messages. */
export function summarise(results) {
  const failureCodes = {};
  for (const r of results) {
    if (!r.ok) failureCodes[r.code] = (failureCodes[r.code] ?? 0) + 1;
  }
  return {
    successes: results.filter((r) => r.ok).length,
    failures: results.filter((r) => !r.ok).length,
    failureCodes,
    messages: results.filter((r) => !r.ok).map((r) => `${r.code}: ${r.message}`),
  };
}

/** SQLSTATEs that must never appear in a READ COMMITTED run: deadlock and serialization failure. */
export function forbiddenCodes(results) {
  return results.filter((r) => !r.ok && ['40P01', '40001'].includes(r.code)).map((r) => r.code);
}

/**
 * Poll pg_stat_activity until `pid` waits on a lock (optionally held by `by`). Bounded polling
 * every 25 ms with a hard deadline; on a timeout it rejects with the current activity so the
 * failure message shows what happened instead.
 */
export async function waitUntilBlocked(observer, pid, { timeoutMs = 5000, by = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await observer.query(
      `SELECT wait_event_type, wait_event, state, pg_blocking_pids(pid) AS blockers
         FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    const row = rows[0];
    if (row?.wait_event_type === 'Lock' && (by == null || row.blockers.includes(by))) {
      return { waitEvent: row.wait_event, blockers: row.blockers };
    }
    if (Date.now() > deadline) {
      const activity = await observer.query(
        `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers, left(query, 80) AS query
           FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      throw new Error(
        `Session ${pid} did not block${by == null ? '' : ` on ${by}`} within ${timeoutMs} ms ` +
          `(second call did not block). Activity: ${JSON.stringify(activity.rows)}`,
      );
    }
    await sleep(25);
  }
}

/** A plain autocommit connection for watching pg_stat_activity and reading state. */
export async function openObserver() {
  const url = getTestDatabaseUrl();
  assertSafeTarget(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  client.on('error', () => {});
  await client.query("SET lock_timeout = '5s'");
  return client;
}

/** Sessions of this database that are not idle (the "quiet database" check). */
export async function activeSessionCount(observer) {
  const { rows } = await observer.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
  );
  return rows[0].n;
}

// -------------------------------------------------------------------------------------------
// Fixture factories: fresh committed rows, built through the real procedures and constraints.
// -------------------------------------------------------------------------------------------

/** Run fn(client) in one committed transaction with the acting user set. Uses the shared pool. */
export async function inTx(actor, fn) {
  committed();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (actor != null) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(actor)]);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Detection rows for sequencing run `runId`: libraries of the run x taxa, `count` rows, `offset` into the grid. */
export async function detectionRows(runId, count = 3, { offset = 0, qcFlag = 'pass' } = {}) {
  const { rows: libs } = await getPool().query(
    'SELECT library_code FROM sequencing_libraries WHERE run_id = $1 ORDER BY library_id',
    [runId],
  );
  const { rows: taxa } = await getPool().query(
    'SELECT taxon_id::int AS id FROM taxa ORDER BY taxon_id',
  );
  const grid = [];
  for (const lib of libs) for (const t of taxa) grid.push([lib.library_code, t.id]);
  return Array.from({ length: count }, (_, i) => {
    const [library_code, taxon_id] = grid[(offset + i) % grid.length];
    return {
      library_code,
      taxon_id,
      read_count: 100 + offset + i,
      confidence: 0.9,
      qc_flag: qcFlag,
    };
  });
}

/** A new draft analysis on run `runId` (marker 1 by default). */
export async function newDraftAnalysis({
  runId = 1,
  markerId = 1,
  supersedes = null,
  name = 'T34',
} = {}) {
  return inTx(5, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO analysis_runs (run_id, marker_id, pipeline_name, pipeline_version, reference_db, supersedes_analysis_id)
       VALUES ($1, $2, $3, '1.0', 'T34-db', $4) RETURNING analysis_id::int AS id`,
      [runId, markerId, name, supersedes],
    );
    return rows[0].id;
  });
}

/** A new analysis in `imported` with `rows` detections, imported through import_detections() by `importer`. */
export async function newImportedAnalysis({
  importer = 5,
  runId = 1,
  rows = 3,
  supersedes = null,
} = {}) {
  const id = await newDraftAnalysis({ runId, supersedes });
  const payload = await detectionRows(runId, rows);
  await inTx(importer, (db) =>
    db.query('SELECT import_detections($1, $2::jsonb, $3)', [
      id,
      JSON.stringify(payload),
      importer,
    ]),
  );
  return id;
}

/** A new analysis that is approved (imported by user 5, approved by user 2). */
export async function newApprovedAnalysis({ runId = 1, rows = 3 } = {}) {
  const id = await newImportedAnalysis({ runId, rows });
  await inTx(2, (db) => db.query('SELECT approve_analysis($1, 2)', [id]));
  return id;
}

/** Everything the analysis tests read back about one analysis. */
export async function analysisState(db, id) {
  const { rows } = await db.query(
    `SELECT status, approved_by::int AS approved_by, approved_at, imported_by::int AS imported_by,
            (SELECT count(*)::int FROM taxon_assignments WHERE analysis_id = $1) AS detections
       FROM analysis_runs WHERE analysis_id = $1`,
    [id],
  );
  return rows[0];
}

/** Audit rows of one entity, optionally by action. */
export async function auditRows(db, entityType, entityId, action = null) {
  const { rows } = await db.query(
    `SELECT audit_id::int AS audit_id, action::text AS action, actor_id::int AS actor_id, details
       FROM audit_logs
      WHERE entity_type = $1 AND entity_id = $2 AND ($3::text IS NULL OR action::text = $3)
      ORDER BY audit_id`,
    [entityType, entityId, action],
  );
  return rows;
}

let nextBatchDay = 1;

/**
 * n extractions that passed QC and are free to book. Built like the lab does it (batch ->
 * extraction -> QC measurement -> verdict), spread over samples 1-12 (project 1); attempt numbers follow the
 * highest attempt of the sample.
 */
export async function newPassedExtractions(n, { qc = 'pass' } = {}) {
  const day = String(1 + (nextBatchDay++ % 27)).padStart(2, '0');
  return inTx(4, async (db) => {
    const { rows: batch } = await db.query(
      `INSERT INTO extraction_batches (lab_id, operator_id, extraction_date, kit_name, notes)
       VALUES (1, 4, $1, 'T34 kit', 'T34 concurrency fixture') RETURNING batch_id::int AS id`,
      [`2026-05-${day}`],
    );
    const ids = [];
    for (let i = 0; i < n; i++) {
      const sampleId = 1 + (i % 12);
      const { rows } = await db.query(
        `INSERT INTO dna_extractions (sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280)
         VALUES ($1, $2, COALESCE((SELECT max(attempt_number) FROM dna_extractions WHERE sample_id = $1), 0) + 1, 25.000, 1.90)
         RETURNING extraction_id::int AS id`,
        [sampleId, batch[0].id],
      );
      ids.push(rows[0].id);
      if (qc !== 'pending') {
        await db.query(
          `INSERT INTO quality_control_results (sample_id, qc_type, result, metric_value, notes, recorded_by)
           VALUES ($1, 'concentration', $2, 25.000, 'T34 fixture', 4)`,
          [sampleId, qc],
        );
        await db.query(
          'UPDATE dna_extractions SET qc_status = $2::qc_status WHERE extraction_id = $1',
          [rows[0].id, qc],
        );
      }
    }
    return ids.sort((a, b) => a - b);
  });
}

/** A new collection event in project 1 / site 1, collected by user 3 (the field researcher). */
export async function newEvent({ projectId = 1, siteId = 1 } = {}) {
  return inTx(3, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO collection_events (project_id, site_id, collector_id, collected_at)
       VALUES ($1, $2, 3, '2026-05-20T08:00:00Z') RETURNING event_id::int AS id`,
      [projectId, siteId],
    );
    return rows[0].id;
  });
}

/** Libraries of one extraction (all runs), for "exactly one booking" assertions. */
export async function librariesOf(db, extractionId, { activeOnly = false } = {}) {
  const { rows } = await db.query(
    `SELECT l.library_id::int AS library_id, l.library_code, l.run_id::int AS run_id, r.status
       FROM sequencing_libraries l JOIN sequencing_runs r ON r.run_id = l.run_id
      WHERE l.extraction_id = $1 AND ($2::boolean = false OR r.status IN ('planned', 'running'))
      ORDER BY l.library_id`,
    [extractionId, activeOnly],
  );
  return rows;
}
