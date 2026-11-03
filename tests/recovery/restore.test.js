// Owner: C (Testing & QA)
// Purpose: Restore a backup and verify key records
//
// backup.sh dumps the seeded test database, restore.sh loads that dump into an empty scratch
// database, and the result must be the same database: same rows, same structure, same behaviour.
// Only the scripts are called; expectations come from the data and the catalog (CONTRACT section 6).
import { statSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { expectViolation } from '../setup/integrity.js';
import {
  BACKUP_SH,
  EXIT,
  RESTORE_SH,
  createScratchDatabase,
  describeRun,
  diffFingerprints,
  dropScratchDatabase,
  dumpPathOf,
  fingerprint,
  fingerprintOf,
  makeDumpDir,
  mask,
  passwordOf,
  probeEnvironment,
  removeDumpDirs,
  runScript,
  runTool,
  urlFor,
  withClient,
} from '../setup/recovery.js';
import {
  closeTestPool,
  getPool,
  getTestDatabaseUrl,
  reseed,
  withRollback,
} from '../setup/testDb.js';
import { committed, csvToRows, readFixture, runTransaction } from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');
const RESTORE_DB = 'ebiotrack_restore_test';

describe.skipIf(!dbAvailable)('recovery: backup.sh -> restore.sh round trip', () => {
  let ready = false;
  let reason = '';
  let dumpDir;
  let backup; // first backup run
  let dump; // path to the dump
  let restore; // restore run into RESTORE_DB
  let source; // fingerprint of the source before anything else happened
  const restoredUrl = () => urlFor(RESTORE_DB);

  /** Run fn(client) on the restored database inside a transaction that is rolled back. */
  const inRestored = (fn, actor) =>
    withClient(restoredUrl(), async (c) => {
      await c.query('BEGIN');
      try {
        if (actor)
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(actor)]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  const q = (c, text, params) => c.query(text, params).then((r) => r.rows);
  const need = (ctx) => {
    if (!ready) ctx.skip(reason);
  };

  beforeAll(async () => {
    await reseed();
    dumpDir = await makeDumpDir();
    const probe = await probeEnvironment(dumpDir);
    ready = probe.ready;
    reason = probe.reason ?? '';
    if (!ready) return;
    backup = probe.backup;
    dump = dumpPathOf(backup);
    source = await withClient(getTestDatabaseUrl(), fingerprint);
    await dropScratchDatabase(RESTORE_DB);
    await createScratchDatabase(RESTORE_DB);
    restore = await runScript(RESTORE_SH, [dump, '--url', restoredUrl()]);
  }, 120_000);

  afterAll(async () => {
    await closeTestPool();
    if (ready) await dropScratchDatabase(RESTORE_DB);
    await removeDumpDirs();
  }, 60_000);

  describe('fingerprint (self-test of the comparison)', () => {
    it('identical databases give an empty diff; a changed cell, dropped index and dropped constraint are named', async () => {
      await withRollback(async (c) => {
        const a = await fingerprint(c);
        expect(diffFingerprints(a, await fingerprint(c))).toEqual([]);
        // Triggers off for the probe: a fired audit trigger would consume a sequence value (nextval is not rolled back).
        await c.query('ALTER TABLE users DISABLE TRIGGER USER');
        await c.query(`UPDATE users SET full_name = full_name || ' x' WHERE user_id = 2`);
        expect(diffFingerprints(a, await fingerprint(c)).join('\n')).toMatch(
          /tables "users" differs/,
        );
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        const idx = Object.keys(a.indexes).find((n) => /^idx_/.test(n));
        await c.query(`DROP INDEX "${idx}"`);
        expect(diffFingerprints(a, await fingerprint(c))).toContain(
          `indexes "${idx}" only in source`,
        );
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query('ALTER TABLE projects DROP CONSTRAINT uq_projects_title');
        expect(diffFingerprints(a, await fingerprint(c)).join('\n')).toContain(
          'projects.uq_projects_title',
        );
      });
    });
  });

  it('1. backup.sh writes a valid, private, password-free artifact', async (ctx) => {
    need(ctx);
    expect(backup.code, describeRun(backup)).toBe(EXIT.OK);
    expect(dump).toMatch(/\/ebiotrack_ebiotrack_test_\d{8}T\d{6}Z\.dump$/);
    expect(path.dirname(dump)).toBe(dumpDir);
    const st = statSync(dump);
    expect(st.size).toBeGreaterThan(50_000);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(`${dump}.sha256`, 'utf8')).toMatch(
      new RegExp(`^[0-9a-f]{64}  ${path.basename(dump)}\\n?$`),
    );
    const list = await runTool('pg_restore', ['--list', dump]);
    if (list.code === 0) {
      const tables = list.stdout.match(/ TABLE public /g) ?? [];
      expect(tables.length).toBeGreaterThanOrEqual(28);
    }
    const password = passwordOf(getTestDatabaseUrl());
    expect(backup.stdout + backup.stderr + path.basename(dump)).not.toContain(password);
    expect(readdirSync(dumpDir).sort()).toEqual([
      path.basename(dump),
      `${path.basename(dump)}.sha256`,
    ]);
  });

  it('2. backup is non-destructive and online: open transactions neither block it nor change the source', async (ctx) => {
    need(ctx);
    const holder = await getPool().connect();
    const second = await makeDumpDir();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM samples WHERE sample_id = 1 FOR UPDATE');
      const before = await fingerprintOf(getTestDatabaseUrl());
      const run = await runScript(BACKUP_SH, [
        '--url',
        getTestDatabaseUrl(),
        '--out-dir',
        second,
        '--quiet',
      ]);
      expect(run.code, describeRun(run)).toBe(EXIT.OK);
      const after = await fingerprintOf(getTestDatabaseUrl());
      expect(diffFingerprints(before, after)).toEqual([]);
      expect(diffFingerprints(source, after)).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it('3. restore.sh loads the dump into an empty database: exit 0, no errors, target name on stdout', (ctx) => {
    need(ctx);
    expect(restore.code, describeRun(restore)).toBe(EXIT.OK);
    expect(restore.stdout.trim()).toBe(RESTORE_DB);
    expect(restore.stderr).not.toMatch(/\bERROR\b/);
    expect(restore.stderr).not.toContain(passwordOf(getTestDatabaseUrl()));
  });

  it('4. data is identical: every table (count and content hash) and the CONTRACT section 6 records', async (ctx) => {
    need(ctx);
    const restored = await fingerprintOf(restoredUrl());
    const dataDiff = diffFingerprints({ tables: source.tables }, { tables: restored.tables });
    expect(dataDiff, mask(dataDiff.join('\n'))).toEqual([]);
    expect(Object.keys(restored.tables)).toHaveLength(28);

    await inRestored(async (c) => {
      const one = async (sqlText) => (await q(c, sqlText))[0];
      expect((await one('SELECT count(*)::int n FROM users')).n).toBe(6);
      expect(await q(c, 'SELECT project_id, created_by FROM projects ORDER BY 1')).toEqual([
        { project_id: '1', created_by: '2' },
        { project_id: '2', created_by: '2' },
      ]);
      expect((await one('SELECT count(*)::int n FROM collection_events')).n).toBe(8);
      expect((await one('SELECT count(*)::int n FROM samples')).n).toBe(17);
      expect(
        await q(
          c,
          `SELECT count(*)::int n, min(extraction_id) lo, max(extraction_id) hi FROM dna_extractions`,
        ),
      ).toEqual([{ n: 17, lo: '1', hi: '17' }]);
      expect(
        (await one(`SELECT qc_status::text s FROM dna_extractions WHERE extraction_id = 17`)).s,
      ).toBe('fail');
      expect(
        await q(
          c,
          `SELECT count(*)::int n, min(library_id) lo, max(library_id) hi, array_agg(DISTINCT run_id ORDER BY run_id) runs FROM sequencing_libraries`,
        ),
      ).toEqual([{ n: 16, lo: '1', hi: '16', runs: ['1', '2'] }]);
      expect(
        (await q(c, 'SELECT status::text s FROM analysis_runs ORDER BY analysis_id')).map(
          (r) => r.s,
        ),
      ).toEqual(['approved', 'approved', 'imported', 'draft']);
      expect(
        await q(
          c,
          `SELECT analysis_id::int a, count(*)::int n FROM taxon_assignments GROUP BY 1 ORDER BY 1`,
        ),
      ).toEqual([
        { a: 1, n: 17 },
        { a: 2, n: 11 },
        { a: 3, n: 15 },
      ]);
      expect(await q(c, `SELECT imported_by FROM analysis_runs WHERE analysis_id = 3`)).toEqual([
        { imported_by: '5' },
      ]);
      expect((await one('SELECT count(*)::int n FROM audit_logs')).n).toBe(
        source.tables.audit_logs.count,
      );
    });
  });

  it('5. structure is identical: constraints, indexes, triggers (enabled flags), functions, views, types, sequences, columns', async (ctx) => {
    need(ctx);
    const restored = await fingerprintOf(restoredUrl());
    const structure = { ...restored, tables: {} };
    const srcStructure = { ...source, tables: {} };
    const diff = diffFingerprints(srcStructure, structure);
    expect(diff, diff.join('\n')).toEqual([]);
    expect(Object.keys(restored.triggers).length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(restored.constraints).length).toBeGreaterThanOrEqual(100);
    expect(Object.keys(restored.indexes).length).toBeGreaterThanOrEqual(28);
    expect(Object.keys(restored.functions).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(restored.sequences).length).toBeGreaterThanOrEqual(20);
    expect(Object.values(restored.triggers).every((t) => t.startsWith('enabled=O'))).toBe(true);
  });

  describe('6. behaviour after restore', () => {
    it('identity sequences hand out ids above every existing id (and 1000 or more)', async (ctx) => {
      need(ctx);
      await inRestored(async (c) => {
        const cols = await q(
          c,
          `SELECT c.table_name t, c.column_name col
             FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.is_identity = 'YES'`,
        );
        expect(cols.length).toBeGreaterThanOrEqual(15);
        for (const { t, col } of cols) {
          const [{ seq }] = await q(c, `SELECT pg_get_serial_sequence($1, $2) seq`, [
            `public."${t}"`,
            col,
          ]);
          const [{ next }] = await q(c, `SELECT nextval($1)::bigint next`, [seq]);
          const [{ max }] = await q(c, `SELECT coalesce(max("${col}"), 0)::bigint max FROM "${t}"`);
          expect(BigInt(next), `${t}.${col}`).toBeGreaterThan(BigInt(max));
          expect(BigInt(next), `${t}.${col}`).toBeGreaterThanOrEqual(1000n);
        }
      });
    });

    it('approve_analysis(3, 2) works once; the second call raises EB003', async (ctx) => {
      need(ctx);
      await inRestored(async (c) => {
        await c.query('SELECT approve_analysis(3, 2)');
        expect(
          await q(c, 'SELECT status::text s FROM analysis_runs WHERE analysis_id = 3'),
        ).toEqual([{ s: 'approved' }]);
        await c.query('SAVEPOINT s');
        await expectViolation(c.query('SELECT approve_analysis(3, 2)'), 'EB003');
        await c.query('ROLLBACK TO s');
      });
    });

    it('constraints still bite: unique title 23505, CHECK 23514, foreign key 23503', async (ctx) => {
      need(ctx);
      await inRestored(async (c) => {
        await c.query('SAVEPOINT a');
        await expectViolation(
          c.query(
            `INSERT INTO projects (title, created_by) VALUES ('Yamuna Biodiversity Survey', 2)`,
          ),
          '23505',
          'uq_projects_title',
        );
        await c.query('ROLLBACK TO a');
        await expectViolation(
          c.query(`UPDATE samples SET volume_ml = -1 WHERE sample_id = 1`),
          '23514',
          'ck_samples_volume',
        );
        await c.query('ROLLBACK TO a');
        await expectViolation(
          c.query(`UPDATE samples SET event_id = 999999 WHERE sample_id = 1`),
          '23503',
          'fk_samples_event_id',
        );
      });
    });

    it('triggers fire: a sample update writes an audit row; register_sample returns an id of 1000 or more', async (ctx) => {
      need(ctx);
      await inRestored(async (c) => {
        const before = (await q(c, 'SELECT count(*)::int n FROM audit_logs'))[0].n;
        await c.query(`UPDATE samples SET storage_location = 'restored-check' WHERE sample_id = 1`);
        const after = (await q(c, 'SELECT count(*)::int n FROM audit_logs'))[0].n;
        expect(after).toBe(before + 1);
        const [{ id }] = await q(c, `SELECT register_sample(1, 1, 10, 1, 'restored', 3) id`);
        expect(BigInt(id)).toBeGreaterThanOrEqual(1000n);
        const [{ sample_code: code }] = await q(
          c,
          'SELECT sample_code FROM samples WHERE sample_id = $1',
          [id],
        );
        expect(code).toMatch(/^EB-\d{8}-\d{4}-\d{3}$/);
      }, 3);
    });
  });

  it('7. the application sees a clean, fully migrated database: migrate() with seeds is a no-op', async (ctx) => {
    need(ctx);
    const { migrate } = await import('../../backend/src/db/migrate.js');
    const result = await migrate({
      seed: true,
      databaseUrl: restoredUrl(),
      nodeEnv: 'test',
      log: () => {},
    });
    expect(result.appliedMigrations).toEqual([]);
    expect(result.appliedSeeds).toEqual([]);
    expect(result.pendingMigrations).toEqual([]);
    expect(result.pendingSeeds).toEqual([]);
  });

  it('9. idempotent: two backups of an unchanged database restore to equal fingerprints', async (ctx) => {
    need(ctx);
    const dirs = [await makeDumpDir(), await makeDumpDir()]; // one directory each: names carry seconds
    const dbs = ['ebiotrack_idem_a_test', 'ebiotrack_idem_b_test'];
    try {
      const dumps = [];
      for (let i = 0; i < 2; i++) {
        const run = await runScript(BACKUP_SH, [
          '--url',
          getTestDatabaseUrl(),
          '--out-dir',
          dirs[i],
          '--quiet',
        ]);
        expect(run.code, describeRun(run)).toBe(EXIT.OK);
        dumps.push(dumpPathOf(run));
      }
      expect(new Set(dumps).size).toBe(2);
      expect(dumps.every((d) => statSync(d).size > 50_000)).toBe(true);
      const prints = [];
      for (let i = 0; i < 2; i++) {
        await dropScratchDatabase(dbs[i]);
        await createScratchDatabase(dbs[i]);
        const run = await runScript(RESTORE_SH, [dumps[i], '--url', urlFor(dbs[i]), '--quiet']);
        expect(run.code, describeRun(run)).toBe(EXIT.OK);
        prints.push(await fingerprintOf(urlFor(dbs[i])));
      }
      expect(diffFingerprints(prints[0], prints[1], ['restore 1', 'restore 2'])).toEqual([]);
      expect(diffFingerprints(source, prints[0])).toEqual([]);
    } finally {
      for (const d of dbs) await dropScratchDatabase(d);
    }
  });

  it('8. round trip with application-created data: new project, sample, import and approval survive', async (ctx) => {
    need(ctx);
    const dir = await makeDumpDir();
    const db = 'ebiotrack_roundtrip_test';
    try {
      committed();
      const { projectId, sampleId, imported } = await runTransaction(
        async (c) => {
          const projectId = (
            await c.query(
              `SELECT create_project_with_owner('T36 round trip', 'T36 objectives', DATE '2026-06-01', 2) AS id`,
            )
          ).rows[0].id;
          const sampleId = (
            await c.query(`SELECT register_sample(1, 1, 5, 0.5, 'T36 freezer', 3) AS id`)
          ).rows[0].id;
          const rows = await csvToRows(readFixture('detections_valid.csv'), c);
          const imported = (
            await c.query('SELECT import_detections($1, $2::jsonb, $3) AS n', [
              4,
              JSON.stringify(rows),
              5,
            ])
          ).rows[0].n;
          await c.query('SELECT approve_analysis(4, 2)');
          return { projectId, sampleId, imported };
        },
        { actorId: 2 },
      );
      expect(BigInt(projectId)).toBeGreaterThanOrEqual(1000n);
      expect(BigInt(sampleId)).toBeGreaterThanOrEqual(1000n);
      expect(imported).toBeGreaterThan(0);

      const srcPrint = await fingerprintOf(getTestDatabaseUrl());
      expect(srcPrint.tables.audit_logs.count).toBeGreaterThanOrEqual(4);
      const run = await runScript(BACKUP_SH, [
        '--url',
        getTestDatabaseUrl(),
        '--out-dir',
        dir,
        '--quiet',
      ]);
      expect(run.code, describeRun(run)).toBe(EXIT.OK);
      await dropScratchDatabase(db);
      await createScratchDatabase(db);
      const res = await runScript(RESTORE_SH, [dumpPathOf(run), '--url', urlFor(db), '--quiet']);
      expect(res.code, describeRun(res)).toBe(EXIT.OK);
      const restoredPrint = await fingerprintOf(urlFor(db));
      const diff = diffFingerprints(srcPrint, restoredPrint);
      expect(diff, diff.join('\n')).toEqual([]);
      await withClient(urlFor(db), async (c) => {
        expect(
          (await q(c, 'SELECT count(*)::int n FROM taxon_assignments WHERE analysis_id = 4'))[0].n,
        ).toBe(Number(imported));
        expect(
          (await q(c, 'SELECT status::text s FROM analysis_runs WHERE analysis_id = 4'))[0].s,
        ).toBe('approved');
        expect(
          (await q(c, 'SELECT title FROM projects WHERE project_id = $1', [projectId]))[0].title,
        ).toBe('T36 round trip');
      });
    } finally {
      await dropScratchDatabase(db);
      await reseed();
    }
  });

  it('keeps the source untouched: a failed duplicate restore into the source database is refused', async (ctx) => {
    need(ctx);
    const before = await fingerprintOf(getTestDatabaseUrl());
    const run = await runScript(RESTORE_SH, [dump, '--url', getTestDatabaseUrl(), '--quiet']);
    expect(run.code, describeRun(run)).toBe(EXIT.REFUSED);
    expect(diffFingerprints(before, await fingerprintOf(getTestDatabaseUrl()))).toEqual([]);
  });
});
