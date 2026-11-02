// Owner: C (Testing & QA)
// Purpose: Self-test of the transaction helpers (runTransaction, observer, snapshot, csvToRows)
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  assertGlobalInvariants,
  caught,
  csvToRows,
  observer,
  parseCsv,
  readFixture,
  runTransaction,
  seededCounts,
  snapshot,
} from '../setup/transactions.js';
import { closeTestPool, getPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

afterAll(() => closeTestPool());

describe('transaction helpers (no database needed)', () => {
  it('parses the valid fixture into 14 records and rejects a wrong header', () => {
    expect(parseCsv(readFixture('detections_valid.csv'))).toHaveLength(14);
    expect(() => parseCsv('a,b\n1,2')).toThrow(/Unexpected CSV header/);
  });
  it('rejects a bad actor id before touching the database', async () => {
    await expect(runTransaction(async () => 1, { actorId: '0' })).rejects.toThrow(TypeError);
    await expect(runTransaction(async () => 1, { actorId: 'x; DROP' })).rejects.toThrow(
      /positive integer/,
    );
  });
});

describe.skipIf(!dbAvailable)('transaction helpers', () => {
  it('commits what fn did and returns its result', async () => {
    const seen = await runTransaction(
      async (db) => {
        const { rows } = await db.query(`SELECT current_setting('app.current_user_id', true) AS a`);
        return rows[0].a;
      },
      { actorId: 2 },
    );
    expect(seen).toBe('2');
  });

  it('rolls back on error and rethrows the very same error object', async () => {
    const injected = Object.assign(new Error('injected'), { code: 'XX999' });
    const err = await caught(() =>
      runTransaction(async (db) => {
        await db.query('CREATE TEMP TABLE probe_t32 (x int) ON COMMIT DROP');
        throw injected;
      }),
    );
    expect(err).toBe(injected);
    const db = await observer();
    try {
      const { rows } = await db.query(`SELECT to_regclass('pg_temp.probe_t32') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      db.release();
    }
  });

  it('keeps a database error unchanged (code and message)', async () => {
    const err = await caught(() => runTransaction((db) => db.query('SELECT 1/0')));
    expect(err.code).toBe('22012');
  });

  it('scopes the actor to the transaction: the next transaction on the same connection has none', async () => {
    const pool = getPool();
    const spy = [];
    const original = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await original();
      spy.push(c);
      return c;
    };
    try {
      await runTransaction(async () => {}, { actorId: 3 });
      const again = await runTransaction(async (db) => {
        const { rows } = await db.query(`SELECT current_setting('app.current_user_id', true) AS a`);
        return { same: spy[0] === db, actor: rows[0].a };
      });
      expect(again.same).toBe(true);
      expect(again.actor ?? '').toBe('');
    } finally {
      pool.connect = original;
    }
  });

  it('releases the connection even when fn throws', async () => {
    const pool = getPool();
    for (let i = 0; i < 12; i += 1) {
      await caught(() =>
        runTransaction(async () => {
          throw new Error('x');
        }),
      );
    }
    // more attempts than max (5) all got a connection, so every failed one was released
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBeGreaterThan(0);
  });

  it('observer runs at READ COMMITTED and does not see uncommitted work', async () => {
    const watcher = await observer();
    try {
      let inside;
      await runTransaction(async (db) => {
        await db.query(`UPDATE users SET full_name = full_name WHERE user_id = 1`);
        const { rows } = await watcher.query(`SELECT count(*)::int AS n FROM users`);
        inside = rows[0].n;
        throw new Error('stop');
      }).catch(() => {});
      expect(inside).toBe(6);
    } finally {
      watcher.release();
    }
  });

  it('snapshots are equal when nothing changed and differ after a change', async () => {
    const db = await observer();
    try {
      const a = await snapshot(db);
      expect(await snapshot(db)).toEqual(a);
      expect(Object.keys(a.counts)).not.toContain('session');
      expect(Object.keys(a.counts).some((n) => n.startsWith('schema_'))).toBe(false);
      await runTransaction(async (tx) => {
        const inside = await snapshot(tx);
        expect(inside).toEqual(a);
        await tx.query(`UPDATE projects SET objectives = objectives || 'x' WHERE project_id = 1`);
        expect((await snapshot(tx)).fingerprints.projects).not.toBe(a.fingerprints.projects);
        throw new Error('stop');
      }).catch(() => {});
      expect(await snapshot(db)).toEqual(a);
    } finally {
      db.release();
    }
  });

  it('csvToRows builds the service payload and rejects an unknown taxon', async () => {
    const db = await observer();
    try {
      const rows = await csvToRows(readFixture('detections_valid.csv'), db);
      expect(rows).toHaveLength(14);
      expect(rows[0]).toEqual({
        library_code: 'LIB-0001',
        taxon_id: 7,
        read_count: 14250,
        confidence: 0.9712,
        qc_flag: 'pass',
      });
      await expect(
        csvToRows(
          'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag\nLIB-0001,No such,species,1,0.5,pass',
          db,
        ),
      ).rejects.toThrow(/Unknown taxon/);
    } finally {
      db.release();
    }
  });

  it('global invariants hold on the seeded world, and the seeded counts are 2/17/43/0', async () => {
    const db = await observer();
    try {
      await assertGlobalInvariants(db);
      expect(await seededCounts(db)).toEqual({
        projects: 2,
        samples: 17,
        detections: 43,
        audit: 0,
      });
    } finally {
      db.release();
    }
  });
});
