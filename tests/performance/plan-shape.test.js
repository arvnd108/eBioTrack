// Owner: C (Testing & QA)
// Purpose: Plan-shape guard: the final indexes are used where intended, results are identical with and without them, every index has a benchmark
//
// Self-contained: loads volume data at scale small (or uses the volume data already in the
// database), compares the database with and without the final index set, and puts everything back.
// It reads plans with EXPLAIN (FORMAT JSON) WITHOUT ANALYZE, so it asserts shape and equal
// results, never time. The minutes-long measurement is `npm run bench`.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SCALES, cleanVolumeData, loadVolumeData } from '../fixtures/generate-volume-data.js';
import { closeTestPool } from '../setup/testDb.js';
import {
  SLICES,
  VOLUME_BASE,
  analyzeAll,
  createFinalIndexes,
  dropFinalIndexes,
  fill,
  lookupParams,
  openSession,
  planShape,
  prepareData,
  prepareQueries,
  presentIndexes,
  readIndexSet,
  resultChecksum,
  undoPrepare,
} from './benchmarks.config.js';

const dbAvailable = inject('dbAvailable');
const set = readIndexSet();
const indexNames = set.indexes.map((i) => i.name);

// slice id/statement id -> { sql, withoutIndexes: {rows, checksum}, withIndexes: {rows, checksum, plan} }
const observed = new Map();
let scale = null;
let client = null;
let loadedByTest = false;
let hadIndexes = [];

/** The scale of volume data already in the database, or null when there is none. */
async function existingScale(c) {
  const { rows } = await c.query('SELECT count(*)::int AS n FROM samples WHERE sample_id >= $1', [
    VOLUME_BASE,
  ]);
  if (rows[0].n === 0) return null;
  const found = Object.entries(SCALES).find(
    ([, s]) => rows[0].n >= s.samples * 0.99 && rows[0].n <= s.samples * 1.01,
  );
  if (!found)
    throw new Error(
      `Volume data of an unknown scale is loaded (${rows[0].n} samples); run npm run volume:clean`,
    );
  return found[0];
}

describe.skipIf(!dbAvailable)('index plan shapes', () => {
  beforeAll(async () => {
    client = await openSession();
    hadIndexes = (await presentIndexes(client, indexNames)).map((i) => i.name);
    scale = await existingScale(client);
    if (!scale) {
      scale = 'small';
      await loadVolumeData({ scale, log: () => {} });
      loadedByTest = true;
    }
    await prepareData(client);

    const params = {};
    for (const slice of SLICES) params[slice.id] = await lookupParams(client, slice);

    // Without the final indexes, then with them: the same statements, results compared afterwards.
    for (const state of ['withoutIndexes', 'withIndexes']) {
      if (state === 'withoutIndexes') await dropFinalIndexes(client, set);
      else await createFinalIndexes(client, set);
      await analyzeAll(client);
      for (const slice of SLICES) {
        await prepareQueries(client, slice);
        for (const s of slice.statements) {
          const key = `${slice.id}/${s.id}`;
          const sql = fill(s.sql, params[slice.id]);
          const entry = observed.get(key) ?? { sql };
          entry[state] = await resultChecksum(client, sql);
          if (state === 'withIndexes') entry.plan = await planShape(client, sql);
          observed.set(key, entry);
        }
      }
    }
  }, 300_000);

  afterAll(async () => {
    if (!client) return;
    const problems = [];
    const attempt = async (what, fn) => {
      try {
        await fn();
      } catch (err) {
        problems.push(`${what}: ${err.message}`);
      }
    };
    // Put the index set back as it was before this file (the benchmark's own end state is "applied").
    await attempt('drop indexes', async () => {
      await dropFinalIndexes(client, set);
      if (hadIndexes.length > 0) await createFinalIndexes(client, set);
    });
    await attempt('undo preparation', () => undoPrepare(client));
    if (loadedByTest) await attempt('volume clean', () => cleanVolumeData());
    await attempt('close', () => client.end());
    await closeTestPool();
    // Fail loudly: a leftover would corrupt every suite that runs after this one.
    if (problems.length > 0) throw new Error(`Cleanup failed: ${problems.join('; ')}`);
  }, 300_000);

  it('the database holds all of the final index set or none of it', () => {
    // A hand-dropped index would otherwise be re-created below and go unnoticed.
    const missing =
      hadIndexes.length === 0 ? [] : indexNames.filter((n) => !hadIndexes.includes(n));
    expect(
      missing,
      `dropped from the database but defined in database/indexes/*.sql: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  describe('the final indexes are used where intended', () => {
    for (const slice of SLICES) {
      for (const s of slice.statements.filter((x) => x.expect === 'improve')) {
        it(`${slice.id}/${s.id} uses ${s.serves.join(' and ')}`, (ctx) => {
          // At small the planner may prefer a sequential scan; only the entries marked smallOk are meaningful there.
          if (scale === 'small' && !s.smallOk)
            ctx.skip(`${s.id} is only meaningful at scale medium`);
          const { plan } = observed.get(`${slice.id}/${s.id}`);
          const used = s.serves.filter((n) => plan.indexesUsed.includes(n));
          expect(used, `${s.id}: indexes used ${plan.indexesUsed.join(', ') || 'none'}`).toEqual(
            s.serves,
          );
        });
      }
    }
  });

  describe('redundancy and not-helped checks keep their plan', () => {
    for (const slice of SLICES) {
      for (const s of slice.statements.filter((x) => x.keepsIndex)) {
        it(`${slice.id}/${s.id} still uses ${s.keepsIndex}`, (ctx) => {
          if (scale === 'small' && !s.smallOk)
            ctx.skip(`${s.id} is only meaningful at scale medium`);
          const { plan } = observed.get(`${slice.id}/${s.id}`);
          expect(plan.indexesUsed).toContain(s.keepsIndex);
          // The statement is not supposed to be changed by the new indexes.
          expect(plan.indexesUsed.filter((n) => (s.relatesTo ?? []).includes(n))).toEqual([]);
        });
      }
    }
  });

  describe('results are identical with and without the indexes', () => {
    for (const slice of SLICES) {
      for (const s of slice.statements) {
        it(`${slice.id}/${s.id}`, () => {
          const o = observed.get(`${slice.id}/${s.id}`);
          expect(o.withIndexes.rows).toBe(o.withoutIndexes.rows);
          expect(o.withIndexes.checksum).toBe(o.withoutIndexes.checksum);
          // At small a date range can legitimately be empty; at medium an empty result would make the comparison meaningless.
          if (scale === 'medium')
            expect(o.withIndexes.rows, 'an empty result compares nothing').toBeGreaterThan(0);
        });
      }
    }
  });

  describe('every index has a benchmark (coverage guard)', () => {
    const statements = SLICES.flatMap((slice) => slice.statements);

    it.each(indexNames)('%s is served by a statement and has an unchanged-check', (name) => {
      expect(
        statements
          .filter((s) => s.expect === 'improve' && s.serves.includes(name))
          .map((s) => s.id),
        `${name} has no benchmark statement that it is supposed to improve (add one in benchmarks.config.js)`,
      ).not.toEqual([]);
      expect(
        statements
          .filter((s) => s.expect === 'unchanged' && (s.relatesTo ?? []).includes(name))
          .map((s) => s.id),
        `${name} has no statement that is expected not to change`,
      ).not.toEqual([]);
    });

    it('no statement names an index that is not in database/indexes/*.sql', () => {
      const known = new Set(indexNames);
      const named = statements.flatMap((s) => [...(s.serves ?? []), ...(s.relatesTo ?? [])]);
      expect(named.filter((n) => !known.has(n))).toEqual([]);
    });
  });
});
