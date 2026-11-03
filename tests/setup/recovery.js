// Owner: C (Testing & QA)
// Purpose: Helpers for the recovery suites: scratch databases, script runner, database fingerprints
//
// The recovery tests treat database/backup/backup.sh and restore.sh as black boxes: they call the
// scripts, then compare the restored database with the source through a fingerprint built from the
// catalog and the data. Nothing here knows how a dump is made.
//
// Usage:
//   const dir = await makeDumpDir();
//   const backup = await runScript(BACKUP_SH, ['--url', getTestDatabaseUrl(), '--out-dir', dir]);
//   await createScratchDatabase('ebiotrack_restore_test');
//   const restore = await runScript(RESTORE_SH, [backup.stdout.trim(), '--url', urlFor('ebiotrack_restore_test')]);
//   const diff = diffFingerprints(await fingerprintOf(getTestDatabaseUrl()), await fingerprintOf(urlFor('ebiotrack_restore_test')));
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeTarget, getTestDatabaseUrl } from './testDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKUP_SH = path.resolve(here, '../../database/backup/backup.sh');
export const RESTORE_SH = path.resolve(here, '../../database/backup/restore.sh');

export const SCRIPT_TIMEOUT_MS = 60_000;

/** Exit codes documented in database/backup/README.md. */
export const EXIT = Object.freeze({
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  REFUSED: 3,
  CONNECTION: 4,
  DUMP_INVALID: 5,
  TOOLS: 6,
});

const SCRATCH_NAME = /^ebiotrack_[a-z0-9_]*_test$/;

// ---- URLs and connections --------------------------------------------------------------------

/** The test database URL with another database name. */
export function urlFor(dbName) {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Admin connection URL: same server and credentials, database `postgres`. */
export const adminUrl = () => urlFor('postgres');

/** The development database URL (never written to; used by the "refuse" tests only). */
export const devUrl = () => urlFor('ebiotrack');

export const passwordOf = (url) => decodeURIComponent(new URL(url).password);

export const databaseNameOf = (url) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

/** Run fn(client) on a short-lived connection. */
export async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Mask the password of every URL in a message so a failure never prints it. */
export function mask(text) {
  return String(text).replace(/(\w+:\/\/[^:/\s@]*:)[^@\s]*@/g, '$1***@');
}

// ---- scratch databases -----------------------------------------------------------------------

/** Throw unless `name` is a throwaway test database name (never ebiotrack, never ebiotrack_test). */
export function assertScratchName(name) {
  if (!SCRATCH_NAME.test(name) || name === 'ebiotrack_test') {
    throw new Error(`Refusing: "${name}" is not a scratch database name (ebiotrack_<x>_test)`);
  }
  assertSafeTarget(urlFor(name));
  return name;
}

/** CREATE DATABASE via the admin connection (empty, default template). */
export async function createScratchDatabase(name) {
  assertScratchName(name);
  await withClient(adminUrl(), (c) => c.query(`CREATE DATABASE "${name}"`));
}

/** DROP DATABASE IF EXISTS ... WITH (FORCE) via the admin connection. */
export async function dropScratchDatabase(name) {
  assertScratchName(name);
  await withClient(adminUrl(), (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

export async function databaseExists(name) {
  return withClient(adminUrl(), async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return rowCount > 0;
  });
}

export async function publicTableCount(url) {
  return withClient(url, async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    return rows[0].n;
  });
}

/**
 * Can the admin connection create databases? Returns { ok, reason }. The suites skip locally (with
 * the reason printed) and fail when CI=true.
 */
export async function canCreateDatabases() {
  try {
    return await withClient(adminUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT rolsuper OR rolcreatedb AS ok FROM pg_roles WHERE rolname = current_user`,
      );
      return rows[0]?.ok
        ? { ok: true }
        : { ok: false, reason: 'the test database role cannot CREATE DATABASE' };
    });
  } catch (err) {
    return { ok: false, reason: `cannot connect to the admin database: ${mask(err.message)}` };
  }
}

// ---- temp directories ------------------------------------------------------------------------

const dumpDirs = new Set();

/** A fresh temp directory for dumps; removed by removeDumpDirs(). */
export async function makeDumpDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ebiotrack-recovery-'));
  dumpDirs.add(dir);
  return dir;
}

export async function removeDumpDirs() {
  for (const dir of dumpDirs) await rm(dir, { recursive: true, force: true });
  dumpDirs.clear();
}

// ---- running the scripts ---------------------------------------------------------------------

/**
 * Run a script with execFile (no shell, argument array, timeout). Never throws on a non-zero exit.
 * @param {string} script
 * @param {string[]} args
 * @param {{env?: Record<string,string|undefined>, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, stdout: string, stderr: string, ms: number}>}
 */
export function runScript(script, args, { env = {}, timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      script,
      args,
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          signal: error?.signal ?? null,
          timedOut: Boolean(error?.killed && error?.signal),
          stdout: String(stdout),
          stderr: String(stderr),
          ms: Math.round(performance.now() - started),
        });
      },
    );
  });
}

/** Run a tool that is expected to exist (e.g. `pg_restore --list`); same result shape. */
export const runTool = runScript;

/** A one-line description of a failed run for assertion messages (password masked). */
export const describeRun = (r) =>
  mask(
    `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );

// ---- fingerprints ----------------------------------------------------------------------------

/**
 * Describe the public schema and its data as plain objects so two databases can be compared.
 *
 * tables: per table { count, md5 }, where md5 covers every row (all columns cast to text) ordered
 * by primary key. `session` is count-only: its rows expire and are volatile.
 * The rest comes from the catalog: columns, constraints, indexes, triggers (with enabled state),
 * functions (md5 of the definition), views, enum types and sequences (last_value; null = not yet
 * called).
 * @param {import('pg').ClientBase} client
 */
export async function fingerprint(client) {
  await client.query(`SET TimeZone = 'UTC'`);
  const out = {
    tables: {},
    sequences: {},
    constraints: {},
    indexes: {},
    triggers: {},
    functions: {},
    views: {},
    types: {},
    columns: {},
  };

  const tables = await client.query(
    `SELECT t.tablename AS name,
            (SELECT string_agg(format('%I', a.attname), ', ' ORDER BY k.ord)
               FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              WHERE i.indrelid = format('%I.%I', t.schemaname, t.tablename)::regclass
                AND i.indisprimary) AS pk
       FROM pg_tables t
      WHERE t.schemaname = 'public'
      ORDER BY t.tablename`,
  );
  for (const { name, pk } of tables.rows) {
    const ident = `"${name.replace(/"/g, '""')}"`;
    if (name === 'session') {
      const { rows } = await client.query(`SELECT count(*)::int AS count FROM ${ident}`);
      out.tables[name] = { count: rows[0].count, md5: null };
      continue;
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS count,
              md5(coalesce(string_agg(t::text, E'\\n' ORDER BY ${pk ?? 't::text'}), '')) AS md5
         FROM ${ident} t`,
    );
    out.tables[name] = rows[0];
  }

  for (const r of (
    await client.query(
      `SELECT sequencename AS name, last_value::text, start_value::text, increment_by::text, data_type::text
         FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`,
    )
  ).rows) {
    out.sequences[r.name] =
      `last=${r.last_value} start=${r.start_value} inc=${r.increment_by} ${r.data_type}`;
  }

  for (const r of (
    await client.query(
      `SELECT conrelid::regclass::text AS tbl, conname, contype, convalidated,
              pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
        ORDER BY 1, 2`,
    )
  ).rows) {
    out.constraints[`${r.tbl}.${r.conname}`] = `${r.contype} validated=${r.convalidated} ${r.def}`;
  }

  for (const r of (
    await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    )
  ).rows) {
    out.indexes[r.indexname] = r.indexdef;
  }

  for (const r of (
    await client.query(
      `SELECT tgrelid::regclass::text AS tbl, tgname, tgenabled, pg_get_triggerdef(oid) AS def
         FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'pg_%'
        ORDER BY 1, 2`,
    )
  ).rows) {
    out.triggers[`${r.tbl}.${r.tgname}`] = `enabled=${r.tgenabled} ${r.def}`;
  }

  for (const r of (
    await client.query(
      `SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) AS md5
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
    )
  ).rows) {
    out.functions[r.sig] = r.md5;
  }

  for (const r of (
    await client.query(
      `SELECT viewname AS name, md5(definition) AS md5 FROM pg_views WHERE schemaname = 'public'
       UNION ALL
       SELECT matviewname, md5(definition) FROM pg_matviews WHERE schemaname = 'public'
       ORDER BY 1`,
    )
  ).rows) {
    out.views[r.name] = r.md5;
  }

  for (const r of (
    await client.query(
      `SELECT t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typnamespace = 'public'::regnamespace
        GROUP BY t.typname ORDER BY 1`,
    )
  ).rows) {
    out.types[r.name] = r.labels;
  }

  for (const r of (
    await client.query(
      `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default,
              is_identity, identity_generation
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    )
  ).rows) {
    out.columns[`${r.table_name}.${r.column_name}`] =
      `#${r.ordinal_position} ${r.data_type} null=${r.is_nullable} default=${r.column_default} ` +
      `identity=${r.is_identity}/${r.identity_generation}`;
  }
  return out;
}

/** Fingerprint a database by URL on a short-lived connection. */
export const fingerprintOf = (url) => withClient(url, fingerprint);

/**
 * Differences between two fingerprints as readable lines; empty when they are identical.
 * @returns {string[]}
 */
export function diffFingerprints(a, b, labels = ['source', 'restored']) {
  const lines = [];
  for (const section of Object.keys(a)) {
    const left = a[section] ?? {};
    const right = b[section] ?? {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const x = left[key];
      const y = right[key];
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      if (x === undefined) lines.push(`${section} "${key}" only in ${labels[1]}`);
      else if (y === undefined) lines.push(`${section} "${key}" only in ${labels[0]}`);
      else
        lines.push(
          `${section} "${key}" differs: ${labels[0]} ${JSON.stringify(x)} vs ${labels[1]} ${JSON.stringify(y)}`,
        );
    }
  }
  return lines;
}

// ---- environment probe -----------------------------------------------------------------------

/**
 * Decide whether the recovery suites can run and take the first backup of the test database.
 * Not ready means: the admin role cannot CREATE DATABASE, or the scripts report missing client tools
 * (exit 6). With CI=true that is an error, otherwise the suite skips with the reason.
 * @param {string} dumpDir
 * @returns {Promise<{ready: boolean, reason?: string, backup?: Awaited<ReturnType<typeof runScript>>}>}
 */
export async function probeEnvironment(dumpDir) {
  const fail = (reason) => {
    if (process.env.CI === 'true') throw new Error(`CI=true but recovery cannot run: ${reason}`);
    console.warn(`[recovery] suite will be SKIPPED: ${reason}`);
    return { ready: false, reason };
  };
  const admin = await canCreateDatabases();
  if (!admin.ok) return fail(admin.reason);
  const backup = await runScript(BACKUP_SH, [
    '--url',
    getTestDatabaseUrl(),
    '--out-dir',
    dumpDir,
    '--quiet',
  ]);
  if (backup.code === EXIT.TOOLS)
    return fail(`backup.sh: client tools missing (${backup.stderr.trim()})`);
  return { ready: true, backup };
}

/** Pick the dump path out of a backup run (stdout is exactly the path). */
export const dumpPathOf = (run) => run.stdout.trim();
