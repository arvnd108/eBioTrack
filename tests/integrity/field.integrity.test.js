// Owner: C (Testing & QA)
// Purpose: Constraint and trigger tests: Field & Samples
//
// Written from CONTRACT 3 (sample_status transitions) and 4.2, migrations 020/090 and the header of
// database/triggers/field_triggers.sql. Source states of the transition matrix are created by a
// plain INSERT with the wanted status (the status trigger only fires on UPDATE), which reaches every
// state in one step; the matrix then UPDATEs to each target.
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
  newEvent,
  newProject,
  newRegion,
  newSample,
  newSite,
  transitionMatrix,
  unique,
  updateRow,
  FIXED_TIME,
} from '../setup/integrity.js';
import { closeTestPool, getPool, setActingUser, withRollback } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ABSENT = 999999999;

const makers = {
  regions: async () => ({ name: unique('Region'), region_type: 'other' }),
  sampling_sites: async () => ({
    region_id: 2,
    name: unique('Site'),
    latitude: 28.6,
    longitude: 77.2,
    habitat_type: 'river',
    created_by: 2,
  }),
  sample_types: async () => ({ type_name: unique('type') }),
  collection_events: async () => ({
    project_id: 1,
    site_id: 1,
    collector_id: 3,
    collected_at: FIXED_TIME,
  }),
  samples: async () => ({ event_id: 1, sample_type_id: 1, sample_code: unique('QA-S') }),
  environmental_measurements: async () => ({
    event_id: 1,
    parameter: unique('param'),
    value: 1.5,
    unit: 'mg/l',
  }),
  sample_status_history: async () => ({ sample_id: 1, new_status: 'stored' }),
};

const insertValid = async (c, table, over = {}) =>
  insertRow(c, table, { ...(await makers[table](c)), ...over });

// CONTRACT 3, samples.status
const SAMPLE_STATES = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];
const SAMPLE_ALLOWED = {
  collected: ['stored', 'failed', 'discarded'],
  stored: ['extracted', 'failed', 'discarded'],
  extracted: ['sequenced', 'failed', 'discarded'],
  sequenced: ['analyzed', 'failed'],
  analyzed: [],
  failed: ['discarded'],
  discarded: [],
};

const historyOf = async (c, sampleId) =>
  (
    await c.query(
      `SELECT old_status, new_status, changed_by, note FROM sample_status_history
        WHERE sample_id = $1 ORDER BY history_id`,
      [sampleId],
    )
  ).rows;

describe.skipIf(!dbAvailable)('field: setup', () => {
  beforeAll(async () => {
    await getPool().query(readFileSync(path.join(root, 'database/roles/grants.sql'), 'utf8'));
  });
  afterAll(() => closeTestPool());

  describe('NOT NULL (23502)', () => {
    const cases = [
      ['regions', ['name', 'region_type']],
      [
        'sampling_sites',
        ['region_id', 'name', 'latitude', 'longitude', 'habitat_type', 'created_by'],
      ],
      ['sample_types', ['type_name']],
      ['collection_events', ['project_id', 'site_id', 'collector_id', 'collected_at']],
      ['samples', ['event_id', 'sample_type_id', 'sample_code', 'status']],
      ['environmental_measurements', ['event_id', 'parameter', 'value', 'unit']],
      ['sample_status_history', ['sample_id', 'new_status']],
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
      ['pk_regions', 'regions', 'region_id', 1],
      ['pk_sampling_sites', 'sampling_sites', 'site_id', 1],
      ['pk_sample_types', 'sample_types', 'sample_type_id', 1],
      ['pk_collection_events', 'collection_events', 'event_id', 1],
      ['pk_samples', 'samples', 'sample_id', 1],
      ['pk_environmental_measurements', 'environmental_measurements', 'measurement_id', 1],
      ['pk_sample_status_history', 'sample_status_history', 'history_id', 1],
    ];

    it.each(pks)('%s: duplicate %s.%s -> 23505', (constraint, table, column, id) =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, table, { [column]: id })),
          '23505',
          constraint,
        );
      }),
    );

    it('uq_regions_name_type: the same name and type twice -> 23505; the same name with another type is accepted', () =>
      withRollback(async (c) => {
        const region = await newRegion(c, { name: 'Twin', region_type: 'basin' });
        await expectViolation(
          inSavepoint(c, () => newRegion(c, { name: region.name, region_type: 'basin' })),
          '23505',
          'uq_regions_name_type',
        );
        await newRegion(c, { name: region.name, region_type: 'reserve' });
      }));

    it('uq_sampling_sites_region_name: the same site name twice in a region -> 23505; the same name in another region is accepted', () =>
      withRollback(async (c) => {
        const site = await newSite(c, { region_id: 2, name: 'Twin site' });
        await expectViolation(
          inSavepoint(c, () => newSite(c, { region_id: 2, name: site.name })),
          '23505',
          'uq_sampling_sites_region_name',
        );
        await newSite(c, { region_id: 3, name: site.name });
      }));

    it('sample_types_type_name_key: duplicate type name -> 23505; a new name is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'sample_types', { type_name: 'water' })),
          '23505',
          'sample_types_type_name_key',
        );
        await insertValid(c, 'sample_types', { type_name: 'ice' });
      }));

    it('samples_sample_code_key: duplicate sample_code -> 23505, in any event; a new code is accepted', () =>
      withRollback(async (c) => {
        const existing = (await c.query('SELECT sample_code FROM samples WHERE sample_id = 1'))
          .rows[0];
        await expectViolation(
          inSavepoint(c, () => newSample(c, { sample_code: existing.sample_code })),
          '23505',
          'samples_sample_code_key',
        );
        await expectViolation(
          inSavepoint(c, () => newSample(c, { event_id: 5, sample_code: existing.sample_code })),
          '23505',
          'samples_sample_code_key',
        );
        await newSample(c, { sample_code: `${existing.sample_code}-b` });
      }));

    it('uq_environmental_measurements_event_parameter: the same parameter twice for an event -> 23505; for another event it is accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'environmental_measurements', { parameter: 'ph' })),
          '23505',
          'uq_environmental_measurements_event_parameter',
        );
        const other = await newEvent(c);
        await insertValid(c, 'environmental_measurements', {
          event_id: other.event_id,
          parameter: 'ph',
        });
      }));
  });

  describe('FOREIGN KEY (23503)', () => {
    const fks = [
      ['fk_regions_parent_region_id', 'regions', 'parent_region_id'],
      ['fk_sampling_sites_region_id', 'sampling_sites', 'region_id'],
      ['fk_sampling_sites_created_by', 'sampling_sites', 'created_by'],
      ['fk_collection_events_site_id', 'collection_events', 'site_id'],
      ['fk_collection_events_project_id', 'collection_events', 'project_id'],
      ['fk_collection_events_collector_id', 'collection_events', 'collector_id'],
      ['fk_samples_event_id', 'samples', 'event_id'],
      ['fk_samples_sample_type_id', 'samples', 'sample_type_id'],
      ['fk_environmental_measurements_event_id', 'environmental_measurements', 'event_id'],
      ['fk_sample_status_history_sample_id', 'sample_status_history', 'sample_id'],
      ['fk_sample_status_history_changed_by', 'sample_status_history', 'changed_by'],
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

    it('fk_collection_events_project_site: an event at a site the project is not linked to -> 23503; a linked site is accepted', () =>
      withRollback(async (c) => {
        // Project 1 collects at sites 1-3; site 4 exists and belongs to project 2 only.
        await expectViolation(
          inSavepoint(c, () => newEvent(c, { project_id: 1, site_id: 4 })),
          '23503',
          'fk_collection_events_project_site',
        );
        await newEvent(c, { project_id: 1, site_id: 3 });
        const project = await newProject(c);
        await expectViolation(
          inSavepoint(c, () => newEvent(c, { project_id: project.project_id, site_id: 1 })),
          '23503',
          'fk_collection_events_project_site',
        );
        await insertRow(c, 'project_sites', { project_id: project.project_id, site_id: 1 });
        await newEvent(c, { project_id: project.project_id, site_id: 1 });
      }));

    it('removing the project-site link of a site that has events is refused (23503)', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () =>
            c.query('DELETE FROM project_sites WHERE project_id = 1 AND site_id = 1'),
          ),
          '23503',
          'fk_collection_events_project_site',
        );
      }));

    it('nullable references accept NULL: regions.parent_region_id, sample_status_history.changed_by', () =>
      withRollback(async (c) => {
        expect(
          (await insertValid(c, 'regions', { parent_region_id: null })).parent_region_id,
        ).toBeNull();
        expect(
          (await insertValid(c, 'sample_status_history', { changed_by: null })).changed_by,
        ).toBeNull();
      }));

    describe('reverse direction: deleting a referenced row', () => {
      it('regions.parent_region_id is ON DELETE SET NULL: deleting a parent region detaches its children', () =>
        withRollback(async (c) => {
          const parent = await newRegion(c);
          const child = await newRegion(c, { parent_region_id: parent.region_id });
          await c.query('DELETE FROM regions WHERE region_id = $1', [parent.region_id]);
          const { rows } = await c.query(
            'SELECT parent_region_id FROM regions WHERE region_id = $1',
            [child.region_id],
          );
          expect(rows[0].parent_region_id).toBeNull();
        }));

      it.each([
        [
          'a region with a site',
          'fk_sampling_sites_region_id',
          async (c) => {
            const region = await newRegion(c);
            await newSite(c, { region_id: region.region_id });
            return ['DELETE FROM regions WHERE region_id = $1', [region.region_id]];
          },
        ],
        [
          'a sample type in use',
          'fk_samples_sample_type_id',
          async () => ['DELETE FROM sample_types WHERE sample_type_id = $1', [1]],
        ],
        [
          'a site with events',
          null,
          async () => ['DELETE FROM sampling_sites WHERE site_id = $1', [1]],
        ],
        [
          'an event with samples',
          null,
          async () => ['DELETE FROM collection_events WHERE event_id = $1', [1]],
        ],
        [
          'a sample with history',
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

      it('the app role cannot DELETE any Field table (42501, D19)', () =>
        withRollback(async (c) => {
          for (const table of [
            'regions',
            'sampling_sites',
            'sample_types',
            'collection_events',
            'samples',
            'environmental_measurements',
            'sample_status_history',
          ]) {
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
        'ck_sampling_sites_latitude',
        'sampling_sites',
        [{ latitude: 90 }, { latitude: -90 }, { latitude: 0 }, { latitude: 89.999999 }],
        [{ latitude: 90.000001 }, { latitude: -90.000001 }],
      ],
      [
        'ck_sampling_sites_longitude',
        'sampling_sites',
        [{ longitude: 180 }, { longitude: -180 }, { longitude: 0 }],
        [{ longitude: 180.000001 }, { longitude: -180.000001 }],
      ],
      [
        'ck_samples_volume',
        'samples',
        [{ volume_ml: 0.01 }, { volume_ml: 1000 }, { volume_ml: null }],
        [{ volume_ml: 0 }, { volume_ml: -0.01 }],
      ],
      [
        'ck_samples_depth',
        'samples',
        [{ depth_m: 0 }, { depth_m: 0.01 }, { depth_m: null }],
        [{ depth_m: -0.01 }],
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

    it('ck_collection_events_collected_at: up to one day ahead passes, one second beyond -> 23514', () =>
      withRollback(async (c) => {
        // now() is the transaction start time, so the boundary is exact inside one transaction.
        const insertAt = (expr) =>
          c.query(
            `INSERT INTO collection_events (project_id, site_id, collector_id, collected_at)
             VALUES (1, 1, 3, ${expr})`,
          );
        await inSavepoint(c, () => insertAt(`now() + interval '1 day'`), { keep: false });
        await inSavepoint(c, () => insertAt(`'2000-01-01T00:00:00Z'`), { keep: false });
        await expectViolation(
          inSavepoint(c, () => insertAt(`now() + interval '1 day 1 second'`)),
          '23514',
          'ck_collection_events_collected_at',
        );
      }));

    it('the CHECK constraints also guard UPDATE (latitude and volume)', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => updateRow(c, 'sampling_sites', 'site_id', 1, { latitude: 91 })),
          '23514',
          'ck_sampling_sites_latitude',
        );
        await expectViolation(
          inSavepoint(c, () => updateRow(c, 'samples', 'sample_id', 1, { volume_ml: 0 })),
          '23514',
          'ck_samples_volume',
        );
      }));
  });

  describe('enum values (22P02)', () => {
    it('region_type: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'regions', { region_type: 'county' })),
          '22P02',
        );
        const values = await enumValues(c, 'region_type');
        expect(values).toEqual(['country', 'state', 'basin', 'reserve', 'other']);
        for (const region_type of values) await insertValid(c, 'regions', { region_type });
      }));

    it('habitat_type: unknown value rejected, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'sampling_sites', { habitat_type: 'desert' })),
          '22P02',
        );
        const values = await enumValues(c, 'habitat_type');
        expect(values).toEqual([
          'river',
          'lake',
          'estuary',
          'marine',
          'wetland',
          'groundwater',
          'soil',
          'other',
        ]);
        for (const habitat_type of values) await insertValid(c, 'sampling_sites', { habitat_type });
      }));

    it('sample_status: unknown value rejected on samples and history, every documented value accepted', () =>
      withRollback(async (c) => {
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'samples', { status: 'lost' })),
          '22P02',
        );
        await expectViolation(
          inSavepoint(c, () => insertValid(c, 'sample_status_history', { new_status: 'lost' })),
          '22P02',
        );
        const values = await enumValues(c, 'sample_status');
        expect(values).toEqual(SAMPLE_STATES);
        for (const status of values) {
          await insertValid(c, 'samples', { status });
          await insertValid(c, 'sample_status_history', { old_status: status, new_status: status });
        }
      }));
  });

  describe('samples.status transitions (CONTRACT 3, EB001)', () => {
    it('the test matrix covers 7 x 7 pairs, 12 of them allowed (as the contract table lists)', () => {
      const matrix = transitionMatrix(SAMPLE_STATES, SAMPLE_ALLOWED);
      expect(matrix).toHaveLength(49);
      expect(matrix.filter(([, , ok]) => ok)).toHaveLength(12);
    });

    const pairs = transitionMatrix(SAMPLE_STATES, SAMPLE_ALLOWED).filter(
      ([from, to]) => from !== to,
    );

    it.each(pairs)('%s -> %s (allowed: %s)', (from, to, allowed) =>
      withRollback(async (c) => {
        await setActingUser(c, 3);
        const sample = await newSample(c, { status: from });
        const before = await historyOf(c, sample.sample_id);
        if (allowed) {
          await c.query(`SELECT set_config('app.status_note', 'matrix move', true)`);
          const updated = await updateRow(c, 'samples', 'sample_id', sample.sample_id, {
            status: to,
          });
          expect(updated.status).toBe(to);
          const after = await historyOf(c, sample.sample_id);
          expect(after).toHaveLength(before.length + 1);
          expect(after.at(-1)).toEqual({
            old_status: from,
            new_status: to,
            changed_by: '3',
            note: 'matrix move',
          });
        } else {
          await expectViolation(
            inSavepoint(c, () =>
              updateRow(c, 'samples', 'sample_id', sample.sample_id, { status: to }),
            ),
            'EB001',
            undefined,
            `Invalid sample status transition: ${from} -> ${to}`,
          );
          const { rows } = await c.query('SELECT status FROM samples WHERE sample_id = $1', [
            sample.sample_id,
          ]);
          expect(rows[0].status).toBe(from);
          expect(await historyOf(c, sample.sample_id)).toHaveLength(before.length);
        }
      }),
    );

    // CONTRACT GAP: CONTRACT 3 lists only changes of status. The trigger header says an update that
    // leaves the status as it is "is not a transition", so it is accepted and writes no history row.
    // The test follows the trigger (rejecting would break any PATCH that resends the status).
    it.each(SAMPLE_STATES)(
      'CONTRACT GAP: %s -> %s (same state) is accepted and writes no history',
      (state) =>
        withRollback(async (c) => {
          const sample = await newSample(c, { status: state });
          await updateRow(c, 'samples', 'sample_id', sample.sample_id, { status: state });
          expect(await historyOf(c, sample.sample_id)).toHaveLength(0);
        }),
    );

    it('a walk through the whole happy path records one history row per step, in order', () =>
      withRollback(async (c) => {
        await setActingUser(c, 4);
        const sample = await newSample(c);
        for (const status of ['stored', 'extracted', 'sequenced', 'analyzed']) {
          await updateRow(c, 'samples', 'sample_id', sample.sample_id, { status });
        }
        const history = await historyOf(c, sample.sample_id);
        expect(history.map((h) => [h.old_status, h.new_status])).toEqual([
          ['collected', 'stored'],
          ['stored', 'extracted'],
          ['extracted', 'sequenced'],
          ['sequenced', 'analyzed'],
        ]);
        expect(new Set(history.map((h) => h.changed_by))).toEqual(new Set(['4']));
      }));

    it('without an acting user the history row has changed_by NULL and no note', () =>
      withRollback(async (c) => {
        const sample = await newSample(c);
        await updateRow(c, 'samples', 'sample_id', sample.sample_id, { status: 'stored' });
        expect(await historyOf(c, sample.sample_id)).toEqual([
          { old_status: 'collected', new_status: 'stored', changed_by: null, note: null },
        ]);
      }));

    it('updating another column of a sample neither checks nor records a status change', () =>
      withRollback(async (c) => {
        const sample = await newSample(c, { status: 'discarded' });
        await updateRow(c, 'samples', 'sample_id', sample.sample_id, {
          storage_location: 'Freezer 9',
        });
        expect(await historyOf(c, sample.sample_id)).toHaveLength(0);
      }));
  });

  describe('triggers of the Field slice are installed', () => {
    const triggers = [
      ['trg_samples_status_transition', 'samples'],
      ['trg_samples_status_history', 'samples'],
      ['trg_samples_audit', 'samples'],
      ['trg_collection_events_audit', 'collection_events'],
      ['trg_sampling_sites_audit', 'sampling_sites'],
    ];

    it.each(triggers)('%s is enabled on %s', async (name, table) => {
      const { rows } = await getPool().query(
        `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass`,
        [name, table],
      );
      expect(rows).toEqual([{ tgenabled: 'O' }]);
    });

    it('trg_samples_audit: a new sample writes an audit row', () =>
      withRollback(async (c) => {
        const sample = await newSample(c);
        const { rows } = await c.query(
          `SELECT action FROM audit_logs WHERE entity_type = 'samples' AND entity_id = $1`,
          [sample.sample_id],
        );
        expect(rows).toEqual([{ action: 'insert' }]);
      }));
  });
});
