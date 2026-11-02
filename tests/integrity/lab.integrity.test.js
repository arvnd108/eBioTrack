// Owner: C (Testing & QA)
// Purpose: Constraint and trigger tests: Laboratory & Sequencing
//
// Written from CONTRACT 3 (run status), 4.3 and 5, migrations 030/090 and the header of
// database/triggers/lab_triggers.sql. Source states of the two state machines are created by a plain
// INSERT with the wanted status (the status triggers only fire on UPDATE).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  asAppRole,
  enumValues,
  expectViolation,
  inSavepoint,
  insertRow,
  newBatch,
  newExtraction,
  newLab,
  newLibrary,
  newRun,
  newSample,
  transitionMatrix,
  unique,
  updateRow,
} from '../setup/integrity.js';
import { closeTestPool, getPool, withRollback } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ABSENT = 999999999;

const makers = {
  laboratories: async () => ({ name: unique('Lab') }),
  extraction_batches: async () => ({ lab_id: 1, operator_id: 4, extraction_date: '2026-01-10' }),
  dna_extractions: async (c) => ({
    sample_id: (await newSample(c, { status: 'stored' })).sample_id,
    batch_id: 1,
  }),
  sequencing_runs: async () => ({ run_code: unique('RUN'), lab_id: 1, platform: 'Illumina' }),
  sequencing_libraries: async (c) => ({
    library_code: unique('LIB'),
    extraction_id: (await newExtraction(c, { qc_status: 'pass' })).extraction_id,
    run_id: (await newRun(c)).run_id,
  }),
  quality_control_results: async () => ({ sample_id: 1, qc_type: 'concentration', result: 'pass' }),
};

const insertValid = async (c, table, over = {}) =>
  insertRow(c, table, { ...(await makers[table](c)), ...over });

// CONTRACT 3, sequencing_runs.status: planned -> running -> completed | failed; planned -> failed
const RUN_STATES = ['planned', 'running', 'completed', 'failed'];
const RUN_ALLOWED = {
  planned: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};
// lab_triggers.sql header 3: an extraction's QC verdict is decided once (CONTRACT 3 names no table)
const QC_STATES = ['pending', 'pass', 'fail'];
const QC_ALLOWED = { pending: ['pass', 'fail'], pass: [], fail: [] };

describe.skipIf(!dbAvailable)('lab: setup', () => {
  beforeAll(async () => {
    await getPool().query(readFileSync(path.join(root, 'database/roles/grants.sql'), 'utf8'));
  });
  afterAll(() => closeTestPool());

  describe('NOT NULL (23502)', () => {
    const cases = [
      ['laboratories', ['name']],
      ['extraction_batches', ['lab_id', 'operator_id', 'extraction_date']],
      ['dna_extractions', ['sample_id', 'batch_id', 'attempt_number', 'qc_status']],
      ['sequencing_runs', ['run_code', 'lab_id', 'platform']],
      ['sequencing_libraries', ['library_code', 'extraction_id', 'run_id']],
      ['quality_control_results', ['qc_type', 'result']],
    ].flatMap(([table, columns]) => columns.map((column) => [table, column]));

    it.each(cases)('%s.%s: NULL -> 23502', (table, column) =>
      withRollback(async (c) => {
        const row = { ...(await makers[table](c)), [column]: null };
        const err = await expectViolation(
          inSavepoint(c, () => insertRow(c, table, row)),
          '23502',
        );
        expect(err.column).toBe(column);
      }),
    );

    it('a valid row of every table is accepted', () =>
      withRollback(async (c) => {
        for (const table of Object.keys(makers)) await insertValid(c, table);
      }));
  });

  describe('primary keys and UNIQUE (23505)', () => {
    const pks = [
      ['pk_laboratories', 'laboratories', 'lab_id'],
      ['pk_extraction_batches', 'extraction_batches', 'batch_id'],
      ['pk_dna_extractions', 'dna_extractions', 'extraction_id'],
      ['pk_sequencing_runs', 'sequencing_runs', 'run_id'],
      ['pk_sequencing_libraries', 'sequencing_libraries', 'library_id'],
      ['pk_quality_control_results', 'quality_control_results', 'qc_id'],
    ];

    it.each(pks)('%s: duplicate %s.%s -> 23505', (constraint, table, column) =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, table, { [column]: 1 })),
          '23505',
          constraint,
        );
      }),
    );

    it('uq_laboratories_name: duplicate lab name -> 23505; a new name is accepted', () =>
      withRollback(async (c) => {
        const { rows } = await c.query('SELECT name FROM laboratories WHERE lab_id = 1');
        await expectViolation(
          inSavepoint(c, () => newLab(c, { name: rows[0].name })),
          '23505',
          'uq_laboratories_name',
        );
        await newLab(c, { name: `${rows[0].name} (annex)` });
      }));

    it('uq_dna_extractions_sample_attempt: the same attempt for a sample twice -> 23505; the next attempt and another sample are accepted', () =>
      withRollback(async (c) => {
        // Sample 1 already has attempt 1 (extraction 1).
        await expectViolation(
          inSavepoint(c, () => newExtraction(c, { sample_id: 1, attempt_number: 1 })),
          '23505',
          'uq_dna_extractions_sample_attempt',
        );
        await newExtraction(c, { sample_id: 1, attempt_number: 2 });
        await newExtraction(c, { attempt_number: 1 });
      }));

    it('uq_sequencing_runs_run_code: duplicate run code -> 23505; a new code is accepted', () =>
      withRollback(async (c) => {
        const { rows } = await c.query('SELECT run_code FROM sequencing_runs WHERE run_id = 1');
        await expectViolation(
          inSavepoint(c, () => newRun(c, { run_code: rows[0].run_code })),
          '23505',
          'uq_sequencing_runs_run_code',
        );
        await newRun(c, { run_code: `${rows[0].run_code}-B` });
      }));

    it('uq_sequencing_libraries_library_code: duplicate library code -> 23505; a new code is accepted', () =>
      withRollback(async (c) => {
        const { rows } = await c.query(
          'SELECT library_code FROM sequencing_libraries WHERE library_id = 1',
        );
        await expectViolation(
          inSavepoint(c, () => newLibrary(c, { library_code: rows[0].library_code })),
          '23505',
          'uq_sequencing_libraries_library_code',
        );
        await newLibrary(c, { library_code: `${rows[0].library_code}-B` });
      }));

    it('uq_sequencing_libraries_extraction_run: an extraction twice on one run -> 23505; on another run it is accepted', () =>
      withRollback(async (c) => {
        // Library 1 is built from extraction 1 on run 1.
        await expectViolation(
          inSavepoint(c, () => newLibrary(c, { extraction_id: 1, run_id: 1 })),
          '23505',
          'uq_sequencing_libraries_extraction_run',
        );
        await newLibrary(c, { extraction_id: 1 });
      }));
  });

  describe('FOREIGN KEY (23503)', () => {
    const fks = [
      ['fk_extraction_batches_lab_id', 'extraction_batches', 'lab_id'],
      ['fk_extraction_batches_operator_id', 'extraction_batches', 'operator_id'],
      ['fk_dna_extractions_batch_id', 'dna_extractions', 'batch_id'],
      ['fk_dna_extractions_sample_id', 'dna_extractions', 'sample_id'],
      ['fk_sequencing_runs_lab_id', 'sequencing_runs', 'lab_id'],
      ['fk_sequencing_libraries_extraction_id', 'sequencing_libraries', 'extraction_id'],
      ['fk_sequencing_libraries_run_id', 'sequencing_libraries', 'run_id'],
      ['fk_quality_control_results_sample_id', 'quality_control_results', 'sample_id'],
      ['fk_quality_control_results_analysis_id', 'quality_control_results', 'analysis_id'],
      ['fk_quality_control_results_recorded_by', 'quality_control_results', 'recorded_by'],
    ];

    it.each(fks)('%s: unknown %s.%s -> 23503', (constraint, table, column) =>
      withRollback(async (c) => {
        const row = { ...(await makers[table](c)), [column]: ABSENT };
        await expectViolation(
          inSavepoint(c, () => insertRow(c, table, row)),
          '23503',
          constraint,
        );
      }),
    );

    describe('reverse direction: deleting a referenced row (RESTRICT / NO ACTION, D19)', () => {
      it.each([
        [
          'a lab with a batch',
          'fk_extraction_batches_lab_id',
          async (c) => {
            const lab = await newLab(c);
            await newBatch(c, { lab_id: lab.lab_id });
            return ['DELETE FROM laboratories WHERE lab_id = $1', [lab.lab_id]];
          },
        ],
        [
          'a lab with a run',
          'fk_sequencing_runs_lab_id',
          async (c) => {
            const lab = await newLab(c);
            await newRun(c, { lab_id: lab.lab_id });
            return ['DELETE FROM laboratories WHERE lab_id = $1', [lab.lab_id]];
          },
        ],
        [
          'a batch with extractions',
          'fk_dna_extractions_batch_id',
          async () => ['DELETE FROM extraction_batches WHERE batch_id = $1', [1]],
        ],
        [
          'an extraction with a library',
          'fk_sequencing_libraries_extraction_id',
          async () => ['DELETE FROM dna_extractions WHERE extraction_id = $1', [1]],
        ],
        [
          'a run with a library',
          'fk_sequencing_libraries_run_id',
          async (c) => {
            const library = await newLibrary(c);
            return ['DELETE FROM sequencing_runs WHERE run_id = $1', [library.run_id]];
          },
        ],
        [
          'a user who operated a batch',
          null,
          async () => ['DELETE FROM users WHERE user_id = $1', [4]],
        ],
        [
          'a sample with an extraction',
          null,
          async () => ['DELETE FROM samples WHERE sample_id = $1', [1]],
        ],
      ])('%s cannot be deleted -> 23503', (_label, constraint, build) =>
        withRollback(async (c) => {
          const [sql, params] = await build(c);
          await expectViolation(
            inSavepoint(c, () => c.query(sql, params)),
            '23503',
            constraint ?? undefined,
          );
        }),
      );

      it('the app role cannot DELETE any Lab table (42501)', () =>
        withRollback(async (c) => {
          for (const table of Object.keys(makers)) {
            await expectViolation(
              inSavepoint(c, () => asAppRole(c, () => c.query(`DELETE FROM ${table} WHERE false`))),
              '42501',
            );
          }
        }));
    });
  });

  describe('CHECK (23514), both sides of every boundary', () => {
    const checks = [
      [
        'ck_laboratories_name_not_blank',
        'laboratories',
        [{ name: 'x' }],
        [{ name: '' }, { name: '   ' }],
      ],
      [
        'ck_dna_extractions_attempt_number',
        'dna_extractions',
        [{ attempt_number: 1 }, { attempt_number: 2 }],
        [{ attempt_number: 0 }, { attempt_number: -1 }],
      ],
      [
        'ck_dna_extractions_concentration',
        'dna_extractions',
        [{ concentration_ng_ul: 0 }, { concentration_ng_ul: 0.001 }, { concentration_ng_ul: null }],
        [{ concentration_ng_ul: -0.001 }],
      ],
      [
        'ck_dna_extractions_purity',
        'dna_extractions',
        [
          { purity_a260_280: 0 },
          { purity_a260_280: 1.8 },
          { purity_a260_280: 999.99 },
          { purity_a260_280: null },
        ],
        [{ purity_a260_280: -0.01 }],
      ],
      [
        'ck_sequencing_runs_run_code_not_blank',
        'sequencing_runs',
        [{ run_code: 'x' }],
        [{ run_code: '' }, { run_code: '   ' }],
      ],
      [
        'ck_sequencing_runs_platform_not_blank',
        'sequencing_runs',
        [{ platform: 'x' }],
        [{ platform: '' }, { platform: '   ' }],
      ],
      [
        'ck_sequencing_libraries_library_code_not_blank',
        'sequencing_libraries',
        [{ library_code: 'x' }],
        [{ library_code: '' }, { library_code: '   ' }],
      ],
      [
        // 030: "a QC result belongs to a sample, an analysis run, or both" (at least one)
        'ck_quality_control_results_target',
        'quality_control_results',
        [
          { sample_id: 1, analysis_id: null },
          { sample_id: null, analysis_id: 1 },
          { sample_id: 1, analysis_id: 1 },
        ],
        [{ sample_id: null, analysis_id: null }],
      ],
    ];

    for (const [constraint, table, good, bad] of checks) {
      it(`${constraint}: ${good.length} valid value(s) pass, ${bad.length} invalid value(s) -> 23514`, () =>
        withRollback(async (c) => {
          for (const over of good) {
            await inSavepoint(c, async () => insertValid(c, table, over), { keep: false });
          }
          for (const over of bad) {
            await expectViolation(
              inSavepoint(c, () => insertValid(c, table, over)),
              '23514',
              constraint,
            );
          }
        }));
    }

    it('ck_quality_control_results_target also guards UPDATE: clearing the last target -> 23514', () =>
      withRollback(async (c) => {
        const qc = await insertValid(c, 'quality_control_results', {
          sample_id: 1,
          analysis_id: null,
        });
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'quality_control_results', 'qc_id', qc.qc_id, { sample_id: null }),
          ),
          '23514',
          'ck_quality_control_results_target',
        );
      }));
  });

  describe('enum values (22P02)', () => {
    it('qc_status: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'dna_extractions', { qc_status: 'maybe' })),
          '22P02',
        );
        const values = await enumValues(c, 'qc_status');
        expect(values).toEqual(QC_STATES);
        for (const qc_status of values) await insertValid(c, 'dna_extractions', { qc_status });
      }));

    it('qc_result: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'quality_control_results', { result: 'fine' })),
          '22P02',
        );
        const values = await enumValues(c, 'qc_result');
        expect(values).toEqual(['pass', 'warn', 'fail']);
        for (const result of values) await insertValid(c, 'quality_control_results', { result });
      }));

    it('qc_type: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'quality_control_results', { qc_type: 'taste' })),
          '22P02',
        );
        const values = await enumValues(c, 'qc_type');
        expect(values).toEqual([
          'extraction_blank',
          'negative_control',
          'positive_control',
          'concentration',
          'contamination_check',
          'read_quality',
        ]);
        for (const qc_type of values) await insertValid(c, 'quality_control_results', { qc_type });
      }));

    it('run_status: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'sequencing_runs', { status: 'paused' })),
          '22P02',
        );
        const values = await enumValues(c, 'run_status');
        expect(values).toEqual(RUN_STATES);
        for (const status of values) await insertValid(c, 'sequencing_runs', { status });
      }));
  });

  describe('sequencing_runs.status transitions (CONTRACT 3, EB001)', () => {
    it('the test matrix covers 4 x 4 pairs, 4 of them allowed', () => {
      const matrix = transitionMatrix(RUN_STATES, RUN_ALLOWED);
      expect(matrix).toHaveLength(16);
      expect(matrix.filter(([, , ok]) => ok)).toHaveLength(4);
    });

    const pairs = transitionMatrix(RUN_STATES, RUN_ALLOWED).filter(([from, to]) => from !== to);

    it.each(pairs)('%s -> %s (allowed: %s)', (from, to, allowed) =>
      withRollback(async (c) => {
        const run = await newRun(c, { status: from });
        const move = () => updateRow(c, 'sequencing_runs', 'run_id', run.run_id, { status: to });
        if (allowed) {
          expect((await move()).status).toBe(to);
        } else {
          await expectViolation(
            inSavepoint(c, move),
            'EB001',
            undefined,
            `cannot move from ${from} to ${to}`,
          );
          const { rows } = await c.query('SELECT status FROM sequencing_runs WHERE run_id = $1', [
            run.run_id,
          ]);
          expect(rows[0].status).toBe(from);
        }
      }),
    );

    // CONTRACT GAP: CONTRACT 3 does not say whether re-sending the current status is a transition.
    // lab_triggers.sql lets it pass (only a CHANGE of status is checked); the test follows the trigger.
    it.each(RUN_STATES)('CONTRACT GAP: %s -> %s (same state) is accepted', (state) =>
      withRollback(async (c) => {
        const run = await newRun(c, { status: state });
        const updated = await updateRow(c, 'sequencing_runs', 'run_id', run.run_id, {
          status: state,
        });
        expect(updated.status).toBe(state);
      }),
    );

    it('a finished run can still have other columns edited (only status is guarded)', () =>
      withRollback(async (c) => {
        const run = await newRun(c, { status: 'completed' });
        const updated = await updateRow(c, 'sequencing_runs', 'run_id', run.run_id, {
          platform: 'Nanopore',
        });
        expect(updated.platform).toBe('Nanopore');
      }));
  });

  describe('dna_extractions.qc_status transitions (EB001)', () => {
    it('the test matrix covers 3 x 3 pairs, 2 of them allowed', () => {
      const matrix = transitionMatrix(QC_STATES, QC_ALLOWED);
      expect(matrix).toHaveLength(9);
      expect(matrix.filter(([, , ok]) => ok)).toHaveLength(2);
    });

    const pairs = transitionMatrix(QC_STATES, QC_ALLOWED).filter(([from, to]) => from !== to);

    it.each(pairs)('%s -> %s (allowed: %s)', (from, to, allowed) =>
      withRollback(async (c) => {
        const extraction = await newExtraction(c, { qc_status: from });
        const move = () =>
          updateRow(c, 'dna_extractions', 'extraction_id', extraction.extraction_id, {
            qc_status: to,
          });
        if (allowed) {
          expect((await move()).qc_status).toBe(to);
        } else {
          await expectViolation(
            inSavepoint(c, move),
            'EB001',
            undefined,
            `from QC status ${from} to ${to}`,
          );
        }
      }),
    );

    // CONTRACT GAP: same reading as for runs; the trigger header says setting the value it already
    // has "is not a transition".
    it.each(QC_STATES)('CONTRACT GAP: %s -> %s (same state) is accepted', (state) =>
      withRollback(async (c) => {
        const extraction = await newExtraction(c, { qc_status: state });
        const updated = await updateRow(
          c,
          'dna_extractions',
          'extraction_id',
          extraction.extraction_id,
          {
            qc_status: state,
          },
        );
        expect(updated.qc_status).toBe(state);
      }),
    );

    it('a booked (passed) extraction can never be marked fail under its library', () =>
      withRollback(async (c) => {
        const library = await newLibrary(c);
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'dna_extractions', 'extraction_id', library.extraction_id, {
              qc_status: 'fail',
            }),
          ),
          'EB001',
        );
      }));
  });

  describe('business rules (EB002)', () => {
    it('trg_sequencing_libraries_qc_pass: a library for the failed extraction 17 -> EB002', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => newLibrary(c, { extraction_id: 17 })),
          'EB002',
          undefined,
          'has not passed QC',
        );
      }));

    it('trg_sequencing_libraries_qc_pass: a pending extraction -> EB002; a passed one is accepted', () =>
      withRollback(async (c) => {
        const pending = await newExtraction(c, { qc_status: 'pending' });
        await expectViolation(
          inSavepoint(c, () => newLibrary(c, { extraction_id: pending.extraction_id })),
          'EB002',
          undefined,
          'qc_status pending',
        );
        const passed = await newExtraction(c, { qc_status: 'pass' });
        await newLibrary(c, { extraction_id: passed.extraction_id });
      }));

    it('trg_sequencing_libraries_qc_pass also fires on UPDATE of extraction_id', () =>
      withRollback(async (c) => {
        const library = await newLibrary(c);
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'sequencing_libraries', 'library_id', library.library_id, {
              extraction_id: 17,
            }),
          ),
          'EB002',
        );
        const other = await newExtraction(c, { qc_status: 'pass' });
        await updateRow(c, 'sequencing_libraries', 'library_id', library.library_id, {
          extraction_id: other.extraction_id,
        });
      }));

    it('trg_dna_extractions_sample_status: a recorded extraction moves its sample stored -> extracted and writes history', () =>
      withRollback(async (c) => {
        const sample = await newSample(c, { status: 'stored' });
        await newExtraction(c, { sample_id: sample.sample_id });
        const { rows } = await c.query('SELECT status FROM samples WHERE sample_id = $1', [
          sample.sample_id,
        ]);
        expect(rows[0].status).toBe('extracted');
        const history = await c.query(
          'SELECT old_status, new_status FROM sample_status_history WHERE sample_id = $1',
          [sample.sample_id],
        );
        expect(history.rows).toEqual([{ old_status: 'stored', new_status: 'extracted' }]);
      }));

    it.each(['collected', 'extracted', 'sequenced', 'analyzed', 'failed', 'discarded'])(
      'trg_dna_extractions_sample_status: a sample in %s is left as it is',
      (status) =>
        withRollback(async (c) => {
          const sample = await newSample(c, { status });
          await newExtraction(c, { sample_id: sample.sample_id });
          const { rows } = await c.query('SELECT status FROM samples WHERE sample_id = $1', [
            sample.sample_id,
          ]);
          expect(rows[0].status).toBe(status);
        }),
    );
  });

  describe('triggers of the Lab slice are installed', () => {
    const triggers = [
      ['trg_sequencing_libraries_qc_pass', 'sequencing_libraries'],
      ['trg_sequencing_runs_status', 'sequencing_runs'],
      ['trg_dna_extractions_qc_status', 'dna_extractions'],
      ['trg_dna_extractions_sample_status', 'dna_extractions'],
      ['trg_dna_extractions_audit', 'dna_extractions'],
      ['trg_sequencing_libraries_audit', 'sequencing_libraries'],
      ['trg_sequencing_runs_audit', 'sequencing_runs'],
      ['trg_quality_control_results_audit', 'quality_control_results'],
    ];

    it.each(triggers)('%s is enabled on %s', async (name, table) => {
      const { rows } = await getPool().query(
        `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`,
        [name, table],
      );
      expect(rows).toEqual([{ tgenabled: 'O' }]);
    });

    it('trg_sequencing_runs_audit: a new run writes an audit row', () =>
      withRollback(async (c) => {
        const run = await newRun(c);
        const { rows } = await c.query(
          `SELECT action FROM audit_logs WHERE entity_type = 'sequencing_runs' AND entity_id = $1`,
          [run.run_id],
        );
        expect(rows).toEqual([{ action: 'insert' }]);
      }));
  });
});
