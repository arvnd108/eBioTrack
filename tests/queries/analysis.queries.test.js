// Owner: C (Testing & QA)
// Purpose: Query results vs known fixtures: Analysis, Taxonomy & Analytics
//
// The governing rule (CONTRACT section 10): analytics use APPROVED analyses only and qc_flag = 'pass'
// only; richness counts species-rank taxa only. Expected values are derived by hand from
// database/seeds/040_seed_analysis.sql (with 020 and 030 for the library -> sample -> event -> site
// chain), compared with the committed prepared statement, with an oracle that filters in JavaScript
// over unfiltered base-table rows, and after rolled-back changes (all of them legal: draft analyses
// are filled, then approved through the real status path; detections are never inserted into an
// approved analysis). bigint/numeric are strings, int4 is a number, dates YYYY-MM-DD, timestamptz ISO.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  newAnalysis,
  newDetection,
  newEvent,
  newExtraction,
  newLibrary,
  newSample,
  newTaxon,
  updateRow,
} from '../setup/integrity.js';
import { acrossSettings, openQuerySession, TIME_ZONES } from '../setup/queries.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

// ---- Fixture world, as derived from the seeds ------------------------------------------------
// library n <- extraction n <- sample n (n <= 16); event of sample n = ceil(n / 2) (seed 020)
const SAMPLE_CODES = [
  'EB-20250515-0001-001', 'EB-20250515-0001-002', 'EB-20250518-0002-001', 'EB-20250518-0002-002',
  'EB-20250522-0003-001', 'EB-20250522-0003-002', 'EB-20260310-0004-001', 'EB-20260310-0004-002',
  'EB-20260312-0005-001', 'EB-20260312-0005-002', 'EB-20260315-0006-001', 'EB-20260315-0006-002',
  'EB-20260405-0007-001', 'EB-20260405-0007-002', 'EB-20260408-0008-001', 'EB-20260408-0008-002',
]; // prettier-ignore
const EVENT = {
  1: { site: 1, project: 1, at: '2025-05-15T08:30:00.000Z' },
  2: { site: 2, project: 1, at: '2025-05-18T09:15:00.000Z' },
  3: { site: 3, project: 1, at: '2025-05-22T07:45:00.000Z' },
  4: { site: 1, project: 1, at: '2026-03-10T08:00:00.000Z' },
  5: { site: 2, project: 1, at: '2026-03-12T09:30:00.000Z' },
  6: { site: 3, project: 1, at: '2026-03-15T08:15:00.000Z' },
  7: { site: 4, project: 2, at: '2026-04-05T10:00:00.000Z' },
  8: { site: 5, project: 2, at: '2026-04-08T11:30:00.000Z' },
};
const SITE_NAME = {
  1: 'Dakpathar Barrage',
  2: 'Okhla Barrage',
  3: 'Sangam Prayagraj',
  4: 'Diamond Harbour',
  5: 'Kakdwip Bay',
};
const eventOfLibrary = (library) => Math.ceil(library / 2);

// taxa: id -> [name, rank, parent]
const TAXA = {
  1: ['Animalia', 'kingdom', null],
  2: ['Chordata', 'phylum', 1],
  3: ['Actinopterygii', 'class', 2],
  4: ['Cypriniformes', 'order', 3],
  5: ['Cyprinidae', 'family', 4],
  6: ['Labeo', 'genus', 5],
  7: ['Labeo rohita', 'species', 6],
  8: ['Labeo calbasu', 'species', 6],
  9: ['Labeo bata', 'species', 6],
  10: ['Cirrhinus', 'genus', 5],
  11: ['Cirrhinus mrigala', 'species', 10],
  12: ['Cyprinus', 'genus', 5],
  13: ['Cyprinus carpio', 'species', 12],
  14: ['Gambusia', 'genus', 3],
  15: ['Gambusia affinis', 'species', 14],
};
const descendantsOf = (id) => {
  const out = [Number(id)];
  for (const [child, [, , parent]] of Object.entries(TAXA)) {
    if (parent === Number(id)) out.push(...descendantsOf(child));
  }
  return out;
};

// The 24 detections that analytics may use: analyses 1 and 2 (approved), qc_flag 'pass'.
// [assignment_id, analysis_id, library_id, taxon_id, read_count, confidence]
// Excluded by the rule: warn 11, 14, 36; fail 17, 28, 42, 43; all of analysis 3 (imported).
const PASS_DETECTIONS = [
  [1, 1, 1, 7, 18420, '0.9812'], [2, 1, 1, 8, 2310, '0.9340'], [3, 1, 2, 7, 15210, '0.9755'],
  [4, 1, 3, 7, 12480, '0.9677'], [5, 1, 3, 11, 6420, '0.9215'], [6, 1, 4, 7, 9860, '0.9602'],
  [7, 1, 4, 11, 5130, '0.9120'], [8, 1, 5, 7, 8810, '0.9544'], [9, 1, 5, 11, 4470, '0.9033'],
  [10, 1, 6, 7, 6390, '0.9420'], [12, 1, 7, 7, 22650, '0.9901'], [13, 1, 7, 8, 3120, '0.9482'],
  [15, 1, 8, 7, 19870, '0.9830'], [16, 1, 8, 8, 2750, '0.9411'],
  [18, 2, 9, 7, 17340, '0.9788'], [19, 2, 10, 7, 14020, '0.9731'], [20, 2, 11, 7, 10240, '0.9650'],
  [21, 2, 11, 11, 5560, '0.9150'], [22, 2, 12, 7, 7720, '0.9500'], [23, 2, 12, 11, 4890, '0.9080'],
  [24, 2, 13, 11, 3350, '0.9010'], [25, 2, 13, 7, 5120, '0.9380'], [26, 2, 14, 7, 4470, '0.9290'],
  [27, 2, 15, 7, 2150, '0.8820'],
]; // prettier-ignore

const TAXA_AT_SITE_COLUMNS = [
  'taxon_id',
  'scientific_name',
  'rank',
  'sample_count',
  'event_count',
  'detection_count',
  'first_detected',
  'last_detected',
  'max_confidence',
  'total_reads',
  'also_at_other_sites',
];
const RICHNESS_COLUMNS = [
  'site_id',
  'site_name',
  'year',
  'observed_taxa',
  'sample_count',
  'events_count',
  'change_vs_previous_year',
];
const HISTORY_COLUMNS = [
  'site_id',
  'site_name',
  'collected_at',
  'sample_code',
  'analysis_id',
  'taxon_id',
  'scientific_name',
  'rank',
  'read_count',
  'confidence',
  'qc_flag',
];
const LINEAGE_COLUMNS = ['taxon_id', 'scientific_name', 'rank', 'parent_taxon_id', 'depth'];
const DETECTION_VIEW_COLUMNS = [
  'assignment_id',
  'read_count',
  'confidence',
  'qc_flag',
  'taxon_id',
  'scientific_name',
  'rank',
  'parent_taxon_id',
  'analysis_id',
  'marker_id',
  'marker_name',
  'pipeline_name',
  'pipeline_version',
  'reference_db',
  'reference_db_version',
  'approved_at',
  'library_id',
  'library_code',
  'sample_id',
  'sample_code',
  'event_id',
  'collected_at',
  'project_id',
  'site_id',
  'site_name',
  'region_id',
  'habitat_type',
];
const RICHNESS_VIEW_COLUMNS = [
  'project_id',
  'site_id',
  'site_name',
  'year',
  'observed_taxa',
  'sample_count',
  'event_count',
];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const omit = (row, keys) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const scaled = (text) => BigInt(text.replace('.', '').padEnd(5, '0')); // numeric(5,4) -> integer

// Richness rows, seed: [site, year, observed_taxa, samples, events]
//  site 1 2025: species {7, 8} -> 2; samples 1, 2, 17 -> 3; 1 event.   2026: {7, 8} -> 2; samples 7, 8
//  site 2 2025: {7, 11} -> 2; 2026: {7} -> 1   (analysis 3 is imported, so libraries 9-10 give only 7)
//  site 3 2025: {7, 11} -> 2; 2026: {7, 11} -> 2
//  site 4 2026: {7, 11} -> 2; site 5 2026: {7} -> 1 (the only other hit is a `fail`)
const RICHNESS = [
  [1, 2025, 2, 3, 1],
  [1, 2026, 2, 2, 1],
  [2, 2025, 2, 2, 1],
  [2, 2026, 1, 2, 1],
  [3, 2025, 2, 2, 1],
  [3, 2026, 2, 2, 1],
  [4, 2026, 2, 2, 1],
  [5, 2026, 1, 2, 1],
];
// change_vs_previous_year: only when the previous calendar year is also a row of that site
const seedChange = (site, year, observed) => {
  const prev = RICHNESS.find((r) => r[0] === site && r[1] === year - 1);
  return prev ? String(observed - prev[2]) : null;
};
const richnessRow = ([site, year, observed, samples, events]) => ({
  site_id: String(site),
  site_name: SITE_NAME[site],
  year,
  observed_taxa: String(observed),
  sample_count: String(samples),
  events_count: String(events),
  change_vs_previous_year: seedChange(site, year, observed),
});

/** Move a draft/imported analysis to `approved` through the real path (importer 5, approver 2). */
async function approveAnalysis(db, analysisId, approvedAt = '2026-06-01T00:00:00Z') {
  await db.query(
    `UPDATE analysis_runs SET status = 'imported' WHERE analysis_id = $1 AND status = 'draft'`,
    [analysisId],
  );
  await db.query(
    `UPDATE analysis_runs SET status = 'approved', approved_by = 2, approved_at = $2 WHERE analysis_id = $1`,
    [analysisId, approvedAt],
  );
}

/** A new sample with a passing extraction and a library on run `runId`. */
async function sequencedSample(db, eventId, runId = 1) {
  const sample = await newSample(db, { event_id: eventId, status: 'stored' });
  const extraction = await newExtraction(db, { sample_id: sample.sample_id, qc_status: 'pass' });
  const library = await newLibrary(db, { extraction_id: extraction.extraction_id, run_id: runId });
  return { sample, extraction, library };
}

describe.skipIf(!dbAvailable)('analysis queries', () => {
  let s;
  beforeAll(async () => {
    s = await openQuerySession('analysis');
  });
  afterAll(async () => {
    await s?.close();
    await closeTestPool();
  });

  // Unfiltered detections with their chain, straight from base tables (comma joins, no status or
  // flag predicate): the oracles below apply the analytics rule in JavaScript.
  const allDetections = () =>
    s.sql(
      `SELECT ta.assignment_id, ta.analysis_id, ta.qc_flag, ta.read_count, ta.confidence, ta.taxon_id,
              ar.status AS analysis_status, t.scientific_name, t.rank, sa.sample_id, sa.sample_code,
              ce.event_id, ce.site_id, ce.project_id, ce.collected_at, si.name AS site_name
         FROM taxon_assignments ta, analysis_runs ar, taxa t, sequencing_libraries sl,
              dna_extractions de, samples sa, collection_events ce, sampling_sites si
        WHERE ar.analysis_id = ta.analysis_id AND t.taxon_id = ta.taxon_id
          AND sl.library_id = ta.library_id AND de.extraction_id = sl.extraction_id
          AND sa.sample_id = de.sample_id AND ce.event_id = sa.event_id AND si.site_id = ce.site_id`,
    );
  const usable = (rows) =>
    rows.filter((r) => r.analysis_status === 'approved' && r.qc_flag === 'pass');
  const utcDate = (iso) => iso.slice(0, 10);

  // ------------------------------------------------------------------------------------------
  describe('analysis: analysis_taxa_at_site', () => {
    const row = (taxon, c) => ({
      taxon_id: String(taxon),
      scientific_name: TAXA[taxon][0],
      rank: TAXA[taxon][1],
      sample_count: c[0],
      event_count: c[1],
      detection_count: c[2],
      first_detected: c[3],
      last_detected: c[4],
      max_confidence: c[5],
      total_reads: c[6],
      also_at_other_sites: c[7],
    });
    // Derivations are in the comments of PASS_DETECTIONS' consumers:
    //  site 1 (libraries 1, 2, 7, 8): taxon 7 in a1 a3 a12 a15 = 4 detections on samples 1, 2, 7, 8;
    //    reads 18420 + 15210 + 22650 + 19870 = 76150; max .9901. taxon 8 in a2 a13 a16: samples 1, 7, 8,
    //    reads 2310 + 3120 + 2750 = 8180; max .9482; taxon 8 is not found at any other site.
    //  site 2 (3, 4, 9, 10): taxon 7 a4 a6 a18 a19, reads 53700, max .9788; taxon 11 a5 a7, reads 11550.
    //  site 3 (5, 6, 11, 12): taxon 7 a8 a10 a20 a22, reads 33160; taxon 11 a9 a21 a23, reads 14920.
    //  site 4 (13, 14): taxon 7 a25 a26, reads 9590; taxon 11 a24 3350.   site 5 (15): taxon 7 a27 2150.
    const SITE = {
      1: [
        row(7, ['4', '2', '4', '2025-05-15', '2026-03-10', '0.9901', '76150', true]),
        row(8, ['3', '2', '3', '2025-05-15', '2026-03-10', '0.9482', '8180', false]),
      ],
      2: [
        row(7, ['4', '2', '4', '2025-05-18', '2026-03-12', '0.9788', '53700', true]),
        row(11, ['2', '1', '2', '2025-05-18', '2025-05-18', '0.9215', '11550', true]),
      ],
      3: [
        row(7, ['4', '2', '4', '2025-05-22', '2026-03-15', '0.9650', '33160', true]),
        row(11, ['3', '2', '3', '2025-05-22', '2026-03-15', '0.9150', '14920', true]),
      ],
      4: [
        row(7, ['2', '1', '2', '2026-04-05', '2026-04-05', '0.9380', '9590', true]),
        row(11, ['1', '1', '1', '2026-04-05', '2026-04-05', '0.9010', '3350', true]),
      ],
      5: [row(7, ['1', '1', '1', '2026-04-08', '2026-04-08', '0.8820', '2150', true])],
    };

    // Oracle: filter and group in JavaScript from the unfiltered rows.
    async function oracleTaxa(site, project, from, to) {
      const all = usable(await allDetections());
      const here = all.filter(
        (r) =>
          r.site_id === String(site) &&
          (project === null || r.project_id === String(project)) &&
          (from === null || utcDate(r.collected_at) >= from) &&
          (to === null || utcDate(r.collected_at) <= to),
      );
      const groups = new Map();
      for (const r of here) groups.set(r.taxon_id, [...(groups.get(r.taxon_id) ?? []), r]);
      return [...groups.values()]
        .map((list) => {
          const dates = list.map((r) => utcDate(r.collected_at)).sort();
          const conf = list.map((r) => r.confidence).sort((a, b) => cmp(scaled(a), scaled(b)));
          return {
            taxon_id: list[0].taxon_id,
            scientific_name: list[0].scientific_name,
            rank: list[0].rank,
            sample_count: String(new Set(list.map((r) => r.sample_id)).size),
            event_count: String(new Set(list.map((r) => r.event_id)).size),
            detection_count: String(list.length),
            first_detected: dates[0],
            last_detected: dates.at(-1),
            max_confidence: conf.at(-1),
            total_reads: String(list.reduce((n, r) => n + r.read_count, 0)),
            also_at_other_sites: all.some(
              (o) => o.taxon_id === list[0].taxon_id && o.site_id !== String(site),
            ),
          };
        })
        .sort(
          (a, b) =>
            Number(b.sample_count) - Number(a.sample_count) ||
            cmp(a.scientific_name, b.scientific_name) ||
            Number(a.taxon_id) - Number(b.taxon_id),
        );
    }

    // A. golden
    it.each([1, 2, 3, 4, 5])('site %i -> the hand-derived taxa', async (site) => {
      await acrossSettings(
        s,
        async () => {
          expect(await s.execute('analysis_taxa_at_site', [site, null, null, null])).toEqual(
            SITE[site],
          );
        },
        { zones: TIME_ZONES },
      );
    });
    it('site 1 from 2026-01-01 -> only event 4: tie on sample_count 2 is ordered by name (calbasu first)', async () => {
      // event 4 holds samples 7, 8 (libraries 7, 8): taxon 7 a12 a15 reads 42520; taxon 8 a13 a16 reads 5870
      expect(await s.execute('analysis_taxa_at_site', [1, null, '2026-01-01', null])).toEqual([
        row(8, ['2', '1', '2', '2026-03-10', '2026-03-10', '0.9482', '5870', false]),
        row(7, ['2', '1', '2', '2026-03-10', '2026-03-10', '0.9901', '42520', true]),
      ]);
    });
    it('site 1 up to 2025-12-31 -> only event 1: taxon 7 on samples 1, 2; taxon 8 on sample 1', async () => {
      expect(await s.execute('analysis_taxa_at_site', [1, null, null, '2025-12-31'])).toEqual([
        row(7, ['2', '1', '2', '2025-05-15', '2025-05-15', '0.9812', '33630', true]),
        row(8, ['1', '1', '1', '2025-05-15', '2025-05-15', '0.9340', '2310', false]),
      ]);
    });

    // B. oracle: every site x project x date window
    it('every site, project and date window equals the oracle', async () => {
      const windows = [
        [null, null],
        ['2025-05-15', '2025-05-15'],
        ['2025-05-16', '2026-03-09'],
        ['2026-01-01', null],
        [null, '2025-12-31'],
        ['2026-03-12', '2026-04-05'],
      ];
      for (const site of [1, 2, 3, 4, 5, 6]) {
        for (const project of [null, 1, 2, 3]) {
          for (const [from, to] of windows) {
            expect(
              await s.execute('analysis_taxa_at_site', [site, project, from, to]),
              `${site} ${project} ${from} ${to}`,
            ).toEqual(await oracleTaxa(site, project, from, to));
          }
        }
      }
    });

    // C. filters
    it('unknown site, a NULL site and a mismatching project -> zero rows', async () => {
      expect(await s.execute('analysis_taxa_at_site', [999, null, null, null])).toEqual([]);
      expect(await s.execute('analysis_taxa_at_site', [null, null, null, null])).toEqual([]);
      expect(await s.execute('analysis_taxa_at_site', [1, 2, null, null])).toEqual([]);
      expect(await s.execute('analysis_taxa_at_site', [4, 1, null, null])).toEqual([]);
      expect(await s.execute('analysis_taxa_at_site', [4, 2, null, null])).toEqual(SITE[4]);
    });
    it('date bounds are inclusive: the event day itself is in, the day before/after is out', async () => {
      const day = async (from, to) =>
        (await s.execute('analysis_taxa_at_site', [1, null, from, to])).length;
      expect(await day('2026-03-10', '2026-03-10')).toBe(2); // event 4 only
      expect(await day('2026-03-11', null)).toBe(0);
      expect(await day(null, '2026-03-09')).toBe(2); // event 1 only
      expect(await day('2025-05-16', '2026-03-09')).toBe(0);
      expect(await day('2026-03-10', '2025-05-15')).toBe(0); // inverted window
    });
    it('a window split at the year boundary partitions the detections of a site', async () => {
      const early = await s.execute('analysis_taxa_at_site', [1, null, null, '2025-12-31']);
      const late = await s.execute('analysis_taxa_at_site', [1, null, '2026-01-01', null]);
      const total = (rows, id) =>
        rows.filter((r) => r.taxon_id === id).reduce((n, r) => n + Number(r.detection_count), 0);
      for (const id of ['7', '8']) {
        expect(total(early, id) + total(late, id)).toBe(total(SITE[1], id));
      }
    });

    // D. metamorphic (analytics rule)
    it('a pass detection in the DRAFT analysis 4 changes nothing', async () => {
      await s.rollback(async (db) => {
        await newDetection(db, { analysis_id: 4, library_id: 1, taxon_id: 13, qc_flag: 'pass' });
        await newDetection(db, { analysis_id: 4, library_id: 2, taxon_id: 7, qc_flag: 'pass' });
        for (const site of [1, 2, 3, 4, 5]) {
          expect(await s.execute('analysis_taxa_at_site', [site, null, null, null])).toEqual(
            SITE[site],
          );
        }
      });
    });
    it('warn and fail detections of a new analysis are ignored even after it is approved; pass ones count', async () => {
      await s.rollback(async (db) => {
        const x = await newAnalysis(db, { run_id: 1 }); // draft on run 1: libraries 1-8
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 1,
          taxon_id: 9,
          qc_flag: 'pass',
          read_count: 500,
          confidence: '0.9990',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 1,
          taxon_id: 13,
          qc_flag: 'fail',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 7,
          taxon_id: 13,
          qc_flag: 'warn',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 7,
          taxon_id: 6,
          qc_flag: 'pass',
          read_count: 40,
          confidence: '0.8000',
        });
        expect(await s.execute('analysis_taxa_at_site', [1, null, null, null])).toEqual(SITE[1]); // still a draft
        await approveAnalysis(db, x.analysis_id);
        const rows = await s.execute('analysis_taxa_at_site', [1, null, null, null]);
        // new rows: species 9 (sample 1) and genus 6 (sample 7), both sample_count 1; 13 (fail/warn) absent
        expect(rows.map((r) => r.taxon_id)).toEqual(['7', '8', '6', '9']);
        expect(rows[2]).toEqual(
          row(6, ['1', '1', '1', '2026-03-10', '2026-03-10', '0.8000', '40', false]),
        );
        expect(rows[3]).toEqual(
          row(9, ['1', '1', '1', '2025-05-15', '2025-05-15', '0.9990', '500', false]),
        );
        expect(rows.slice(0, 2)).toEqual(SITE[1]);
        expect(rows).toEqual(await oracleTaxa(1, null, null, null));
      });
    });
    it('approving the imported analysis 3 adds its pass detections: site 4 gains taxon 15 and counts', async () => {
      await s.rollback(async (db) => {
        expect(await s.execute('analysis_taxa_at_site', [4, null, null, null])).toEqual(SITE[4]);
        await approveAnalysis(db, 3);
        // site 4 (libraries 13, 14): taxon 15 a37 a39 (reads 9410, max .9470); taxon 7 gains a40 (1260,
        // .8310); taxon 11 gains a38 (2170, .8860). Sample counts: 15 -> 2, 7 -> 2, 11 -> 1
        // (name order inside the tie of 2: Gambusia affinis before Labeo rohita).
        expect(await s.execute('analysis_taxa_at_site', [4, null, null, null])).toEqual([
          row(15, ['2', '1', '2', '2026-04-05', '2026-04-05', '0.9470', '9410', true]),
          row(7, ['2', '1', '3', '2026-04-05', '2026-04-05', '0.9380', '10850', true]),
          row(11, ['1', '1', '2', '2026-04-05', '2026-04-05', '0.9010', '5520', true]),
        ]);
        expect(await s.execute('analysis_taxa_at_site', [4, null, null, null])).toEqual(
          await oracleTaxa(4, null, null, null),
        );
        // site 1 is untouched (analysis 3 has no library of run 1)
        expect(await s.execute('analysis_taxa_at_site', [1, null, null, null])).toEqual(SITE[1]);
      });
    });
    it('superseding analysis 1 (by an approved correction) removes its detections from site 1', async () => {
      await s.rollback(async (db) => {
        await newAnalysis(db, { run_id: 1, status: 'approved', supersedes_analysis_id: 1 });
        await updateRow(db, 'analysis_runs', 'analysis_id', 1, { status: 'superseded' });
        expect(await s.execute('analysis_taxa_at_site', [1, null, null, null])).toEqual([]);
        expect(
          (await s.execute('analysis_taxa_at_site', [2, null, null, null])).map((r) => [
            r.taxon_id,
            r.detection_count,
          ]),
        ).toEqual([
          ['7', '2'], // only analysis 2's libraries 9, 10 remain
        ]);
        expect(await s.execute('analysis_taxa_at_site', [5, null, null, null])).toEqual(SITE[5]);
      });
    });
    it('UTC day boundaries: an event at 2026-01-01 00:30Z counts as 2026-01-01 in every session zone', async () => {
      await s.rollback(async (db) => {
        const x = await newAnalysis(db, { run_id: 1 });
        const mk = async (at) => {
          const e = await newEvent(db, { project_id: 1, site_id: 1, collected_at: at });
          const { sample, library } = await sequencedSample(db, e.event_id);
          await newDetection(db, {
            analysis_id: x.analysis_id,
            library_id: library.library_id,
            taxon_id: 7,
            read_count: 10,
            confidence: '0.5000',
          });
          return sample.sample_id;
        };
        await mk('2025-12-31T23:30:00Z');
        await mk('2026-01-01T00:30:00Z');
        await approveAnalysis(db, x.analysis_id);
        await acrossSettings(
          s,
          async (label) => {
            const q = async (from, to) =>
              (await s.execute('analysis_taxa_at_site', [1, null, from, to])).find(
                (r) => r.taxon_id === '7',
              )?.detection_count;
            // 2025-12-31T23:30Z is Dec 31 in UTC (Jan 1 in Kolkata/Kiritimati); 2026-01-01T00:30Z is Jan 1
            expect(await q('2025-12-31', '2025-12-31'), label).toBe('1');
            expect(await q('2026-01-01', '2026-01-01'), label).toBe('1');
            expect(await q(null, '2025-12-31'), label).toBe('3'); // events 1 + this one -> 2 + 1 detections of taxon 7
            expect(await q('2026-01-01', null), label).toBe('3'); // event 4 (2) + the New Year one
          },
          { zones: TIME_ZONES },
        );
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('analysis_taxa_at_site', [1, null, null, null]);
      expect(cols.map((c) => c.name)).toEqual(TAXA_AT_SITE_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        taxon_id: 'bigint',
        rank: 'taxon_rank',
        sample_count: 'bigint',
        first_detected: 'date',
        max_confidence: 'numeric',
        total_reads: 'bigint',
        also_at_other_sites: 'boolean',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes', async () => {
      const first = await s.execute('analysis_taxa_at_site', [2, null, null, null]);
      expect(await s.execute('analysis_taxa_at_site', [2, null, null, null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('analysis_taxa_at_site', [2, null, null, null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('analysis: analysis_richness_by_site_year', () => {
    const SEED_ROWS = RICHNESS.map(richnessRow);

    // Oracle: effort and detections counted in JavaScript from unfiltered rows.
    async function oracleRichness(
      project,
      site,
      yearFrom,
      yearTo,
      { passOnly = true, approvedOnly = true, speciesOnly = true } = {},
    ) {
      const samples = await s.sql(
        `SELECT sa.sample_id, ce.event_id, ce.site_id, ce.project_id, ce.collected_at, si.name AS site_name
           FROM samples sa, collection_events ce, sampling_sites si
          WHERE ce.event_id = sa.event_id AND si.site_id = ce.site_id`,
      );
      const inScope = (r) => {
        const year = Number(r.collected_at.slice(0, 4));
        return (
          (project === null || r.project_id === String(project)) &&
          (site === null || r.site_id === String(site)) &&
          (yearFrom === null || year >= yearFrom) &&
          (yearTo === null || year <= yearTo)
        );
      };
      const detections = (await allDetections()).filter(
        (r) =>
          (!approvedOnly || r.analysis_status === 'approved') &&
          (!passOnly || r.qc_flag === 'pass') &&
          (!speciesOnly || r.rank === 'species') &&
          inScope(r),
      );
      const groups = new Map();
      for (const r of samples.filter(inScope)) {
        const key = `${r.site_id}|${r.collected_at.slice(0, 4)}`;
        const g = groups.get(key) ?? {
          site: r.site_id,
          name: r.site_name,
          year: Number(r.collected_at.slice(0, 4)),
          samples: new Set(),
          events: new Set(),
        };
        g.samples.add(r.sample_id);
        g.events.add(r.event_id);
        groups.set(key, g);
      }
      const rows = [...groups.values()]
        .sort((a, b) => Number(a.site) - Number(b.site) || a.year - b.year)
        .map((g) => ({
          site_id: g.site,
          site_name: g.name,
          year: g.year,
          observed_taxa: String(
            new Set(
              detections
                .filter(
                  (d) => d.site_id === g.site && Number(d.collected_at.slice(0, 4)) === g.year,
                )
                .map((d) => d.taxon_id),
            ).size,
          ),
          sample_count: String(g.samples.size),
          events_count: String(g.events.size),
        }));
      return rows.map((r, i) => {
        const prev = rows[i - 1];
        const consecutive = prev && prev.site_id === r.site_id && prev.year === r.year - 1;
        return {
          ...r,
          change_vs_previous_year: consecutive
            ? String(Number(r.observed_taxa) - Number(prev.observed_taxa))
            : null,
        };
      });
    }

    // A. golden
    it('(NULL, NULL, NULL, NULL) -> the eight site-years of the fixture world', async () => {
      await acrossSettings(
        s,
        async () => {
          expect(
            await s.execute('analysis_richness_by_site_year', [null, null, null, null]),
          ).toEqual(SEED_ROWS);
        },
        { zones: TIME_ZONES },
      );
      // spot checks of the literals: site 1 2025 has 3 samples (1, 2, 17) in 1 event
      expect(SEED_ROWS[0]).toMatchObject({
        site_id: '1',
        year: 2025,
        observed_taxa: '2',
        sample_count: '3',
        events_count: '1',
        change_vs_previous_year: null,
      });
      expect(SEED_ROWS[3]).toMatchObject({
        site_id: '2',
        year: 2026,
        observed_taxa: '1',
        change_vs_previous_year: '-1',
      });
    });
    it('project 2 -> sites 4 and 5 only; site 1 -> its two years with change 0', async () => {
      expect(await s.execute('analysis_richness_by_site_year', [2, null, null, null])).toEqual([
        SEED_ROWS[6],
        SEED_ROWS[7],
      ]);
      expect(await s.execute('analysis_richness_by_site_year', [null, 1, null, null])).toEqual([
        SEED_ROWS[0],
        SEED_ROWS[1],
      ]);
      expect(SEED_ROWS[1].change_vs_previous_year).toBe('0');
    });
    it('the analytics rule matters on this fixture: all-flags counts differ (site 1 2026 = 3, site 5 2026 = 2)', async () => {
      const loose = await oracleRichness(null, null, null, null, { passOnly: false });
      const get = (rows, site, year) =>
        rows.find((r) => r.site_id === String(site) && r.year === year).observed_taxa;
      expect(get(loose, 1, 2026)).toBe('3');
      expect(get(loose, 5, 2026)).toBe('2');
      const strict = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
      expect(get(strict, 1, 2026)).toBe('2');
      expect(get(strict, 5, 2026)).toBe('1');
    });

    // B. oracle
    it('every project x site x year window equals the oracle', async () => {
      for (const project of [null, 1, 2, 99]) {
        for (const site of [null, 1, 2, 4, 99]) {
          for (const [from, to] of [
            [null, null],
            [2025, 2025],
            [2026, 2026],
            [2026, null],
            [null, 2025],
            [2025, 2026],
            [2027, null],
            [2026, 2025],
          ]) {
            expect(
              await s.execute('analysis_richness_by_site_year', [project, site, from, to]),
              `${project} ${site} ${from} ${to}`,
            ).toEqual(await oracleRichness(project, site, from, to));
          }
        }
      }
    });

    // C. filters
    it('year bounds are inclusive; a gap in the filter blanks change_vs_previous_year', async () => {
      const r2026 = await s.execute('analysis_richness_by_site_year', [null, null, 2026, null]);
      expect(r2026).toHaveLength(5);
      expect(r2026.every((r) => r.year === 2026 && r.change_vs_previous_year === null)).toBe(true);
      const r2025 = await s.execute('analysis_richness_by_site_year', [null, null, null, 2025]);
      expect(r2025.map((r) => r.site_id)).toEqual(['1', '2', '3']);
      expect(await s.execute('analysis_richness_by_site_year', [null, null, 2027, null])).toEqual(
        [],
      );
      expect(await s.execute('analysis_richness_by_site_year', [99, null, null, null])).toEqual([]);
      expect(await s.execute('analysis_richness_by_site_year', [null, 99, null, null])).toEqual([]);
    });
    it('per-site results partition the unfiltered result', async () => {
      const all = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
      const parts = [];
      for (const id of [1, 2, 3, 4, 5])
        parts.push(...(await s.execute('analysis_richness_by_site_year', [null, id, null, null])));
      expect(parts).toEqual(all);
    });

    // D. metamorphic
    it('a pass detection in DRAFT analysis 4 changes no richness value', async () => {
      await s.rollback(async (db) => {
        await newDetection(db, { analysis_id: 4, library_id: 1, taxon_id: 13 });
        await newDetection(db, { analysis_id: 4, library_id: 13 - 12, taxon_id: 9 });
        expect(await s.execute('analysis_richness_by_site_year', [null, null, null, null])).toEqual(
          SEED_ROWS,
        );
      });
    });
    it('fail/warn/genus detections in a newly approved analysis do not raise richness; a pass species does', async () => {
      await s.rollback(async (db) => {
        const x = await newAnalysis(db, { run_id: 1 });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 1,
          taxon_id: 9,
          qc_flag: 'pass',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 1,
          taxon_id: 13,
          qc_flag: 'fail',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 7,
          taxon_id: 13,
          qc_flag: 'warn',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 7,
          taxon_id: 6,
          qc_flag: 'pass',
        }); // genus
        expect(await s.execute('analysis_richness_by_site_year', [null, null, null, null])).toEqual(
          SEED_ROWS,
        ); // draft
        await approveAnalysis(db, x.analysis_id);
        const rows = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
        // site 1 2025 gains species 9 (library 1 is on event 1): 2 -> 3, and 2026 stays 2 so the change becomes -1
        expect(rows[0]).toMatchObject({ site_id: '1', year: 2025, observed_taxa: '3' });
        expect(rows[1]).toMatchObject({
          site_id: '1',
          year: 2026,
          observed_taxa: '2',
          change_vs_previous_year: '-1',
        });
        expect(rows.slice(2)).toEqual(SEED_ROWS.slice(2));
        expect(rows).toEqual(await oracleRichness(null, null, null, null));
      });
    });
    it('approving the imported analysis 3: site 2 2026 = 2, site 4 2026 = 3, site 5 2026 = 2; sites 1 and 3 unchanged', async () => {
      await s.rollback(async (db) => {
        await approveAnalysis(db, 3);
        // libraries 9-16 gain: l9 {7, 15}, l10 {7, 15}, l11 {7, 11}, l12 {7}, l13 {15, 11}, l14 {15, 7}, l15 {15}
        const expected = SEED_ROWS.map((r) => ({ ...r }));
        const set = (site, year, n) => {
          expected.find((r) => r.site_id === String(site) && r.year === year).observed_taxa =
            String(n);
        };
        set(2, 2026, 2); // {7} + {7, 15}
        set(4, 2026, 3); // {7, 11} + {15}
        set(5, 2026, 2); // {7} + {15}
        // changes follow: site 2 2026 vs 2025 (2 -> 2) = 0
        expected.find((r) => r.site_id === '2' && r.year === 2026).change_vs_previous_year = '0';
        const rows = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
        expect(rows).toEqual(expected);
        expect(rows).toEqual(await oracleRichness(null, null, null, null));
      });
    });
    it('superseding analysis 1: observed_taxa falls to 0 on its site-years but the effort rows stay', async () => {
      await s.rollback(async (db) => {
        await newAnalysis(db, { run_id: 1, status: 'approved', supersedes_analysis_id: 1 });
        await updateRow(db, 'analysis_runs', 'analysis_id', 1, { status: 'superseded' });
        const rows = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
        expect(rows).toHaveLength(8);
        expect(rows.map((r) => r.observed_taxa)).toEqual(['0', '0', '0', '1', '0', '2', '2', '1']);
        // change: site 1 0 -> 0 = 0; site 2 0 -> 1 = +1; site 3 0 -> 2 = +2
        expect(rows.map((r) => r.change_vs_previous_year)).toEqual([
          null,
          '0',
          null,
          '1',
          null,
          '2',
          null,
          null,
        ]);
        expect(rows.map((r) => r.sample_count)).toEqual(SEED_ROWS.map((r) => r.sample_count));
      });
    });
    it('a site-year with a sample but no detection is listed with observed_taxa 0; a year gap blanks the change', async () => {
      await s.rollback(async (db) => {
        const e = await newEvent(db, {
          project_id: 1,
          site_id: 3,
          collected_at: '2023-02-01T00:00:00Z',
        });
        await newSample(db, { event_id: e.event_id });
        const rows = await s.execute('analysis_richness_by_site_year', [null, 3, null, null]);
        expect(
          rows.map((r) => [
            r.year,
            r.observed_taxa,
            r.sample_count,
            r.events_count,
            r.change_vs_previous_year,
          ]),
        ).toEqual([
          [2023, '0', '1', '1', null],
          [2025, '2', '2', '1', null], // 2024 is missing, so no change is reported
          [2026, '2', '2', '1', '0'],
        ]);
      });
    });
    it('an event without samples adds no effort row', async () => {
      await s.rollback(async (db) => {
        await newEvent(db, { project_id: 1, site_id: 2, collected_at: '2024-01-01T00:00:00Z' });
        expect(await s.execute('analysis_richness_by_site_year', [null, null, null, null])).toEqual(
          SEED_ROWS,
        );
      });
    });
    it('UTC year boundary: 2025-12-31T23:30Z is 2025 and 2026-01-01T00:30Z is 2026 in every session zone', async () => {
      await s.rollback(async (db) => {
        for (const at of ['2025-12-31T23:30:00Z', '2026-01-01T00:30:00Z']) {
          const e = await newEvent(db, { project_id: 2, site_id: 5, collected_at: at });
          await newSample(db, { event_id: e.event_id });
        }
        await acrossSettings(
          s,
          async (label) => {
            const rows = await s.execute('analysis_richness_by_site_year', [2, 5, null, null]);
            expect(
              rows.map((r) => [r.year, r.sample_count, r.events_count, r.change_vs_previous_year]),
              label,
            ).toEqual([
              [2025, '1', '1', null], // the Dec 31 event
              [2026, '3', '2', '1'], // event 8 (2 samples) + the Jan 1 event (1 sample); observed 1 vs 0
            ]);
            expect(rows[0].observed_taxa, label).toBe('0');
            expect(rows[1].observed_taxa, label).toBe('1');
          },
          { zones: TIME_ZONES },
        );
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('analysis_richness_by_site_year', [null, null, null, null]);
      expect(cols.map((c) => c.name)).toEqual(RICHNESS_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        site_id: 'bigint',
        year: 'integer',
        observed_taxa: 'bigint',
        sample_count: 'bigint',
        events_count: 'bigint',
        change_vs_previous_year: 'bigint',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes', async () => {
      const first = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
      expect(await s.execute('analysis_richness_by_site_year', [null, null, null, null])).toEqual(
        first,
      );
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(
            await s.execute('analysis_richness_by_site_year', [null, null, null, null]),
          ).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('analysis: analysis_taxon_detection_history', () => {
    const expectedRows = (taxa, { project = null, from = null, to = null } = {}) =>
      PASS_DETECTIONS.filter(([, , , taxon]) => taxa.includes(taxon))
        .map(([assignment, analysis, library, taxon, reads, conf]) => {
          const ev = EVENT[eventOfLibrary(library)];
          return {
            site_id: String(ev.site),
            site_name: SITE_NAME[ev.site],
            collected_at: ev.at,
            sample_code: SAMPLE_CODES[library - 1],
            analysis_id: String(analysis),
            taxon_id: String(taxon),
            scientific_name: TAXA[taxon][0],
            rank: TAXA[taxon][1],
            read_count: reads,
            confidence: conf,
            qc_flag: 'pass',
            assignment,
            project: ev.project,
          };
        })
        .filter(
          (r) =>
            (project === null || r.project === project) &&
            (from === null || r.collected_at.slice(0, 10) >= from) &&
            (to === null || r.collected_at.slice(0, 10) <= to),
        )
        .sort(
          (a, b) =>
            cmp(a.collected_at, b.collected_at) ||
            Number(a.site_id) - Number(b.site_id) ||
            cmp(a.scientific_name, b.scientific_name) ||
            cmp(a.sample_code, b.sample_code) ||
            Number(a.analysis_id) - Number(b.analysis_id),
        )
        .map((r) => omit(r, ['assignment', 'project']));

    // Oracle: descendants by repeated child lookups in the taxa table, filter/sort in JavaScript.
    async function oracleHistory(taxon, project, from, to) {
      const taxa = await s.sql(`SELECT taxon_id, parent_taxon_id FROM taxa`);
      const known = taxa.some((t) => t.taxon_id === String(taxon));
      const subtree = new Set(known ? [String(taxon)] : []);
      for (let grew = true; grew;) {
        grew = false;
        for (const t of taxa) {
          if (
            t.parent_taxon_id !== null &&
            subtree.has(t.parent_taxon_id) &&
            !subtree.has(t.taxon_id)
          ) {
            subtree.add(t.taxon_id);
            grew = true;
          }
        }
      }
      return usable(await allDetections())
        .filter(
          (r) =>
            subtree.has(r.taxon_id) &&
            (project === null || r.project_id === String(project)) &&
            (from === null || utcDate(r.collected_at) >= from) &&
            (to === null || utcDate(r.collected_at) <= to),
        )
        .map((r) => ({
          site_id: r.site_id,
          site_name: r.site_name,
          collected_at: r.collected_at,
          sample_code: r.sample_code,
          analysis_id: r.analysis_id,
          taxon_id: r.taxon_id,
          scientific_name: r.scientific_name,
          rank: r.rank,
          read_count: r.read_count,
          confidence: r.confidence,
          qc_flag: r.qc_flag,
        }))
        .sort(
          (a, b) =>
            cmp(a.collected_at, b.collected_at) ||
            Number(a.site_id) - Number(b.site_id) ||
            cmp(a.scientific_name, b.scientific_name) ||
            cmp(a.sample_code, b.sample_code) ||
            Number(a.analysis_id) - Number(b.analysis_id),
        );
    }

    // A. golden
    it('species 11 (Cirrhinus mrigala) -> six detections, in time order', async () => {
      // a5 (l3, 6420) a7 (l4, 5130) on event 2; a9 (l5, 4470) on event 3; a21 (l11, 5560) a23 (l12, 4890)
      // on event 6; a24 (l13, 3350) on event 7. Analyses: 1, 1, 1, 2, 2, 2.
      const rows = await s.execute('analysis_taxon_detection_history', [11, null, null, null]);
      expect(rows.map((r) => [r.sample_code, r.analysis_id, r.read_count, r.confidence])).toEqual([
        ['EB-20250518-0002-001', '1', 6420, '0.9215'],
        ['EB-20250518-0002-002', '1', 5130, '0.9120'],
        ['EB-20250522-0003-001', '1', 4470, '0.9033'],
        ['EB-20260315-0006-001', '2', 5560, '0.9150'],
        ['EB-20260315-0006-002', '2', 4890, '0.9080'],
        ['EB-20260405-0007-001', '2', 3350, '0.9010'],
      ]);
      expect(rows[0]).toEqual({
        site_id: '2',
        site_name: 'Okhla Barrage',
        collected_at: '2025-05-18T09:15:00.000Z',
        sample_code: 'EB-20250518-0002-001',
        analysis_id: '1',
        taxon_id: '11',
        scientific_name: 'Cirrhinus mrigala',
        rank: 'species',
        read_count: 6420,
        confidence: '0.9215',
        qc_flag: 'pass',
      });
      expect(rows).toEqual(expectedRows([11]));
    });
    it('species 7 (Labeo rohita) -> fifteen detections, one per library 1-15; species 8 -> three', async () => {
      await acrossSettings(s, async () => {
        const rows = await s.execute('analysis_taxon_detection_history', [7, null, null, null]);
        expect(rows).toHaveLength(15);
        expect(rows.map((r) => r.sample_code)).toEqual(SAMPLE_CODES.slice(0, 15));
        expect(rows).toEqual(expectedRows([7]));
      });
      expect(
        (await s.execute('analysis_taxon_detection_history', [8, null, null, null])).map(
          (r) => r.sample_code,
        ),
      ).toEqual(['EB-20250515-0001-001', 'EB-20260310-0004-001', 'EB-20260310-0004-002']);
    });
    it('a genus returns the detections of its species: Labeo = 18 (species 7: 15, species 8: 3, species 9: none)', async () => {
      const rows = await s.execute('analysis_taxon_detection_history', [6, null, null, null]);
      expect(rows).toHaveLength(18);
      expect(new Set(rows.map((r) => r.taxon_id))).toEqual(new Set(['7', '8']));
      // same collected_at and site: scientific_name decides before sample_code (calbasu, then rohita)
      expect(rows.slice(0, 3).map((r) => [r.scientific_name, r.sample_code])).toEqual([
        ['Labeo calbasu', 'EB-20250515-0001-001'],
        ['Labeo rohita', 'EB-20250515-0001-001'],
        ['Labeo rohita', 'EB-20250515-0001-002'],
      ]);
      expect(rows).toEqual(expectedRows([6, 7, 8, 9]));
    });
    it.each([
      [5, 24, 'family Cyprinidae: species 7 (15) + 8 (3) + 11 (6)'],
      [
        3,
        24,
        'class Actinopterygii: also Gambusia affinis, which only analysis 3 (imported) detects',
      ],
      [1, 24, 'kingdom Animalia'],
      [10, 6, 'genus Cirrhinus'],
    ])('taxon %i -> %i rows (%s)', async (taxon, count) => {
      const rows = await s.execute('analysis_taxon_detection_history', [taxon, null, null, null]);
      expect(rows).toHaveLength(count);
      expect(rows).toEqual(expectedRows(descendantsOf(taxon)));
    });
    it.each([
      [9, 'Labeo bata is never detected'],
      [13, 'Cyprinus carpio is never detected'],
      [12, 'genus Cyprinus has only an undetected species'],
      [15, 'Gambusia affinis is only in the imported analysis 3'],
      [14, 'genus Gambusia has only that species'],
      [999, 'unknown taxon'],
    ])('taxon %i -> zero rows (%s)', async (taxon) => {
      expect(
        await s.execute('analysis_taxon_detection_history', [taxon, null, null, null]),
      ).toEqual([]);
    });

    // B. oracle
    it('every taxon x project x window equals the oracle', async () => {
      for (const taxon of [1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 999]) {
        for (const project of [null, 1, 2]) {
          for (const [from, to] of [
            [null, null],
            ['2026-01-01', null],
            [null, '2025-12-31'],
            ['2026-03-12', '2026-04-05'],
          ]) {
            expect(
              await s.execute('analysis_taxon_detection_history', [taxon, project, from, to]),
              `${taxon} ${project} ${from} ${to}`,
            ).toEqual(await oracleHistory(taxon, project, from, to));
          }
        }
      }
    });

    // C. filters
    it('project filter: taxon 7 has 12 rows in project 1 and 3 in project 2; project 3 -> none', async () => {
      expect(await s.execute('analysis_taxon_detection_history', [7, 1, null, null])).toHaveLength(
        12,
      );
      expect(
        (await s.execute('analysis_taxon_detection_history', [7, 2, null, null])).map(
          (r) => r.sample_code,
        ),
      ).toEqual(['EB-20260405-0007-001', 'EB-20260405-0007-002', 'EB-20260408-0008-001']);
      expect(await s.execute('analysis_taxon_detection_history', [7, 3, null, null])).toEqual([]);
    });
    it('date bounds are inclusive and partition the history', async () => {
      const one = await s.execute('analysis_taxon_detection_history', [
        7,
        null,
        '2026-03-12',
        '2026-03-12',
      ]);
      expect(one.map((r) => r.sample_code)).toEqual([
        'EB-20260312-0005-001',
        'EB-20260312-0005-002',
      ]);
      const early = await s.execute('analysis_taxon_detection_history', [
        7,
        null,
        null,
        '2025-12-31',
      ]);
      const late = await s.execute('analysis_taxon_detection_history', [
        7,
        null,
        '2026-01-01',
        null,
      ]);
      expect([...early, ...late]).toEqual(
        await s.execute('analysis_taxon_detection_history', [7, null, null, null]),
      );
      expect(early).toHaveLength(6);
    });

    // D. metamorphic
    it('draft analysis 4 and warn/fail detections never appear; a new approved analysis adds its pass rows', async () => {
      await s.rollback(async (db) => {
        await newDetection(db, { analysis_id: 4, library_id: 1, taxon_id: 7 });
        const x = await newAnalysis(db, { run_id: 1 });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 2,
          taxon_id: 7,
          qc_flag: 'fail',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 3,
          taxon_id: 7,
          qc_flag: 'warn',
        });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: 4,
          taxon_id: 7,
          qc_flag: 'pass',
          read_count: 77,
          confidence: '0.7700',
        });
        expect(
          await s.execute('analysis_taxon_detection_history', [7, null, null, null]),
        ).toHaveLength(15); // draft
        await approveAnalysis(db, x.analysis_id);
        const rows = await s.execute('analysis_taxon_detection_history', [7, null, null, null]);
        expect(rows).toHaveLength(16);
        const added = rows.filter((r) => r.analysis_id === x.analysis_id);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
          sample_code: 'EB-20250518-0002-002',
          read_count: 77,
          confidence: '0.7700',
        });
        // same event and site, same taxon and sample code as analysis 1's row: ordered by analysis_id
        const same = rows.filter((r) => r.sample_code === 'EB-20250518-0002-002');
        expect(same.map((r) => r.analysis_id)).toEqual(['1', x.analysis_id]);
      });
    });
    it('approving the imported analysis 3 makes taxon 15 (and its genus) visible', async () => {
      await s.rollback(async (db) => {
        expect(await s.execute('analysis_taxon_detection_history', [15, null, null, null])).toEqual(
          [],
        );
        await approveAnalysis(db, 3);
        // analysis 3 pass rows of taxon 15: a30 (l9) a32 (l10) a37 (l13) a39 (l14) a41 (l15)
        const rows = await s.execute('analysis_taxon_detection_history', [15, null, null, null]);
        expect(rows.map((r) => [r.sample_code, r.analysis_id, r.read_count])).toEqual([
          ['EB-20260312-0005-001', '3', 2410],
          ['EB-20260312-0005-002', '3', 1890],
          ['EB-20260405-0007-001', '3', 5230],
          ['EB-20260405-0007-002', '3', 4180],
          ['EB-20260408-0008-001', '3', 3340],
        ]);
        expect(await s.execute('analysis_taxon_detection_history', [14, null, null, null])).toEqual(
          rows,
        );
        expect(await s.execute('analysis_taxon_detection_history', [3, null, null, null])).toEqual(
          await oracleHistory(3, null, null, null),
        );
      });
    });
    it('a taxon moved under another parent moves its detections into that subtree', async () => {
      await s.rollback(async (db) => {
        // species 11 re-parented from genus Cirrhinus (10) to genus Cyprinus (12)
        await updateRow(db, 'taxa', 'taxon_id', 11, { parent_taxon_id: 12 });
        expect(await s.execute('analysis_taxon_detection_history', [10, null, null, null])).toEqual(
          [],
        );
        expect(
          await s.execute('analysis_taxon_detection_history', [12, null, null, null]),
        ).toHaveLength(6);
        expect(
          await s.execute('analysis_taxon_detection_history', [6, null, null, null]),
        ).toHaveLength(18);
      });
    });

    // cycle safety: trg_taxa_tree now refuses loops and a child that does not rank below its parent, so
    // the tests that exercise the queries' own guards switch it off for their rolled-back transaction.
    async function chain(db) {
      const a = await newTaxon(db, { rank: 'family' });
      const b = await newTaxon(db, { rank: 'genus', parent_taxon_id: a.taxon_id });
      const c = await newTaxon(db, { rank: 'species', parent_taxon_id: b.taxon_id });
      const x = await newAnalysis(db, { run_id: 1 });
      await newDetection(db, { analysis_id: x.analysis_id, library_id: 1, taxon_id: b.taxon_id });
      await newDetection(db, { analysis_id: x.analysis_id, library_id: 2, taxon_id: c.taxon_id });
      await approveAnalysis(db, x.analysis_id);
      return { a, b, c };
    }
    it('a 3-level chain terminates: the root sees both descendants, the leaf only itself', async () => {
      await s.rollback(async (db) => {
        const { a, b, c } = await chain(db);
        const root = await s.execute('analysis_taxon_detection_history', [
          a.taxon_id,
          null,
          null,
          null,
        ]);
        expect(root.map((r) => r.taxon_id).sort()).toEqual([b.taxon_id, c.taxon_id].sort());
        expect(
          await s.execute('analysis_taxon_detection_history', [b.taxon_id, null, null, null]),
        ).toHaveLength(2);
        expect(
          (await s.execute('analysis_taxon_detection_history', [c.taxon_id, null, null, null])).map(
            (r) => r.taxon_id,
          ),
        ).toEqual([c.taxon_id]);
        expect(root).toHaveLength(2);
      });
    });
    it('a longer parent loop (A -> B -> C -> A) still terminates and returns each detection once', async () => {
      await s.rollback(async (db) => {
        const { a, b, c } = await chain(db);
        await db.query('ALTER TABLE taxa DISABLE TRIGGER trg_taxa_tree');
        await updateRow(db, 'taxa', 'taxon_id', a.taxon_id, { parent_taxon_id: c.taxon_id });
        for (const start of [a, b, c]) {
          const rows = await s.execute('analysis_taxon_detection_history', [
            start.taxon_id,
            null,
            null,
            null,
          ]);
          expect(rows.map((r) => r.taxon_id).sort(), `start ${start.taxon_id}`).toEqual(
            [b.taxon_id, c.taxon_id].sort(),
          );
        }
        // the lineage query stops too: ancestors root-first are B, C, then A; the loop is cut
        const lineage = await s.execute('analysis_taxon_lineage', [a.taxon_id]);
        expect(lineage.map((r) => r.taxon_id)).toEqual([b.taxon_id, c.taxon_id, a.taxon_id]);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('analysis_taxon_detection_history', [7, null, null, null]);
      expect(cols.map((c) => c.name)).toEqual(HISTORY_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        site_id: 'bigint',
        collected_at: 'timestamp with time zone',
        analysis_id: 'bigint',
        rank: 'taxon_rank',
        read_count: 'integer',
        confidence: 'numeric',
        qc_flag: 'qc_flag',
      });
    });

    // F. determinism
    it('identical on repeat, under both plan modes and in every session zone', async () => {
      const first = await s.execute('analysis_taxon_detection_history', [5, null, null, null]);
      expect(await s.execute('analysis_taxon_detection_history', [5, null, null, null])).toEqual(
        first,
      );
      await acrossSettings(
        s,
        async () => {
          expect(
            await s.execute('analysis_taxon_detection_history', [5, null, null, null]),
          ).toEqual(first);
        },
        { zones: TIME_ZONES },
      );
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('analysis: analysis_taxon_lineage', () => {
    const lineageOf = (id) => {
      const out = [];
      for (let cur = Number(id); cur !== null; cur = TAXA[cur][2]) out.unshift(cur);
      return out.map((taxon, depth) => ({
        taxon_id: String(taxon),
        scientific_name: TAXA[taxon][0],
        rank: TAXA[taxon][1],
        parent_taxon_id: TAXA[taxon][2] === null ? null : String(TAXA[taxon][2]),
        depth,
      }));
    };

    // A. golden: Labeo rohita is seven levels deep: kingdom (depth 0) down to species (depth 6)
    it('species 7 -> Animalia, Chordata, Actinopterygii, Cypriniformes, Cyprinidae, Labeo, Labeo rohita', async () => {
      const rows = await s.execute('analysis_taxon_lineage', [7]);
      expect(
        rows.map((r) => [r.taxon_id, r.scientific_name, r.rank, r.parent_taxon_id, r.depth]),
      ).toEqual([
        ['1', 'Animalia', 'kingdom', null, 0],
        ['2', 'Chordata', 'phylum', '1', 1],
        ['3', 'Actinopterygii', 'class', '2', 2],
        ['4', 'Cypriniformes', 'order', '3', 3],
        ['5', 'Cyprinidae', 'family', '4', 4],
        ['6', 'Labeo', 'genus', '5', 5],
        ['7', 'Labeo rohita', 'species', '6', 6],
      ]);
    });
    it('species 15 (Gambusia affinis) hangs off the class: 1, 2, 3, 14, 15 with depths 0-4', async () => {
      expect(
        (await s.execute('analysis_taxon_lineage', [15])).map((r) => [r.taxon_id, r.depth]),
      ).toEqual([
        ['1', 0],
        ['2', 1],
        ['3', 2],
        ['14', 3],
        ['15', 4],
      ]);
    });
    it('the root alone -> one row at depth 0 with a NULL parent; an unknown taxon -> zero rows', async () => {
      expect(await s.execute('analysis_taxon_lineage', [1])).toEqual([
        {
          taxon_id: '1',
          scientific_name: 'Animalia',
          rank: 'kingdom',
          parent_taxon_id: null,
          depth: 0,
        },
      ]);
      expect(await s.execute('analysis_taxon_lineage', [999])).toEqual([]);
      expect(await s.execute('analysis_taxon_lineage', [null])).toEqual([]);
    });

    // B. oracle: every taxon walks parent links in a plain loop
    it.each(Object.keys(TAXA).map(Number))(
      'taxon %i -> equals the hand-built chain',
      async (taxon) => {
        expect(await s.execute('analysis_taxon_lineage', [taxon])).toEqual(lineageOf(taxon));
        const [{ n }] = await s.sql(
          `WITH RECURSIVE up(id, parent) AS (SELECT taxon_id, parent_taxon_id FROM taxa WHERE taxon_id = $1
           UNION ALL SELECT t.taxon_id, t.parent_taxon_id FROM taxa t, up WHERE t.taxon_id = up.parent)
         SELECT count(*) AS n FROM up`,
          [taxon],
        );
        expect(lineageOf(taxon)).toHaveLength(Number(n));
      },
    );

    // C/D. metamorphic
    it('a new child extends the chain by one level and the root stays first', async () => {
      await s.rollback(async (db) => {
        await db.query('ALTER TABLE taxa DISABLE TRIGGER trg_taxa_tree'); // a species under a species, to extend the chain
        const sub = await newTaxon(db, { rank: 'species', parent_taxon_id: 7 });
        const rows = await s.execute('analysis_taxon_lineage', [sub.taxon_id]);
        expect(rows).toHaveLength(8);
        expect(rows[0]).toMatchObject({ taxon_id: '1', depth: 0 });
        expect(rows.at(-1)).toMatchObject({
          taxon_id: sub.taxon_id,
          parent_taxon_id: '7',
          depth: 7,
        });
        // the parent's own lineage did not change
        expect(await s.execute('analysis_taxon_lineage', [7])).toEqual(lineageOf(7));
      });
    });
    it('re-parenting a genus moves the whole lineage: Labeo under Gambusia gets depth 5 via the class', async () => {
      await s.rollback(async (db) => {
        await db.query('ALTER TABLE taxa DISABLE TRIGGER trg_taxa_tree'); // a genus under a genus
        await updateRow(db, 'taxa', 'taxon_id', 6, { parent_taxon_id: 14 });
        expect((await s.execute('analysis_taxon_lineage', [7])).map((r) => r.taxon_id)).toEqual([
          '1',
          '2',
          '3',
          '14',
          '6',
          '7',
        ]);
      });
    });
    it('a parent loop terminates with each taxon once, in a stable order', async () => {
      await s.rollback(async (db) => {
        await db.query('ALTER TABLE taxa DISABLE TRIGGER trg_taxa_tree');
        const a = await newTaxon(db, { rank: 'genus' });
        const b = await newTaxon(db, { rank: 'species', parent_taxon_id: a.taxon_id });
        await updateRow(db, 'taxa', 'taxon_id', a.taxon_id, { parent_taxon_id: b.taxon_id });
        const rows = await s.execute('analysis_taxon_lineage', [b.taxon_id]);
        expect(rows.map((r) => r.taxon_id)).toEqual([a.taxon_id, b.taxon_id]);
        expect(rows.map((r) => r.depth)).toEqual([0, 1]);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('analysis_taxon_lineage', [7]);
      expect(cols.map((c) => c.name)).toEqual(LINEAGE_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        taxon_id: 'bigint',
        rank: 'taxon_rank',
        parent_taxon_id: 'bigint',
        depth: 'integer',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes', async () => {
      const first = await s.execute('analysis_taxon_lineage', [7]);
      expect(await s.execute('analysis_taxon_lineage', [7])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('analysis_taxon_lineage', [7])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('analysis: v_approved_detections', () => {
    it('has 24 rows: analysis 1 contributes 14 (17 minus 2 warn and 1 fail), analysis 2 contributes 10', async () => {
      const rows = await s.queryView('v_approved_detections', { orderBy: 'assignment_id' });
      expect(rows).toHaveLength(24);
      expect(rows.filter((r) => r.analysis_id === '1')).toHaveLength(14);
      expect(rows.filter((r) => r.analysis_id === '2')).toHaveLength(10);
      expect(rows.every((r) => r.qc_flag === 'pass')).toBe(true);
      expect(rows.map((r) => Number(r.assignment_id))).toEqual(PASS_DETECTIONS.map((d) => d[0]));
    });
    it('only species 7, 8 and 11 appear: 15, 3 and 6 rows; 9, 13 and 15 never', async () => {
      const rows = await s.queryView('v_approved_detections');
      const count = (id) => rows.filter((r) => r.taxon_id === String(id)).length;
      expect([7, 8, 11].map(count)).toEqual([15, 3, 6]);
      expect([9, 13, 15].map(count)).toEqual([0, 0, 0]);
    });
    it('assignment 1 carries every documented column', async () => {
      expect(
        (await s.queryView('v_approved_detections', { where: 'assignment_id = 1' }))[0],
      ).toEqual({
        assignment_id: '1',
        read_count: 18420,
        confidence: '0.9812',
        qc_flag: 'pass',
        taxon_id: '7',
        scientific_name: 'Labeo rohita',
        rank: 'species',
        parent_taxon_id: '6',
        analysis_id: '1',
        marker_id: '1',
        marker_name: '12S',
        pipeline_name: 'OBITools3',
        pipeline_version: '3.0.1',
        reference_db: 'MitoFish',
        reference_db_version: '2025-06',
        approved_at: '2026-04-02T11:30:00.000Z',
        library_id: '1',
        library_code: 'LIB-0001',
        sample_id: '1',
        sample_code: 'EB-20250515-0001-001',
        event_id: '1',
        collected_at: '2025-05-15T08:30:00.000Z',
        project_id: '1',
        site_id: '1',
        site_name: 'Dakpathar Barrage',
        region_id: '2',
        habitat_type: 'river',
      });
    });
    it('oracle: the view equals the rule applied in JavaScript to the unfiltered rows', async () => {
      const view = await s.queryView('v_approved_detections', { orderBy: 'assignment_id' });
      const expected = usable(await allDetections()).sort(
        (a, b) => Number(a.assignment_id) - Number(b.assignment_id),
      );
      expect(view.map((r) => [r.assignment_id, r.sample_code, r.site_id, r.collected_at])).toEqual(
        expected.map((r) => [r.assignment_id, r.sample_code, r.site_id, r.collected_at]),
      );
    });
    it('draft/imported analyses and warn/fail rows are excluded; approving analysis 3 adds its 12 pass rows', async () => {
      await s.rollback(async (db) => {
        await newDetection(db, { analysis_id: 4, library_id: 1, taxon_id: 13 });
        expect(await s.queryView('v_approved_detections')).toHaveLength(24);
        await approveAnalysis(db, 3);
        // analysis 3: 15 rows, 1 warn (a36) and 3 fail (a42, a43... a42 fail, a43 fail) -> 12 pass
        const rows = await s.queryView('v_approved_detections');
        expect(rows).toHaveLength(36);
        expect(rows.filter((r) => r.analysis_id === '3')).toHaveLength(12);
        expect(rows.filter((r) => r.taxon_id === '15')).toHaveLength(5);
      });
    });
    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_approved_detections')).map((c) => c.name)).toEqual(
        DETECTION_VIEW_COLUMNS,
      );
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('analysis: v_site_richness', () => {
    it('eight rows: the richness table of the fixture plus the owning project', async () => {
      await acrossSettings(
        s,
        async () => {
          const rows = await s.queryView('v_site_richness', { orderBy: 'site_id, year' });
          expect(rows).toEqual(
            RICHNESS.map(([site, year, observed, samples, events]) => ({
              project_id: String(EVENT[site <= 3 ? 1 : 7].project),
              site_id: String(site),
              site_name: SITE_NAME[site],
              year,
              observed_taxa: String(observed),
              sample_count: String(samples),
              event_count: String(events),
            })),
          );
        },
        { zones: TIME_ZONES },
      );
    });
    it('agrees with analysis_richness_by_site_year on every shared column', async () => {
      const view = await s.queryView('v_site_richness', { orderBy: 'site_id, year' });
      const query = await s.execute('analysis_richness_by_site_year', [null, null, null, null]);
      expect(
        view.map((r) => [r.site_id, r.year, r.observed_taxa, r.sample_count, r.event_count]),
      ).toEqual(
        query.map((r) => [r.site_id, r.year, r.observed_taxa, r.sample_count, r.events_count]),
      );
    });
    it('draft detections do not count; approving analysis 3 raises sites 2, 4 and 5 for 2026', async () => {
      await s.rollback(async (db) => {
        await newDetection(db, { analysis_id: 4, library_id: 5, taxon_id: 13 });
        const before = await s.queryView('v_site_richness', { orderBy: 'site_id, year' });
        expect(before.map((r) => r.observed_taxa)).toEqual([
          '2',
          '2',
          '2',
          '1',
          '2',
          '2',
          '2',
          '1',
        ]);
        await approveAnalysis(db, 3);
        const after = await s.queryView('v_site_richness', { orderBy: 'site_id, year' });
        expect(after.map((r) => r.observed_taxa)).toEqual(['2', '2', '2', '2', '2', '2', '3', '2']);
      });
    });
    it('a site-year without detections is listed with 0; a pass genus-level hit does not raise the count', async () => {
      await s.rollback(async (db) => {
        const e = await newEvent(db, {
          project_id: 1,
          site_id: 3,
          collected_at: '2024-05-01T00:00:00Z',
        });
        const { library } = await sequencedSample(db, e.event_id);
        const x = await newAnalysis(db, { run_id: 1 });
        await newDetection(db, {
          analysis_id: x.analysis_id,
          library_id: library.library_id,
          taxon_id: 6,
          qc_flag: 'pass',
        });
        await approveAnalysis(db, x.analysis_id);
        const row = (
          await s.queryView('v_site_richness', { where: 'site_id = 3 AND year = 2024' })
        )[0];
        expect(row).toMatchObject({
          project_id: '1',
          observed_taxa: '0',
          sample_count: '1',
          event_count: '1',
        });
      });
    });
    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_site_richness')).map((c) => c.name)).toEqual(
        RICHNESS_VIEW_COLUMNS,
      );
    });
  });
});
