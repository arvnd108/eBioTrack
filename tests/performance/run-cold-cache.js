// Owner: C (Testing & QA)
// Purpose: Cold-cache pass of the T35 benchmark: the first execution of each statement after a database restart
//
//   node performance/run-cold-cache.js [--scale medium] [--repeats 1] [--container ebiotrack-db-1] [--out DIR|none]
//
// run-benchmarks.js measures with every page already in shared buffers. This script answers the
// other half of "say which": before EACH timed execution it restarts the PostgreSQL container
// (empties shared_buffers), drops the Linux page cache inside the Docker VM, reconnects and runs one
// EXPLAIN (ANALYZE, BUFFERS). Pages then come from storage: "read" buffers are the cold I/O.
// It needs Docker and the container of docker-compose.yml, and takes several minutes.
// Index state, prepared data and restore follow run-benchmarks.js (the final indexes end applied).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { SCALES } from '../fixtures/generate-volume-data.js';
import {
  REPO_ROOT,
  SLICES,
  analyzeAll,
  assertIndexState,
  checkVolume,
  createFinalIndexes,
  describePlan,
  dropFinalIndexes,
  fill,
  lookupParams,
  openSession,
  prepareData,
  readIndexSet,
  undoPrepare,
} from './benchmarks.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

function parseArgs(argv) {
  const o = {
    scale: 'medium',
    repeats: 1,
    container: 'ebiotrack-db-1',
    out: path.join(here, 'results'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scale') o.scale = argv[++i];
    else if (a === '--repeats') o.repeats = Number(argv[++i]);
    else if (a === '--container') o.container = argv[++i];
    else if (a === '--out') o.out = argv[++i] === 'none' ? null : path.resolve(argv[i]);
    else throw new Error(`Unknown option ${a}`);
  }
  if (!Number.isInteger(o.repeats) || o.repeats < 1)
    throw new Error('--repeats must be a positive integer');
  return o;
}

/**
 * PREPARE the slice's statements without running the file's example EXECUTE lines: those would read
 * the tables and warm the caches that this script has just emptied.
 */
async function prepareOnly(client, slice) {
  await client.query('DEALLOCATE ALL');
  const file = path.join(REPO_ROOT, 'database/queries', slice.queryFile);
  await client.query(fs.readFileSync(file, 'utf8').replace(/^EXECUTE[\s\S]*?;/gm, ''));
}

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });

/** Restart the container and empty the OS page cache; resolves once PostgreSQL accepts connections. */
async function goCold(container) {
  docker('restart', '-t', '5', container);
  docker(
    'run',
    '--rm',
    '--privileged',
    'alpine',
    'sh',
    '-c',
    'sync; echo 3 > /proc/sys/vm/drop_caches',
  );
  for (let i = 0; i < 60; i++) {
    try {
      return await openSession();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('PostgreSQL did not come back after the restart');
}

async function coldRun(container, slice, sql) {
  const client = await goCold(container);
  try {
    await prepareOnly(client, slice);
    const doc = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)).rows[0][
      'QUERY PLAN'
    ][0];
    const plan = describePlan(doc.Plan);
    return {
      ms: doc['Execution Time'],
      topNode: plan.topNode,
      indexesUsed: plan.indexesUsed,
      hit: plan.buffersHit,
      read: plan.buffersRead,
    };
  } finally {
    await client.end();
  }
}

async function measurePhase(opts, params, log) {
  const out = {};
  for (const slice of SLICES) {
    for (const s of slice.statements) {
      const sql = fill(s.sql, params[slice.id]);
      const runs = [];
      for (let k = 0; k < opts.repeats; k++) runs.push(await coldRun(opts.container, slice, sql));
      runs.sort((a, b) => a.ms - b.ms);
      const mid = runs[Math.floor(runs.length / 2)];
      out[`${slice.id}/${s.id}`] = {
        topNode: mid.topNode,
        indexesUsed: mid.indexesUsed,
        buffersHit: mid.hit,
        buffersRead: mid.read,
        ms: round(mid.ms),
        msAll: runs.map((r) => round(r.ms)),
      };
      log(`  ${slice.id}/${s.id}`.padEnd(16) + ` ${round(mid.ms)} ms (${mid.read} read)`);
    }
  }
  return out;
}

const fmt = (x) => (x >= 100 ? Math.round(x) : x >= 10 ? round(x, 1) : round(x, 2));
const factor = (a, b) => (b > 0 ? `${fmt(a / b)}x` : 'n/a');

const planOf = (m) =>
  m.indexesUsed.length > 0
    ? `${m.topNode} (${m.indexesUsed.filter((n) => n.startsWith('idx_')).join(', ') || 'no new index'})`
    : m.topNode;

/** Statements the index made slower on cold storage (at least 20% and 0.5 ms). */
function coldRegressions(doc) {
  return doc.statements.filter(
    (s) => s.indexed.ms > s.baseline.ms * 1.25 && s.indexed.ms - s.baseline.ms >= 0.5,
  );
}

function buildMarkdown(doc) {
  const h = doc.header;
  const lines = [
    '# Cold-cache benchmark results (T35)',
    '',
    `Generated by \`${h.command}\` on ${h.generatedAt}. Do not edit by hand; every number comes from \`cold-cache-results.json\`.`,
    '',
    `- Scale \`${h.scale}\`, ${h.postgres}; same session settings, index set and statements as \`benchmark-results.md\`.`,
    `- Cold means: before each execution the PostgreSQL container is restarted (empty shared_buffers) and the Linux page cache of the Docker VM is dropped. Each figure is the first execution after that${h.repeats > 1 ? ` (median of ${h.repeats} cold executions)` : ' (one cold execution per statement and phase)'}.`,
    '- "read" is the number of shared buffers fetched from storage (the cold I/O); "hit" were found in shared buffers during the same execution. Times include that I/O and vary more between machines than the warm figures.',
    '',
  ];
  for (const slice of SLICES) {
    lines.push(
      `## ${slice.title}`,
      '',
      '| id | cold ms before -> after | factor | read buffers before -> after | plan before -> after |',
      '| -- | ----------------------- | ------ | ---------------------------- | -------------------- |',
    );
    for (const s of doc.statements.filter((x) => x.slice === slice.id)) {
      const b = s.baseline;
      const i = s.indexed;
      lines.push(
        `| ${s.id} | ${fmt(b.ms)} -> ${fmt(i.ms)} | ${factor(b.ms, i.ms)} | ${b.buffersRead} -> ${i.buffersRead} | ${planOf(b)} -> ${planOf(i)} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Statements that are slower cold with the indexes', '');
  const slower = coldRegressions(doc);
  if (slower.length === 0) lines.push('None.', '');
  else {
    lines.push(
      'Fewer buffers does not mean less time on cold storage: a bitmap or index scan fetches scattered pages, a sequential scan reads ahead. The planner uses the default random_page_cost = 4 (tuned for spinning disks), which makes it choose these index plans.',
      '',
      '| id | cold ms before -> after | slowdown | read buffers before -> after |',
      '| -- | ----------------------- | -------- | ---------------------------- |',
      ...slower.map(
        (s) =>
          `| ${s.slice}/${s.id} | ${fmt(s.baseline.ms)} -> ${fmt(s.indexed.ms)} | ${factor(s.indexed.ms, s.baseline.ms)} | ${s.baseline.buffersRead} -> ${s.indexed.buffersRead} |`,
      ),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runColdCache(opts) {
  const log = (m) => console.log(m);
  const started = performance.now();
  const set = readIndexSet();
  let client = await openSession();
  let prepared = false;
  try {
    await checkVolume(client, opts.scale, SCALES);
    await prepareData(client);
    prepared = true;
    const params = {};
    for (const slice of SLICES) params[slice.id] = await lookupParams(client, slice);
    const postgres = (await client.query('SELECT version() AS v')).rows[0].v.split(' on ')[0];

    const measured = {};
    for (const phase of ['baseline', 'indexed']) {
      log(`\nPhase ${phase} (cold)`);
      if (phase === 'baseline') await dropFinalIndexes(client, set);
      else await createFinalIndexes(client, set);
      await assertIndexState(client, set, phase);
      await analyzeAll(client);
      await client.end(); // one connection at a time: the restart drops it anyway
      measured[phase] = await measurePhase(opts, params, log);
      client = await openSession();
    }

    await createFinalIndexes(client, set);
    await assertIndexState(client, set, 'indexed');
    await analyzeAll(client);
    await undoPrepare(client);
    prepared = false;

    const statements = SLICES.flatMap((slice) =>
      slice.statements.map((s) => ({
        slice: slice.id,
        id: s.id,
        expect: s.expect,
        baseline: measured.baseline[`${slice.id}/${s.id}`],
        indexed: measured.indexed[`${slice.id}/${s.id}`],
      })),
    );
    const doc = {
      header: {
        generatedAt: new Date().toISOString(),
        command: `node performance/run-cold-cache.js --scale ${opts.scale} --repeats ${opts.repeats}`,
        scale: opts.scale,
        postgres,
        repeats: opts.repeats,
        durationSeconds: round((performance.now() - started) / 1000, 1),
        volatileFields: ['header.generatedAt', 'header.durationSeconds', 'statements[].*.ms*'],
      },
      statements,
    };
    if (opts.out) {
      fs.mkdirSync(opts.out, { recursive: true });
      const emit = async (file, text) => {
        const target = path.join(opts.out, file);
        fs.writeFileSync(
          target,
          await prettier.format(text, {
            ...(await prettier.resolveConfig(target)),
            filepath: target,
          }),
        );
      };
      await emit('cold-cache-results.json', JSON.stringify(doc, null, 2));
      await emit('cold-cache-results.md', buildMarkdown(doc));
    }
    log(`\nCold pass finished in ${doc.header.durationSeconds} s`);
    return doc;
  } finally {
    try {
      if (prepared) {
        await createFinalIndexes(client, set);
        await undoPrepare(client);
      }
    } finally {
      await client.end().catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runColdCache(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
