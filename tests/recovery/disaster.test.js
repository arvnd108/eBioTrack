// Owner: C (Testing & QA)
// Purpose: Disaster scenarios: damage a throwaway copy, restore the backup, prove nothing was lost
//
// Each scenario takes the backup of the seeded test database (made once in beforeAll), damages a
// scratch copy that was itself restored from that backup (never the real test database), restores
// the backup into a second scratch database and compares it with the fingerprint of the original.
// The refusal tests prove that restore.sh says no (and changes nothing) when it should.
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  BACKUP_SH,
  EXIT,
  RESTORE_SH,
  createScratchDatabase,
  databaseExists,
  databaseNameOf,
  describeRun,
  devUrl,
  diffFingerprints,
  dropScratchDatabase,
  dumpPathOf,
  fingerprint,
  fingerprintOf,
  makeDumpDir,
  mask,
  passwordOf,
  probeEnvironment,
  publicTableCount,
  removeDumpDirs,
  runScript,
  urlFor,
  withClient,
} from '../setup/recovery.js';
import { closeTestPool, getTestDatabaseUrl, reseed } from '../setup/testDb.js';
import { committed, runTransaction } from '../setup/transactions.js';

const dbAvailable = inject('dbAvailable');
const DAMAGED = 'ebiotrack_damaged_test';
const RECOVERED = 'ebiotrack_recovered_test';
const TRAP = 'ebiotrack_trap_test';
const ALL = [DAMAGED, RECOVERED, TRAP];

describe.skipIf(!dbAvailable)('recovery: disaster scenarios', () => {
  let ready = false;
  let reason = '';
  let dumpDir;
  let dump;
  let source;
  const need = (ctx) => {
    if (!ready) ctx.skip(reason);
  };
  const restoreArgs = (db, ...extra) => [dump, '--url', urlFor(db), '--quiet', ...extra];
  const restoreInto = (db, ...extra) => runScript(RESTORE_SH, restoreArgs(db, ...extra));

  /** A fresh scratch database restored from the backup (what the damage is done to). */
  const freshCopy = async (db) => {
    await dropScratchDatabase(db);
    await createScratchDatabase(db);
    const run = await restoreInto(db);
    expect(run.code, describeRun(run)).toBe(EXIT.OK);
  };
  /** Run damaging SQL on a copy as a DBA would (user triggers off). Never the real test database. */
  const damage = async (db, ...statements) => {
    expect(db).toMatch(/^ebiotrack_[a-z]+_test$/);
    expect(db).not.toBe('ebiotrack_test');
    await withClient(urlFor(db), async (c) => {
      await c.query('SET session_replication_role = replica');
      for (const s of statements) await c.query(s);
    });
  };
  const count = (db, text) => withClient(urlFor(db), async (c) => (await c.query(text)).rows[0].n);
  /** Restore into an empty RECOVERED and assert it equals the original. */
  const recoverAndCompare = async () => {
    await dropScratchDatabase(RECOVERED);
    await createScratchDatabase(RECOVERED);
    const run = await restoreInto(RECOVERED);
    expect(run.code, describeRun(run)).toBe(EXIT.OK);
    const diff = diffFingerprints(source, await fingerprintOf(urlFor(RECOVERED)));
    expect(diff, diff.join('\n')).toEqual([]);
  };

  beforeAll(async () => {
    await reseed();
    dumpDir = await makeDumpDir();
    for (const db of ALL) await dropScratchDatabase(db);
    const probe = await probeEnvironment(dumpDir);
    ready = probe.ready;
    reason = probe.reason ?? '';
    if (!ready) return;
    expect(probe.backup.code, describeRun(probe.backup)).toBe(EXIT.OK);
    dump = dumpPathOf(probe.backup);
    source = await withClient(getTestDatabaseUrl(), fingerprint);
  }, 120_000);

  afterAll(async () => {
    await closeTestPool();
    if (ready) for (const db of ALL) await dropScratchDatabase(db);
    await removeDumpDirs();
  }, 60_000);

  describe('data loss and damage: restore brings back exactly the backed-up state', () => {
    it('accidental delete: 15 detections of analysis 3 are gone, the restore brings them back', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      await damage(DAMAGED, 'DELETE FROM taxon_assignments WHERE analysis_id = 3');
      expect(await count(DAMAGED, 'SELECT count(*)::int n FROM taxon_assignments')).toBe(28);
      await recoverAndCompare();
      expect(
        await count(
          RECOVERED,
          'SELECT count(*)::int n FROM taxon_assignments WHERE analysis_id = 3',
        ),
      ).toBe(15);
    });

    it('dropped table: sample_status_history is back with its rows, constraints and triggers', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      await damage(DAMAGED, 'DROP TABLE sample_status_history CASCADE');
      expect(await publicTableCount(urlFor(DAMAGED))).toBe(27);
      await recoverAndCompare();
      expect(await publicTableCount(urlFor(RECOVERED))).toBe(28);
    });

    it('wrong update: every sample volume overwritten, the restore has the original values', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      await damage(DAMAGED, 'UPDATE samples SET volume_ml = 99999 WHERE volume_ml IS NOT NULL');
      const damaged = await fingerprintOf(urlFor(DAMAGED));
      expect(diffFingerprints(source, damaged).join('\n')).toMatch(/tables "samples" differs/);
      await recoverAndCompare();
    });

    it('whole database lost: restore.sh --create rebuilds it under the same name', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      await dropScratchDatabase(DAMAGED);
      expect(await databaseExists(DAMAGED)).toBe(false);
      const run = await restoreInto(DAMAGED, '--create');
      expect(run.code, describeRun(run)).toBe(EXIT.OK);
      const diff = diffFingerprints(source, await fingerprintOf(urlFor(DAMAGED)));
      expect(diff, diff.join('\n')).toEqual([]);
    });

    it('--drop-existing --confirm <name> replaces a damaged database in place', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      await damage(DAMAGED, 'DELETE FROM taxon_assignments');
      const run = await restoreInto(DAMAGED, '--drop-existing', '--confirm', DAMAGED);
      expect(run.code, describeRun(run)).toBe(EXIT.OK);
      const diff = diffFingerprints(source, await fingerprintOf(urlFor(DAMAGED)));
      expect(diff, diff.join('\n')).toEqual([]);
    });

    it('point in time (honesty): rows written after the backup are NOT in the restored database', async (ctx) => {
      need(ctx);
      committed();
      try {
        await runTransaction(
          (c) =>
            c.query(
              `SELECT create_project_with_owner('T36 written after the backup', 'x', DATE '2026-06-01', 2)`,
            ),
          { actorId: 2 },
        );
        expect(
          await count(
            'ebiotrack_test',
            `SELECT count(*)::int n FROM projects WHERE title = 'T36 written after the backup'`,
          ),
        ).toBe(1);
        await recoverAndCompare();
        expect(
          await count(
            RECOVERED,
            `SELECT count(*)::int n FROM projects WHERE title = 'T36 written after the backup'`,
          ),
        ).toBe(0);
        expect(await count(RECOVERED, 'SELECT count(*)::int n FROM projects')).toBe(2);
      } finally {
        await reseed();
      }
    });
  });

  describe('refusals: restore.sh says no and leaves everything as it was', () => {
    it('non-empty target: exit 3, the message names the table count, the target is unchanged', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      const before = await fingerprintOf(urlFor(DAMAGED));
      const run = await restoreInto(DAMAGED);
      expect(run.code, describeRun(run)).toBe(EXIT.REFUSED);
      expect(run.stderr).toMatch(/28/);
      expect(diffFingerprints(before, await fingerprintOf(urlFor(DAMAGED)))).toEqual([]);
    });

    it('the source database itself is protected: restoring into ebiotrack_test exits 3 and changes nothing', async (ctx) => {
      need(ctx);
      const before = await fingerprintOf(getTestDatabaseUrl());
      const run = await runScript(RESTORE_SH, [dump, '--url', getTestDatabaseUrl(), '--quiet']);
      expect(run.code, describeRun(run)).toBe(EXIT.REFUSED);
      expect(diffFingerprints(before, await fingerprintOf(getTestDatabaseUrl()))).toEqual([]);
    });

    it('--drop-existing without --confirm, or with the wrong name, exits 3 and drops nothing', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      const before = await fingerprintOf(urlFor(DAMAGED));
      for (const extra of [
        ['--drop-existing'],
        ['--drop-existing', '--confirm', 'ebiotrack_other_test'],
        ['--drop-existing', '--confirm', 'ebiotrack'],
      ]) {
        const run = await restoreInto(DAMAGED, ...extra);
        expect(run.code, extra.join(' ') + '\n' + describeRun(run)).toBe(EXIT.REFUSED);
      }
      expect(diffFingerprints(before, await fingerprintOf(urlFor(DAMAGED)))).toEqual([]);
    });

    it('missing target database without --create: exit 3 and no database is created', async (ctx) => {
      need(ctx);
      await dropScratchDatabase(TRAP);
      const run = await restoreInto(TRAP);
      expect(run.code, describeRun(run)).toBe(EXIT.REFUSED);
      expect(await databaseExists(TRAP)).toBe(false);
    });

    it('the development database `ebiotrack` is refused, with or without --drop-existing, and is not changed', async (ctx) => {
      need(ctx);
      const exists = await databaseExists('ebiotrack');
      const before = exists ? await fingerprintOf(devUrl()) : null;
      const plain = await runScript(RESTORE_SH, [dump, '--url', devUrl(), '--quiet']);
      expect(plain.code, describeRun(plain)).toBe(EXIT.REFUSED);
      const drop = await runScript(RESTORE_SH, [
        dump,
        '--url',
        devUrl(),
        '--quiet',
        '--drop-existing',
        '--confirm',
        'ebiotrack',
      ]);
      expect(drop.code, describeRun(drop)).toBe(EXIT.REFUSED);
      if (exists) expect(diffFingerprints(before, await fingerprintOf(devUrl()))).toEqual([]);
    });

    it('bad credentials: backup.sh and restore.sh exit 4, create no file, leak no password', async (ctx) => {
      need(ctx);
      const url = new URL(getTestDatabaseUrl());
      const wrong = 'definitely-not-the-password-9z';
      url.password = wrong;
      const dir = await makeDumpDir();
      const b = await runScript(BACKUP_SH, ['--url', url.toString(), '--out-dir', dir]);
      expect(b.code, describeRun(b)).toBe(EXIT.CONNECTION);
      expect(readdirSync(dir)).toEqual([]);
      const r = await runScript(RESTORE_SH, [
        dump,
        '--url',
        urlFor(DAMAGED).replace(passwordOf(getTestDatabaseUrl()), wrong),
      ]);
      expect(r.code, describeRun(r)).toBe(EXIT.CONNECTION);
      for (const run of [b, r]) {
        expect(run.stdout + run.stderr).not.toContain(wrong);
        expect(run.stdout + run.stderr).not.toContain(passwordOf(getTestDatabaseUrl()));
      }
    });
  });

  describe('damaged dumps: nothing half-restored', () => {
    const copyDump = async (sidecar) => {
      const dir = await makeDumpDir();
      const target = path.join(dir, path.basename(dump));
      copyFileSync(dump, target);
      if (sidecar) copyFileSync(`${dump}.sha256`, `${target}.sha256`);
      return target;
    };
    const tryRestore = async (file) => {
      await dropScratchDatabase(TRAP);
      await createScratchDatabase(TRAP);
      const run = await runScript(RESTORE_SH, [file, '--url', urlFor(TRAP), '--quiet']);
      return { run, tables: await publicTableCount(urlFor(TRAP)) };
    };

    it('truncated dump: non-zero exit, no tables in the target', async (ctx) => {
      need(ctx);
      const file = await copyDump(false);
      truncateSync(file, Math.floor(statSync(file).size / 2));
      const { run, tables } = await tryRestore(file);
      expect(run.code, describeRun(run)).not.toBe(EXIT.OK);
      expect(tables).toBe(0);
    });

    it('late truncation (the last 2% missing; the table of contents still reads): non-zero exit and zero tables', async (ctx) => {
      need(ctx);
      const file = await copyDump(false);
      truncateSync(file, Math.floor(statSync(file).size * 0.98));
      const { run, tables } = await tryRestore(file);
      expect(run.code, describeRun(run)).not.toBe(EXIT.OK);
      expect(tables).toBe(0);
    });

    it('tampered checksum file: exit 5 before anything is touched', async (ctx) => {
      need(ctx);
      const file = await copyDump(true);
      const sum = readFileSync(`${file}.sha256`, 'utf8');
      writeFileSync(`${file}.sha256`, (sum[0] === '0' ? '1' : '0') + sum.slice(1));
      const { run, tables } = await tryRestore(file);
      expect(run.code, describeRun(run)).toBe(EXIT.DUMP_INVALID);
      expect(tables).toBe(0);
    });

    it('corrupted bytes in the middle: non-zero exit and nothing restored (all or nothing)', async (ctx) => {
      need(ctx);
      const file = await copyDump(false);
      const bytes = readFileSync(file);
      const mid = Math.floor(bytes.length / 2);
      for (let i = 0; i < 64; i++) bytes[mid + i] = bytes[mid + i] ^ 0xff;
      writeFileSync(file, bytes);
      const { run, tables } = await tryRestore(file);
      expect(run.code, describeRun(run)).not.toBe(EXIT.OK);
      expect(tables).toBe(0);
    });

    it('missing dump file: exit 5', async (ctx) => {
      need(ctx);
      const run = await runScript(RESTORE_SH, [
        path.join(dumpDir, 'nope.dump'),
        '--url',
        urlFor(TRAP),
      ]);
      expect(run.code, describeRun(run)).toBe(EXIT.DUMP_INVALID);
    });

    it('partial-restore trap: a clash in the middle of the restore rolls everything back (exit 1, zero tables)', async (ctx) => {
      need(ctx);
      await dropScratchDatabase(TRAP);
      await createScratchDatabase(TRAP);
      await withClient(urlFor(TRAP), (c) =>
        c.query(`CREATE TYPE project_status AS ENUM ('clash')`),
      );
      const run = await runScript(RESTORE_SH, [dump, '--url', urlFor(TRAP), '--quiet']);
      expect(run.code, describeRun(run)).toBe(EXIT.UNEXPECTED);
      expect(await publicTableCount(urlFor(TRAP))).toBe(0);
      expect(await databaseExists(TRAP)).toBe(true);
    });
  });

  describe('roles and grants', () => {
    const can = (db, role, table, privilege) =>
      withClient(
        urlFor(db),
        async (c) =>
          (
            await c.query('SELECT has_table_privilege($1, $2, $3) AS ok', [
              role,
              `public.${table}`,
              privilege,
            ])
          ).rows[0].ok,
      );

    it('a normal restore re-applies database/roles/grants.sql: app may write, readonly may only read', async (ctx) => {
      need(ctx);
      await freshCopy(DAMAGED);
      expect(await can(DAMAGED, 'ebiotrack_app', 'samples', 'SELECT')).toBe(true);
      expect(await can(DAMAGED, 'ebiotrack_app', 'samples', 'INSERT')).toBe(true);
      expect(await can(DAMAGED, 'ebiotrack_readonly', 'samples', 'SELECT')).toBe(true);
      expect(await can(DAMAGED, 'ebiotrack_readonly', 'samples', 'INSERT')).toBe(false);
    });

    it('--skip-grants leaves the three roles without any privilege on the restored tables (dump has no ACLs)', async (ctx) => {
      need(ctx);
      await dropScratchDatabase(DAMAGED);
      await createScratchDatabase(DAMAGED);
      const run = await restoreInto(DAMAGED, '--skip-grants');
      expect(run.code, describeRun(run)).toBe(EXIT.OK);
      expect(await can(DAMAGED, 'ebiotrack_app', 'samples', 'SELECT')).toBe(false);
      expect(await can(DAMAGED, 'ebiotrack_readonly', 'samples', 'SELECT')).toBe(false);
    });
  });

  it('no script output ever contains the database password', async (ctx) => {
    need(ctx);
    const run = await runScript(BACKUP_SH, [
      '--url',
      getTestDatabaseUrl(),
      '--out-dir',
      await makeDumpDir(),
    ]);
    expect(run.code, describeRun(run)).toBe(EXIT.OK);
    expect(mask(run.stdout + run.stderr)).not.toContain(passwordOf(getTestDatabaseUrl()));
    expect(databaseNameOf(getTestDatabaseUrl())).toBe('ebiotrack_test');
  });
});
