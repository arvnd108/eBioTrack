// Owner: C (Testing & QA)
// Purpose: Self-test of the query helpers (openQuerySession, execute, rollback, acrossSettings)
import { afterAll, describe, expect, inject, it } from 'vitest';
import { newProject } from '../setup/integrity.js';
import {
  acrossSettings,
  normaliseRows,
  openQuerySession,
  preparedNames,
  queryFilePath,
  SLICES,
} from '../setup/queries.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

afterAll(() => closeTestPool());

describe('query helpers (no database needed)', () => {
  it('finds the prepared statement names in a file, in order', () => {
    expect(
      preparedNames('PREPARE a_b (int) AS SELECT 1;\n  prepare c1(text) AS SELECT 2;'),
    ).toEqual(['a_b', 'c1']);
  });
  it('turns Date values into ISO UTC strings and leaves other values alone', () => {
    expect(normaliseRows([{ at: new Date('2026-01-01T00:00:00Z'), n: 3, s: null }])).toEqual([
      { at: '2026-01-01T00:00:00.000Z', n: 3, s: null },
    ]);
  });
  it('rejects an unknown slice', () => {
    expect(() => queryFilePath('nope')).toThrow(/Unknown slice/);
    expect(SLICES).toHaveLength(4);
  });
});

describe.skipIf(!dbAvailable)('query helpers', () => {
  it('runs a committed statement, validates names and views, and reports columns', async () => {
    const s = await openQuerySession('access');
    try {
      expect(s.names).toContain('access_user_projects');
      expect(await s.execute('access_user_projects', [999999, null])).toEqual([]);
      await expect(s.execute('x; DROP TABLE users', [])).rejects.toThrow(/Invalid prepared/);
      await expect(s.queryView('users')).rejects.toThrow(/Not a known view/);
      expect((await s.columns('access_user_projects', [999999, null])).length).toBeGreaterThan(0);
      expect((await s.viewColumns('v_project_summary')).map((c) => c.name)).toContain('project_id');
    } finally {
      await s.close();
    }
  });

  it('quotes values safely: a quote in a parameter is data, not SQL', async () => {
    const s = await openQuerySession('access');
    try {
      await expect(
        s.execute('access_user_projects', ["1'; DROP TABLE users; --", null]),
      ).rejects.toThrow(/invalid input syntax/);
      const [{ n }] = await s.sql('SELECT count(*) AS n FROM users');
      expect(Number(n)).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it('rollback makes writes visible to prepared statements and then undoes them', async () => {
    const s = await openQuerySession('access');
    try {
      const before = await s.queryView('v_project_summary');
      await s.rollback(async (db) => {
        await newProject(db);
        expect(await s.queryView('v_project_summary')).toHaveLength(before.length + 1);
      });
      expect(await s.queryView('v_project_summary')).toHaveLength(before.length);
    } finally {
      await s.close();
    }
  });

  it('acrossSettings visits every zone and plan mode and restores the session settings', async () => {
    const s = await openQuerySession('access');
    try {
      const zone = (await s.client.query('SHOW TimeZone')).rows[0].TimeZone;
      const seen = [];
      await acrossSettings(
        s,
        async (label) => {
          seen.push(label);
          const [{ tz }] = await s.sql(`SELECT current_setting('TimeZone') AS tz`);
          expect(label.startsWith(tz)).toBe(true);
        },
        { zones: ['UTC', 'Asia/Kolkata'] },
      );
      expect(seen).toHaveLength(4);
      expect((await s.client.query('SHOW TimeZone')).rows[0].TimeZone).toBe(zone);
    } finally {
      await s.close();
    }
  });
});
