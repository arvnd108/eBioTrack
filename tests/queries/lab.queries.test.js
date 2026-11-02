// Owner: C (Testing & QA)
// Purpose: Query results vs known fixtures: Laboratory & Sequencing
//
// Expected values are derived by hand from database/seeds/030_seed_lab.sql (with 020 for sample and
// site names), compared with the committed prepared statement, with an oracle written without CTEs
// or window functions, and after rolled-back changes. bigint/numeric are strings, int4 is a number,
// dates YYYY-MM-DD, timestamptz ISO UTC (see tests/setup/queries.js).
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  insertRow,
  newBatch,
  newExtraction,
  newLibrary,
  newRun,
  newSample,
  updateRow,
} from '../setup/integrity.js';
import { acrossSettings, openQuerySession } from '../setup/queries.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

const LAB_1 = 'Dehradun eDNA Laboratory';
const LAB_2 = 'Kolkata Estuarine Genomics Laboratory';
const KIT = 'DNeasy PowerWater Kit';

// Seed 030: extraction n is for sample n (attempt 1). Batch 1 = samples 1-6 and 17 (lab 1, 2025-05-20),
// batch 2 = samples 7-12 (lab 1, 2026-03-16), batch 3 = samples 13-16 (lab 2, 2026-04-10).
// All of 1-16 pass; extraction 17 fails (0.350 ng/uL, A260/280 1.32).
const CONCENTRATION = [
  '18.420', '15.730', '22.910', '12.050', '27.360', '9.880', '31.240', '24.670',
  '14.120', '11.590', '19.330', '8.760', '16.480', '13.910', '21.050', '10.270',
]; // prettier-ignore
const PURITY = [
  '1.86', '1.84', '1.88', '1.81', '1.90', '1.79', '1.92', '1.87',
  '1.83', '1.80', '1.85', '1.77', '1.84', '1.82', '1.89', '1.78',
]; // prettier-ignore
const batchOf = (n) => (n <= 6 ? 1 : n <= 12 ? 2 : 3);
const labOf = (n) => (batchOf(n) === 3 ? LAB_2 : LAB_1);
// Run 1 (RUN-001, lab 1, 2026-03-25) holds libraries 1-8; run 2 (RUN-002, lab 2, 2026-04-18) 9-16.
const runOf = (n) => (n <= 8 ? 1 : 2);
const RUN = {
  1: { code: 'RUN-001', date: '2026-03-25' },
  2: { code: 'RUN-002', date: '2026-04-18' },
};
const libraryCode = (n) => `LIB-${String(n).padStart(4, '0')}`;

// Seed 020: event n has samples 2n-1 and 2n; sample 17 is a third sample on event 1.
const SAMPLE_CODES = [
  'EB-20250515-0001-001', 'EB-20250515-0001-002', 'EB-20250518-0002-001', 'EB-20250518-0002-002',
  'EB-20250522-0003-001', 'EB-20250522-0003-002', 'EB-20260310-0004-001', 'EB-20260310-0004-002',
  'EB-20260312-0005-001', 'EB-20260312-0005-002', 'EB-20260315-0006-001', 'EB-20260315-0006-002',
  'EB-20260405-0007-001', 'EB-20260405-0007-002', 'EB-20260408-0008-001', 'EB-20260408-0008-002',
]; // prettier-ignore
const SAMPLE_17 = 'EB-20250515-0001-003';
const EVENT_AT = {
  1: '2025-05-15T08:30:00.000Z',
  2: '2025-05-18T09:15:00.000Z',
  3: '2025-05-22T07:45:00.000Z',
  4: '2026-03-10T08:00:00.000Z',
  5: '2026-03-12T09:30:00.000Z',
  6: '2026-03-15T08:15:00.000Z',
  7: '2026-04-05T10:00:00.000Z',
  8: '2026-04-08T11:30:00.000Z',
};
const EVENT_SITE = { 1: 1, 2: 2, 3: 3, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5 };
const EVENT_PROJECT = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 2 };
const SITE_NAME = {
  1: 'Dakpathar Barrage',
  2: 'Okhla Barrage',
  3: 'Sangam Prayagraj',
  4: 'Diamond Harbour',
  5: 'Kakdwip Bay',
};
const eventOfSample = (n) => (n === 17 ? 1 : Math.ceil(n / 2));

const BATCH_COLUMNS = [
  'batch_id',
  'lab_name',
  'extraction_date',
  'kit_name',
  'extractions',
  'passed',
  'failed',
  'pending',
  'pass_rate_pct',
];
const RUN_COLUMNS = [
  'run_code',
  'run_date',
  'run_status',
  'libraries_in_run',
  'library_code',
  'extraction_id',
  'attempt_number',
  'sample_code',
  'collected_at',
  'site_name',
];
const PROBLEM_COLUMNS = [
  'sample_id',
  'sample_code',
  'sample_status',
  'site_name',
  'severity',
  'problems',
  'reasons',
  'sequenced',
];
const PIPELINE_COLUMNS = [
  'sample_id',
  'sample_code',
  'project_id',
  'site_id',
  'site_name',
  'collected_at',
  'sample_status',
  'extraction_attempts',
  'latest_extraction_id',
  'latest_attempt_number',
  'latest_qc_status',
  'latest_concentration_ng_ul',
  'latest_purity_a260_280',
  'batch_id',
  'lab_name',
  'library_id',
  'library_code',
  'run_id',
  'run_code',
  'run_status',
  'run_date',
  'pipeline_stage',
];
const FAILED_QC_COLUMNS = [
  'sample_id',
  'sample_code',
  'project_id',
  'site_name',
  'extraction_id',
  'source',
  'qc_type',
  'severity',
  'metric_value',
  'reason',
  'recorded_by',
  'recorded_at',
];

// Problems of the seed. Reasons are sorted by text: 'concentration...' < 'contamination_check...'
// < 'extraction attempt...' (c-o-n-c before c-o-n-t before e).
const PROBLEM_17 = {
  sample_id: '17',
  sample_code: SAMPLE_17,
  sample_status: 'failed',
  site_name: 'Dakpathar Barrage',
  severity: 'fail',
  problems: '3', // extraction 17 failed + QC 17 concentration fail + QC 23 contamination_check fail
  reasons:
    'concentration fail (0.350): Below 1.0 ng/uL; sample marked failed; ' +
    'contamination_check fail: Low yield and A260/280 1.32 suggest inhibitors; ' +
    'extraction attempt 1 failed QC',
  sequenced: false, // sample 17 has no library
};
const PROBLEM_12 = {
  sample_id: '12',
  sample_code: 'EB-20260315-0006-002',
  sample_status: 'analyzed',
  site_name: 'Sangam Prayagraj',
  severity: 'warn',
  problems: '1', // QC 22 negative_control warn
  reasons: 'negative_control warn (0.080): Faint band in PCR negative; within tolerance, kept',
  sequenced: true,
};

describe.skipIf(!dbAvailable)('lab queries', () => {
  let s;
  beforeAll(async () => {
    s = await openQuerySession('lab');
  });
  afterAll(async () => {
    await s?.close();
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------
  describe('lab: q1_extraction_qc_by_batch', () => {
    // Oracle: one COUNT per (batch, qc_status) with comma joins; the rate is computed in JS from
    // exact integers and formatted with one decimal (half up).
    async function oracleBatches(labId) {
      const batches = await s.sql(
        `SELECT b.batch_id, l.name AS lab_name, b.extraction_date, b.kit_name
           FROM extraction_batches b, laboratories l
          WHERE l.lab_id = b.lab_id AND ($1::bigint IS NULL OR b.lab_id = $1)
          ORDER BY b.extraction_date, b.batch_id`,
        [labId],
      );
      const out = [];
      for (const b of batches) {
        const count = async (status) =>
          Number(
            (
              await s.sql(
                `SELECT count(*) AS n FROM dna_extractions x
                  WHERE x.batch_id = $1 AND ($2::text IS NULL OR x.qc_status::text = $2)`,
                [b.batch_id, status],
              )
            )[0].n,
          );
        const total = await count(null);
        const passed = await count('pass');
        out.push({
          batch_id: b.batch_id,
          lab_name: b.lab_name,
          extraction_date: b.extraction_date,
          kit_name: b.kit_name,
          extractions: String(total),
          passed: String(passed),
          failed: String(await count('fail')),
          pending: String(await count('pending')),
          pass_rate_pct:
            total === 0 ? null : (Math.floor((passed * 1000) / total + 0.5) / 10).toFixed(1),
        });
      }
      return out;
    }

    const BATCH_1 = {
      batch_id: '1',
      lab_name: LAB_1,
      extraction_date: '2025-05-20',
      kit_name: KIT,
      extractions: '7', // samples 1-6 and 17
      passed: '6',
      failed: '1', // extraction 17
      pending: '0',
      pass_rate_pct: '85.7', // 6 / 7 = 85.714..
    };
    const BATCH_2 = {
      ...BATCH_1,
      batch_id: '2',
      extraction_date: '2026-03-16',
      extractions: '6',
      passed: '6',
      failed: '0',
      pass_rate_pct: '100.0',
    };
    const BATCH_3 = {
      ...BATCH_2,
      batch_id: '3',
      lab_name: LAB_2,
      extraction_date: '2026-04-10',
      extractions: '4',
      passed: '4',
    };

    // A. golden
    it('NULL -> three batches ordered by extraction_date: 7 (6 pass, 1 fail), 6, 4', async () => {
      await acrossSettings(s, async () => {
        expect(await s.execute('q1_extraction_qc_by_batch', [null])).toEqual([
          BATCH_1,
          BATCH_2,
          BATCH_3,
        ]);
      });
    });
    it('lab 1 -> batches 1 and 2; lab 2 -> batch 3', async () => {
      expect(await s.execute('q1_extraction_qc_by_batch', [1])).toEqual([BATCH_1, BATCH_2]);
      expect(await s.execute('q1_extraction_qc_by_batch', [2])).toEqual([BATCH_3]);
    });

    // B. oracle
    it.each([null, 1, 2, 999])('lab %s -> equals the oracle', async (labId) => {
      expect(await s.execute('q1_extraction_qc_by_batch', [labId])).toEqual(
        await oracleBatches(labId),
      );
    });

    // C. filters
    it('unknown lab -> zero rows; the per-lab results partition the unfiltered result', async () => {
      expect(await s.execute('q1_extraction_qc_by_batch', [999])).toEqual([]);
      const all = await s.execute('q1_extraction_qc_by_batch', [null]);
      const parts = [
        ...(await s.execute('q1_extraction_qc_by_batch', [1])),
        ...(await s.execute('q1_extraction_qc_by_batch', [2])),
      ];
      expect(parts.map((r) => r.batch_id).sort()).toEqual(all.map((r) => r.batch_id).sort());
    });
    it('the three counts always add up to the extractions column', async () => {
      for (const r of await s.execute('q1_extraction_qc_by_batch', [null])) {
        expect(Number(r.passed) + Number(r.failed) + Number(r.pending)).toBe(Number(r.extractions));
      }
    });

    // D. metamorphic
    it('a batch without extractions appears with zeros and a NULL pass rate', async () => {
      await s.rollback(async (db) => {
        const batch = await newBatch(db, { lab_id: 2, extraction_date: '2026-05-01' });
        const rows = await s.execute('q1_extraction_qc_by_batch', [2]);
        expect(rows.map((r) => r.batch_id)).toEqual(['3', batch.batch_id]); // 2026-04-10 then 2026-05-01
        expect(rows[1]).toEqual({
          batch_id: batch.batch_id,
          lab_name: LAB_2,
          extraction_date: '2026-05-01',
          kit_name: null,
          extractions: '0',
          passed: '0',
          failed: '0',
          pending: '0',
          pass_rate_pct: null,
        });
      });
    });
    it('rates round to one decimal: 1/6 = 16.7, 2/3 = 66.7, 1/2 = 50.0, 0/1 = 0.0', async () => {
      await s.rollback(async (db) => {
        const make = async (statuses) => {
          const batch = await newBatch(db, { lab_id: 2, extraction_date: '2027-01-01' });
          for (const qc_status of statuses) {
            await newExtraction(db, { batch_id: batch.batch_id, qc_status });
          }
          return batch.batch_id;
        };
        const cases = [
          [
            ['pass', 'fail', 'fail', 'fail', 'fail', 'pending'],
            '16.7',
            { passed: '1', failed: '4', pending: '1', extractions: '6' },
          ],
          [
            ['pass', 'pass', 'fail'],
            '66.7',
            { passed: '2', failed: '1', pending: '0', extractions: '3' },
          ],
          [['pass', 'fail'], '50.0', { passed: '1', failed: '1', pending: '0', extractions: '2' }],
          [['pending'], '0.0', { passed: '0', failed: '0', pending: '1', extractions: '1' }],
        ];
        for (const [statuses, rate, counts] of cases) {
          const id = await make(statuses);
          const row = (await s.execute('q1_extraction_qc_by_batch', [2])).find(
            (r) => r.batch_id === id,
          );
          expect(row).toMatchObject({ pass_rate_pct: rate, ...counts });
        }
      });
    });
    it('batches with the same date are ordered by batch_id; an earlier date sorts first', async () => {
      await s.rollback(async (db) => {
        const early = await newBatch(db, { lab_id: 1, extraction_date: '2024-01-01' });
        const tie = await newBatch(db, { lab_id: 1, extraction_date: '2026-03-16' });
        const ids = (await s.execute('q1_extraction_qc_by_batch', [1])).map((r) => r.batch_id);
        expect(ids).toEqual([early.batch_id, '1', '2', tie.batch_id]);
      });
    });
    it('settling pending extractions moves exactly one count at a time (pending -> pass, pending -> fail)', async () => {
      await s.rollback(async (db) => {
        // qc_status can only leave `pending`, so build a batch with two pending extractions
        const batch = await newBatch(db, { lab_id: 2, extraction_date: '2027-02-01' });
        const x1 = await newExtraction(db, { batch_id: batch.batch_id });
        const x2 = await newExtraction(db, { batch_id: batch.batch_id });
        const get = async () =>
          (await s.execute('q1_extraction_qc_by_batch', [2])).find(
            (r) => r.batch_id === batch.batch_id,
          );
        expect(await get()).toMatchObject({
          extractions: '2',
          passed: '0',
          failed: '0',
          pending: '2',
          pass_rate_pct: '0.0',
        });
        await updateRow(db, 'dna_extractions', 'extraction_id', x1.extraction_id, {
          qc_status: 'pass',
        });
        expect(await get()).toMatchObject({
          extractions: '2',
          passed: '1',
          failed: '0',
          pending: '1',
          pass_rate_pct: '50.0',
        });
        await updateRow(db, 'dna_extractions', 'extraction_id', x2.extraction_id, {
          qc_status: 'fail',
        });
        expect(await get()).toMatchObject({
          extractions: '2',
          passed: '1',
          failed: '1',
          pending: '0',
          pass_rate_pct: '50.0',
        });
        // the seeded batches did not move
        expect(
          (await s.execute('q1_extraction_qc_by_batch', [1])).map((r) => r.pass_rate_pct),
        ).toEqual(['85.7', '100.0']);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('q1_extraction_qc_by_batch', [null]);
      expect(cols.map((c) => c.name)).toEqual(BATCH_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        batch_id: 'bigint',
        lab_name: 'text',
        extraction_date: 'date',
        extractions: 'bigint',
        pass_rate_pct: 'numeric',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes', async () => {
      const first = await s.execute('q1_extraction_qc_by_batch', [null]);
      expect(await s.execute('q1_extraction_qc_by_batch', [null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('q1_extraction_qc_by_batch', [null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('lab: q2_run_libraries_with_samples', () => {
    const expectedRow = (n) => ({
      run_code: RUN[runOf(n)].code,
      run_date: RUN[runOf(n)].date,
      run_status: 'completed',
      libraries_in_run: '8',
      library_code: libraryCode(n),
      extraction_id: String(n),
      attempt_number: 1,
      sample_code: SAMPLE_CODES[n - 1],
      collected_at: EVENT_AT[eventOfSample(n)],
      site_name: SITE_NAME[EVENT_SITE[eventOfSample(n)]],
    });
    const ALL = Array.from({ length: 16 }, (_, i) => expectedRow(i + 1));

    // Oracle: per-run counts from COUNT queries; the row details from comma joins; JS ordering.
    async function oracleRuns(runId) {
      const runs = await s.sql(
        `SELECT run_id FROM sequencing_runs WHERE ($1::bigint IS NULL OR run_id = $1) ORDER BY run_id`,
        [runId],
      );
      const out = [];
      for (const run of runs) {
        const [{ n }] = await s.sql(
          `SELECT count(*) AS n FROM sequencing_libraries WHERE run_id = $1`,
          [run.run_id],
        );
        const rows = await s.sql(
          `SELECT r.run_code, r.run_date, r.status AS run_status, lib.library_code, x.extraction_id,
                  x.attempt_number, sa.sample_code, ce.collected_at, si.name AS site_name
             FROM sequencing_runs r, sequencing_libraries lib, dna_extractions x, samples sa,
                  collection_events ce, sampling_sites si
            WHERE r.run_id = $1 AND lib.run_id = r.run_id AND x.extraction_id = lib.extraction_id
              AND sa.sample_id = x.sample_id AND ce.event_id = sa.event_id AND si.site_id = ce.site_id
            ORDER BY lib.library_code`,
          [run.run_id],
        );
        for (const r of rows) out.push({ ...r, libraries_in_run: n });
      }
      return out.map(({ run_code, run_date, run_status, libraries_in_run, ...rest }) => ({
        run_code,
        run_date,
        run_status,
        libraries_in_run,
        ...rest,
      }));
    }

    // A. golden
    it('NULL -> 16 libraries: LIB-0001..0008 on RUN-001, LIB-0009..0016 on RUN-002, 8 per run', async () => {
      await acrossSettings(s, async () => {
        expect(await s.execute('q2_run_libraries_with_samples', [null])).toEqual(ALL);
      });
    });
    it('run 1 -> the first eight rows; run 2 -> the last eight', async () => {
      expect(await s.execute('q2_run_libraries_with_samples', [1])).toEqual(ALL.slice(0, 8));
      expect(await s.execute('q2_run_libraries_with_samples', [2])).toEqual(ALL.slice(8));
    });
    it('sample 17 has no library, so its sample code never appears', async () => {
      const codes = (await s.execute('q2_run_libraries_with_samples', [null])).map(
        (r) => r.sample_code,
      );
      expect(codes).not.toContain(SAMPLE_17);
      expect(new Set(codes).size).toBe(16);
    });

    // B. oracle
    it.each([null, 1, 2, 999])('run %s -> equals the oracle', async (runId) => {
      expect(await s.execute('q2_run_libraries_with_samples', [runId])).toEqual(
        await oracleRuns(runId),
      );
    });

    // C. filters
    it('unknown run -> zero rows; per-run results partition the unfiltered result', async () => {
      expect(await s.execute('q2_run_libraries_with_samples', [999])).toEqual([]);
      const all = await s.execute('q2_run_libraries_with_samples', [null]);
      expect([
        ...(await s.execute('q2_run_libraries_with_samples', [1])),
        ...(await s.execute('q2_run_libraries_with_samples', [2])),
      ]).toEqual(all);
    });

    // D. metamorphic
    it('a new library in run 1 raises libraries_in_run to 9 on every run-1 row only', async () => {
      await s.rollback(async (db) => {
        const lib = await newLibrary(db, { run_id: 1 });
        const rows = await s.execute('q2_run_libraries_with_samples', [null]);
        expect(rows).toHaveLength(17);
        expect(
          rows.filter((r) => r.run_code === 'RUN-001').every((r) => r.libraries_in_run === '9'),
        ).toBe(true);
        expect(
          rows.filter((r) => r.run_code === 'RUN-002').every((r) => r.libraries_in_run === '8'),
        ).toBe(true);
        // library codes are unique() strings that sort after LIB-0008 within the run
        expect(rows.filter((r) => r.run_code === 'RUN-001').at(-1).library_code).toBe(
          lib.library_code,
        );
      });
    });
    it('a run without libraries produces no row; a new run with one library has libraries_in_run 1', async () => {
      await s.rollback(async (db) => {
        const empty = await newRun(db);
        expect(await s.execute('q2_run_libraries_with_samples', [empty.run_id])).toEqual([]);
        expect(await s.execute('q2_run_libraries_with_samples', [null])).toHaveLength(16);
        const lib = await newLibrary(db, { run_id: empty.run_id });
        const rows = await s.execute('q2_run_libraries_with_samples', [empty.run_id]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          libraries_in_run: '1',
          library_code: lib.library_code,
          run_status: 'planned',
          attempt_number: 1,
        });
      });
    });
    it('a second extraction attempt with its own library shows attempt_number 2 for the same sample', async () => {
      await s.rollback(async (db) => {
        const first = await newExtraction(db, { qc_status: 'fail' });
        const second = await newExtraction(db, {
          sample_id: first.sample_id,
          attempt_number: 2,
          qc_status: 'pass',
        });
        await newLibrary(db, { extraction_id: second.extraction_id, run_id: 2 });
        const rows = await s.execute('q2_run_libraries_with_samples', [2]);
        expect(rows).toHaveLength(9);
        expect(rows.at(-1)).toMatchObject({
          extraction_id: second.extraction_id,
          attempt_number: 2,
        });
        expect(rows.at(-1).sample_code).toBe(
          (
            await s.sql('SELECT sample_code FROM samples WHERE sample_id = $1', [first.sample_id])
          )[0].sample_code,
        );
      });
    });
    it('moving a run through planned -> running shows in every row of that run only', async () => {
      await s.rollback(async (db) => {
        // seeded runs are `completed` (terminal), so use a new run with two libraries
        const run = await newRun(db);
        await newLibrary(db, { run_id: run.run_id });
        await newLibrary(db, { run_id: run.run_id });
        await updateRow(db, 'sequencing_runs', 'run_id', run.run_id, { status: 'running' });
        const rows = await s.execute('q2_run_libraries_with_samples', [null]);
        expect(rows.filter((r) => r.run_status === 'running')).toHaveLength(2);
        expect(rows.filter((r) => r.run_status === 'completed')).toHaveLength(16);
        expect(
          rows.filter((r) => r.run_status === 'running').every((r) => r.libraries_in_run === '2'),
        ).toBe(true);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('q2_run_libraries_with_samples', [null]);
      expect(cols.map((c) => c.name)).toEqual(RUN_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        run_date: 'date',
        run_status: 'run_status',
        libraries_in_run: 'bigint',
        collected_at: 'timestamp with time zone',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes', async () => {
      const first = await s.execute('q2_run_libraries_with_samples', [null]);
      expect(await s.execute('q2_run_libraries_with_samples', [null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('q2_run_libraries_with_samples', [null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('lab: q3_samples_with_qc_problems', () => {
    // Oracle: three plain queries, grouped and formatted in JS (reasons sorted by code unit; every
    // reason in these tests starts with a lower-case letter, so database collation agrees).
    async function oracleProblems(projectId) {
      const problems = [];
      for (const r of await s.sql(
        `SELECT sample_id, attempt_number FROM dna_extractions WHERE qc_status = 'fail'`,
      )) {
        problems.push({
          sample_id: r.sample_id,
          severity: 'fail',
          reason: `extraction attempt ${r.attempt_number} failed QC`,
        });
      }
      for (const r of await s.sql(
        `SELECT sample_id, qc_type, result, metric_value, notes FROM quality_control_results
          WHERE result <> 'pass' AND sample_id IS NOT NULL`,
      )) {
        problems.push({
          sample_id: r.sample_id,
          severity: r.result,
          reason: `${r.qc_type} ${r.result}${r.metric_value === null ? '' : ` (${r.metric_value})`}${r.notes === null ? '' : `: ${r.notes}`}`,
        });
      }
      for (const r of await s.sql(
        `SELECT q.analysis_id, q.qc_type, q.result, q.metric_value, q.notes, x.sample_id
           FROM quality_control_results q, analysis_runs a, sequencing_libraries lib, dna_extractions x
          WHERE q.result <> 'pass' AND q.sample_id IS NULL AND a.analysis_id = q.analysis_id
            AND lib.run_id = a.run_id AND x.extraction_id = lib.extraction_id`,
      )) {
        problems.push({
          sample_id: r.sample_id,
          severity: r.result,
          reason: `analysis ${r.analysis_id} ${r.qc_type} ${r.result}${r.metric_value === null ? '' : ` (${r.metric_value})`}${r.notes === null ? '' : `: ${r.notes}`}`,
        });
      }
      const bySample = new Map();
      for (const p of problems)
        bySample.set(p.sample_id, [...(bySample.get(p.sample_id) ?? []), p]);
      const out = [];
      for (const [sampleId, list] of bySample) {
        const [sample] = await s.sql(
          `SELECT sa.sample_id, sa.sample_code, sa.status, si.name AS site_name, ce.project_id
             FROM samples sa, collection_events ce, sampling_sites si
            WHERE sa.sample_id = $1 AND ce.event_id = sa.event_id AND si.site_id = ce.site_id`,
          [sampleId],
        );
        if (projectId !== null && sample.project_id !== String(projectId)) continue;
        const [{ n }] = await s.sql(
          `SELECT count(*) AS n FROM sequencing_libraries lib, dna_extractions x
            WHERE x.extraction_id = lib.extraction_id AND x.sample_id = $1`,
          [sampleId],
        );
        out.push({
          sample_id: sample.sample_id,
          sample_code: sample.sample_code,
          sample_status: sample.status,
          site_name: sample.site_name,
          severity: list.some((p) => p.severity === 'fail') ? 'fail' : 'warn',
          problems: String(list.length),
          reasons: list
            .map((p) => p.reason)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .join('; '),
          sequenced: Number(n) > 0,
        });
      }
      return out.sort(
        (a, b) =>
          (a.severity === 'fail' ? 0 : 1) - (b.severity === 'fail' ? 0 : 1) ||
          Number(a.sample_id) - Number(b.sample_id),
      );
    }
    const qc = (db, over) =>
      insertRow(db, 'quality_control_results', {
        qc_type: 'read_quality',
        result: 'fail',
        recorded_by: 4,
        ...over,
      });

    // A. golden
    it('NULL -> sample 17 (fail, 3 problems, not sequenced) then sample 12 (warn, 1 problem)', async () => {
      expect(await s.execute('q3_samples_with_qc_problems', [null])).toEqual([
        PROBLEM_17,
        PROBLEM_12,
      ]);
    });
    it('project 1 -> both samples; project 2 and an unknown project -> zero rows', async () => {
      expect(await s.execute('q3_samples_with_qc_problems', [1])).toEqual([PROBLEM_17, PROBLEM_12]);
      expect(await s.execute('q3_samples_with_qc_problems', [2])).toEqual([]);
      expect(await s.execute('q3_samples_with_qc_problems', [999])).toEqual([]);
    });
    it('a sample with several problems is counted once; only fail/warn count (20 pass rows are ignored)', async () => {
      const rows = await s.execute('q3_samples_with_qc_problems', [null]);
      expect(rows.map((r) => r.sample_id)).toEqual(['17', '12']);
      expect(rows.find((r) => r.sample_id === '17').problems).toBe('3');
    });

    // B. oracle
    it.each([null, 1, 2])('project %s -> equals the oracle', async (projectId) => {
      expect(await s.execute('q3_samples_with_qc_problems', [projectId])).toEqual(
        await oracleProblems(projectId),
      );
    });

    // D. metamorphic
    it('a failed QC result on a clean sample adds a fail row and sorts it before the warn', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: 5, metric_value: '12.5', notes: 'low quality' });
        const rows = await s.execute('q3_samples_with_qc_problems', [null]);
        expect(rows.map((r) => [r.sample_id, r.severity])).toEqual([
          ['5', 'fail'],
          ['17', 'fail'],
          ['12', 'warn'],
        ]);
        expect(rows[0]).toMatchObject({
          sample_code: 'EB-20250522-0003-001',
          sample_status: 'analyzed',
          problems: '1',
          reasons: 'read_quality fail (12.5): low quality',
          sequenced: true,
        });
        expect(rows).toEqual(await oracleProblems(null));
      });
    });
    it('a warn on a sample that already failed keeps severity fail and raises the problem count', async () => {
      await s.rollback(async (db) => {
        await qc(db, {
          sample_id: 17,
          result: 'warn',
          qc_type: 'negative_control',
          notes: 'faint',
        });
        const row = (await s.execute('q3_samples_with_qc_problems', [null])).find(
          (r) => r.sample_id === '17',
        );
        expect(row).toMatchObject({ severity: 'fail', problems: '4' });
        expect(row.reasons).toContain('negative_control warn: faint');
      });
    });
    it('a fail on a warn-only sample flips its severity to fail and moves it to the top group', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: 12, notes: 'bad run' });
        const rows = await s.execute('q3_samples_with_qc_problems', [null]);
        expect(rows.map((r) => [r.sample_id, r.severity, r.problems])).toEqual([
          ['12', 'fail', '2'],
          ['17', 'fail', '3'],
        ]);
        expect(rows[0].reasons).toBe(
          'negative_control warn (0.080): Faint band in PCR negative; within tolerance, kept; read_quality fail: bad run',
        );
      });
    });
    it('a passing QC result adds no problem row', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: 5, result: 'pass', notes: 'fine' });
        expect(await s.execute('q3_samples_with_qc_problems', [null])).toEqual([
          PROBLEM_17,
          PROBLEM_12,
        ]);
      });
    });
    it('an analysis-level fail (no sample) is attributed to every sample of that analysis run', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: null, analysis_id: 3, notes: 'chimeras' }); // analysis 3 -> run 2 -> samples 9-16
        const rows = await s.execute('q3_samples_with_qc_problems', [null]);
        const ids = rows.map((r) => r.sample_id);
        expect(ids).toEqual(['9', '10', '11', '12', '13', '14', '15', '16', '17']); // fail group by sample id (12 is now fail too)
        expect(rows.find((r) => r.sample_id === '9')).toMatchObject({
          severity: 'fail',
          problems: '1',
          reasons: 'analysis 3 read_quality fail: chimeras',
          sequenced: true,
        });
        expect(rows.find((r) => r.sample_id === '12')).toMatchObject({
          severity: 'fail',
          problems: '2',
        });
        expect(rows).toEqual(await oracleProblems(null));
        expect(
          await s
            .execute('q3_samples_with_qc_problems', [2])
            .then((r) => r.map((x) => x.sample_id)),
        ).toEqual(['13', '14', '15', '16']);
      });
    });
    it('a failed extraction attempt adds a problem, and the sample is not `sequenced` without a library', async () => {
      await s.rollback(async (db) => {
        const failed = await newExtraction(db, { qc_status: 'fail' });
        const rows = await s.execute('q3_samples_with_qc_problems', [null]);
        const row = rows.find((r) => r.sample_id === failed.sample_id);
        expect(row).toMatchObject({
          severity: 'fail',
          problems: '1',
          reasons: 'extraction attempt 1 failed QC',
          sequenced: false,
        });
        expect(rows).toEqual(await oracleProblems(null));
      });
    });
    it('a failed attempt followed by a passing attempt with a library: still listed, now sequenced', async () => {
      await s.rollback(async (db) => {
        const first = await newExtraction(db, { qc_status: 'fail' });
        const second = await newExtraction(db, {
          sample_id: first.sample_id,
          attempt_number: 2,
          qc_status: 'pass',
        });
        await newLibrary(db, { extraction_id: second.extraction_id });
        const row = (await s.execute('q3_samples_with_qc_problems', [null])).find(
          (r) => r.sample_id === first.sample_id,
        );
        expect(row).toMatchObject({ problems: '1', sequenced: true });
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('q3_samples_with_qc_problems', [null]);
      expect(cols.map((c) => c.name)).toEqual(PROBLEM_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        sample_id: 'bigint',
        sample_status: 'sample_status',
        severity: 'text',
        problems: 'bigint',
        reasons: 'text',
        sequenced: 'boolean',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes', async () => {
      const first = await s.execute('q3_samples_with_qc_problems', [null]);
      expect(await s.execute('q3_samples_with_qc_problems', [null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('q3_samples_with_qc_problems', [null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('lab: v_lab_pipeline_status', () => {
    // Seed: samples 1-16 are `analyzed` with a passing extraction, a library and a completed run ->
    // stage `sequenced` (first matching rule); sample 17 is `failed` -> `sample_failed`, whatever its
    // (failed) extraction says, and has no library.
    const seededRow = (n) => {
      const event = eventOfSample(n);
      const base = {
        sample_id: String(n),
        sample_code: n === 17 ? SAMPLE_17 : SAMPLE_CODES[n - 1],
        project_id: String(EVENT_PROJECT[event]),
        site_id: String(EVENT_SITE[event]),
        site_name: SITE_NAME[EVENT_SITE[event]],
        collected_at: EVENT_AT[event],
        extraction_attempts: '1',
        latest_extraction_id: String(n),
        latest_attempt_number: 1,
      };
      if (n === 17) {
        return {
          ...base,
          sample_status: 'failed',
          latest_qc_status: 'fail',
          latest_concentration_ng_ul: '0.350',
          latest_purity_a260_280: '1.32',
          batch_id: '1',
          lab_name: LAB_1,
          library_id: null,
          library_code: null,
          run_id: null,
          run_code: null,
          run_status: null,
          run_date: null,
          pipeline_stage: 'sample_failed',
        };
      }
      return {
        ...base,
        sample_status: 'analyzed',
        latest_qc_status: 'pass',
        latest_concentration_ng_ul: CONCENTRATION[n - 1],
        latest_purity_a260_280: PURITY[n - 1],
        batch_id: String(batchOf(n)),
        lab_name: labOf(n),
        library_id: String(n),
        library_code: libraryCode(n),
        run_id: String(runOf(n)),
        run_code: RUN[runOf(n)].code,
        run_status: 'completed',
        run_date: RUN[runOf(n)].date,
        pipeline_stage: 'sequenced',
      };
    };
    const stageOf = async (sampleId) =>
      (
        await s.queryView('v_lab_pipeline_status', { where: 'sample_id = $1', params: [sampleId] })
      )[0];

    it('one row per sample: 16 at stage sequenced with their library and run, sample 17 sample_failed', async () => {
      await acrossSettings(s, async () => {
        const rows = await s.queryView('v_lab_pipeline_status', { orderBy: 'sample_id' });
        expect(rows).toEqual(Array.from({ length: 17 }, (_, i) => seededRow(i + 1)));
      });
    });

    it('oracle: stage counts and the run/library link equal base-table counts', async () => {
      const rows = await s.queryView('v_lab_pipeline_status');
      expect(rows.filter((r) => r.pipeline_stage === 'sequenced')).toHaveLength(16);
      const [{ n }] = await s.sql(
        `SELECT count(*) AS n FROM samples sa, dna_extractions x, sequencing_libraries lib, sequencing_runs r
          WHERE x.sample_id = sa.sample_id AND lib.extraction_id = x.extraction_id
            AND r.run_id = lib.run_id AND r.status = 'completed' AND sa.status = 'analyzed'`,
      );
      expect(rows.filter((r) => r.pipeline_stage === 'sequenced')).toHaveLength(Number(n));
    });

    // metamorphic: every stage of the CASE, in order. Samples are created in the state each rule needs.
    it('a sample without extraction is not_extracted (attempts 0, all lab columns NULL)', async () => {
      await s.rollback(async (db) => {
        const sample = await newSample(db, { event_id: 7 });
        expect(await stageOf(sample.sample_id)).toMatchObject({
          sample_status: 'collected',
          pipeline_stage: 'not_extracted',
          extraction_attempts: '0',
          latest_extraction_id: null,
          latest_qc_status: null,
          lab_name: null,
          library_code: null,
          project_id: '2',
          site_id: '4',
        });
      });
    });
    it('pending extraction -> extraction_qc_pending; pass -> awaiting_library; fail -> extraction_failed', async () => {
      await s.rollback(async (db) => {
        const make = async () => {
          const sample = await newSample(db, { status: 'stored' });
          const x = await newExtraction(db, { sample_id: sample.sample_id, batch_id: 3 });
          return { sampleId: sample.sample_id, extractionId: x.extraction_id };
        };
        const passing = await make();
        const failing = await make();
        expect(await stageOf(passing.sampleId)).toMatchObject({
          pipeline_stage: 'extraction_qc_pending',
          latest_qc_status: 'pending',
          lab_name: LAB_2,
          batch_id: '3',
        });
        // qc_status can only leave `pending`, hence one sample per outcome
        await updateRow(db, 'dna_extractions', 'extraction_id', passing.extractionId, {
          qc_status: 'pass',
        });
        await updateRow(db, 'dna_extractions', 'extraction_id', failing.extractionId, {
          qc_status: 'fail',
        });
        expect((await stageOf(passing.sampleId)).pipeline_stage).toBe('awaiting_library');
        expect((await stageOf(failing.sampleId)).pipeline_stage).toBe('extraction_failed');
      });
    });
    it.each([
      ['planned', 'run_planned'],
      ['running', 'sequencing'],
      ['completed', 'sequenced'],
      ['failed', 'run_failed'],
    ])('library on a %s run -> %s (sample status does not hide it)', async (runStatus, stage) => {
      await s.rollback(async (db) => {
        const run = await newRun(db, { status: runStatus, run_date: '2026-06-01' });
        const lib = await newLibrary(db, { run_id: run.run_id });
        const sampleId = (
          await s.sql('SELECT x.sample_id FROM dna_extractions x WHERE x.extraction_id = $1', [
            lib.extraction_id,
          ])
        )[0].sample_id;
        expect(await stageOf(sampleId)).toMatchObject({
          pipeline_stage: stage,
          run_id: run.run_id,
          run_status: runStatus,
          run_date: '2026-06-01',
          library_code: lib.library_code,
        });
      });
    });
    it('a discarded or failed sample is sample_failed even with a library (rule order)', async () => {
      await s.rollback(async (db) => {
        const lib = await newLibrary(db);
        const sampleId = (
          await s.sql('SELECT sample_id FROM dna_extractions WHERE extraction_id = $1', [
            lib.extraction_id,
          ])
        )[0].sample_id;
        await updateRow(db, 'samples', 'sample_id', sampleId, { status: 'discarded' });
        expect(await stageOf(sampleId)).toMatchObject({
          pipeline_stage: 'sample_failed',
          sample_status: 'discarded',
        });
      });
    });
    it('with two attempts the latest attempt decides; the attempt count is 2', async () => {
      await s.rollback(async (db) => {
        const sample = await newSample(db, { status: 'stored' });
        await newExtraction(db, { sample_id: sample.sample_id, qc_status: 'fail' });
        expect((await stageOf(sample.sample_id)).pipeline_stage).toBe('extraction_failed');
        const second = await newExtraction(db, {
          sample_id: sample.sample_id,
          attempt_number: 2,
          qc_status: 'pass',
        });
        const row = await stageOf(sample.sample_id);
        expect(row).toMatchObject({
          extraction_attempts: '2',
          latest_extraction_id: second.extraction_id,
          latest_attempt_number: 2,
          latest_qc_status: 'pass',
          pipeline_stage: 'awaiting_library',
        });
      });
    });
    it('a library on two runs reports the run with the latest run_date', async () => {
      await s.rollback(async (db) => {
        const lib = await newLibrary(db, { run_id: 1 });
        const later = await newRun(db, { status: 'running', run_date: '2026-12-01' });
        await insertRow(db, 'sequencing_libraries', {
          library_code: `${lib.library_code}-b`,
          extraction_id: lib.extraction_id,
          run_id: later.run_id,
        });
        const sampleId = (
          await s.sql('SELECT sample_id FROM dna_extractions WHERE extraction_id = $1', [
            lib.extraction_id,
          ])
        )[0].sample_id;
        expect(await stageOf(sampleId)).toMatchObject({
          run_id: later.run_id,
          pipeline_stage: 'sequencing',
        });
        // still one row for the sample
        expect(
          await s.queryView('v_lab_pipeline_status', {
            where: 'sample_id = $1',
            params: [sampleId],
          }),
        ).toHaveLength(1);
      });
    });

    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_lab_pipeline_status')).map((c) => c.name)).toEqual(
        PIPELINE_COLUMNS,
      );
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('lab: v_failed_qc', () => {
    // Seed: the failed extraction 17 (operator = batch operator 4, recorded when the extraction row was
    // created) plus QC rows 17 (sample 17 concentration fail), 22 (sample 12 negative_control warn) and
    // 23 (sample 17 contamination_check fail, no metric).
    const SEEDED = [
      {
        sample_id: '17',
        sample_code: SAMPLE_17,
        project_id: '1',
        site_name: 'Dakpathar Barrage',
        extraction_id: '17',
        source: 'extraction',
        qc_type: null,
        severity: 'fail',
        metric_value: '0.350',
        reason: 'Extraction attempt 1 failed QC (0.350 ng/uL, A260/280 1.32)',
        recorded_by: '4',
        recorded_at: '2025-05-20T14:00:00.000Z',
      },
      {
        sample_id: '17',
        sample_code: SAMPLE_17,
        project_id: '1',
        site_name: 'Dakpathar Barrage',
        extraction_id: null,
        source: 'qc_result',
        qc_type: 'concentration',
        severity: 'fail',
        metric_value: '0.350',
        reason: 'Below 1.0 ng/uL; sample marked failed',
        recorded_by: '4',
        recorded_at: '2025-05-20T15:30:00.000Z',
      },
      {
        sample_id: '17',
        sample_code: SAMPLE_17,
        project_id: '1',
        site_name: 'Dakpathar Barrage',
        extraction_id: null,
        source: 'qc_result',
        qc_type: 'contamination_check',
        severity: 'fail',
        metric_value: null,
        reason: 'Low yield and A260/280 1.32 suggest inhibitors',
        recorded_by: '4',
        recorded_at: '2025-05-20T15:50:00.000Z',
      },
      {
        sample_id: '12',
        sample_code: 'EB-20260315-0006-002',
        project_id: '1',
        site_name: 'Sangam Prayagraj',
        extraction_id: null,
        source: 'qc_result',
        qc_type: 'negative_control',
        severity: 'warn',
        metric_value: '0.080',
        reason: 'Faint band in PCR negative; within tolerance, kept',
        recorded_by: '4',
        recorded_at: '2026-03-16T14:00:00.000Z',
      },
    ];
    const sorted = (rows) =>
      [...rows].sort(
        (a, b) =>
          Number(a.sample_id) - Number(b.sample_id) ||
          a.recorded_at.localeCompare(b.recorded_at) ||
          a.source.localeCompare(b.source),
      );
    const qc = (db, over) =>
      insertRow(db, 'quality_control_results', {
        qc_type: 'read_quality',
        result: 'fail',
        recorded_by: 4,
        ...over,
      });

    it('four rows: one failed extraction, two failed QC results on sample 17, one warn on sample 12', async () => {
      await acrossSettings(s, async () => {
        expect(sorted(await s.queryView('v_failed_qc'))).toEqual(sorted(SEEDED));
      });
    });

    it('agrees with q3_samples_with_qc_problems: the same samples with the same problem counts', async () => {
      const view = await s.queryView('v_failed_qc');
      const counts = {};
      for (const r of view) counts[r.sample_id] = (counts[r.sample_id] ?? 0) + 1;
      const q3 = await s.execute('q3_samples_with_qc_problems', [null]);
      expect(Object.fromEntries(q3.map((r) => [r.sample_id, Number(r.problems)]))).toEqual(counts);
    });

    it('oracle: failed-extraction and fail/warn QC rows counted on base tables', async () => {
      const [{ n }] = await s.sql(
        `SELECT (SELECT count(*) FROM dna_extractions WHERE qc_status = 'fail')
              + (SELECT count(*) FROM quality_control_results WHERE result <> 'pass' AND sample_id IS NOT NULL) AS n`,
      );
      expect(await s.queryView('v_failed_qc')).toHaveLength(Number(n));
    });

    it('a failed QC result on a clean sample appears here and in q3; a pass result appears in neither', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: 5, result: 'pass' });
        expect(await s.queryView('v_failed_qc')).toHaveLength(4);
        const failed = await qc(db, { sample_id: 5, metric_value: '12.5', notes: 'low quality' });
        const rows = await s.queryView('v_failed_qc', { where: 'sample_id = 5' });
        expect(rows).toEqual([
          {
            sample_id: '5',
            sample_code: 'EB-20250522-0003-001',
            project_id: '1',
            site_name: 'Sangam Prayagraj',
            extraction_id: null,
            source: 'qc_result',
            qc_type: 'read_quality',
            severity: 'fail',
            metric_value: '12.5',
            reason: 'low quality',
            recorded_by: '4',
            recorded_at: (
              await s.sql('SELECT recorded_at FROM quality_control_results WHERE qc_id = $1', [
                failed.qc_id,
              ])
            )[0].recorded_at,
          },
        ]);
        expect(
          (await s.execute('q3_samples_with_qc_problems', [null])).map((r) => r.sample_id),
        ).toContain('5');
      });
    });
    it('without notes the reason falls back to "<qc_type> <result>"', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: 6, result: 'warn' });
        const [row] = await s.queryView('v_failed_qc', { where: 'sample_id = 6' });
        expect(row).toMatchObject({
          reason: 'read_quality warn',
          severity: 'warn',
          source: 'qc_result',
        });
      });
    });
    it('an analysis-level result is listed once per sample of that analysis run, source analysis_qc', async () => {
      await s.rollback(async (db) => {
        await qc(db, { sample_id: null, analysis_id: 1, result: 'warn', notes: 'low depth' }); // analysis 1 -> run 1 -> samples 1-8
        const rows = await s.queryView('v_failed_qc', {
          where: `source = 'analysis_qc'`,
          orderBy: 'sample_id',
        });
        expect(rows.map((r) => r.sample_id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
        expect(rows[0]).toMatchObject({
          reason: 'analysis 1 read_quality warn: low depth',
          severity: 'warn',
          extraction_id: null,
        });
      });
    });
    it('a new failed extraction attempt shows with the batch operator as recorded_by', async () => {
      await s.rollback(async (db) => {
        const x = await newExtraction(db, {
          qc_status: 'fail',
          concentration_ng_ul: '0.5',
          purity_a260_280: '1.10',
        });
        const [row] = await s.queryView('v_failed_qc', {
          where: 'extraction_id = $1',
          params: [x.extraction_id],
        });
        expect(row).toMatchObject({
          source: 'extraction',
          qc_type: null,
          severity: 'fail',
          recorded_by: '4',
          reason: 'Extraction attempt 1 failed QC (0.500 ng/uL, A260/280 1.10)',
        });
      });
    });

    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_failed_qc')).map((c) => c.name)).toEqual(FAILED_QC_COLUMNS);
    });
  });
});
