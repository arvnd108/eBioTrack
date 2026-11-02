// Owner: C (Testing & QA)
// Purpose: Injected import error rolls back everything
//
// Real transactions (BEGIN/COMMIT/ROLLBACK over pool clients), judged from a second connection.
// Scenario of database/transactions/analysis_transaction.sql: analysis 4 (draft, run 1, no
// detections); user 5 (analyst) imports, user 2 (principal investigator) approves.
//
// Audit expectations, derived from database/triggers/analysis_triggers.sql section 4 and the header
// of database/procedures/analysis_procedures.sql (not from a first run):
//   * audit_row_change() is attached to analysis_runs only; taxon_assignments is deliberately not
//     audited, so an import adds exactly ONE audit row: the trigger's 'update' of analysis 4
//     (status draft -> imported, imported_by NULL -> 5), actor 5.
//   * approve_analysis adds TWO rows: the trigger's 'update' (status, approved_by, approved_at) and
//     the explicit 'approve' entry with details {from_status, to_status, detection_count,
//     importer_id}; both actor 2.
//   * A rolled-back transaction adds none.
// CONTRACT GAP: the trigger file says import_detections() "already writes one summary audit entry
// with the row counts"; the procedure header (and the code) say it writes none. Tested as coded.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeTestPool } from '../setup/testDb.js';
import {
  assertGlobalInvariants,
  caught,
  committed,
  csvToRows,
  observer,
  parseCsv,
  readFixture,
  restoreIfCommitted,
  runTransaction,
  seededCounts,
  snapshot,
} from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');

const INJECTED_PLAIN = new Error('injected');
const ANALYSIS = 4;
const IMPORTER = 5;
const APPROVER = 2;

const validCsv = readFixture('detections_valid.csv');
const invalidCsv = readFixture('detections_invalid_row.csv');

const importSql = 'SELECT import_detections($1, $2::jsonb, $3) AS n';
const callImport = async (db, rows, analysis = ANALYSIS, actor = IMPORTER) =>
  (await db.query(importSql, [analysis, JSON.stringify(rows), actor])).rows[0].n;
const callApprove = (db, analysis = ANALYSIS, actor = APPROVER) =>
  db.query('SELECT approve_analysis($1, $2)', [analysis, actor]);

let watcher;
const analysisState = async (id = ANALYSIS) =>
  (
    await watcher.query(
      `SELECT status, imported_by::int AS imported_by, approved_by::int AS approved_by,
              approved_at IS NOT NULL AS has_approved_at,
              (SELECT count(*)::int FROM taxon_assignments WHERE analysis_id = $1) AS detections
         FROM analysis_runs WHERE analysis_id = $1`,
      [id],
    )
  ).rows[0];
const auditAfter = async (baseline) =>
  (
    await watcher.query(
      `SELECT audit_id::int AS audit_id, actor_id::int AS actor_id, entity_type,
              entity_id::int AS entity_id, action, details
         FROM audit_logs WHERE audit_id > $1 ORDER BY audit_id`,
      [baseline],
    )
  ).rows;
const auditMax = async () =>
  Number((await watcher.query('SELECT COALESCE(max(audit_id), 0) AS m FROM audit_logs')).rows[0].m);

describe.skipIf(!dbAvailable)('analysis: import and approval transactions', () => {
  let validRows;
  let validRecords;

  beforeAll(async () => {
    watcher = await observer();
    validRows = await csvToRows(validCsv, watcher);
    validRecords = parseCsv(validCsv);
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
  // Facts re-derived from the CSV text itself, so a drifting fixture fails loudly.
  const csvFacts = () => {
    const reads = validRecords.reduce((n, r) => n + Number(r.read_count), 0);
    const flag = (f) => validRecords.filter((r) => r.qc_flag === f).length;
    const taxa = new Set(validRecords.map((r) => `${r.scientific_name}|${r.taxon_rank}`)).size;
    return {
      rows: validRecords.length,
      reads,
      pass: flag('pass'),
      warn: flag('warn'),
      fail: flag('fail'),
      taxa,
    };
  };

  describe('analysis: the fixtures are what the suite assumes', () => {
    it('valid file -> 14 rows, 6 taxa, flags 10/2/2, 76518 reads', () => {
      expect(csvFacts()).toEqual({ rows: 14, reads: 76518, pass: 10, warn: 2, fail: 2, taxa: 6 });
    });
    it('invalid file -> the same rows but one: file row 8 names LIB-0009 (array position 7)', () => {
      const bad = parseCsv(invalidCsv);
      const position = bad.findIndex((r) => r.library_code === 'LIB-0009') + 1;
      expect(bad).toHaveLength(14);
      expect(position).toBe(7);
      expect(position + 1).toBe(8); // the header is file row 1
      const differing = bad.filter((r, i) => JSON.stringify(r) !== JSON.stringify(validRecords[i]));
      expect(differing).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------
  // A, F (state errors after a commit), G (approval), H (audit): one committed import, many reads.
  describe('analysis: import_detections commit path (analysis 4, actor 5)', () => {
    let baselineAudit;
    let visibleBefore;
    let returned;
    let sawInsideTransaction;

    beforeAll(async () => {
      baselineAudit = await auditMax();
      committed();
      returned = await runTransaction(
        async (db) => {
          const n = await callImport(db, validRows);
          // inside the transaction its own effects are visible, to the observer they are not
          sawInsideTransaction = (
            await db.query(
              'SELECT count(*)::int AS n FROM taxon_assignments WHERE analysis_id = $1',
              [ANALYSIS],
            )
          ).rows[0].n;
          visibleBefore = {
            state: await analysisState(),
            audit: (await auditAfter(baselineAudit)).length,
          };
          return n;
        },
        { actorId: IMPORTER },
      );
    });
    afterAll(() => restoreIfCommitted());

    it('returns 14 and the transaction sees its own 14 rows', () => {
      expect(returned).toBe(14);
      expect(sawInsideTransaction).toBe(14);
    });
    it('before COMMIT the observer still sees a draft with 0 detections and no audit rows', () => {
      expect(visibleBefore.state).toMatchObject({
        status: 'draft',
        detections: 0,
        imported_by: null,
      });
      expect(visibleBefore.audit).toBe(0);
    });
    it('after COMMIT the observer sees 14 detections, status imported, imported_by 5', async () => {
      expect(await analysisState()).toMatchObject({
        status: 'imported',
        imported_by: IMPORTER,
        approved_by: null,
        has_approved_at: false,
        detections: 14,
      });
    });
    it('the stored detections match the CSV: 6 taxa, flags 10/2/2, 76518 reads', async () => {
      const facts = csvFacts();
      const { rows } = await watcher.query(
        `SELECT count(DISTINCT taxon_id)::int AS taxa,
                count(*) FILTER (WHERE qc_flag = 'pass')::int AS pass,
                count(*) FILTER (WHERE qc_flag = 'warn')::int AS warn,
                count(*) FILTER (WHERE qc_flag = 'fail')::int AS fail,
                sum(read_count)::int AS reads
           FROM taxon_assignments WHERE analysis_id = $1`,
        [ANALYSIS],
      );
      expect(rows[0]).toEqual({
        taxa: facts.taxa,
        pass: facts.pass,
        warn: facts.warn,
        fail: facts.fail,
        reads: facts.reads,
      });
    });

    // H. audit consistency
    it('audit: exactly one row, the trigger update of analysis 4 by actor 5 (taxon_assignments is not audited)', async () => {
      const rows = await auditAfter(baselineAudit);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: IMPORTER,
        entity_type: 'analysis_runs',
        entity_id: ANALYSIS,
        action: 'update',
      });
      expect(rows[0].details.status).toEqual({ old: 'draft', new: 'imported' });
      expect(rows[0].details.imported_by).toEqual({ old: null, new: IMPORTER });
      expect(rows.some((r) => r.entity_type === 'taxon_assignments')).toBe(false);
    });
  });

  // ------------------------------------------------------------------------------------------
  // F, G: wrong-state errors and the approval unit. The steps run once, in order, in beforeAll and
  // the tests read what each step captured, so the tests themselves are order independent.
  describe('analysis: state errors after the commit and approval atomicity', () => {
    const step = {};

    beforeAll(async () => {
      committed();
      await runTransaction((db) => callImport(db, validRows), { actorId: IMPORTER });

      // F. a second import of the same file
      step.f = { before: await snapshot(watcher) };
      step.f.err = await caught(() =>
        runTransaction((db) => callImport(db, validRows), { actorId: IMPORTER }),
      );
      step.f.after = await snapshot(watcher);
      step.f.state = await analysisState();

      // G1. approval by the importer
      step.g1 = { before: await snapshot(watcher), baseline: await auditMax() };
      step.g1.err = await caught(() =>
        runTransaction((db) => callApprove(db, ANALYSIS, IMPORTER), { actorId: IMPORTER }),
      );
      step.g1.after = await snapshot(watcher);
      step.g1.audit = await auditAfter(step.g1.baseline);
      step.g1.state = await analysisState();

      // G2. a failure after a successful approve_analysis
      step.g2 = { before: await snapshot(watcher), baseline: await auditMax() };
      step.g2.injected = new Error('injected after approve');
      step.g2.err = await caught(() =>
        runTransaction(
          async (db) => {
            await callApprove(db);
            step.g2.insideAudit = (
              await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE audit_id > $1', [
                step.g2.baseline,
              ])
            ).rows[0].n;
            throw step.g2.injected;
          },
          { actorId: APPROVER },
        ),
      );
      step.g2.after = await snapshot(watcher);
      step.g2.state = await analysisState();

      // G3. the real approval
      step.g3 = { baseline: await auditMax() };
      await runTransaction((db) => callApprove(db), { actorId: APPROVER });
      step.g3.state = await analysisState();
      step.g3.audit = await auditAfter(step.g3.baseline);
      step.g3.seeded = (
        await watcher.query(
          `SELECT analysis_id::int AS id, status FROM analysis_runs WHERE analysis_id < 4 ORDER BY 1`,
        )
      ).rows;
      step.g3.seededDetections = (
        await watcher.query(
          'SELECT count(*)::int AS n FROM taxon_assignments WHERE analysis_id < 4',
        )
      ).rows[0].n;

      // G4. a second approval
      step.g4 = { baseline: await auditMax() };
      step.g4.err = await caught(() =>
        runTransaction((db) => callApprove(db), { actorId: APPROVER }),
      );
      step.g4.audit = await auditAfter(step.g4.baseline);
    });
    afterAll(() => restoreIfCommitted());

    it('F: a second import of the same file -> EB003 "already imported", still exactly 14 detections', () => {
      expect(step.f.err.code).toBe('EB003');
      expect(step.f.err.message).toBe(`Analysis ${ANALYSIS} is already imported`);
      expect(step.f.after).toEqual(step.f.before);
      expect(step.f.state.detections).toBe(14);
    });
    it('G: approval by the importer (user 5) -> EB002 naming the rule; still imported, zero new audit rows', () => {
      // user 5 is an analyst: the role check (D17) answers first, the importer rule is the second line
      expect(step.g1.err.code).toBe('EB002');
      expect(step.g1.err.message).toMatch(/User 5 may not approve analyses/);
      expect(step.g1.after).toEqual(step.g1.before);
      expect(step.g1.audit).toEqual([]);
      expect(step.g1.state.status).toBe('imported');
    });
    it('G: an injected failure after a successful approve_analysis rolls back the approval and its audit entries', () => {
      expect(step.g2.err).toBe(step.g2.injected);
      expect(step.g2.insideAudit).toBe(2); // trigger update + explicit approve entry, both visible inside
      expect(step.g2.after).toEqual(step.g2.before);
      expect(step.g2.state).toMatchObject({ status: 'imported', approved_by: null });
    });
    it('G: approve by user 2 commits status approved, approved_by 2, approved_at set, and two audit rows', () => {
      expect(step.g3.state).toMatchObject({
        status: 'approved',
        imported_by: IMPORTER,
        approved_by: APPROVER,
        has_approved_at: true,
        detections: 14,
      });
      const rows = step.g3.audit;
      expect(rows.map((r) => [r.action, r.actor_id, r.entity_type, r.entity_id])).toEqual([
        ['update', APPROVER, 'analysis_runs', ANALYSIS],
        ['approve', APPROVER, 'analysis_runs', ANALYSIS],
      ]);
      expect(rows[0].details.status).toEqual({ old: 'imported', new: 'approved' });
      expect(rows[1].details).toEqual({
        from_status: 'imported',
        to_status: 'approved',
        detection_count: 14,
        importer_id: IMPORTER,
      });
      // the seeded analyses 1-3 and their detections are untouched (analysis 4 is the one that moved)
      expect(step.g3.seeded).toEqual([
        { id: 1, status: 'approved' },
        { id: 2, status: 'approved' },
        { id: 3, status: 'imported' },
      ]);
      expect(step.g3.seededDetections).toBe(43);
    });
    it('G: a second approval -> EB003 "already approved", no new audit rows', () => {
      expect(step.g4.err.code).toBe('EB003');
      expect(step.g4.audit).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------
  // Rolled-back scenarios: no cleanup needed, snapshot equality is the proof.
  describe('analysis: import_detections rolls back everything', () => {
    let before;
    let baseline;
    const untouched = async () => {
      expect(await snapshot(watcher)).toEqual(before);
      expect(await auditAfter(baseline)).toEqual([]);
      expect(await analysisState()).toMatchObject({
        status: 'draft',
        imported_by: null,
        detections: 0,
      });
    };
    afterEach(untouched);
    const importWith = (rows, { analysis = ANALYSIS, actor = IMPORTER } = {}) =>
      caught(() =>
        runTransaction((db) => callImport(db, rows, analysis, actor), { actorId: actor }),
      );

    beforeAll(async () => {
      before = await snapshot(watcher);
      baseline = await auditMax();
    });

    // B. the fixture error
    it('detections_invalid_row.csv -> EB002 naming array row 7 (file row 8) and LIB-0009; the 13 valid rows are not inserted', async () => {
      const rows = await csvToRows(invalidCsv, watcher);
      const records = parseCsv(invalidCsv);
      const position = records.findIndex((r) => r.library_code === 'LIB-0009') + 1;
      const err = await importWith(rows);
      expect(err.code).toBe('EB002');
      expect(err.message).toContain(`Row ${position}, field library_code`);
      expect(err.message).toContain('LIB-0009');
      expect(err.message).toContain('belongs to another sequencing run');
      expect(err.detail).toContain(`file row ${position + 1}`);
    });

    // C. injected-error matrix
    const POSITIONS = [
      ['first', 0],
      ['middle', 7],
      ['last', 13],
    ];
    const KINDS = [
      [
        'unknown library_code',
        (r) => (r.library_code = 'LIB-9999'),
        'library LIB-9999 does not exist',
      ],
      [
        'library of another run',
        (r) => (r.library_code = 'LIB-0009'),
        'belongs to another sequencing run',
      ],
      ['unknown taxon_id', (r) => (r.taxon_id = 999999), 'taxon 999999 does not exist'],
      ['confidence above 1', (r) => (r.confidence = 1.5), 'field confidence: must be from 0 to 1'],
      ['confidence below 0', (r) => (r.confidence = -0.1), 'field confidence: must be from 0 to 1'],
      [
        'negative read_count',
        (r) => (r.read_count = -5),
        'field read_count: must be a whole number',
      ],
      [
        'qc_flag outside the enum',
        (r) => (r.qc_flag = 'maybe'),
        'field qc_flag: must be one of pass, warn, fail',
      ],
      ['missing field', (r) => delete r.confidence, 'field confidence: is required'],
    ];
    const cases = KINDS.flatMap(([kind, corrupt, fragment]) =>
      POSITIONS.map(([where, index]) => [kind, where, index, corrupt, fragment]),
    );
    it.each(cases)(
      '%s at the %s row (array index %i) -> EB002 with that row number, nothing changed',
      async (_k, _w, index, corrupt, fragment) => {
        const rows = structuredClone(validRows);
        corrupt(rows[index]);
        const err = await importWith(rows);
        expect(err.code).toBe('EB002');
        expect(err.message).toContain(`Row ${index + 1},`);
        expect(err.message).toContain(fragment);
        expect(err.detail).toContain(`file row ${index + 2}`);
      },
    );

    it.each(POSITIONS)(
      'duplicate (library, taxon) pair injected at the %s row -> EB002 naming both rows',
      async (_w, index) => {
        const rows = structuredClone(validRows);
        // copy another row's pair into this one; the LATER occurrence is the one reported
        const source = index === 0 ? 1 : 0;
        rows[index].library_code = rows[source].library_code;
        rows[index].taxon_id = rows[source].taxon_id;
        const first = Math.min(index, source) + 1;
        const second = Math.max(index, source) + 1;
        const err = await importWith(rows);
        expect(err.code).toBe('EB002');
        expect(err.message).toContain(`Row ${second}, field library_code`);
        expect(err.message).toContain(`already appears in row ${first}`);
      },
    );

    it.each([
      ['an object', '{}'],
      ['a string', '"rows"'],
      ['a JSON null', 'null'],
      ['a number', '7'],
    ])('payload that is %s, not an array -> EB002 "must be a JSON array"', async (_n, json) => {
      const err = await caught(() =>
        runTransaction((db) => db.query(importSql, [ANALYSIS, json, IMPORTER]), {
          actorId: IMPORTER,
        }),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('The detections must be a JSON array of rows');
    });
    it('a SQL NULL payload -> EB002 "must be a JSON array"', async () => {
      const err = await caught(() =>
        runTransaction((db) => db.query(importSql, [ANALYSIS, null, IMPORTER]), {
          actorId: IMPORTER,
        }),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('The detections must be a JSON array of rows');
    });
    it('an empty array -> EB002 "at least one row is required"', async () => {
      const err = await importWith([]);
      expect(err.code).toBe('EB002');
      expect(err.message).toMatch(/array is empty; at least one row is required/);
    });
    it('a row that is not an object -> EB002 naming its position', async () => {
      const rows = structuredClone(validRows);
      rows[4] = 'LIB-0001';
      const err = await importWith(rows);
      expect(err.code).toBe('EB002');
      expect(err.message).toContain('Row 5, field row: must be a JSON object');
    });

    // two bad rows: the documented order decides which one is reported
    it('two structural errors -> the lowest row is reported (row 3, not row 6)', async () => {
      const rows = structuredClone(validRows);
      rows[5].qc_flag = 'maybe';
      rows[2].confidence = 2;
      const err = await importWith(rows);
      expect(err.message).toContain('Row 3, field confidence');
    });
    it('a structural error on a later row wins over a reference error on an earlier row (structure is checked first)', async () => {
      const rows = structuredClone(validRows);
      rows[1].taxon_id = 999999; // reference error, array row 2
      rows[9].qc_flag = 'maybe'; // structural error, array row 10
      const err = await importWith(rows);
      expect(err.message).toContain('Row 10, field qc_flag');
    });
    it('two library errors -> the lowest row (row 4) is reported', async () => {
      const rows = structuredClone(validRows);
      rows[10].library_code = 'LIB-9998';
      rows[3].library_code = 'LIB-9999';
      const err = await importWith(rows);
      expect(err.message).toContain('Row 4, field library_code');
      expect(err.message).toContain('LIB-9999');
    });
    it('a library error wins over a taxon error on an earlier row (libraries are checked before taxa)', async () => {
      const rows = structuredClone(validRows);
      rows[0].taxon_id = 999999;
      rows[6].library_code = 'LIB-9999';
      const err = await importWith(rows);
      expect(err.message).toContain('Row 7, field library_code');
    });

    // acting user
    it('an unknown actor (999), a viewer (6) and a NULL actor -> EB002, nothing changed', async () => {
      for (const actor of [999, 6]) {
        const err = await importWith(validRows, { actor });
        expect(err.code, `actor ${actor}`).toBe('EB002');
      }
      const err = await caught(() =>
        runTransaction((db) => db.query(importSql, [ANALYSIS, JSON.stringify(validRows), null])),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('An acting user is required');
    });

    // D. failure after success (caller-side injection)
    it.each([
      [
        'a plain Error',
        async () => {
          throw INJECTED_PLAIN;
        },
        null,
      ],
      ['a division by zero', (db) => db.query('SELECT 1/0'), '22012'],
      [
        'a duplicate project title',
        (db) =>
          db.query(
            `INSERT INTO projects (title, created_by) VALUES ('Yamuna Biodiversity Survey', 2)`,
          ),
        '23505',
      ],
    ])(
      'import succeeds, then %s -> everything rolled back, the error unchanged, observer never saw a row',
      async (_n, fail, code) => {
        let seenByObserver;
        let importedInside;
        const err = await caught(() =>
          runTransaction(
            async (db) => {
              importedInside = await callImport(db, validRows);
              seenByObserver = (await analysisState()).detections;
              await fail(db);
            },
            { actorId: IMPORTER },
          ),
        );
        expect(importedInside).toBe(14);
        expect(seenByObserver).toBe(0);
        if (code === null) expect(err).toBe(INJECTED_PLAIN);
        else expect(err.code).toBe(code);
      },
    );

    // F. wrong state, rolled back
    it.each([
      [3, 'imported', 'EB003', 'Analysis 3 is already imported'],
      [1, 'approved', 'EB003', 'Analysis 1 is already approved'],
    ])(
      'import into seeded analysis %i (%s) -> %s, nothing changed',
      async (analysis, _status, code, message) => {
        const fingerprint = await snapshot(watcher);
        const err = await importWith(validRows, { analysis });
        expect(err.code).toBe(code);
        expect(err.message).toBe(message);
        expect(await snapshot(watcher)).toEqual(fingerprint);
      },
    );
    it('import into a rejected analysis -> EB001 (the rejection itself is rolled back with it)', async () => {
      let rejected;
      const err = await caught(() =>
        runTransaction(
          async (db) => {
            await db.query(`SELECT reject_analysis($1, $2, 'T32: wrong reference database')`, [
              ANALYSIS,
              APPROVER,
            ]);
            rejected = (
              await db.query('SELECT status FROM analysis_runs WHERE analysis_id = $1', [ANALYSIS])
            ).rows[0].status;
            await callImport(db, validRows);
          },
          { actorId: APPROVER },
        ),
      );
      expect(rejected).toBe('rejected');
      expect(err.code).toBe('EB001');
      expect(err.message).toMatch(
        /Analysis 4 is rejected; detections can only be imported into a draft analysis/,
      );
    });
    it('import into an analysis that does not exist -> EB002', async () => {
      const err = await importWith(validRows, { analysis: 999999 });
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('Analysis 999999 does not exist');
    });

    // approval refusals on seeded data
    it('approval of the seeded imported analysis 3 by its importer (user 5) -> EB002, still imported, zero audit rows', async () => {
      const err = await caught(() =>
        runTransaction((db) => callApprove(db, 3, IMPORTER), { actorId: IMPORTER }),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('User 5 may not approve analyses');
    });
    it('approval of draft analysis 4 -> EB001; of approved analysis 1 -> EB003; nothing changes', async () => {
      const draft = await caught(() =>
        runTransaction((db) => callApprove(db, ANALYSIS), { actorId: APPROVER }),
      );
      expect(draft.code).toBe('EB001');
      expect(draft.message).toMatch(/only an imported analysis can be approved/);
      const done = await caught(() =>
        runTransaction((db) => callApprove(db, 1), { actorId: APPROVER }),
      );
      expect(done.code).toBe('EB003');
    });
    it('a principal investigator who imported may not approve their own import -> EB002 (D17), all rolled back', async () => {
      const err = await caught(() =>
        runTransaction(
          async (db) => {
            await callImport(db, validRows, ANALYSIS, APPROVER);
            await callApprove(db, ANALYSIS, APPROVER);
          },
          { actorId: APPROVER },
        ),
      );
      expect(err.code).toBe('EB002');
      expect(err.message).toBe('The importer may not approve their own analysis');
    });
    it('approve_analysis(3) by user 2 then an injected failure -> approval and both audit rows gone, analyses 1-3 fingerprint equal', async () => {
      const injected = new Error('injected after approve of 3');
      const err = await caught(() =>
        runTransaction(
          async (db) => {
            await callApprove(db, 3);
            throw injected;
          },
          { actorId: APPROVER },
        ),
      );
      expect(err).toBe(injected);
    });
  });

  // ------------------------------------------------------------------------------------------
  // E. Savepoint recovery inside one committed transaction.
  describe('analysis: savepoint recovery (bad file, then the good one, same transaction)', () => {
    let baseline;
    let failure;
    let imported;
    beforeAll(async () => {
      baseline = await auditMax();
      committed();
      const bad = await csvToRows(invalidCsv, watcher);
      imported = await runTransaction(
        async (db) => {
          await db.query('SAVEPOINT s');
          try {
            await callImport(db, bad);
          } catch (err) {
            failure = err;
          }
          await db.query('ROLLBACK TO SAVEPOINT s');
          return callImport(db, validRows);
        },
        { actorId: IMPORTER },
      );
    });
    afterAll(() => restoreIfCommitted());

    it('the bad file fails with EB002 inside the savepoint', () => {
      expect(failure.code).toBe('EB002');
      expect(failure.message).toContain('Row 7');
    });
    it('the good file then imports 14 rows in the same transaction and COMMIT keeps them exactly once', async () => {
      expect(imported).toBe(14);
      expect(await analysisState()).toMatchObject({
        status: 'imported',
        imported_by: IMPORTER,
        detections: 14,
      });
      expect((await auditAfter(baseline)).map((r) => [r.action, r.actor_id])).toEqual([
        ['update', IMPORTER],
      ]);
    });
  });
});
