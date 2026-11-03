// Owner: C (Testing & QA)
// Purpose: Runs the index benchmark protocol (baseline, then final indexes) with EXPLAIN (ANALYZE, BUFFERS), and the write cost with triggers enabled
//
// Usage (from tests/, volume data loaded with `npm run volume:load -- --scale medium`):
//   npm run bench                                  both phases, writes performance/results/
//   node performance/run-benchmarks.js [--scale medium] [--phase baseline|indexed|both] [--runs 5]
//        [--out results/|none] [--no-write-cost] [--keep-prep]
//   node performance/run-benchmarks.js --cleanup                  remove the rows the preparation added
//   node performance/run-benchmarks.js --restore-final-indexes    apply database/indexes/*.sql
//
// Protocol: phase 0 drops every index of the final set (names read from the index files), runs
// ANALYZE and measures; phase 1 applies the index files, runs ANALYZE and measures again. Per
// statement: one checksum execution (row count + md5 of the sorted rows), one discarded warm-up
// and `runs` timed EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) runs; buffers are those of the median
// run. Nothing persists: writes roll back, and the final index set is applied at the end.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { SCALES } from '../fixtures/generate-volume-data.js';
import {
  SETTINGS,
  SLICES,
  VOLUME_BASE,
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
  prepareQueries,
  readIndexSet,
  resultChecksum,
  undoPrepare,
} from './benchmarks.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEED = 20260101;
const IMPROVE_BUFFERS = 0.9; // "at least 10% fewer buffers"
const DOC_TOLERANCE = 0.25;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

function parseArgs(argv) {
  const o = {
    scale: 'medium',
    phase: 'both',
    runs: 5,
    out: path.join(here, 'results'),
    seed: DEFAULT_SEED,
    writeCost: true,
    keepPrep: false,
    cleanup: false,
    restore: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scale') o.scale = argv[++i];
    else if (a === '--phase') o.phase = argv[++i];
    else if (a === '--runs') o.runs = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i] === 'none' ? null : path.resolve(argv[i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--no-write-cost') o.writeCost = false;
    else if (a === '--keep-prep') o.keepPrep = true;
    else if (a === '--cleanup') o.cleanup = true;
    else if (a === '--restore-final-indexes') o.restore = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!['baseline', 'indexed', 'both'].includes(o.phase))
    throw new Error('--phase: baseline, indexed or both');
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs must be a positive integer');
  return o;
}

async function rowCounts(client) {
  const { rows } = await client.query(
    `SELECT table_name AS t,
            (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS n
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

async function assertTriggersEnabled(client) {
  const { rows } = await client.query(
    `SELECT tgrelid::regclass::text AS tbl, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'`,
  );
  if (rows.length > 0) {
    throw new Error(`Disabled triggers: ${rows.map((r) => `${r.tbl}.${r.tgname}`).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------------------------

export async function measureStatement(client, sql, runs) {
  const { rows, checksum } = await resultChecksum(client, sql);
  const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
  await client.query(explain); // warm-up, discarded
  const timed = [];
  for (let k = 0; k < runs; k++) {
    const doc = (await client.query(explain)).rows[0]['QUERY PLAN'][0];
    timed.push({ ms: doc['Execution Time'], plan: describePlan(doc.Plan) });
  }
  timed.sort((a, b) => a.ms - b.ms);
  const mid = timed[Math.floor(timed.length / 2)];
  return {
    topNode: mid.plan.topNode,
    scansByRelation: mid.plan.scansByRelation,
    indexesUsed: mid.plan.indexesUsed,
    rows,
    buffersHit: mid.plan.buffersHit,
    buffersRead: mid.plan.buffersRead,
    rowsRemovedByFilter: mid.plan.rowsRemovedByFilter,
    ms: { median: round(mid.ms), min: round(timed[0].ms), max: round(timed.at(-1).ms) },
    checksum,
  };
}

const buffersOf = (p) => p.buffersHit + p.buffersRead;

/** Measure every statement in the current index state. */
async function measureAll(client, params, runs, log) {
  const out = {};
  for (const slice of SLICES) {
    await prepareQueries(client, slice);
    for (const s of slice.statements) {
      const sql = fill(s.sql, params[slice.id]);
      out[`${slice.id}/${s.id}`] = await measureStatement(client, sql, runs);
      log(`  ${slice.id}/${s.id}`.padEnd(16) + ` ${out[`${slice.id}/${s.id}`].ms.median} ms`);
    }
  }
  return out;
}

function relOf(s, set) {
  if (s.rel) return s.rel;
  if (s.documented?.rel) return s.documented.rel;
  const name = [...(s.serves ?? []), ...(s.relatesTo ?? [])][0];
  return set.indexes.find((i) => i.name === name)?.table ?? null;
}

export function planLabel(phase, rel, keeps) {
  if (!phase) return '-';
  const nodes = (phase.scansByRelation[rel] ?? [phase.topNode]).join(' + ');
  const named = phase.indexesUsed.filter((n) => n.startsWith('idx_') || n === keeps);
  return named.length > 0 ? `${nodes} (${named.join(', ')})` : nodes;
}

function compare(s, set, base, idx) {
  const out = { rel: relOf(s, set), findings: [] };
  if (!base || !idx) return { ...out, speedup: null, verdict: null };
  // Differences of a couple of buffers on tiny plans are noise, not a change.
  const tiny = Math.abs(buffersOf(idx) - buffersOf(base)) <= 2;
  const bufRatio = tiny ? 1 : buffersOf(idx) / Math.max(buffersOf(base), 1);
  const timeRatio = idx.ms.median / Math.max(base.ms.median, 1e-6);
  const timeGain = timeRatio <= 0.8 && base.ms.median - idx.ms.median >= 0.5;
  let verdict;
  if (s.expect === 'unchanged') {
    verdict =
      bufRatio > IMPROVE_BUFFERS && bufRatio < 1 / IMPROVE_BUFFERS ? 'expected-unchanged' : null;
  }
  if (!verdict) {
    if (bufRatio <= IMPROVE_BUFFERS || timeGain) verdict = 'improved';
    else if (bufRatio >= 1 / IMPROVE_BUFFERS && timeRatio > 1.1) verdict = 'worse';
    else verdict = 'unchanged';
  }
  if (base.checksum !== idx.checksum || base.rows !== idx.rows) {
    out.findings.push({
      kind: 'result-differs',
      text: 'the result differs with the indexes (count or md5)',
    });
  }
  if (s.expect === 'improve') {
    const used = s.serves.filter((n) => idx.indexesUsed.includes(n));
    if (used.length === 0) {
      out.findings.push({
        kind: 'index-unused',
        owner: true,
        text: `none of ${s.serves.join(', ')} is used in the indexed plan`,
      });
    } else if (used.length < s.serves.length) {
      out.findings.push({
        kind: 'index-partly-unused',
        owner: true,
        text: `only ${used.join(', ')} of ${s.serves.join(', ')} is used`,
      });
    }
    if (s.mustImprove && !(bufRatio <= IMPROVE_BUFFERS)) {
      out.findings.push({
        kind: 'not-improved',
        owner: true,
        text: `buffers ${buffersOf(base)} -> ${buffersOf(idx)} (needs 10% fewer)`,
      });
    } else if (verdict === 'worse') {
      out.findings.push({
        kind: 'worse',
        owner: true,
        text: `slower and more buffers: ${buffersOf(base)} -> ${buffersOf(idx)}`,
      });
    }
  } else if (verdict !== 'expected-unchanged') {
    out.findings.push({
      kind: 'unexpected-change',
      owner: true,
      text: `expected unchanged, plan or buffers changed: ${buffersOf(base)} -> ${buffersOf(idx)} (${s.reason ?? ''})`,
    });
  }
  if (s.keepsIndex) {
    for (const [name, p] of [
      ['baseline', base],
      ['indexed', idx],
    ]) {
      if (!p.indexesUsed.includes(s.keepsIndex)) {
        out.findings.push({
          kind: 'constraint-index-unused',
          owner: true,
          text: `${s.keepsIndex} is not used in the ${name} plan`,
        });
      }
    }
  }
  if (s.documented) {
    for (const [name, p] of [
      ['baseline', base],
      ['indexed', idx],
    ]) {
      const doc = s.documented[name];
      const got = buffersOf(p);
      const nodes = p.scansByRelation[s.documented.rel] ?? [];
      const off = Math.abs(got - doc.buffers) / doc.buffers > DOC_TOLERANCE;
      const nodeOff = doc.node !== null && !nodes.some((n) => n === doc.node);
      if (off || nodeOff) {
        out.findings.push({
          kind: 'documented-differs',
          owner: true,
          text: `${name}: documented ${doc.node}, ${doc.buffers} buffers; measured ${nodes.join(' + ') || p.topNode}, ${got} buffers`,
        });
      }
    }
  }
  return {
    ...out,
    speedup: {
      buffers: round(buffersOf(base) / Math.max(buffersOf(idx), 1), 2),
      time: round(base.ms.median / Math.max(idx.ms.median, 1e-6), 2),
    },
    verdict,
  };
}

// ---------------------------------------------------------------------------------------------
// Write side (triggers enabled; every measurement rolls back)
// ---------------------------------------------------------------------------------------------

/** nextval() is not rolled back: remember every sequence so the rolled-back writes leave no trace. */
async function snapshotSequences(client) {
  const { rows } = await client.query(
    `SELECT format('%I.%I', schemaname, sequencename) AS name, start_value::text AS start, last_value::text AS last
       FROM pg_sequences WHERE schemaname = 'public'`,
  );
  return rows;
}

async function restoreSequences(client, snapshot) {
  for (const { name, start, last } of snapshot) {
    await client.query('SELECT setval($1::regclass, $2::bigint, $3)', [
      name,
      last ?? start,
      last !== null,
    ]);
  }
}

async function timeInRollback(client, setup, body, runs) {
  const times = [];
  const sequences = await snapshotSequences(client);
  let detail;
  for (let k = 0; k <= runs; k++) {
    await client.query('BEGIN');
    try {
      const ctx = await setup();
      const t0 = performance.now();
      detail = await body(ctx);
      const ms = performance.now() - t0;
      if (k > 0) times.push(ms); // run 0 is the warm-up
    } finally {
      await client.query('ROLLBACK');
      await restoreSequences(client, sequences);
    }
    await client.query('VACUUM audit_logs'); // rolled-back audit rows would otherwise pile up
  }
  return {
    ms: {
      median: round(median(times), 2),
      min: round(Math.min(...times), 2),
      max: round(Math.max(...times), 2),
    },
    detail,
  };
}

const BULK = [
  { table: 'project_members', sizes: [20000] },
  { table: 'collection_events', sizes: [20000] },
  { table: 'dna_extractions', sizes: [20000, 100000] },
  { table: 'sequencing_libraries', sizes: [20000, 100000] },
  { table: 'taxon_assignments', sizes: [20000, 100000] },
];

async function indexNamesOn(client, table) {
  const { rows } = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY 1`,
    [table],
  );
  return rows.map((r) => r.indexname);
}

async function bulkInsertCost(client, runs, log) {
  const out = [];
  for (const { table, sizes } of BULK) {
    const trig = await client.query(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`,
      [table, `trg_${table}_audit`],
    );
    const call = trig.rows[0]?.def.match(/EXECUTE FUNCTION (.*)$/)?.[1] ?? null; // audit_row_change('<pk>')
    const indexes = await indexNamesOn(client, table);
    for (const want of sizes) {
      const n = Math.min(
        want,
        (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,
      );
      const scratch = `bench_scratch_${table}`;
      const r = await timeInRollback(
        client,
        async () => {
          await client.query(`CREATE TABLE "${scratch}" (LIKE "${table}" INCLUDING ALL)`);
          if (call) {
            await client.query(
              `CREATE TRIGGER trg_bench_audit AFTER INSERT OR UPDATE OR DELETE ON "${scratch}" FOR EACH ROW EXECUTE FUNCTION ${call}`,
            );
          }
        },
        async () => {
          await client.query(`INSERT INTO "${scratch}" SELECT * FROM "${table}" LIMIT ${n}`);
          return (
            await client.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = $1`, [
              scratch,
            ])
          ).rows[0].n;
        },
        runs,
      );
      if (call && r.detail !== n)
        throw new Error(`${table}: expected ${n} audit rows from the trigger, got ${r.detail}`);
      out.push({
        id: `W1/${table}/${n}`,
        kind: 'bulk-insert',
        label: `INSERT ... SELECT of ${n} rows into a scratch copy of ${table}${call ? ' with its audit trigger' : ' (no audit trigger on this table)'}`,
        table,
        rows: n,
        auditRows: call ? r.detail : 0,
        indexesOnTable: indexes,
        ms: r.ms,
        msPer1000: round((r.ms.median / n) * 1000, 3),
      });
      log(`  ${table} ${n}: ${r.ms.median} ms`);
    }
  }
  for (const n of [20000, 100000]) {
    const indexes = await indexNamesOn(client, 'audit_logs');
    const r = await timeInRollback(
      client,
      async () => {},
      async () => {
        await client.query(
          `INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, details)
           SELECT actor_id, entity_type, entity_id, action, details FROM audit_logs LIMIT ${n}`,
        );
      },
      runs,
    );
    out.push({
      id: `W3/audit_logs/${n}`,
      kind: 'audit-insert',
      label: `INSERT of ${n} audit_logs rows (the cost every audited write pays)`,
      table: 'audit_logs',
      rows: n,
      auditRows: n,
      indexesOnTable: indexes,
      ms: r.ms,
      msPer1000: round((r.ms.median / n) * 1000, 3),
    });
    log(`  audit_logs ${n}: ${r.ms.median} ms`);
  }
  return out;
}

async function procedureCost(client, runs, log) {
  const out = [];
  const indexes = {
    samples: await indexNamesOn(client, 'samples'),
    sequencing_libraries: await indexNamesOn(client, 'sequencing_libraries'),
    taxon_assignments: await indexNamesOn(client, 'taxon_assignments'),
  };
  const events = (
    await client.query(
      `SELECT event_id::text AS id FROM collection_events WHERE event_id >= $1 ORDER BY event_id LIMIT 500`,
      [VOLUME_BASE],
    )
  ).rows.map((r) => r.id);
  const extractions = (
    await client.query(
      `SELECT extraction_id::text AS id FROM dna_extractions WHERE extraction_id >= $1 AND qc_status = 'pass' ORDER BY extraction_id LIMIT 500`,
      [VOLUME_BASE],
    )
  ).rows.map((r) => r.id);

  let r = await timeInRollback(
    client,
    async () => {},
    async () => {
      for (const id of events)
        await client.query('SELECT register_sample($1, 1, 10, 1, $2, 1)', [id, 'bench']);
    },
    runs,
  );
  out.push({
    id: 'W2/register_sample',
    kind: 'procedure',
    label: '500 x register_sample on volume events (audit + status-history triggers)',
    operations: events.length,
    indexesOnTable: indexes.samples,
    ms: r.ms,
    msPerOp: round(r.ms.median / events.length, 3),
  });
  log(`  register_sample: ${r.ms.median} ms`);

  r = await timeInRollback(
    client,
    async () => {},
    async () => {
      for (let k = 0; k + 5 <= extractions.length; k += 5) {
        await client.query(
          `SELECT create_sequencing_run(1, 'Illumina MiSeq', DATE '2026-01-01', $1::bigint[], 4)`,
          [`{${extractions.slice(k, k + 5).join(',')}}`],
        );
      }
    },
    runs,
  );
  out.push({
    id: 'W2/create_sequencing_run',
    kind: 'procedure',
    label: '100 x create_sequencing_run of 5 extractions (run + 5 libraries, audited)',
    operations: Math.floor(extractions.length / 5),
    indexesOnTable: indexes.sequencing_libraries,
    ms: r.ms,
    msPerOp: round(r.ms.median / Math.floor(extractions.length / 5), 3),
  });
  log(`  create_sequencing_run: ${r.ms.median} ms`);

  // 50 draft analyses (one per volume run) with 200 rows each (100 libraries x 2 taxa), created untimed in the transaction.
  const marker = (
    await client.query(
      `SELECT marker_id::text AS id FROM analysis_runs WHERE analysis_id >= $1 ORDER BY analysis_id LIMIT 1`,
      [VOLUME_BASE],
    )
  ).rows[0].id;
  const taxa = (
    await client.query(
      `SELECT taxon_id::text AS id FROM taxa WHERE taxon_id >= $1 ORDER BY taxon_id LIMIT 2`,
      [VOLUME_BASE],
    )
  ).rows.map((x) => x.id);
  const runIds = (
    await client.query(
      `SELECT run_id::text AS id FROM sequencing_runs WHERE run_id >= $1 ORDER BY run_id LIMIT 50`,
      [VOLUME_BASE],
    )
  ).rows.map((x) => x.id);
  const payloads = [];
  for (const runId of runIds) {
    const codes = (
      await client.query(
        `SELECT library_code FROM sequencing_libraries WHERE run_id = $1 ORDER BY library_id LIMIT 100`,
        [runId],
      )
    ).rows.map((x) => x.library_code);
    payloads.push(
      JSON.stringify(
        codes.flatMap((c) =>
          taxa.map((t) => ({
            library_code: c,
            taxon_id: Number(t),
            read_count: 100,
            confidence: 0.95,
            qc_flag: 'pass',
          })),
        ),
      ),
    );
  }
  r = await timeInRollback(
    client,
    async () => {
      const ids = [];
      for (const [k, runId] of runIds.entries()) {
        const row = await client.query(
          `INSERT INTO analysis_runs (run_id, marker_id, pipeline_name, pipeline_version, reference_db, status)
           VALUES ($1, $2, $3, '1', 'bench', 'draft') RETURNING analysis_id::text AS id`,
          [runId, marker, `bench-${k}`],
        );
        ids.push(row.rows[0].id);
      }
      return ids;
    },
    async (ids) => {
      for (const [k, id] of ids.entries())
        await client.query('SELECT import_detections($1, $2::jsonb, 5)', [id, payloads[k]]);
    },
    runs,
  );
  out.push({
    id: 'W2/import_detections',
    kind: 'procedure',
    label: `${runIds.length} x import_detections of ${payloads[0] ? JSON.parse(payloads[0]).length : 0} rows`,
    operations: runIds.length,
    indexesOnTable: indexes.taxon_assignments,
    ms: r.ms,
    msPerOp: round(r.ms.median / runIds.length, 3),
  });
  log(`  import_detections: ${r.ms.median} ms`);
  return out;
}

async function measureWrites(client, runs, log) {
  await assertTriggersEnabled(client);
  const before = Number((await client.query('SELECT count(*) AS n FROM audit_logs')).rows[0].n);
  const out = [
    ...(await bulkInsertCost(client, runs, log)),
    ...(await procedureCost(client, runs, log)),
  ];
  const after = Number((await client.query('SELECT count(*) AS n FROM audit_logs')).rows[0].n);
  if (after !== before)
    throw new Error(`audit_logs changed during the write measurements (${before} -> ${after})`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const f = (x) => (x >= 100 ? Math.round(x).toString() : x >= 1 ? x.toFixed(2) : x.toFixed(3));
const ratio = (x) => (x == null ? '-' : x >= 10 ? `${Math.round(x)}x` : `${x.toFixed(2)}x`);

function buildMarkdown(doc) {
  const h = doc.header;
  const L = [];
  L.push('# Benchmark results (T35)', '');
  L.push(
    `Generated by \`${h.command}\` on ${h.generatedAt}. Do not edit by hand; every number comes from \`benchmark-results.json\`.`,
    '',
  );
  L.push(`- Scale \`${h.scale}\` (seed ${h.seed}), ${h.postgres}`);
  L.push(
    `- Settings: ${Object.entries(h.settings)
      .map(([k, v]) => `${k} = ${v}`)
      .join(', ')}`,
  );
  L.push(
    `- Server: ${Object.entries(h.server)
      .map(([k, v]) => `${k} = ${v}`)
      .join(', ')}`,
  );
  L.push(
    `- Method: per statement one checksum run, one discarded warm-up and ${h.runs} timed runs of \`EXPLAIN (ANALYZE, BUFFERS)\`; the figures are the median run, all data warm in shared buffers. Buffers (shared hit + read) are the primary comparison, time is secondary and machine dependent.`,
  );
  L.push(
    `- Index set (read from \`database/indexes/*.sql\`): ${h.indexes.map((i) => `\`${i.name}\` on ${i.table} (${i.columns})`).join('; ')}`,
  );
  L.push(
    `- Prepared data (removed again at the end): ${h.prepared.measurements} environmental_measurements rows, ${h.prepared.approvals} analyses approved.`,
    '',
  );
  L.push(
    'Verdicts: `improved`, `unchanged` (a statement that was supposed to improve did not), `worse`, `expected-unchanged` (no index was supposed to help; the reason is listed). Factor = before / after.',
    '',
  );
  for (const slice of SLICES) {
    L.push(`## ${slice.ticket}: ${slice.title}`, '');
    L.push(
      '| id | query | rows | plan before -> after | buffers before -> after | ms before -> after | factor (buffers / ms) | verdict | documented |',
    );
    L.push('|---|---|---:|---|---|---|---|---|---|');
    for (const s of doc.statements.filter((x) => x.slice === slice.id)) {
      const b = s.phases.baseline;
      const i = s.phases.indexed;
      const bb = b ? b.buffersHit + b.buffersRead : null;
      const ib = i ? i.buffersHit + i.buffersRead : null;
      const docs = s.documented
        ? `${s.documented.baseline.buffers} -> ${s.documented.indexed.buffers}${s.findings.some((x) => x.kind === 'documented-differs') ? ' (differs)' : ''}`
        : '-';
      L.push(
        `| ${s.id} | ${s.label}${s.selectivity ? ` (${s.selectivity})` : ''} | ${(i ?? b).rows} | ${planLabel(b, s.rel, s.keepsIndex)} -> ${planLabel(i, s.rel, s.keepsIndex)} | ${bb ?? '-'} -> ${ib ?? '-'} | ${b ? f(b.ms.median) : '-'} -> ${i ? f(i.ms.median) : '-'} | ${s.speedup ? `${ratio(s.speedup.buffers)} / ${ratio(s.speedup.time)}` : '-'} | ${s.verdict ?? '-'} | ${docs} |`,
      );
    }
    L.push('');
    const why = doc.statements.filter((x) => x.slice === slice.id && x.expect === 'unchanged');
    if (why.length > 0) {
      L.push('Expected to stay unchanged:', '');
      for (const s of why) L.push(`- ${s.id}: ${s.reason}`);
      L.push('');
    }
  }
  if (doc.writeCost.length > 0) {
    L.push('## Write cost with the audit and status-history triggers enabled', '');
    L.push(
      'Every measurement runs in a transaction that is rolled back (bulk inserts go into a scratch copy that carries the same audit trigger, so `audit_logs` receives one row per inserted row). Median of the timed runs, ms.',
      '',
    );
    L.push(
      '| operation | rows / ops | baseline ms | indexed ms | multiplier | baseline per 1000 rows (or per op) | indexed per 1000 rows (or per op) |',
    );
    L.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const w of doc.writeCost) {
      L.push(
        `| ${w.label} | ${w.rows ?? w.operations} | ${f(w.baseline.ms.median)} | ${f(w.indexed.ms.median)} | ${ratio(w.multiplier)} | ${f(w.baseline.msPer1000 ?? w.baseline.msPerOp)} | ${f(w.indexed.msPer1000 ?? w.indexed.msPerOp)} |`,
      );
    }
    L.push('');
    L.push('### Cost against benefit per index', '');
    for (const line of doc.writeSummary) L.push(`- ${line}`);
    L.push('');
  }
  L.push('## Findings', '');
  if (doc.findings.length === 0) L.push('None.');
  for (const x of doc.findings)
    L.push(`- ${x.id} (${x.kind}${x.owner ? `, for ${x.owner}` : ''}): ${x.text}`);
  L.push('');
  L.push('## Reproduce', '');
  L.push(
    '```bash',
    'cd backend && npm run db:reset',
    `cd ../tests && npm run volume:load -- --scale ${h.scale}`,
    'npm run bench',
    'npm run bench -- --cleanup && npm run volume:clean',
    '```',
    '',
  );
  return L.join('\n');
}

const OWNER_OF_FILE = {
  'access_indexes.sql': 'A/Access',
  'analysis_indexes.sql': 'A/Analysis',
  'lab_indexes.sql': 'B/Lab',
  'field_indexes.sql': 'D/Field',
};

function summariseWrites(doc, set) {
  const lines = [];
  for (const idx of set.indexes) {
    const rowsOn = doc.writeCost.filter((w) => w.table === idx.table && w.rows === 20000);
    const w = rowsOn.find((x) => x.kind === 'bulk-insert') ?? rowsOn[0];
    const others = set.indexes
      .filter((i) => i.table === idx.table && i.name !== idx.name)
      .map((i) => i.name);
    const best = doc.statements
      .filter((s) => s.serves?.includes(idx.name) && s.speedup)
      .sort((a, b) => b.speedup.buffers - a.speedup.buffers)[0];
    if (!w || !best) continue;
    const verb = best.speedup.buffers > w.multiplier ? 'justified' : 'not clearly justified';
    lines.push(
      `\`${idx.name}\` (${idx.table}${others.length ? `, together with ${others.join(', ')}` : ''}): bulk insert of ${w.rows} rows ${f(w.baseline.ms.median)} -> ${f(w.indexed.ms.median)} ms (${ratio(w.multiplier)}, +${f(w.indexed.msPer1000 - w.baseline.msPer1000)} ms per 1000 rows); best read gain ${best.id} ${ratio(best.speedup.buffers)} fewer buffers, ${ratio(best.speedup.time)} faster; ${verb}.`,
    );
  }
  return lines;
}

function consoleTable(doc) {
  console.log(
    '\nid'.padEnd(18) +
      'rows'.padStart(8) +
      'buf before'.padStart(12) +
      'buf after'.padStart(11) +
      'ms before'.padStart(11) +
      'ms after'.padStart(10) +
      '  verdict',
  );
  for (const s of doc.statements) {
    const b = s.phases.baseline;
    const i = s.phases.indexed;
    console.log(
      `${s.slice}/${s.id}`.padEnd(18) +
        String((i ?? b).rows).padStart(8) +
        String(b ? buffersOf(b) : '-').padStart(12) +
        String(i ? buffersOf(i) : '-').padStart(11) +
        String(b ? f(b.ms.median) : '-').padStart(11) +
        String(i ? f(i.ms.median) : '-').padStart(10) +
        `  ${s.verdict ?? '-'}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function runBenchmarks(opts) {
  const log = (m) => console.log(m);
  const started = performance.now();
  const client = await openSession();
  const set = readIndexSet();
  let preparedAdded = false;
  let indexTouched = false;
  let sequencesAtStart = null;
  try {
    const volume = await checkVolume(client, opts.scale, SCALES);
    await assertTriggersEnabled(client);
    const countsBefore = await rowCounts(client);
    sequencesAtStart = await snapshotSequences(client);
    log(
      `Volume data: ${volume.samples} samples, ${volume.assignments} assignments, ${volume.audit} audit rows`,
    );
    log(`Index set: ${set.indexes.map((i) => i.name).join(', ')}`);

    preparedAdded = true;
    const prepared = await prepareData(client);
    log(
      `Prepared data: ${prepared.measurements} measurements, ${prepared.approvals} approved analyses`,
    );

    const server = {};
    for (const k of ['shared_buffers', 'work_mem', 'random_page_cost', 'effective_cache_size']) {
      server[k] = (await client.query(`SHOW ${k}`)).rows[0][k];
    }
    const settings = {};
    for (const [k] of SETTINGS) settings[k] = (await client.query(`SHOW ${k}`)).rows[0][k];
    const postgres = (await client.query('SELECT version() AS v')).rows[0].v.split(' on ')[0];

    // Parameters are looked up once (deterministic) and shared by both phases.
    const params = {};
    for (const slice of SLICES) {
      params[slice.id] = await lookupParams(client, slice);
    }

    const phases = opts.phase === 'both' ? ['baseline', 'indexed'] : [opts.phase];
    const measured = {};
    const writes = {};
    for (const phase of phases) {
      log(`\nPhase ${phase}`);
      indexTouched = true;
      if (phase === 'baseline') await dropFinalIndexes(client, set);
      else await createFinalIndexes(client, set);
      await assertIndexState(client, set, phase);
      await analyzeAll(client);
      measured[phase] = await measureAll(client, params, opts.runs, log);
      if (opts.writeCost) {
        log('Write cost (triggers enabled, rolled back)');
        writes[phase] = await measureWrites(client, opts.runs, log);
      }
    }

    // Restore the end state before anything is reported.
    await createFinalIndexes(client, set);
    await assertIndexState(client, set, 'indexed');
    await analyzeAll(client);
    indexTouched = false;
    if (!opts.keepPrep) {
      const removed = await undoPrepare(client);
      preparedAdded = false;
      log(
        `Removed the prepared data again: ${removed.measurements} measurements, ${removed.approvals} approvals`,
      );
    }
    const countsAfter = await rowCounts(client);
    if (!opts.keepPrep) {
      const diff = Object.keys(countsBefore).filter((t) => countsBefore[t] !== countsAfter[t]);
      if (diff.length > 0) throw new Error(`Row counts changed for ${diff.join(', ')}`);
    }
    await assertTriggersEnabled(client);

    const statements = [];
    const findings = [];
    for (const slice of SLICES) {
      for (const s of slice.statements) {
        const key = `${slice.id}/${s.id}`;
        const base = measured.baseline?.[key] ?? null;
        const idx = measured.indexed?.[key] ?? null;
        const cmp = compare(s, set, base, idx);
        const sql = fill(s.sql, params[slice.id]);
        statements.push({
          id: s.id,
          slice: slice.id,
          label: s.label,
          sql: s.sql,
          params: Object.fromEntries(
            [...s.sql.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], params[slice.id][m[1]]]),
          ),
          resolvedSql: sql,
          expect: s.expect,
          serves: s.serves ?? [],
          relatesTo: s.relatesTo ?? [],
          keepsIndex: s.keepsIndex ?? null,
          selectivity: s.selectivity,
          reason: s.reason ?? null,
          mustImprove: Boolean(s.mustImprove),
          documented: s.documented ?? null,
          rel: cmp.rel,
          phases: { baseline: base, indexed: idx },
          speedup: cmp.speedup,
          verdict: cmp.verdict,
          findings: cmp.findings,
        });
        for (const x of cmp.findings) {
          const file = set.indexes.find((i) =>
            [...(s.serves ?? []), ...(s.relatesTo ?? [])].includes(i.name),
          )?.file;
          findings.push({
            id: `${slice.id}/${s.id}`,
            kind: x.kind,
            owner: x.owner ? (OWNER_OF_FILE[file] ?? 'index owner') : undefined,
            text: x.text,
          });
        }
      }
    }
    const writeCost = [];
    if (writes.baseline && writes.indexed) {
      for (const b of writes.baseline) {
        const i = writes.indexed.find((x) => x.id === b.id);
        const side = (w) => ({
          ms: w.ms,
          msPer1000: w.msPer1000,
          msPerOp: w.msPerOp,
          indexesOnTable: w.indexesOnTable,
        });
        writeCost.push({
          id: b.id,
          kind: b.kind,
          label: b.label,
          table: b.table,
          rows: b.rows,
          operations: b.operations,
          auditRows: b.auditRows,
          baseline: side(b),
          indexed: side(i),
          multiplier: round(i.ms.median / b.ms.median, 2),
        });
      }
    }
    const doc = {
      header: {
        generatedAt: new Date().toISOString(),
        command: `node performance/run-benchmarks.js --scale ${opts.scale} --phase ${opts.phase} --runs ${opts.runs}`,
        scale: opts.scale,
        seed: opts.seed,
        postgres,
        settings,
        server,
        runs: opts.runs,
        durationSeconds: round((performance.now() - started) / 1000, 1),
        indexes: set.indexes.map(({ name, table, columns, file }) => ({
          name,
          table,
          columns,
          file,
        })),
        prepared,
        rowCountsUnchanged: !opts.keepPrep,
        volatileFields: [
          'header.generatedAt',
          'header.durationSeconds',
          'statements[].phases.*.ms',
          'statements[].speedup.time',
          'writeCost[].baseline.ms',
          'writeCost[].indexed.ms',
          'writeCost[].multiplier',
        ],
      },
      statements,
      writeCost,
      writeSummary: [],
      findings,
    };
    doc.writeSummary = summariseWrites(doc, set);

    if (opts.out) {
      fs.mkdirSync(opts.out, { recursive: true });
      // Written through Prettier so the committed files satisfy `npm run format` as generated.
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
      await emit('benchmark-results.json', JSON.stringify(doc, null, 2));
      await emit('benchmark-results.md', buildMarkdown(doc));
    }
    consoleTable(doc);

    const failures = [];
    for (const s of statements) {
      for (const x of s.findings)
        if (x.kind === 'result-differs') failures.push(`${s.slice}/${s.id}: ${x.text}`);
      if (
        s.mustImprove &&
        s.phases.baseline &&
        s.phases.indexed &&
        buffersOf(s.phases.indexed) / Math.max(buffersOf(s.phases.baseline), 1) > IMPROVE_BUFFERS
      ) {
        failures.push(
          `${s.slice}/${s.id}: buffers ${buffersOf(s.phases.baseline)} -> ${buffersOf(s.phases.indexed)} (not 10% fewer)`,
        );
      }
    }
    log(
      `\n${opts.out ? `Wrote ${path.join(opts.out, 'benchmark-results.json')} and .md` : 'Nothing written (--out none)'} in ${doc.header.durationSeconds} s; ${findings.length} finding(s).`,
    );
    return { doc, failures };
  } finally {
    // Whatever happened, leave the final index set applied and the added rows removed.
    if (indexTouched) {
      await createFinalIndexes(client, set).catch((e) =>
        console.error(`restore indexes: ${e.message}`),
      );
    }
    if (preparedAdded && !opts.keepPrep)
      await undoPrepare(client).catch((e) => console.error(`undo preparation: ${e.message}`));
    if (sequencesAtStart)
      await restoreSequences(client, sequencesAtStart).catch((e) =>
        console.error(`restore sequences: ${e.message}`),
      );
    await client.end();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cleanup) {
    const client = await openSession();
    try {
      console.log('Removed:', await undoPrepare(client));
    } finally {
      await client.end();
    }
    return;
  }
  if (opts.restore) {
    const client = await openSession();
    try {
      const set = readIndexSet();
      await createFinalIndexes(client, set);
      await assertIndexState(client, set, 'indexed');
      await analyzeAll(client);
      console.log(`Applied ${set.indexes.length} indexes from database/indexes/*.sql`);
    } finally {
      await client.end();
    }
    return;
  }
  const { failures } = await runBenchmarks(opts);
  if (failures.length > 0) {
    console.error(`\nFAILED:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
