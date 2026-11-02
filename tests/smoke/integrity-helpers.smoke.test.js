// Owner: C (Testing & QA)
// Purpose: Self-test of the integrity helpers (inSavepoint, expectViolation, transitionMatrix)
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  expectViolation,
  inSavepoint,
  insertRow,
  newProject,
  transitionMatrix,
} from '../setup/integrity.js';
import { closeTestPool, withRollback } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

afterAll(() => closeTestPool());

describe('transitionMatrix (no database needed)', () => {
  it('lists every ordered pair and marks the allowed ones', () => {
    const matrix = transitionMatrix(['a', 'b'], { a: ['b'] });
    expect(matrix).toEqual([
      ['a', 'a', false],
      ['a', 'b', true],
      ['b', 'a', false],
      ['b', 'b', false],
    ]);
  });
});

describe.skipIf(!dbAvailable)('integrity helpers', () => {
  it('inSavepoint keeps the transaction usable after an error', () =>
    withRollback(async (client) => {
      await expect(inSavepoint(client, () => client.query('SELECT 1/0'))).rejects.toMatchObject({
        code: '22012',
      });
      const { rows } = await client.query('SELECT 1 AS ok');
      expect(rows[0].ok).toBe(1);
    }));

  it('inSavepoint with keep: false leaves no row behind', () =>
    withRollback(async (client) => {
      const project = await inSavepoint(client, () => newProject(client), { keep: false });
      const { rowCount } = await client.query('SELECT 1 FROM projects WHERE project_id = $1', [
        project.project_id,
      ]);
      expect(rowCount).toBe(0);
    }));

  it('expectViolation checks the code and the constraint name', () =>
    withRollback(async (client) => {
      const dup = () =>
        insertRow(client, 'projects', { title: 'Coastal Estuary Pilot', created_by: 2 });
      const err = await expectViolation(inSavepoint(client, dup), '23505', 'uq_projects_title');
      expect(err.table).toBe('projects');
    }));

  it('expectViolation fails on a wrong constraint, a wrong code and a success', () =>
    withRollback(async (client) => {
      const dup = () =>
        insertRow(client, 'projects', { title: 'Coastal Estuary Pilot', created_by: 2 });
      await expect(
        expectViolation(inSavepoint(client, dup), '23505', 'pk_projects'),
      ).rejects.toThrow(/Expected SQLSTATE 23505 on constraint pk_projects/);
      await expect(expectViolation(inSavepoint(client, dup), '23503')).rejects.toThrow(
        /Expected SQLSTATE 23503 but got 23505/,
      );
      await expect(
        expectViolation(
          inSavepoint(client, () => newProject(client)),
          '23505',
        ),
      ).rejects.toThrow(/statement succeeded/);
    }));
});
