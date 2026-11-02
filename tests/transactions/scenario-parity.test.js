// Owner: C (Testing & QA)
// Purpose: Atomicity cases for the Lab and Field T18 transaction scenarios
//
// The same kind of cases as project-create.test.js for the other two slices, kept to what
// database/transactions/lab_transaction.sql and field_transaction.sql demonstrate:
//   Lab   (actor 4, lab technician): create_sequencing_run / assign_extraction_to_run
//   Field (actor 3, field researcher): collection_events + environmental_measurements +
//         register_sample() in one transaction.
//
// Audit expectations, derived from the installed audit triggers (not from a first run):
//   Lab:   sequencing_runs and sequencing_libraries are audited, so a run with N libraries adds
//          1 + N 'insert' rows (entity_id = run_id / library_id), actor = the acting user.
//          dna_extractions is audited too, but FOR UPDATE changes no row, so no extraction audit row.
//   Field: collection_events and samples are audited; environmental_measurements and
//          sample_status_history are not. An event with 4 measurements and 3 samples adds 1 + 3 = 4
//          audit rows, 3 history rows (NULL -> collected, changed_by = the actor).
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeTestPool } from '../setup/testDb.js';
import {
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

const TECH = 4;
const FIELD = 3;
const LAB = 1;

let watcher;
const auditMax = async () =>
  Number((await watcher.query('SELECT COALESCE(max(audit_id), 0) AS m FROM audit_logs')).rows[0].m);
const auditAfter = async (baseline) =>
  (
    await watcher.query(
      `SELECT actor_id::int AS actor_id, entity_type, entity_id::int AS entity_id, action
         FROM audit_logs WHERE audit_id > $1 ORDER BY audit_id`,
      [baseline],
    )
  ).rows;
const tally = (rows) => {
  const out = {};
  for (const r of rows)
    out[`${r.entity_type}/${r.action}`] = (out[`${r.entity_type}/${r.action}`] ?? 0) + 1;
  return out;
};

describe.skipIf(!dbAvailable)('lab and field: transaction scenarios', () => {
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

  // ============================================================================================
  // Lab
  // ============================================================================================
  const createRun = async (db, ids, platform = 'Illumina MiSeq') =>
    (
      await db.query(
        `SELECT create_sequencing_run($1, $2, DATE '2026-06-01', $3::bigint[], $4) AS id`,
        [LAB, platform, ids, TECH],
      )
    ).rows[0].id;
  const assign = async (db, run, extraction) =>
    (await db.query('SELECT assign_extraction_to_run($1, $2, $3) AS id', [run, extraction, TECH]))
      .rows[0].id;
  const runRow = async (id) =>
    (
      await watcher.query(
        `SELECT run_id::int AS id, status, lab_id::int AS lab_id, run_code FROM sequencing_runs WHERE run_id = $1`,
        [id],
      )
    ).rows[0];
  const libraries = async (run) =>
    (
      await watcher.query(
        `SELECT extraction_id::int AS extraction_id, library_code FROM sequencing_libraries
          WHERE run_id = $1 ORDER BY extraction_id`,
        [run],
      )
    ).rows;

  describe('lab: create_sequencing_run commit path', () => {
    const a = {};
    const sp = {};
    beforeAll(async () => {
      committed();
      a.extractionsBefore = (
        await snapshot(watcher, ['dna_extractions'])
      ).fingerprints.dna_extractions;
      a.baseline = await auditMax();
      a.id = await runTransaction(
        async (db) => {
          const id = await createRun(db, [1, 2, 3]);
          a.inside = (await auditAfter(a.baseline)).length;
          return id;
        },
        { actorId: TECH },
      );
      a.audit = await auditAfter(a.baseline);

      // savepoint recovery: a bad booking (extraction 17 failed QC) costs only the bad step
      sp.baseline = await auditMax();
      sp.id = await runTransaction(
        async (db) => {
          const id = await createRun(db, [6]);
          await db.query('SAVEPOINT s');
          sp.failure = await caught(() => assign(db, id, 17));
          await db.query('ROLLBACK TO SAVEPOINT s');
          await assign(db, id, 7);
          return id;
        },
        { actorId: TECH },
      );
      sp.audit = await auditAfter(sp.baseline);
      a.extractionsAfter = (
        await snapshot(watcher, ['dna_extractions'])
      ).fingerprints.dna_extractions;
    });
    afterAll(() => restoreIfCommitted());

    it('the observer sees nothing until COMMIT', () => {
      expect(a.inside).toBe(0);
    });
    it('without extraction 17 the run is planned with one library per extraction (LIB-<id>, RUN-<id>)', async () => {
      const run = await runRow(a.id);
      expect(run).toMatchObject({ status: 'planned', lab_id: LAB });
      expect(Number(a.id)).toBeGreaterThanOrEqual(1000);
      expect(run.run_code).toBe(`RUN-${a.id}`);
      const libs = await libraries(a.id);
      expect(libs.map((l) => l.extraction_id)).toEqual([1, 2, 3]);
      expect(libs.every((l) => /^LIB-\d{4,}$/.test(l.library_code))).toBe(true);
      expect(new Set(libs.map((l) => l.library_code)).size).toBe(3);
    });
    it('the extractions themselves are unchanged (FOR UPDATE locks, it does not write)', () => {
      expect(a.extractionsAfter).toBe(a.extractionsBefore);
    });
    it('audit: 4 insert rows (1 run + 3 libraries), all actor 4', () => {
      expect(tally(a.audit)).toEqual({
        'sequencing_runs/insert': 1,
        'sequencing_libraries/insert': 3,
      });
      expect(a.audit.every((r) => r.actor_id === TECH)).toBe(true);
      expect(a.audit.find((r) => r.entity_type === 'sequencing_runs').entity_id).toBe(Number(a.id));
    });

    it('booking an extraction already on the planned run -> EB002 "already booked", nothing partial', async () => {
      const before = await snapshot(watcher);
      const err = await caught(() =>
        runTransaction((db) => createRun(db, [4, 3]), { actorId: TECH }),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe(`Extraction 3 is already booked on run RUN-${a.id} (planned)`);
      expect(await snapshot(watcher)).toEqual(before);
      const single = await caught(() =>
        runTransaction((db) => assign(db, a.id, 2), { actorId: TECH }),
      );
      expect(single.code).toBe('EB002');
      expect(await snapshot(watcher)).toEqual(before);
    });
    it('a second run in the same transaction with a conflicting extraction undoes the FIRST run too', async () => {
      const before = await snapshot(watcher);
      let firstRun;
      const err = await caught(() =>
        runTransaction(
          async (db) => {
            firstRun = await createRun(db, [4, 5]);
            await createRun(db, [5, 8]);
          },
          { actorId: TECH },
        ),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toMatch(/^Extraction 5 is already booked on run RUN-\d+ \(planned\)$/);
      expect(await runRow(firstRun)).toBeUndefined();
      expect(await snapshot(watcher)).toEqual(before);
    });

    it('savepoint: the failed-QC extraction 17 is refused (EB002) and undone; the run keeps libraries for 6 and 7', async () => {
      expect(sp.failure.code).toBe('EB002');
      expect(sp.failure.message).toBe('Extraction 17 has not passed QC (qc_status fail)');
      expect((await libraries(sp.id)).map((l) => l.extraction_id)).toEqual([6, 7]);
      expect(tally(sp.audit)).toEqual({
        'sequencing_runs/insert': 1,
        'sequencing_libraries/insert': 2,
      });
    });
  });

  describe('lab: create_sequencing_run rolls back everything', () => {
    let before;
    let baseline;
    beforeAll(async () => {
      before = await snapshot(watcher);
      baseline = await auditMax();
    });
    afterEach(async () => {
      expect(await snapshot(watcher)).toEqual(before);
      expect(await auditAfter(baseline)).toEqual([]);
    });

    it('a list containing the failed-QC extraction 17 -> EB002, no run, no libraries, no audit rows', async () => {
      const err = await caught(() =>
        runTransaction((db) => createRun(db, [1, 2, 17]), { actorId: TECH }),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('Extraction 17 has not passed QC (qc_status fail)');
      expect(err.detail).toBe('Only extractions with qc_status pass can be sequenced.');
    });
    it('an unknown extraction (9999) -> 23503, nothing created', async () => {
      const err = await caught(() =>
        runTransaction((db) => createRun(db, [1, 9999]), { actorId: TECH }),
      );
      expect(err.code).toBe('23503');
      expect(err.message).toBe('Extraction 9999 does not exist');
    });
    it('an injected error after a successful run creation rolls back the run and its libraries', async () => {
      const injected = new Error('injected after create_sequencing_run');
      let inside;
      const err = await caught(() =>
        runTransaction(
          async (db) => {
            const id = await createRun(db, [1, 2]);
            inside = (
              await db.query(
                'SELECT count(*)::int AS n FROM sequencing_libraries WHERE run_id = $1',
                [id],
              )
            ).rows[0].n;
            throw injected;
          },
          { actorId: TECH },
        ),
      );
      expect(err).toBe(injected);
      expect(inside).toBe(2);
    });
  });

  // ============================================================================================
  // Field
  // ============================================================================================
  const newEvent = async (db, note) =>
    (
      await db.query(
        `INSERT INTO collection_events (project_id, site_id, collector_id, collected_at, notes)
         VALUES (1, 1, $1, '2026-06-15 08:00:00+00', $2) RETURNING event_id`,
        [FIELD, note],
      )
    ).rows[0].event_id;
  const measure = (db, event, rows = MEASUREMENTS) =>
    db.query(
      `INSERT INTO environmental_measurements (event_id, parameter, value, unit)
       SELECT $1, v.p, v.val, v.u FROM unnest($2::text[], $3::numeric[], $4::text[]) AS v(p, val, u)`,
      [event, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2])],
    );
  const MEASUREMENTS = [
    ['temperature_c', 24.6, 'celsius'],
    ['ph', 7.8, 'pH'],
    ['dissolved_oxygen_mg_l', 6.9, 'mg/L'],
    ['turbidity_ntu', 12.4, 'NTU'],
  ];
  const register = async (db, event, type, volume, depth, storage = null) =>
    (
      await db.query('SELECT register_sample($1, $2, $3, $4, $5, $6) AS id', [
        event,
        type,
        volume,
        depth,
        storage,
        FIELD,
      ])
    ).rows[0].id;
  const eventSamples = async (event) =>
    (
      await watcher.query(
        `SELECT s.sample_id::int AS id, s.sample_code, s.status,
                (SELECT count(*)::int FROM sample_status_history h WHERE h.sample_id = s.sample_id) AS history
           FROM samples s WHERE s.event_id = $1 ORDER BY s.sample_id`,
        [event],
      )
    ).rows;

  describe('field: event, measurements and samples commit path', () => {
    const a = {};
    const sp = {};
    beforeAll(async () => {
      committed();
      a.before = await snapshot(watcher);
      a.baseline = await auditMax();
      a.event = await runTransaction(
        async (db) => {
          const event = await newEvent(db, 'T32 field trip');
          await measure(db, event);
          await register(db, event, 1, '1000.00', '0.50');
          await register(db, event, 1, '500.00', '1.00');
          await register(db, event, 3, null, null, 'Freezer D-1');
          a.seenInside = (await auditAfter(a.baseline)).length;
          return event;
        },
        { actorId: FIELD },
      );
      a.audit = await auditAfter(a.baseline);
      a.after = await snapshot(watcher);

      sp.event = await runTransaction(
        async (db) => {
          const event = await newEvent(db, 'T32 savepoint trip');
          await register(db, event, 1, '10.00', '0.10');
          await db.query('SAVEPOINT m');
          sp.failure = await caught(() => register(db, event, 1, '-1', '0.10'));
          await db.query('ROLLBACK TO SAVEPOINT m');
          await register(db, event, 1, '20.00', '0.20');
          return event;
        },
        { actorId: FIELD },
      );
    });
    afterAll(() => restoreIfCommitted());

    it('the observer sees none of it before COMMIT', () => {
      expect(a.seenInside).toBe(0);
    });
    it('after COMMIT: 1 event, 4 measurements, 3 samples and 3 history rows were added', () => {
      const delta = (t) => a.after.counts[t] - a.before.counts[t];
      expect([
        delta('collection_events'),
        delta('environmental_measurements'),
        delta('samples'),
        delta('sample_status_history'),
      ]).toEqual([1, 4, 3, 3]);
    });
    it('each sample is collected, has a first history row, and a code EB-20260615-<event>-00n in call order', async () => {
      const samples = await eventSamples(a.event);
      expect(samples.map((s) => s.status)).toEqual(['collected', 'collected', 'collected']);
      expect(samples.map((s) => s.history)).toEqual([1, 1, 1]);
      const event = String(a.event).padStart(4, '0');
      expect(samples.map((s) => s.sample_code)).toEqual([
        `EB-20260615-${event}-001`,
        `EB-20260615-${event}-002`,
        `EB-20260615-${event}-003`,
      ]);
      const { rows } = await watcher.query(
        `SELECT old_status, new_status, changed_by::int AS changed_by
           FROM sample_status_history WHERE sample_id = ANY($1::bigint[])`,
        [samples.map((s) => s.id)],
      );
      expect(rows).toEqual(
        Array(3).fill({ old_status: null, new_status: 'collected', changed_by: FIELD }),
      );
    });
    it('audit: 4 insert rows (1 event + 3 samples), all actor 3; measurements and history are not audited', () => {
      expect(tally(a.audit)).toEqual({ 'collection_events/insert': 1, 'samples/insert': 3 });
      expect(a.audit.every((r) => r.actor_id === FIELD)).toBe(true);
    });

    it('savepoint: the invalid volume (-1) fails 23514 and is undone; the event keeps samples -001 and -002', async () => {
      expect(sp.failure.code).toBe('23514');
      expect(sp.failure.message).toBe('Sample volume must be greater than zero');
      const samples = await eventSamples(sp.event);
      const event = String(sp.event).padStart(4, '0');
      expect(samples.map((s) => s.sample_code)).toEqual([
        `EB-20260615-${event}-001`,
        `EB-20260615-${event}-002`,
      ]);
      expect(samples.map((s) => s.history)).toEqual([1, 1]);
    });
  });

  describe('field: a bad step undoes the whole event', () => {
    let before;
    let baseline;
    beforeAll(async () => {
      before = await snapshot(watcher);
      baseline = await auditMax();
    });
    afterEach(async () => {
      expect(await snapshot(watcher)).toEqual(before);
      expect(await auditAfter(baseline)).toEqual([]);
    });
    const failingAfterTwoSamples = (bad) =>
      caught(() =>
        runTransaction(
          async (db) => {
            const event = await newEvent(db, 'T32 rollback trip');
            await measure(db, event);
            await register(db, event, 1, '1000.00', '0.50');
            await register(db, event, 1, '500.00', '1.00');
            await bad(db, event);
          },
          { actorId: FIELD },
        ),
      );

    it('an invalid volume on the third sample -> 23514; event, measurements, samples, history and audit rows are all gone', async () => {
      const err = await failingAfterTwoSamples((db, event) => register(db, event, 1, '0', null));
      expect(err.code).toBe('23514');
    });
    it('an unknown sample type on the third sample -> 23503', async () => {
      const err = await failingAfterTwoSamples((db, event) =>
        register(db, event, 99999, '5.00', null),
      );
      expect(err.code).toBe('23503');
      expect(err.message).toBe('Sample type 99999 does not exist');
    });
    it('a duplicate measurement parameter -> 23505 on uq_environmental_measurements_event_parameter', async () => {
      const err = await failingAfterTwoSamples((db, event) =>
        measure(db, event, [['ph', 7.9, 'pH']]),
      );
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('uq_environmental_measurements_event_parameter');
    });
    it('a negative depth -> 23514', async () => {
      const err = await failingAfterTwoSamples((db, event) => register(db, event, 1, '5.00', '-2'));
      expect(err.code).toBe('23514');
      expect(err.message).toBe('Sample depth cannot be negative');
    });
  });
});
