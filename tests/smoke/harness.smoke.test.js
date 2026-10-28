// Owner: C (Testing & QA)
// Purpose: Smoke suite proving the test harness works (safety guard, reset, helpers); no feature tests
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  assertSafeTarget,
  closeTestPool,
  expectSqlState,
  getPool,
  loadBackendConfig,
  reseed,
  resetTestDatabase,
  setActingUser,
  withRollback,
} from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const dbDescribe = describe.skipIf(!dbAvailable);

if (!dbAvailable) {
  console.warn('[skip] harness DB checks skipped: test database not reachable (see globalSetup)');
}

afterAll(() => closeTestPool());

describe('safety guard (no database needed)', () => {
  it('accepts the test database', () => {
    expect(assertSafeTarget('postgres://u:p@localhost:5432/ebiotrack_test')).toBe('ebiotrack_test');
  });

  it('rejects the development database', () => {
    expect(() => assertSafeTarget('postgres://u:p@localhost:5432/ebiotrack')).toThrow(/not a test/);
  });

  it('rejects empty, malformed, and database-less URLs', () => {
    expect(() => assertSafeTarget('')).toThrow(/malformed/);
    expect(() => assertSafeTarget('not a url')).toThrow(/malformed/);
    expect(() => assertSafeTarget('postgres://u:p@localhost:5432/')).toThrow(/not a test/);
  });

  it('rejects look-alike names', () => {
    for (const name of [
      'ebiotrack_test_backup',
      'ebiotrack_testing',
      'prod_test',
      'ebiotrack-test',
    ]) {
      expect(() => assertSafeTarget(`postgres://u:p@localhost:5432/${name}`)).toThrow();
    }
  });
});

describe('environment guard', () => {
  it('forces NODE_ENV=test and points the backend config at the test database', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const { config } = await loadBackendConfig();
    expect(config.isTest).toBe(true);
    expect(config.databaseUrl).toBe(process.env.TEST_DATABASE_URL);
    expect(new URL(config.databaseUrl).pathname).toBe('/ebiotrack_test');
  });
});

dbDescribe('database lifecycle', () => {
  it('connects to the test database and nothing else', async () => {
    const { rows } = await getPool().query('SELECT current_database() AS db');
    expect(rows[0].db).toBe('ebiotrack_test');
  });

  it('has the slice migrations applied', async () => {
    const { rows } = await getPool().query('SELECT filename FROM schema_migrations');
    const prefixes = rows.map((r) => r.filename.slice(0, 3));
    for (const expected of ['001', '010', '020', '030', '040', '090']) {
      expect(prefixes).toContain(expected);
    }
  });

  it('resetTestDatabase({ seed: false }) migrates but loads no seeds', async () => {
    const result = await resetTestDatabase({ seed: false });
    expect(result.appliedMigrations.length).toBeGreaterThanOrEqual(6);
    expect(result.appliedSeeds).toEqual([]);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBeGreaterThanOrEqual(6);
    // schema_seeds is only created when a seed runs, so it must not list anything here.
    const seeds = await getPool().query(`SELECT to_regclass('public.schema_seeds') AS t`);
    expect(seeds.rows[0].t).toBeNull();
  });

  it('resetTestDatabase({ seed: true }) loads the seed files, and is repeatable', async () => {
    const first = await resetTestDatabase({ seed: true });
    const second = await resetTestDatabase({ seed: true });
    expect(second.appliedMigrations).toEqual(first.appliedMigrations);
    expect(second.appliedSeeds).toEqual(first.appliedSeeds);
    const { rows } = await getPool().query('SELECT filename FROM schema_seeds ORDER BY filename');
    expect(rows.map((r) => r.filename.slice(0, 3))).toEqual(['010', '020', '030', '040']);
  });

  it('reseed() restores the seeds without rebuilding the schema', async () => {
    const result = await reseed();
    expect(result.appliedSeeds.map((f) => f.slice(0, 3))).toEqual(['010', '020', '030', '040']);
  });

  // The fixture world arrives with the seed tasks; these become real tests in T30/T31.
  it.todo('roles has IDs 1-6 after reset'); // CONTRACT 6
  it.todo('6 seeded users, 2 projects, 8 collection events, 17 samples, 32 measurements'); // CONTRACT 6
});

dbDescribe('helpers', () => {
  it('withRollback leaves no trace', async () => {
    await withRollback(async (client) => {
      await client.query('CREATE TABLE harness_tmp (id int)');
      await client.query('INSERT INTO harness_tmp VALUES (1)');
      const { rows } = await client.query('SELECT count(*)::int AS n FROM harness_tmp');
      expect(rows[0].n).toBe(1);
    });
    const { rows } = await getPool().query(`SELECT to_regclass('public.harness_tmp') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('withRollback rolls back and rethrows when the callback fails', async () => {
    await expect(
      withRollback(async (client) => {
        await client.query('CREATE TABLE harness_tmp (id int)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await getPool().query(`SELECT to_regclass('public.harness_tmp') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('setActingUser is visible inside the transaction and gone after it', async () => {
    await withRollback(async (client) => {
      await setActingUser(client, 3);
      const { rows } = await client.query(
        `SELECT current_setting('app.current_user_id', true) AS v`,
      );
      expect(rows[0].v).toBe('3');
    });
    const { rows } = await getPool().query(
      `SELECT current_setting('app.current_user_id', true) AS v`,
    );
    expect(rows[0].v === null || rows[0].v === '').toBe(true);
  });

  it('expectSqlState passes on a matching SQLSTATE and fails otherwise', async () => {
    const pool = getPool();
    const err = await expectSqlState(pool.query('SELECT 1/0'), '22012');
    expect(err.code).toBe('22012');
    await expect(expectSqlState(pool.query('SELECT 1'), '22012')).rejects.toThrow(/succeeded/);
    await expect(expectSqlState(pool.query('SELECT 1/0'), '23505')).rejects.toThrow(/got 22012/);
  });

  it('app-created IDs start at 1000 (D6)', async (ctx) => {
    const { rows } = await getPool().query(
      `SELECT table_name, column_name, identity_start
         FROM information_schema.columns
        WHERE table_schema = 'public' AND is_identity = 'YES'`,
    );
    if (rows.length === 0)
      return ctx.skip('no identity columns yet (D6 checked once tables exist)');
    for (const row of rows) {
      expect(Number(row.identity_start), `${row.table_name}.${row.column_name}`).toBe(1000);
    }
  });
});
