// Owner: A (Backend)
// Purpose: Migration runner for database/migrations
//
// Usage: node src/db/migrate.js [--seed] [--reset] [--status]
//   (none)    apply pending files from database/migrations/
//   --seed    then apply pending files from database/seeds/ (after 090)
//   --reset   first drop and recreate the public schema (development/test only)
//   --status  list applied vs pending, change nothing
//
// Tracking: migrations are recorded in `schema_migrations`, seeds in `schema_seeds`
// (same columns: filename, checksum, applied_at). Each file runs in one transaction with its
// tracking insert. Do not put BEGIN/COMMIT inside migration files.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { config, maskDatabaseUrl } from '../config/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FILE_PATTERN = /^(\d{3})_.+\.sql$/;
// Arbitrary constant; all runners must agree on it so concurrent runs serialize.
const ADVISORY_LOCK_KEY = 7261001;

const KINDS = {
  migrations: { table: 'schema_migrations', label: 'migration' },
  seeds: { table: 'schema_seeds', label: 'seed' },
};

export class MigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Find `NNN_name.sql` files in a directory, sorted by numeric prefix. */
async function discover(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = names
    .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
    .filter((f) => f.match)
    .map((f) => ({ filename: f.name, order: Number(f.match[1]) }))
    .sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));

  for (let i = 1; i < files.length; i++) {
    if (files[i].order === files[i - 1].order) {
      throw new MigrationError(
        `Two files share the prefix ${String(files[i].order).padStart(3, '0')}: ` +
          `${files[i - 1].filename} and ${files[i].filename}`,
      );
    }
  }

  return Promise.all(
    files.map(async (f) => {
      const sql = await readFile(path.join(dir, f.filename), 'utf8');
      return { filename: f.filename, sql, checksum: sha256(sql) };
    }),
  );
}

async function trackingTableExists(client, table) {
  const { rows } = await client.query('SELECT to_regclass($1) AS oid', [`public.${table}`]);
  return rows[0].oid !== null;
}

async function ensureTrackingTable(client, table) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
       filename   text PRIMARY KEY,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function loadApplied(client, table) {
  if (!(await trackingTableExists(client, table))) return new Map();
  const { rows } = await client.query(`SELECT filename, checksum FROM ${table}`);
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

function describeSqlError(err, file) {
  let where = '';
  if (err.position) {
    const line = file.sql.slice(0, Number(err.position) - 1).split('\n').length;
    where = ` (line ${line})`;
  }
  const detail = err.detail ? `\n  detail: ${err.detail}` : '';
  const context = err.where ? `\n  where: ${err.where}` : '';
  return `${file.filename}${where}: ${err.message}${detail}${context}`;
}

/** Refuse to continue if an already-applied file was edited. */
function verifyChecksums(kind, files, applied) {
  for (const file of files) {
    const recorded = applied.get(file.filename);
    if (recorded !== undefined && recorded !== file.checksum) {
      throw new MigrationError(
        `Checksum mismatch: ${kind.label} ${file.filename} was changed after it was applied.\n` +
          'Applied files must never be edited; put changes in a new numbered file, or, if this is\n' +
          'only your local development database, rebuild it with: npm run db:reset',
      );
    }
  }
}

async function applyFile(client, kind, file, log) {
  try {
    await client.query('BEGIN');
    await client.query(file.sql);
    await client.query(`INSERT INTO ${kind.table} (filename, checksum) VALUES ($1, $2)`, [
      file.filename,
      file.checksum,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new MigrationError(`Failed to apply ${kind.label} ${describeSqlError(err, file)}`, {
      cause: err,
    });
  }
  log(`  applied ${file.filename}`);
}

/**
 * Apply (or report on) migrations and optionally seeds.
 * @param {object} [options]
 * @param {boolean} [options.seed] also apply database/seeds after the migrations
 * @param {boolean} [options.reset] drop and recreate the public schema first (development/test only)
 * @param {boolean} [options.status] report applied/pending only; changes nothing
 * @param {string} [options.databaseUrl] defaults to config.databaseUrl (the test DB when NODE_ENV=test)
 * @param {string} [options.nodeEnv] defaults to config.nodeEnv; gates --reset
 * @param {string} [options.migrationsDir] defaults to database/migrations
 * @param {string} [options.seedsDir] defaults to database/seeds
 * @param {(message: string) => void} [options.log] defaults to console.log
 * @returns {Promise<{appliedMigrations: string[], appliedSeeds: string[], pendingMigrations: string[], pendingSeeds: string[]}>}
 */
export async function migrate({
  seed = false,
  reset = false,
  status = false,
  databaseUrl = config.databaseUrl,
  nodeEnv = config.nodeEnv,
  migrationsDir = path.join(repoRoot, 'database/migrations'),
  seedsDir = path.join(repoRoot, 'database/seeds'),
  log = console.log,
} = {}) {
  if (reset && !status && !['development', 'test'].includes(nodeEnv)) {
    throw new MigrationError(
      `Refusing to --reset when NODE_ENV=${nodeEnv}; only development or test.`,
    );
  }

  const migrations = await discover(migrationsDir);
  const seeds = await discover(seedsDir);
  const result = {
    appliedMigrations: [],
    appliedSeeds: [],
    pendingMigrations: [],
    pendingSeeds: [],
  };

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    log(`Target database: ${rows[0].db} (${maskDatabaseUrl(databaseUrl)})`);

    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      if (reset && !status) {
        log('Resetting: dropping and recreating schema "public"');
        await client.query('DROP SCHEMA public CASCADE');
        await client.query('CREATE SCHEMA public');
      }

      const plan = [
        { kind: KINDS.migrations, files: migrations, run: true, pendingKey: 'pendingMigrations' },
        { kind: KINDS.seeds, files: seeds, run: seed, pendingKey: 'pendingSeeds' },
      ];

      // Verify everything first so a tampered file stops the run before anything is applied.
      const appliedByKind = new Map();
      for (const { kind, files, run } of plan) {
        const applied = await loadApplied(client, kind.table);
        appliedByKind.set(kind, applied);
        if (run || status) verifyChecksums(kind, files, applied);
        const onDisk = new Set(files.map((f) => f.filename));
        for (const name of applied.keys()) {
          if (!onDisk.has(name))
            log(`  warning: applied ${kind.label} ${name} is no longer on disk`);
        }
      }

      for (const { kind, files, run, pendingKey } of plan) {
        const applied = appliedByKind.get(kind);
        const pending = files.filter((f) => !applied.has(f.filename));

        if (status) {
          result[pendingKey] = pending.map((f) => f.filename);
          log(`${kind.label}s:`);
          for (const f of files)
            log(`  ${applied.has(f.filename) ? 'applied' : 'pending'}  ${f.filename}`);
          continue;
        }
        if (!run) {
          result[pendingKey] = pending.map((f) => f.filename);
          continue;
        }

        if (kind === KINDS.migrations || pending.length > 0) {
          await ensureTrackingTable(client, kind.table);
        }
        if (pending.length === 0) log(`No pending ${kind.label}s.`);
        for (const file of pending) {
          await applyFile(client, kind, file, log);
          result[kind === KINDS.migrations ? 'appliedMigrations' : 'appliedSeeds'].push(
            file.filename,
          );
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    await client.end();
  }
  return result;
}

function parseArgs(argv) {
  const known = { '--seed': 'seed', '--reset': 'reset', '--status': 'status' };
  const options = {};
  for (const arg of argv) {
    if (!(arg in known))
      throw new MigrationError(`Unknown option: ${arg} (use --seed, --reset, --status)`);
    options[known[arg]] = true;
  }
  return options;
}

async function main() {
  try {
    await migrate(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof MigrationError ? err.message : err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
