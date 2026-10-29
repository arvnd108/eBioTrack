// Owner: C (Testing & QA)
// Purpose: Deterministic volume-data generator and loader for the test database (index benchmarks)
//
// Usage (from tests/):
//   npm run volume:load -- --scale small|medium|large [--seed N] [--dry-run]
//   npm run volume:clean
//
// Test database only: refuses any URL that is not ebiotrack_test (assertSafeTarget). Every
// generated row has an explicit ID >= VOLUME_BASE (1 000 000), so it never collides with seed rows
// (< 1000) or rows created by tests (1000 upward) and can be removed by ID range alone.
// Output is a pure function of (seed, scale): no Math.random(), no random()/now() in SQL.
// Constraints and triggers stay enabled; rows are inserted in dependency order.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSafeTarget,
  closeTestPool,
  getPool,
  getTestDatabaseUrl,
  loadBackendConfig,
} from '../setup/testDb.js';

export const VOLUME_BASE = 1_000_000;
const DEFAULT_SEED = 20260101;
const BATCH = 5000;
const START_MS = Date.parse('2019-01-01T00:00:00Z');

/** Target row counts per scale. Medium aims for about a minute on a laptop. */
export const SCALES = {
  small: {
    users: 200,
    projects: 20,
    members: 500,
    sites: 200,
    events: 1000,
    samples: 5000,
    taxa: 200,
    assignments: 20000,
    audit: 20000,
  },
  medium: {
    users: 2000,
    projects: 100,
    members: 20000,
    sites: 2000,
    events: 20000,
    samples: 100000,
    taxa: 2000,
    assignments: 500000,
    audit: 500000,
  },
  large: {
    users: 10000,
    projects: 500,
    members: 200000,
    sites: 10000,
    events: 100000,
    samples: 500000,
    taxa: 10000,
    assignments: 2000000,
    audit: 2000000,
  },
};

const LIBS_PER_RUN = 100;
const SAMPLES_PER_BATCH = 50;
const ENTITY_TYPES = ['samples', 'projects', 'collection_events', 'taxon_assignments', 'users'];

// --- deterministic randomness -------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Uniform [0,1) value for (tag, index, salt) that does not depend on generation order. */
function makeRand(seed) {
  return (tag, i, salt = 0) =>
    mulberry32(
      (seed ^ hash32(tag) ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0,
    )();
}

const iso = (ms) => new Date(ms).toISOString();

// --- plan: table definitions --------------------------------------------------------------

/**
 * Build the load plan (tables in dependency order) for a scale and seed.
 * Each table: name, count, columns [name, pgType, castExpr?], row(i) -> values (0-based i).
 */
export function buildPlan(scaleName, seed = DEFAULT_SEED) {
  const s = SCALES[scaleName];
  if (!s) throw new Error(`Unknown scale "${scaleName}" (use small, medium, or large)`);
  const r = makeRand(seed);
  const id = (i) => VOLUME_BASE + i;
  const skew = (tag, i, n, power, salt = 0) =>
    Math.min(n - 1, Math.floor(n * r(tag, i, salt) ** power));

  const P = s.projects;
  const U = s.users;
  const membersPer = Math.min(U, Math.round(s.members / P));
  // Project p's members are users start..start+membersPer-1 (wrapping); starts are skewed toward
  // low IDs, so a few users sit in many projects. The first member is the owner.
  const startOf = (p) => skew('mstart', p, U, 3);
  const userOf = (p, k) => (startOf(p) + k) % U;
  // Each site belongs to one or two projects.
  const projSites = Array.from({ length: P }, () => []);
  const projectSiteRows = [];
  for (let j = 0; j < s.sites; j++) {
    const first = j % P;
    const second = (j * 7 + 3) % P;
    for (const p of first === second ? [first] : [first, second]) {
      projSites[p].push(j);
      projectSiteRows.push([id(p), id(j)]);
    }
  }
  const eventProject = (e) => skew('evproj', e, P, 2);
  const eventSite = (e) => {
    const list = projSites[eventProject(e)];
    return list[Math.min(list.length - 1, Math.floor(list.length * r('evsite', e)))];
  };
  const eventAt = (e) => START_MS + e * 1_800_000;
  const spe = Math.max(1, Math.round(s.samples / s.events));
  const eventOfSample = (i) => Math.min(s.events - 1, Math.floor(i / spe));
  const nBatches = Math.ceil(s.samples / SAMPLES_PER_BATCH);
  const nRuns = Math.ceil(s.samples / LIBS_PER_RUN);
  const perLib = Math.max(1, Math.round(s.assignments / s.samples));
  const entityCount = {
    samples: s.samples,
    projects: P,
    collection_events: s.events,
    taxon_assignments: s.assignments,
    users: U,
  };
  const chain = ['collected', 'stored', 'extracted', 'sequenced'];

  const tables = [
    {
      name: 'users',
      count: U,
      idCol: 'user_id',
      cols: [
        ['user_id', 'bigint'],
        ['full_name', 'text'],
        ['email', 'text'],
        ['password_hash', 'text'],
        ['created_at', 'timestamptz'],
      ],
      row: (i) => [
        id(i),
        `Volume User ${i}`,
        `volume-user-${i}@ebiotrack.test`,
        'volume-data-not-a-login',
        '2025-01-01T00:00:00Z',
      ],
    },
    {
      name: 'projects',
      count: P,
      idCol: 'project_id',
      cols: [
        ['project_id', 'bigint'],
        ['title', 'text'],
        ['status', 'text', 'project_status'],
        ['created_by', 'bigint'],
        ['created_at', 'timestamptz'],
      ],
      row: (i) => [
        id(i),
        `Volume Project ${i}`,
        'active',
        id(userOf(i, 0)),
        '2025-01-01T00:00:00Z',
      ],
    },
    {
      name: 'project_members',
      count: P * membersPer,
      cols: [
        ['project_id', 'bigint'],
        ['user_id', 'bigint'],
        ['project_role', 'text', 'project_role'],
        ['joined_at', 'timestamptz'],
      ],
      row: (i) => {
        const p = Math.floor(i / membersPer);
        const k = i % membersPer;
        const role = k === 0 ? 'owner' : ['manager', 'contributor', 'contributor', 'viewer'][k % 4];
        return [id(p), id(userOf(p, k)), role, '2025-01-02T00:00:00Z'];
      },
    },
    {
      name: 'sampling_sites',
      count: s.sites,
      idCol: 'site_id',
      cols: [
        ['site_id', 'bigint'],
        ['region_id', 'bigint'],
        ['name', 'text'],
        ['latitude', 'numeric'],
        ['longitude', 'numeric'],
        ['habitat_type', 'text', 'habitat_type'],
        ['created_by', 'bigint'],
        ['created_at', 'timestamptz'],
      ],
      // Regions 2 and 3 are seed rows (read-only references).
      row: (i) => [
        id(i),
        2 + (i % 2),
        `Volume Site ${i}`,
        (8 + r('lat', i) * 28).toFixed(6),
        (68 + r('lon', i) * 29).toFixed(6),
        i % 2 === 0 ? 'river' : 'estuary',
        id(userOf(i % P, 0)),
        '2025-01-01T00:00:00Z',
      ],
    },
    {
      name: 'project_sites',
      count: projectSiteRows.length,
      cols: [
        ['project_id', 'bigint'],
        ['site_id', 'bigint'],
      ],
      row: (i) => projectSiteRows[i],
    },
    {
      name: 'collection_events',
      count: s.events,
      idCol: 'event_id',
      cols: [
        ['event_id', 'bigint'],
        ['project_id', 'bigint'],
        ['site_id', 'bigint'],
        ['collector_id', 'bigint'],
        ['collected_at', 'timestamptz'],
        ['created_at', 'timestamptz'],
      ],
      row: (i) => {
        const p = eventProject(i);
        return [
          id(i),
          id(p),
          id(eventSite(i)),
          id(userOf(p, Math.floor(membersPer * r('evcol', i)))),
          iso(eventAt(i)),
          iso(eventAt(i)),
        ];
      },
    },
    {
      name: 'samples',
      count: s.samples,
      idCol: 'sample_id',
      cols: [
        ['sample_id', 'bigint'],
        ['event_id', 'bigint'],
        ['sample_type_id', 'bigint'],
        ['sample_code', 'text'],
        ['volume_ml', 'numeric'],
        ['status', 'text', 'sample_status'],
        ['created_at', 'timestamptz'],
      ],
      // Sample types 1-4 are seed rows. Code is unique because it embeds the full event ID.
      row: (i) => {
        const e = eventOfSample(i);
        const day = iso(eventAt(e)).slice(0, 10).replaceAll('-', '');
        return [
          id(i),
          id(e),
          1 + (i % 4),
          `EB-${day}-${id(e)}-${String(i % spe).padStart(3, '0')}`,
          (250 + Math.floor(r('vol', i) * 1750)).toFixed(2),
          'sequenced',
          iso(eventAt(e)),
        ];
      },
    },
    {
      name: 'sample_status_history',
      count: s.samples * 4,
      idCol: 'history_id',
      keyCol: 'sample_id',
      cols: [
        ['history_id', 'bigint'],
        ['sample_id', 'bigint'],
        ['old_status', 'text', 'sample_status'],
        ['new_status', 'text', 'sample_status'],
        ['changed_by', 'bigint'],
        ['changed_at', 'timestamptz'],
      ],
      row: (i) => {
        const smp = Math.floor(i / 4);
        const k = i % 4;
        return [
          id(i),
          id(smp),
          k === 0 ? null : chain[k - 1],
          chain[k],
          id(userOf(smp % P, 0)),
          iso(eventAt(eventOfSample(smp)) + k * 86_400_000),
        ];
      },
    },
    {
      name: 'extraction_batches',
      count: nBatches,
      idCol: 'batch_id',
      cols: [
        ['batch_id', 'bigint'],
        ['lab_id', 'bigint'],
        ['operator_id', 'bigint'],
        ['extraction_date', 'date'],
        ['created_at', 'timestamptz'],
      ],
      // Labs 1 and 2 are seed rows.
      row: (i) => {
        const when = eventAt(Math.min(s.events - 1, Math.floor((i * SAMPLES_PER_BATCH) / spe)));
        return [
          id(i),
          1 + (i % 2),
          id(userOf(i % P, 1 % membersPer)),
          iso(when + 86_400_000).slice(0, 10),
          iso(when + 86_400_000),
        ];
      },
    },
    {
      name: 'dna_extractions',
      count: s.samples,
      idCol: 'extraction_id',
      cols: [
        ['extraction_id', 'bigint'],
        ['sample_id', 'bigint'],
        ['batch_id', 'bigint'],
        ['concentration_ng_ul', 'numeric'],
        ['purity_a260_280', 'numeric'],
        ['qc_status', 'text', 'qc_status'],
        ['created_at', 'timestamptz'],
      ],
      row: (i) => [
        id(i),
        id(i),
        id(Math.floor(i / SAMPLES_PER_BATCH)),
        (5 + r('conc', i) * 40).toFixed(3),
        (1.7 + r('pur', i) * 0.3).toFixed(2),
        'pass',
        iso(eventAt(eventOfSample(i)) + 2 * 86_400_000),
      ],
    },
    {
      name: 'sequencing_runs',
      count: nRuns,
      idCol: 'run_id',
      cols: [
        ['run_id', 'bigint'],
        ['run_code', 'text'],
        ['lab_id', 'bigint'],
        ['platform', 'text'],
        ['run_date', 'date'],
        ['status', 'text', 'run_status'],
        ['created_at', 'timestamptz'],
      ],
      row: (i) => {
        const when =
          eventAt(Math.min(s.events - 1, Math.floor((i * LIBS_PER_RUN) / spe))) + 3 * 86_400_000;
        return [
          id(i),
          `VOLRUN-${String(i).padStart(6, '0')}`,
          1 + (i % 2),
          'Illumina MiSeq',
          iso(when).slice(0, 10),
          'completed',
          iso(when),
        ];
      },
    },
    {
      name: 'sequencing_libraries',
      count: s.samples,
      idCol: 'library_id',
      cols: [
        ['library_id', 'bigint'],
        ['library_code', 'text'],
        ['extraction_id', 'bigint'],
        ['run_id', 'bigint'],
        ['created_at', 'timestamptz'],
      ],
      row: (i) => [
        id(i),
        `VLIB-${String(i).padStart(7, '0')}`,
        id(i),
        id(Math.floor(i / LIBS_PER_RUN)),
        iso(eventAt(eventOfSample(i)) + 3 * 86_400_000),
      ],
    },
    {
      name: 'taxa',
      count: s.taxa,
      idCol: 'taxon_id',
      cols: [
        ['taxon_id', 'bigint'],
        ['scientific_name', 'text'],
        ['rank', 'text', 'taxon_rank'],
        ['parent_taxon_id', 'bigint'],
      ],
      // Parent 6 is the seed genus Labeo.
      row: (i) => [id(i), `Volumeus species${i}`, 'species', 6],
    },
    {
      name: 'analysis_runs',
      count: nRuns,
      idCol: 'analysis_id',
      cols: [
        ['analysis_id', 'bigint'],
        ['run_id', 'bigint'],
        ['marker_id', 'bigint'],
        ['pipeline_name', 'text'],
        ['pipeline_version', 'text'],
        ['reference_db', 'text'],
        ['status', 'text', 'analysis_status'],
        ['imported_by', 'bigint'],
        ['created_at', 'timestamptz'],
      ],
      // Marker 1 is a seed row.
      row: (i) => [
        id(i),
        id(i),
        1,
        'OBITools3',
        '3.0.1',
        'MitoFish',
        'imported',
        id(userOf(i % P, 0)),
        iso(eventAt(Math.min(s.events - 1, Math.floor((i * LIBS_PER_RUN) / spe))) + 5 * 86_400_000),
      ],
    },
    {
      name: 'taxon_assignments',
      count: s.samples * perLib,
      idCol: 'assignment_id',
      cols: [
        ['assignment_id', 'bigint'],
        ['analysis_id', 'bigint'],
        ['library_id', 'bigint'],
        ['taxon_id', 'bigint'],
        ['read_count', 'integer'],
        ['confidence', 'numeric'],
        ['qc_flag', 'text', 'qc_flag'],
        ['created_at', 'timestamptz'],
      ],
      // Each library gets perLib distinct taxa: a skewed start plus consecutive offsets.
      row: (i) => {
        const lib = Math.floor(i / perLib);
        const k = i % perLib;
        const conf = r('conf', i);
        return [
          id(i),
          id(Math.floor(lib / LIBS_PER_RUN)),
          id(lib),
          id((skew('tstart', lib, s.taxa, 3) + k) % s.taxa),
          Math.floor(10 ** (1 + 4 * r('reads', i))),
          conf.toFixed(4),
          conf >= 0.8 ? 'pass' : conf >= 0.5 ? 'warn' : 'fail',
          iso(eventAt(eventOfSample(lib)) + 5 * 86_400_000),
        ];
      },
    },
    {
      name: 'audit_logs',
      count: s.audit,
      idCol: 'audit_id',
      cols: [
        ['audit_id', 'bigint'],
        ['actor_id', 'bigint'],
        ['entity_type', 'text'],
        ['entity_id', 'bigint'],
        ['action', 'text', 'audit_action'],
        ['details', 'text', 'jsonb'],
        ['created_at', 'timestamptz'],
      ],
      // Entity IDs are skewed (cubed uniform), so a few entities carry most of the trail.
      row: (i) => {
        const type = ENTITY_TYPES[i % ENTITY_TYPES.length];
        return [
          id(i),
          id(skew('actor', i, U, 2)),
          type,
          id(skew('entity', i, entityCount[type], 3)),
          i % 3 === 0 ? 'insert' : 'update',
          JSON.stringify({ n: i }),
          iso(START_MS + i * 60_000),
        ];
      },
    },
  ];
  return tables;
}

// --- loading ------------------------------------------------------------------------------

async function insertBatches(client, table) {
  const names = table.cols.map(([n]) => n).join(', ');
  const placeholders = table.cols.map(([, type], k) => `$${k + 1}::${type}[]`).join(', ');
  const select = table.cols.map(([n, , cast]) => (cast ? `t.${n}::${cast}` : `t.${n}`)).join(', ');
  const alias = table.cols.map(([n]) => n).join(', ');
  const sql = `INSERT INTO ${table.name} (${names}) SELECT ${select} FROM unnest(${placeholders}) AS t(${alias})`;
  for (let from = 0; from < table.count; from += BATCH) {
    const to = Math.min(table.count, from + BATCH);
    const columns = table.cols.map(() => []);
    for (let i = from; i < to; i++) table.row(i).forEach((v, k) => columns[k].push(v));
    await client.query(sql, columns);
  }
}

// DELETE statements in reverse dependency order; each removes only rows with IDs >= VOLUME_BASE.
const CLEAN_STEPS = [
  ['audit_logs', 'audit_id'],
  ['taxon_assignments', 'assignment_id'],
  ['analysis_runs', 'analysis_id'],
  ['sequencing_libraries', 'library_id'],
  ['sequencing_runs', 'run_id'],
  ['taxa', 'taxon_id'],
  ['dna_extractions', 'extraction_id'],
  ['extraction_batches', 'batch_id'],
  ['sample_status_history', 'sample_id'],
  ['samples', 'sample_id'],
  ['collection_events', 'event_id'],
  ['project_sites', 'project_id'],
  ['project_members', 'project_id'],
  ['sampling_sites', 'site_id'],
  ['projects', 'project_id'],
  ['users', 'user_id'],
];

/**
 * Remove every volume row (IDs >= VOLUME_BASE) from the test database; seed rows are untouched.
 * Each table is deleted and then vacuumed in its own step. Deleting a parent row makes PostgreSQL
 * scan its child table to check the foreign key, and without the VACUUM the child's dead rows make
 * that scan quadratic. Re-running after a failure is safe: it only ever removes volume rows.
 */
export async function cleanVolumeData() {
  assertSafeTarget(getTestDatabaseUrl());
  const client = await getPool().connect();
  try {
    let total = 0;
    // Table and column names come from the fixed list above.
    for (const [table, column] of CLEAN_STEPS) {
      total += (await client.query(`DELETE FROM ${table} WHERE ${column} >= $1`, [VOLUME_BASE]))
        .rowCount;
      await client.query(`VACUUM ${table}`);
    }
    return total;
  } finally {
    client.release();
  }
}

export async function loadVolumeData({
  scale = 'medium',
  seed = DEFAULT_SEED,
  log = console.log,
} = {}) {
  assertSafeTarget(getTestDatabaseUrl());
  const plan = buildPlan(scale, seed);
  const client = await getPool().connect();
  const started = performance.now();
  try {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM users WHERE user_id >= $1',
      [VOLUME_BASE],
    );
    if (rows[0].n > 0) {
      throw new Error(
        'Volume data is already loaded; run `npm run volume:clean` first (no-op refused)',
      );
    }
    await client.query('BEGIN');
    const summary = [];
    for (const table of plan) {
      const t0 = performance.now();
      await insertBatches(client, table);
      summary.push([table.name, table.count, Math.round(performance.now() - t0)]);
      log(
        `  ${table.name.padEnd(24)} ${String(table.count).padStart(9)} rows  ${Math.round(performance.now() - t0)} ms`,
      );
    }
    await client.query('COMMIT');
    log('Running ANALYZE so the planner has statistics');
    await client.query('ANALYZE');
    log(
      `Loaded scale "${scale}" (seed ${seed}) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function parseArgs(argv) {
  const options = { scale: 'medium', seed: DEFAULT_SEED, dryRun: false, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scale') options.scale = argv[++i];
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--clean') options.clean = true;
    else throw new Error(`Unknown option: ${arg} (use --scale, --seed, --dry-run, --clean)`);
  }
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = getTestDatabaseUrl();
  assertSafeTarget(url);
  const { maskDatabaseUrl } = await loadBackendConfig();
  console.log(`Target database: ${maskDatabaseUrl(url)}`);
  if (options.clean) {
    console.log(`Removed ${await cleanVolumeData()} volume rows (IDs >= ${VOLUME_BASE})`);
  } else if (options.dryRun) {
    console.log(`Planned row counts for scale "${options.scale}" (nothing written):`);
    for (const t of buildPlan(options.scale, options.seed)) {
      console.log(`  ${t.name.padEnd(24)} ${String(t.count).padStart(9)} rows`);
    }
  } else {
    await loadVolumeData(options);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await closeTestPool();
  }
}
