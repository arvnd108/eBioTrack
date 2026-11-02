// Owner: C (Testing & QA)
// Purpose: Constraint and trigger tests: Analysis, Taxonomy & Analytics
//
// Written from CONTRACT 3 (analysis_runs transitions, supersession), 4.4, D17, D19, migrations
// 040/090/096 and the header of database/triggers/analysis_triggers.sql. Source states of the
// transition matrix are created by a plain INSERT with the wanted status (the triggers only fire on
// UPDATE/DELETE of analysis_runs); an approved source is given approver 2 and a fixed timestamp, and
// the matrix sends the same values, so only the status differs (a changed approver would raise
// EB002 from the immutability trigger before the EB001 under test).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  asAppRole,
  enumValues,
  expectViolation,
  FIXED_TIME,
  inSavepoint,
  insertRow,
  newAnalysis,
  newDetection,
  newRun,
  newTaxon,
  transitionMatrix,
  unique,
  updateRow,
} from '../setup/integrity.js';
import { closeTestPool, getPool, withRollback } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ABSENT = 999999999;

const makers = {
  dna_markers: async () => ({ marker_name: unique('marker') }),
  analysis_runs: async () => ({
    run_id: 1,
    marker_id: 1,
    pipeline_name: 'qiime2',
    pipeline_version: '2024.5',
    reference_db: 'SILVA',
  }),
  taxa: async () => ({ scientific_name: unique('Taxon'), rank: 'species' }),
  taxon_assignments: async (c) => ({
    analysis_id: 4,
    library_id: 1,
    taxon_id: (await newTaxon(c)).taxon_id,
    read_count: 10,
    confidence: 0.9,
    qc_flag: 'pass',
  }),
  data_exports: async () => ({ requested_by: 2, project_id: 1, export_type: 'samples_csv' }),
};

const insertValid = async (c, table, over = {}) =>
  insertRow(c, table, { ...(await makers[table](c)), ...over });

// CONTRACT 3, analysis_runs.status
const STATES = ['draft', 'imported', 'approved', 'rejected', 'superseded'];
const ALLOWED = {
  draft: ['imported', 'rejected'],
  imported: ['approved', 'rejected'],
  approved: ['superseded'],
  rejected: ['draft'],
  superseded: [],
};

/** Walk a new analysis legally to approved (draft -> imported -> approved, importer 5, approver 2). */
async function newApproved(c, over = {}) {
  const run = await newAnalysis(c, over);
  await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, { status: 'imported' });
  return updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
    status: 'approved',
    approved_by: 2,
    approved_at: FIXED_TIME,
  });
}

/** An approved run that has been superseded by an approved correction. */
async function newSuperseded(c) {
  const old = await newApproved(c);
  await newAnalysis(c, { status: 'approved', supersedes_analysis_id: old.analysis_id });
  return updateRow(c, 'analysis_runs', 'analysis_id', old.analysis_id, { status: 'superseded' });
}

const statusOf = async (c, id) =>
  (await c.query('SELECT status FROM analysis_runs WHERE analysis_id = $1', [id])).rows[0].status;

describe.skipIf(!dbAvailable)('analysis: setup', () => {
  beforeAll(async () => {
    await getPool().query(readFileSync(path.join(root, 'database/roles/grants.sql'), 'utf8'));
  });
  afterAll(() => closeTestPool());

  describe('NOT NULL (23502)', () => {
    const cases = [
      ['dna_markers', ['marker_name']],
      [
        'analysis_runs',
        ['run_id', 'marker_id', 'pipeline_name', 'pipeline_version', 'reference_db', 'status'],
      ],
      ['taxa', ['scientific_name', 'rank']],
      [
        'taxon_assignments',
        ['analysis_id', 'library_id', 'taxon_id', 'read_count', 'confidence', 'qc_flag'],
      ],
      ['data_exports', ['requested_by', 'project_id', 'export_type']],
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
      ['pk_dna_markers', 'dna_markers', 'marker_id'],
      ['pk_analysis_runs', 'analysis_runs', 'analysis_id'],
      ['pk_taxa', 'taxa', 'taxon_id'],
      ['pk_taxon_assignments', 'taxon_assignments', 'assignment_id'],
      ['pk_data_exports', 'data_exports', 'export_id'],
    ];

    it.each(pks)('%s: duplicate %s.%s -> 23505', (constraint, table, column) =>
      withRollback(async (c) => {
        if (table === 'data_exports') await insertValid(c, table, { export_id: 1 });
        await expectViolation(
          inSavepoint(c, () => insertValid(c, table, { [column]: 1 })),
          '23505',
          constraint,
        );
      }),
    );

    it('uq_dna_markers_marker_name: duplicate marker name -> 23505; a new name is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'dna_markers', { marker_name: '12S' })),
          '23505',
          'uq_dna_markers_marker_name',
        );
        await insertValid(c, 'dna_markers', { marker_name: '16S' });
      }));

    it('uq_taxa_scientific_name_rank: the same name at the same rank -> 23505; at a different rank it is accepted', () =>
      withRollback(async (c) => {
        const taxon = await newTaxon(c, { scientific_name: 'Homonymus', rank: 'genus' });
        await expectViolation(
          inSavepoint(c, () => newTaxon(c, { scientific_name: 'Homonymus', rank: 'genus' })),
          '23505',
          'uq_taxa_scientific_name_rank',
        );
        await newTaxon(c, { scientific_name: taxon.scientific_name, rank: 'species' });
        await newTaxon(c, { scientific_name: taxon.scientific_name, rank: 'family' });
      }));

    it('uq_taxon_assignments_analysis_library_taxon: the same taxon twice for one library of an analysis -> 23505; another library, taxon or analysis is accepted', () =>
      withRollback(async (c) => {
        const taxon = await newTaxon(c);
        await newDetection(c, { analysis_id: 4, library_id: 1, taxon_id: taxon.taxon_id });
        await expectViolation(
          inSavepoint(c, () =>
            newDetection(c, { analysis_id: 4, library_id: 1, taxon_id: taxon.taxon_id }),
          ),
          '23505',
          'uq_taxon_assignments_analysis_library_taxon',
        );
        await newDetection(c, { analysis_id: 4, library_id: 2, taxon_id: taxon.taxon_id });
        await newDetection(c, {
          analysis_id: 4,
          library_id: 1,
          taxon_id: (await newTaxon(c)).taxon_id,
        });
        const other = await newAnalysis(c);
        await newDetection(c, {
          analysis_id: other.analysis_id,
          library_id: 1,
          taxon_id: taxon.taxon_id,
        });
      }));

    it('uq_analysis_runs_supersedes_analysis_id: two corrections of one run -> 23505; runs with no correction (NULLs) are unlimited', () =>
      withRollback(async (c) => {
        await newAnalysis(c, { supersedes_analysis_id: 1 });
        await expectViolation(
          inSavepoint(c, () => newAnalysis(c, { supersedes_analysis_id: 1 })),
          '23505',
          'uq_analysis_runs_supersedes_analysis_id',
        );
        await newAnalysis(c, { supersedes_analysis_id: 2 });
        await newAnalysis(c);
        await newAnalysis(c);
      }));
  });

  describe('FOREIGN KEY (23503)', () => {
    const fks = [
      ['fk_analysis_runs_marker_id', 'analysis_runs', 'marker_id'],
      ['fk_analysis_runs_run_id', 'analysis_runs', 'run_id'],
      ['fk_analysis_runs_imported_by', 'analysis_runs', 'imported_by'],
      ['fk_analysis_runs_approved_by', 'analysis_runs', 'approved_by'],
      ['fk_analysis_runs_supersedes_analysis_id', 'analysis_runs', 'supersedes_analysis_id'],
      ['fk_taxa_parent_taxon_id', 'taxa', 'parent_taxon_id'],
      ['fk_taxon_assignments_analysis_id', 'taxon_assignments', 'analysis_id'],
      ['fk_taxon_assignments_taxon_id', 'taxon_assignments', 'taxon_id'],
      ['fk_taxon_assignments_library_id', 'taxon_assignments', 'library_id'],
      ['fk_data_exports_requested_by', 'data_exports', 'requested_by'],
      ['fk_data_exports_project_id', 'data_exports', 'project_id'],
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

    describe('reverse direction: deleting a referenced row (RESTRICT, D19)', () => {
      it.each([
        [
          'a marker used by an analysis',
          'fk_analysis_runs_marker_id',
          async () => ['DELETE FROM dna_markers WHERE marker_id = $1', [1]],
        ],
        [
          'a taxon with a child',
          'fk_taxa_parent_taxon_id',
          async (c) => {
            const parent = await newTaxon(c, { rank: 'genus' });
            await newTaxon(c, { parent_taxon_id: parent.taxon_id });
            return ['DELETE FROM taxa WHERE taxon_id = $1', [parent.taxon_id]];
          },
        ],
        [
          'a taxon with detections',
          'fk_taxon_assignments_taxon_id',
          async (c) => {
            const detection = await newDetection(c, { taxon_id: (await newTaxon(c)).taxon_id });
            return ['DELETE FROM taxa WHERE taxon_id = $1', [detection.taxon_id]];
          },
        ],
        [
          'a library with detections',
          'fk_taxon_assignments_library_id',
          async () => ['DELETE FROM sequencing_libraries WHERE library_id = $1', [1]],
        ],
        [
          'an imported analysis with detections (the trigger allows the delete, the FK refuses)',
          'fk_taxon_assignments_analysis_id',
          async () => ['DELETE FROM analysis_runs WHERE analysis_id = $1', [3]],
        ],
        [
          'a sequencing run used by an analysis',
          'fk_analysis_runs_run_id',
          async (c) => {
            const run = await newRun(c);
            await newAnalysis(c, { run_id: run.run_id });
            return ['DELETE FROM sequencing_runs WHERE run_id = $1', [run.run_id]];
          },
        ],
        [
          'a run that a correction names',
          'fk_analysis_runs_supersedes_analysis_id',
          async (c) => {
            const target = await newAnalysis(c);
            await newAnalysis(c, { supersedes_analysis_id: target.analysis_id });
            return ['DELETE FROM analysis_runs WHERE analysis_id = $1', [target.analysis_id]];
          },
        ],
        [
          'a project with an export',
          null,
          async (c) => {
            await insertValid(c, 'data_exports');
            return ['DELETE FROM projects WHERE project_id = $1', [1]];
          },
        ],
      ])('%s -> 23503', (_label, constraint, build) =>
        withRollback(async (c) => {
          const [sql, params] = await build(c);
          await expectViolation(
            inSavepoint(c, () => c.query(sql, params)),
            '23503',
            constraint ?? undefined,
          );
        }),
      );

      it('the app role cannot DELETE any Analysis table (42501)', () =>
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
        'ck_dna_markers_marker_name_not_blank',
        'dna_markers',
        [{ marker_name: 'x' }],
        [{ marker_name: '' }, { marker_name: '   ' }],
      ],
      [
        'ck_analysis_runs_pipeline_name_not_blank',
        'analysis_runs',
        [{ pipeline_name: 'x' }],
        [{ pipeline_name: '' }, { pipeline_name: '   ' }],
      ],
      [
        'ck_analysis_runs_pipeline_version_not_blank',
        'analysis_runs',
        [{ pipeline_version: 'x' }],
        [{ pipeline_version: '' }, { pipeline_version: '   ' }],
      ],
      [
        'ck_analysis_runs_reference_db_not_blank',
        'analysis_runs',
        [{ reference_db: 'x' }],
        [{ reference_db: '' }, { reference_db: '   ' }],
      ],
      [
        'ck_analysis_runs_approved_fields',
        'analysis_runs',
        [
          { status: 'approved', approved_by: 2, approved_at: FIXED_TIME },
          { status: 'imported', approved_by: null, approved_at: null },
          { status: 'draft', approved_by: 2, approved_at: null },
        ],
        [
          { status: 'approved', approved_by: null, approved_at: FIXED_TIME },
          { status: 'approved', approved_by: 2, approved_at: null },
          { status: 'approved', approved_by: null, approved_at: null },
        ],
      ],
      [
        'ck_taxa_scientific_name_not_blank',
        'taxa',
        [{ scientific_name: 'x' }],
        [{ scientific_name: '' }, { scientific_name: '   ' }],
      ],
      [
        'ck_taxon_assignments_read_count',
        'taxon_assignments',
        [{ read_count: 0 }, { read_count: 1 }, { read_count: 2147483647 }],
        [{ read_count: -1 }],
      ],
      [
        'ck_taxon_assignments_confidence',
        'taxon_assignments',
        [{ confidence: 0 }, { confidence: 0.5 }, { confidence: 1 }],
        [{ confidence: 1.0001 }, { confidence: -0.0001 }],
      ],
      [
        'ck_data_exports_row_count',
        'data_exports',
        [{ row_count: null }, { row_count: 0 }, { row_count: 1 }],
        [{ row_count: -1 }],
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

    it('ck_taxa_not_own_parent: a taxon cannot be its own parent -> 23514; a different parent is accepted', () =>
      withRollback(async (c) => {
        const taxon = await newTaxon(c);
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'taxa', 'taxon_id', taxon.taxon_id, { parent_taxon_id: taxon.taxon_id }),
          ),
          '23514',
          'ck_taxa_not_own_parent',
        );
        await updateRow(c, 'taxa', 'taxon_id', taxon.taxon_id, { parent_taxon_id: 1 });
      }));

    it('ck_analysis_runs_supersedes_not_self: a run cannot supersede itself -> 23514; another run is accepted', () =>
      withRollback(async (c) => {
        const run = await newAnalysis(c);
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
              supersedes_analysis_id: run.analysis_id,
            }),
          ),
          '23514',
          'ck_analysis_runs_supersedes_not_self',
        );
        await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
          supersedes_analysis_id: 1,
        });
      }));
  });

  describe('enum values (22P02)', () => {
    it('analysis_status: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => newAnalysis(c, { status: 'pending' })),
          '22P02',
        );
        const values = await enumValues(c, 'analysis_status');
        expect(values).toEqual(STATES);
        for (const status of values) await newAnalysis(c, { status });
      }));

    it('qc_flag: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'taxon_assignments', { qc_flag: 'bad' })),
          '22P02',
        );
        const values = await enumValues(c, 'qc_flag');
        expect(values).toEqual(['pass', 'warn', 'fail']);
        for (const qc_flag of values) await insertValid(c, 'taxon_assignments', { qc_flag });
      }));

    it('taxon_rank: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'taxa', { rank: 'tribe' })),
          '22P02',
        );
        const values = await enumValues(c, 'taxon_rank');
        expect(values).toEqual([
          'domain',
          'kingdom',
          'phylum',
          'class',
          'order',
          'family',
          'genus',
          'species',
        ]);
        for (const rank of values) await insertValid(c, 'taxa', { rank });
      }));

    it('export_type: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'data_exports', { export_type: 'pdf' })),
          '22P02',
        );
        const values = await enumValues(c, 'export_type');
        expect(values).toEqual(['samples_csv', 'detections_csv', 'richness_csv']);
        for (const export_type of values) await insertValid(c, 'data_exports', { export_type });
      }));
  });

  describe('analysis_runs.status transitions (CONTRACT 3, EB001)', () => {
    it('the test matrix covers 5 x 5 pairs, 6 of them allowed', () => {
      const matrix = transitionMatrix(STATES, ALLOWED);
      expect(matrix).toHaveLength(25);
      expect(matrix.filter(([, , ok]) => ok)).toHaveLength(6);
    });

    const pairs = transitionMatrix(STATES, ALLOWED).filter(([from, to]) => from !== to);

    it.each(pairs)('%s -> %s (allowed: %s)', (from, to, allowed) =>
      withRollback(async (c) => {
        const source = await newAnalysis(c, { status: from });
        if (from === 'approved' && to === 'superseded') {
          // The only legal exit of approved needs an approved correction (CONTRACT 3).
          await newAnalysis(c, { status: 'approved', supersedes_analysis_id: source.analysis_id });
        }
        const changes = { status: to };
        if (to === 'approved') Object.assign(changes, { approved_by: 2, approved_at: FIXED_TIME });
        const move = () =>
          updateRow(c, 'analysis_runs', 'analysis_id', source.analysis_id, changes);
        if (allowed) {
          expect((await move()).status).toBe(to);
        } else {
          await expectViolation(
            inSavepoint(c, move),
            'EB001',
            undefined,
            `cannot move from ${from} to ${to}`,
          );
          expect(await statusOf(c, source.analysis_id)).toBe(from);
        }
      }),
    );

    // CONTRACT GAP: CONTRACT 3 does not say whether re-sending the current status is a transition.
    // analysis_triggers.sql lets it pass ("Updates that do not change status pass"); the test
    // follows the trigger.
    it.each(STATES)('CONTRACT GAP: %s -> %s (same state) is accepted', (state) =>
      withRollback(async (c) => {
        const run = await newAnalysis(c, { status: state });
        const updated = await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
          status: state,
        });
        expect(updated.status).toBe(state);
      }),
    );

    it('imported -> approved by the importer is refused (EB002, D17)', () =>
      withRollback(async (c) => {
        const run = await newAnalysis(c, { status: 'imported', imported_by: 5 });
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
              status: 'approved',
              approved_by: 5,
              approved_at: FIXED_TIME,
            }),
          ),
          'EB002',
          undefined,
          'different approver than the importer',
        );
        expect(await statusOf(c, run.analysis_id)).toBe('imported');
      }));

    it('imported -> approved with no recorded importer is refused (EB002)', () =>
      withRollback(async (c) => {
        const run = await newAnalysis(c, { status: 'imported', imported_by: null });
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
              status: 'approved',
              approved_by: 2,
              approved_at: FIXED_TIME,
            }),
          ),
          'EB002',
        );
      }));

    it('approved -> superseded needs an APPROVED correction: none -> EB001, an imported one -> EB001, an approved one -> accepted', () =>
      withRollback(async (c) => {
        const old = await newApproved(c);
        const supersede = () =>
          updateRow(c, 'analysis_runs', 'analysis_id', old.analysis_id, { status: 'superseded' });
        await expectViolation(inSavepoint(c, supersede), 'EB001', undefined, 'approved correction');
        const correction = await newAnalysis(c, {
          status: 'imported',
          supersedes_analysis_id: old.analysis_id,
        });
        await expectViolation(inSavepoint(c, supersede), 'EB001', undefined, 'approved correction');
        await updateRow(c, 'analysis_runs', 'analysis_id', correction.analysis_id, {
          status: 'approved',
          approved_by: 2,
          approved_at: FIXED_TIME,
        });
        expect((await supersede()).status).toBe('superseded');
      }));

    it('rejected -> draft is allowed and the run can then be imported again', () =>
      withRollback(async (c) => {
        const run = await newAnalysis(c, { status: 'rejected' });
        await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, { status: 'draft' });
        const again = await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
          status: 'imported',
        });
        expect(again.status).toBe('imported');
      }));
  });

  describe('immutability of approved and superseded results (EB002, D19)', () => {
    const edits = [
      ['pipeline_name', 'edited'],
      ['pipeline_version', 'edited'],
      ['reference_db', 'edited'],
      ['reference_db_version', 'edited'],
      ['parameters', '{"edited": true}'],
      ['run_id', 2],
      ['marker_id', 2],
      ['imported_by', 3],
      ['approved_by', 3],
      ['approved_at', '2026-02-02T00:00:00Z'],
      ['supersedes_analysis_id', 1],
    ];

    it.each(edits)('approved: editing %s -> EB002 naming the column', (column, value) =>
      withRollback(async (c) => {
        const run = await newApproved(c);
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, { [column]: value }),
          ),
          'EB002',
          undefined,
          `column ${column} cannot be changed`,
        );
      }),
    );

    it.each(edits)('superseded: editing %s -> EB002 naming the column', (column, value) =>
      withRollback(async (c) => {
        const run = await newSuperseded(c);
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, { [column]: value }),
          ),
          'EB002',
          undefined,
          `column ${column} cannot be changed`,
        );
      }),
    );

    it('the seeded approved analysis 1 cannot be edited or deleted (EB002)', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', 1, { pipeline_name: 'x' }),
          ),
          'EB002',
        );
        await expectViolation(
          inSavepoint(c, () => c.query('DELETE FROM analysis_runs WHERE analysis_id = 1')),
          'EB002',
          undefined,
          'cannot be deleted',
        );
      }));

    it('approved and superseded runs cannot be deleted (EB002)', () =>
      withRollback(async (c) => {
        for (const run of [await newApproved(c), await newSuperseded(c)]) {
          await expectViolation(
            inSavepoint(c, () =>
              c.query('DELETE FROM analysis_runs WHERE analysis_id = $1', [run.analysis_id]),
            ),
            'EB002',
          );
        }
      }));

    it.each(['draft', 'imported', 'rejected'])(
      '%s: columns can be edited and the run can be deleted',
      (status) =>
        withRollback(async (c) => {
          const run = await newAnalysis(c, { status });
          const edited = await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
            pipeline_name: 'edited',
            parameters: '{"k": 1}',
          });
          expect(edited.pipeline_name).toBe('edited');
          const { rowCount } = await c.query('DELETE FROM analysis_runs WHERE analysis_id = $1', [
            run.analysis_id,
          ]);
          expect(rowCount).toBe(1);
        }),
    );

    it('supersedes_analysis_id is free to change in draft and rejected, fixed once the run has been imported (EB002)', () =>
      withRollback(async (c) => {
        const draft = await newAnalysis(c);
        await updateRow(c, 'analysis_runs', 'analysis_id', draft.analysis_id, {
          supersedes_analysis_id: 1,
        });
        const imported = await newAnalysis(c, { status: 'imported', supersedes_analysis_id: 2 });
        await expectViolation(
          inSavepoint(c, () =>
            updateRow(c, 'analysis_runs', 'analysis_id', imported.analysis_id, {
              supersedes_analysis_id: null,
            }),
          ),
          'EB002',
          undefined,
          'supersedes_analysis_id',
        );
      }));

    describe('detections (taxon_assignments)', () => {
      it('seeded detections of approved analysis 1: update, delete and insert -> EB002', () =>
        withRollback(async (c) => {
          const { rows } = await c.query(
            'SELECT assignment_id FROM taxon_assignments WHERE analysis_id = 1 ORDER BY 1 LIMIT 1',
          );
          const id = rows[0].assignment_id;
          await expectViolation(
            inSavepoint(c, () =>
              updateRow(c, 'taxon_assignments', 'assignment_id', id, { read_count: 1 }),
            ),
            'EB002',
            undefined,
            'cannot be changed',
          );
          await expectViolation(
            inSavepoint(c, () =>
              c.query('DELETE FROM taxon_assignments WHERE assignment_id = $1', [id]),
            ),
            'EB002',
            undefined,
            'cannot be deleted',
          );
          await expectViolation(
            inSavepoint(c, () => newDetection(c, { analysis_id: 1, library_id: 3, taxon_id: 1 })),
            'EB002',
            undefined,
            'cannot be added to',
          );
        }));

      it.each([
        ['approved', newApproved],
        ['superseded', newSuperseded],
      ])(
        '%s analysis: a detection inserted while draft can no longer be updated, deleted or joined by another',
        (_label, walk) =>
          withRollback(async (c) => {
            // Detections go in while the analysis is a draft; the walk then freezes the run.
            const run = await newAnalysis(c);
            const detection = await newDetection(c, { analysis_id: run.analysis_id });
            await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
              status: 'imported',
            });
            await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
              status: 'approved',
              approved_by: 2,
              approved_at: FIXED_TIME,
            });
            if (walk === newSuperseded) {
              await newAnalysis(c, { status: 'approved', supersedes_analysis_id: run.analysis_id });
              await updateRow(c, 'analysis_runs', 'analysis_id', run.analysis_id, {
                status: 'superseded',
              });
            }
            await expectViolation(
              inSavepoint(c, () =>
                updateRow(c, 'taxon_assignments', 'assignment_id', detection.assignment_id, {
                  read_count: 99,
                }),
              ),
              'EB002',
            );
            await expectViolation(
              inSavepoint(c, () =>
                c.query('DELETE FROM taxon_assignments WHERE assignment_id = $1', [
                  detection.assignment_id,
                ]),
              ),
              'EB002',
            );
            await expectViolation(
              inSavepoint(c, () =>
                newDetection(c, { analysis_id: run.analysis_id, library_id: 2 }),
              ),
              'EB002',
            );
          }),
      );

      it('a detection cannot be moved INTO an approved analysis by changing analysis_id (EB002)', () =>
        withRollback(async (c) => {
          const approved = await newApproved(c);
          const detection = await newDetection(c, { analysis_id: 4 });
          await expectViolation(
            inSavepoint(c, () =>
              updateRow(c, 'taxon_assignments', 'assignment_id', detection.assignment_id, {
                analysis_id: approved.analysis_id,
              }),
            ),
            'EB002',
            undefined,
            'cannot be added to',
          );
        }));

      it.each(['draft', 'imported', 'rejected'])(
        '%s analysis: detections can be inserted, updated and deleted',
        (status) =>
          withRollback(async (c) => {
            const run = await newAnalysis(c, { status });
            const detection = await newDetection(c, { analysis_id: run.analysis_id });
            const updated = await updateRow(
              c,
              'taxon_assignments',
              'assignment_id',
              detection.assignment_id,
              {
                read_count: 99,
              },
            );
            expect(updated.read_count).toBe(99);
            const { rowCount } = await c.query(
              'DELETE FROM taxon_assignments WHERE assignment_id = $1',
              [detection.assignment_id],
            );
            expect(rowCount).toBe(1);
          }),
      );

      it('the seeded detections of imported analysis 3 and the empty draft analysis 4 can be edited', () =>
        withRollback(async (c) => {
          const { rows } = await c.query(
            'SELECT assignment_id FROM taxon_assignments WHERE analysis_id = 3 ORDER BY 1 LIMIT 1',
          );
          await updateRow(c, 'taxon_assignments', 'assignment_id', rows[0].assignment_id, {
            read_count: 1,
          });
          await newDetection(c, { analysis_id: 4 });
        }));
    });
  });

  describe('triggers of the Analysis slice are installed', () => {
    const triggers = [
      ['trg_analysis_runs_status', 'analysis_runs'],
      ['trg_analysis_runs_immutable', 'analysis_runs'],
      ['trg_taxon_assignments_immutable', 'taxon_assignments'],
      ['trg_analysis_runs_audit', 'analysis_runs'],
      ['trg_taxa_audit', 'taxa'],
      ['trg_dna_markers_audit', 'dna_markers'],
      ['trg_data_exports_audit', 'data_exports'],
    ];

    it.each(triggers)('%s is enabled on %s', async (name, table) => {
      const { rows } = await getPool().query(
        `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`,
        [name, table],
      );
      expect(rows).toEqual([{ tgenabled: 'O' }]);
    });

    it('trg_taxon_assignments_audit does not exist (detections are audited in bulk by import_detections)', async () => {
      const { rows } = await getPool().query(
        `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_taxon_assignments_audit'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('trg_taxa_audit: a new taxon writes an audit row', () =>
      withRollback(async (c) => {
        const taxon = await newTaxon(c);
        const { rows } = await c.query(
          `SELECT action FROM audit_logs WHERE entity_type = 'taxa' AND entity_id = $1`,
          [taxon.taxon_id],
        );
        expect(rows).toEqual([{ action: 'insert' }]);
      }));
  });
});
