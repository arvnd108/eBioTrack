// Owner: A (Backend)
// Purpose: Tests for query helpers (needs the test database; skipped if unreachable)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { callProcedure, query, queryOne, withTransaction } from '../src/db/query.js';
import { probeDatabase } from './helpers.js';

const available = await probeDatabase();

describe('argument checks (no database needed)', () => {
  it('rejects placeholders without params, and non-array params', async () => {
    await expect(query('SELECT $1::int')).rejects.toThrow(TypeError);
    await expect(query('SELECT 1', 'nope')).rejects.toThrow(TypeError);
    await expect(query('')).rejects.toThrow(TypeError);
  });

  it('rejects unsafe procedure names before touching the database', async () => {
    for (const name of ['abs; DROP TABLE x', 'a b', '1abc', '', 'schema.fn', 'fn()', null]) {
      await expect(callProcedure(name, [1])).rejects.toThrow(TypeError);
    }
  });

  it('rejects a bad actorId', async () => {
    for (const actorId of ['abc', 0, -3, 1.5, '1; DROP']) {
      await expect(withTransaction(async () => {}, { actorId })).rejects.toThrow(TypeError);
    }
  });
});

describe.skipIf(!available)('query helpers', () => {
  beforeAll(async () => {
    await query('DROP TABLE IF EXISTS t01_scratch');
    await query('CREATE TABLE t01_scratch (id int PRIMARY KEY, note text)');
  });

  afterAll(async () => {
    await query('DROP TABLE IF EXISTS t01_scratch');
    await closePool();
  });

  const assertAllReleased = () => {
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  };

  it('runs parameterized queries', async () => {
    expect(await query('SELECT $1::int + $2::int AS sum', [2, 3])).toEqual([{ sum: 5 }]);
    expect(await query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('treats injection attempts as plain values', async () => {
    const evil = "x'); DROP TABLE t01_scratch; --";
    await query('INSERT INTO t01_scratch (id, note) VALUES ($1, $2)', [900, evil]);
    expect((await queryOne('SELECT note FROM t01_scratch WHERE id = $1', [900])).note).toBe(evil);
    await query('DELETE FROM t01_scratch WHERE id = $1', [900]);
  });

  it('queryOne returns the first row or null', async () => {
    expect(await queryOne('SELECT 7 AS n')).toEqual({ n: 7 });
    expect(await queryOne('SELECT id FROM t01_scratch WHERE id = $1', [-1])).toBeNull();
  });

  it('returns bigint values as numbers', async () => {
    expect(await queryOne('SELECT count(*) AS n, 42::bigint AS id')).toEqual({ n: 1, id: 42 });
  });

  it('commits on success and returns the callback result', async () => {
    const result = await withTransaction(async (client) => {
      await query('INSERT INTO t01_scratch (id) VALUES ($1)', [1], client);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await queryOne('SELECT id FROM t01_scratch WHERE id = 1')).toEqual({ id: 1 });
    assertAllReleased();
  });

  it('rolls back on error and rethrows the original error with its code', async () => {
    const original = Object.assign(new Error('boom'), { code: 'EB002' });
    let caught;
    try {
      await withTransaction(async (client) => {
        await query('INSERT INTO t01_scratch (id) VALUES ($1)', [2], client);
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect(caught.code).toBe('EB002');
    expect(await queryOne('SELECT id FROM t01_scratch WHERE id = 2')).toBeNull();
    assertAllReleased();
  });

  it('preserves PostgreSQL error codes such as 23505', async () => {
    let code;
    try {
      await withTransaction(async (client) => {
        await query('INSERT INTO t01_scratch (id) VALUES ($1)', [1], client);
      });
    } catch (err) {
      code = err.code;
    }
    expect(code).toBe('23505');
    assertAllReleased();
  });

  it('exposes app.current_user_id inside the transaction only', async () => {
    const inside = await withTransaction(
      async (client) =>
        queryOne("SELECT current_setting('app.current_user_id', true) AS id", [], client),
      { actorId: 42 },
    );
    expect(inside.id).toBe('42');
    const after = await queryOne("SELECT current_setting('app.current_user_id', true) AS id");
    expect(after.id || null).toBeNull();
    assertAllReleased();
  });

  it('does not set the actor when none is given', async () => {
    const row = await withTransaction(async (client) =>
      queryOne("SELECT current_setting('app.current_user_id', true) AS id", [], client),
    );
    expect(row.id || null).toBeNull();
  });

  it('callProcedure calls a function with bound arguments', async () => {
    expect(await callProcedure('abs', [-5])).toEqual([{ abs: 5 }]);
    await withTransaction(async (client) => {
      expect(await callProcedure('abs', [-9], client)).toEqual([{ abs: 9 }]);
    });
  });
});
