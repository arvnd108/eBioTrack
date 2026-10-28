// Owner: A (Backend)
// Purpose: Tests for the migration runner (needs the test database; skipped if unreachable)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config/env.js';
import { MigrationError, migrate } from '../src/db/migrate.js';
import { probeDatabase } from './helpers.js';

const available = await probeDatabase();
const quiet = () => {};

describe.skipIf(!available)('migrate', () => {
  let dir;
  let migrationsDir;
  let seedsDir;
  let client;

  const write = (sub, name, sql) => writeFile(path.join(sub, name), sql);
  const run = (options = {}) => migrate({ migrationsDir, seedsDir, log: quiet, ...options });
  const tableExists = async (name) =>
    (await client.query('SELECT to_regclass($1) AS oid', [`public.${name}`])).rows[0].oid !== null;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ebiotrack-migrate-'));
    migrationsDir = path.join(dir, 'migrations');
    seedsDir = path.join(dir, 'seeds');
    await mkdir(migrationsDir);
    await mkdir(seedsDir);
    await migrate({ reset: true, migrationsDir, seedsDir, log: quiet });
  });

  afterAll(async () => {
    await migrate({ reset: true, migrationsDir: dir, seedsDir: dir, log: quiet }).catch(() => {});
    await client?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('applies files in numeric order, regardless of directory order', async () => {
    await write(migrationsDir, '090_last.sql', 'CREATE TABLE c (x int);');
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    await write(migrationsDir, '010_second.sql', 'CREATE TABLE b (x int);');
    const result = await run();
    expect(result.appliedMigrations).toEqual(['001_first.sql', '010_second.sql', '090_last.sql']);
    const { rows } = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY applied_at',
    );
    expect(rows.map((r) => r.filename)).toEqual(result.appliedMigrations);
  });

  it('is a no-op the second time', async () => {
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    await run();
    const second = await run();
    expect(second.appliedMigrations).toEqual([]);
  });

  it('applies comment-only stub files and records them', async () => {
    await write(migrationsDir, '010_stub.sql', '-- Owner: C\n-- Purpose: nothing yet\n');
    const result = await run();
    expect(result.appliedMigrations).toEqual(['010_stub.sql']);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    expect(rows).toHaveLength(1);
  });

  it('rolls back a failing file, names it, and stops', async () => {
    await write(migrationsDir, '001_ok.sql', 'CREATE TABLE ok (x int);');
    await write(migrationsDir, '010_bad.sql', 'CREATE TABLE half (x int);\nSELECT 1/0;');
    await write(migrationsDir, '020_never.sql', 'CREATE TABLE never (x int);');
    await expect(run()).rejects.toThrow(/010_bad\.sql.*division by zero/s);
    expect(await tableExists('ok')).toBe(true);
    expect(await tableExists('half')).toBe(false);
    expect(await tableExists('never')).toBe(false);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    expect(rows.map((r) => r.filename)).toEqual(['001_ok.sql']);
  });

  it('reports the line of a syntax error', async () => {
    await write(migrationsDir, '001_syntax.sql', 'SELECT 1;\nSELECT 2;\nCREAT TABLE x (y int);');
    await expect(run()).rejects.toThrow(/001_syntax\.sql \(line 3\)/);
  });

  it('fails loudly when an applied file was modified', async () => {
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    await run();
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int, y int);');
    await expect(run()).rejects.toThrow(/Checksum mismatch.*001_first\.sql.*db:reset/s);
  });

  it('runs seeds only with --seed, after migrations, and tracks them separately', async () => {
    await write(migrationsDir, '001_t.sql', 'CREATE TABLE t (x int);');
    await write(seedsDir, '010_seed.sql', 'INSERT INTO t VALUES (1);');
    const without = await run();
    expect(without.appliedSeeds).toEqual([]);
    expect(without.pendingSeeds).toEqual(['010_seed.sql']);

    const withSeed = await run({ seed: true });
    expect(withSeed.appliedSeeds).toEqual(['010_seed.sql']);
    expect((await client.query('SELECT count(*)::int AS n FROM t')).rows[0].n).toBe(1);
    expect((await run({ seed: true })).appliedSeeds).toEqual([]);
  });

  it('--status reports pending files and changes nothing', async () => {
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    const status = await run({ status: true });
    expect(status.pendingMigrations).toEqual(['001_first.sql']);
    expect(await tableExists('a')).toBe(false);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    expect(rows).toEqual([]);
  });

  it('--reset rebuilds the schema', async () => {
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    await run();
    const again = await run({ reset: true });
    expect(again.appliedMigrations).toEqual(['001_first.sql']);
  });

  it('--reset refuses outside development and test', async () => {
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    await run();
    await expect(run({ reset: true, nodeEnv: 'production' })).rejects.toThrow(MigrationError);
    expect(await tableExists('a')).toBe(true);
  });

  it('rejects two files with the same numeric prefix', async () => {
    await write(migrationsDir, '010_a.sql', '-- a');
    await write(migrationsDir, '010_b.sql', '-- b');
    await expect(run()).rejects.toThrow(/share the prefix 010/);
  });

  it('ignores files that do not match NNN_name.sql', async () => {
    await write(migrationsDir, 'README.md', 'docs');
    await write(migrationsDir, '1_short.sql', 'SELECT 1/0;');
    expect((await run()).appliedMigrations).toEqual([]);
  });

  it('serializes concurrent runs with an advisory lock', async () => {
    await write(migrationsDir, '001_first.sql', 'CREATE TABLE a (x int);');
    await write(migrationsDir, '010_second.sql', 'CREATE TABLE b (x int);');
    const results = await Promise.all([run(), run()]);
    const applied = results.flatMap((r) => r.appliedMigrations);
    expect(applied.sort()).toEqual(['001_first.sql', '010_second.sql']);
  });
});
