// Owner: C (Testing & QA)
// Purpose: Keeps the detection CSV fixtures consistent with the seeded fixture world
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { closeTestPool, getPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = {
  valid: 'tests/fixtures/detections_valid.csv',
  invalid: 'tests/fixtures/detections_invalid_row.csv',
  starter: 'datasets/sample_detections.csv',
};
const COLUMNS = [
  'library_code',
  'scientific_name',
  'taxon_rank',
  'read_count',
  'confidence',
  'qc_flag',
];
const RANKS = ['domain', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];
const FLAGS = ['pass', 'warn', 'fail'];

// The fixtures contain no quoted fields or embedded commas (asserted below), so a plain split is enough.
function load(name) {
  const buffer = readFileSync(path.join(root, FILES[name]));
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  expect(lines.pop()).toBe(''); // trailing newline
  const header = lines.shift().split(',');
  const rows = lines.map((line) => {
    expect(line.includes('"') || line.includes('\r')).toBe(false);
    const f = line.split(',');
    return (
      Object.fromEntries(header.map((h, k) => [h, f[k]])) && {
        fields: f,
        ...Object.fromEntries(header.map((h, k) => [h, f[k]])),
      }
    );
  });
  return { buffer, text, header, rows };
}

afterAll(() => closeTestPool());

describe.each(Object.keys(FILES))('%s CSV format', (name) => {
  const file = load(name);

  it('is UTF-8 without BOM and under 10 MB', () => {
    expect(file.buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(statSync(path.join(root, FILES[name])).size).toBeLessThan(10 * 1024 * 1024);
  });

  it('has exactly the six contract columns and six fields per row', () => {
    expect([...file.header].sort()).toEqual([...COLUMNS].sort());
    for (const row of file.rows) expect(row.fields).toHaveLength(6);
  });

  it('has valid ranks, flags, read counts and confidences', () => {
    for (const row of file.rows) {
      expect(RANKS).toContain(row.taxon_rank);
      expect(FLAGS).toContain(row.qc_flag);
      expect(row.read_count).toMatch(/^\d+$/);
      const confidence = Number(row.confidence);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it('never repeats a library + taxon pair', () => {
    const keys = file.rows.map((r) => `${r.library_code}|${r.scientific_name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('known values of detections_valid.csv', () => {
  it('has 14 rows, 6 distinct taxa, 10 pass / 2 warn / 2 fail, 8 libraries', () => {
    const { rows } = load('valid');
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((r) => r.scientific_name)).size).toBe(6);
    const count = (flag) => rows.filter((r) => r.qc_flag === flag).length;
    expect([count('pass'), count('warn'), count('fail')]).toEqual([10, 2, 2]);
    expect(new Set(rows.map((r) => r.library_code)).size).toBe(8);
  });

  it.todo('imports cleanly into analysis 4 through import_detections()'); // T16-A, T32
  it.todo('invalid file is rejected with EB002 and leaves analysis 4 empty and draft'); // T16-A, T32
});

describe.skipIf(!dbAvailable)('fixtures against the seeded database', () => {
  const lookups = async (rows) => {
    const db = getPool();
    const libs = await db.query(
      'SELECT library_code, run_id FROM sequencing_libraries WHERE library_code = ANY($1)',
      [[...new Set(rows.map((r) => r.library_code))]],
    );
    const taxa = await db.query('SELECT scientific_name, rank::text AS rank FROM taxa');
    return {
      runOf: new Map(libs.rows.map((l) => [l.library_code, Number(l.run_id)])),
      taxa: new Set(taxa.rows.map((t) => `${t.scientific_name}|${t.rank}`)),
    };
  };

  it('analysis 4 is a draft on run 1 with no detections', async () => {
    const { rows } = await getPool().query(
      `SELECT a.run_id, a.status::text AS status, (SELECT count(*)::int FROM taxon_assignments t WHERE t.analysis_id = a.analysis_id) AS n
         FROM analysis_runs a WHERE a.analysis_id = 4`,
    );
    expect(rows[0]).toEqual({ run_id: '1', status: 'draft', n: 0 });
  });

  it.each(['valid', 'starter'])(
    '%s: every library is on run 1 and every taxon exists',
    async (name) => {
      const { rows } = load(name);
      const { runOf, taxa } = await lookups(rows);
      for (const row of rows) {
        expect(runOf.get(row.library_code), row.library_code).toBe(1);
        expect(taxa.has(`${row.scientific_name}|${row.taxon_rank}`), row.scientific_name).toBe(
          true,
        );
      }
    },
  );

  it('invalid: exactly one row breaks the library/run rule, at file row 8', async () => {
    const { rows } = load('invalid');
    const { runOf, taxa } = await lookups(rows);
    const bad = rows
      .map((row, k) => ({ row, fileRow: k + 2 })) // header is row 1
      .filter(({ row }) => runOf.get(row.library_code) !== 1);
    expect(bad).toHaveLength(1);
    expect(bad[0].fileRow).toBe(8);
    expect(bad[0].row.library_code).toBe('LIB-0009');
    for (const row of rows) expect(taxa.has(`${row.scientific_name}|${row.taxon_rank}`)).toBe(true);
  });

  it('invalid differs from valid in exactly one field of one row', () => {
    const valid = load('valid').rows;
    const invalid = load('invalid').rows;
    expect(invalid).toHaveLength(valid.length);
    const diffs = valid.flatMap((v, k) => v.fields.filter((f, j) => f !== invalid[k].fields[j]));
    expect(diffs).toHaveLength(1);
  });
});
