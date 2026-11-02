// Owner: C (Testing & QA)
// Purpose: Query results vs known fixtures: Field Collection & Samples
//
// Expected values are derived by hand from database/seeds/020_seed_field.sql (derivation next to each
// literal), compared with the committed prepared statement, with an oracle written without CTEs or
// window functions, and after rolled-back changes. bigint/numeric are strings, dates YYYY-MM-DD,
// timestamptz ISO UTC (see tests/setup/queries.js).
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { insertRow, newEvent, newSample, newSite, unique, updateRow } from '../setup/integrity.js';
import { acrossSettings, openQuerySession, TIME_ZONES } from '../setup/queries.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

// Seed 020. events: id -> [site, project, collected_at]. Event n holds samples 2n-1 and 2n; sample 17
// is a third sample on event 1 and the only failed one.
const EVENTS = {
  1: ['1', '1', '2025-05-15T08:30:00.000Z'],
  2: ['2', '1', '2025-05-18T09:15:00.000Z'],
  3: ['3', '1', '2025-05-22T07:45:00.000Z'],
  4: ['1', '1', '2026-03-10T08:00:00.000Z'],
  5: ['2', '1', '2026-03-12T09:30:00.000Z'],
  6: ['3', '1', '2026-03-15T08:15:00.000Z'],
  7: ['4', '2', '2026-04-05T10:00:00.000Z'],
  8: ['5', '2', '2026-04-08T11:30:00.000Z'],
};
const SITES = {
  1: ['Dakpathar Barrage', 'Yamuna River Basin', 'river', '2'],
  2: ['Okhla Barrage', 'Yamuna River Basin', 'river', '2'],
  3: ['Sangam Prayagraj', 'Yamuna River Basin', 'river', '2'],
  4: ['Diamond Harbour', 'Hooghly Estuary', 'estuary', '3'],
  5: ['Kakdwip Bay', 'Hooghly Estuary', 'estuary', '3'],
};
// [sample_id, event_id, sample_code]
const SAMPLES = [
  [1, 1, 'EB-20250515-0001-001'],
  [2, 1, 'EB-20250515-0001-002'],
  [17, 1, 'EB-20250515-0001-003'],
  [3, 2, 'EB-20250518-0002-001'],
  [4, 2, 'EB-20250518-0002-002'],
  [5, 3, 'EB-20250522-0003-001'],
  [6, 3, 'EB-20250522-0003-002'],
  [7, 4, 'EB-20260310-0004-001'],
  [8, 4, 'EB-20260310-0004-002'],
  [9, 5, 'EB-20260312-0005-001'],
  [10, 5, 'EB-20260312-0005-002'],
  [11, 6, 'EB-20260315-0006-001'],
  [12, 6, 'EB-20260315-0006-002'],
  [13, 7, 'EB-20260405-0007-001'],
  [14, 7, 'EB-20260405-0007-002'],
  [15, 8, 'EB-20260408-0008-001'],
  [16, 8, 'EB-20260408-0008-002'],
];
const STATUSES = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];

// samples per site (events 1+4, 2+5, 3+6, 7, 8): 3+2, 2+2, 2+2, 2, 2 -> 5, 4, 4, 2, 2 (seed 020)
const SITE_TOTALS = { 1: 5, 2: 4, 3: 4, 4: 2, 5: 2 };

function siteCountsRow(siteId, over = {}) {
  const [name, region, habitat] = SITES[siteId];
  const total = SITE_TOTALS[siteId];
  const failed = siteId === 1 ? 1 : 0; // sample 17 is on event 1 -> site 1
  return {
    site_id: String(siteId),
    site_name: name,
    region_name: region,
    habitat_type: habitat,
    total_samples: String(total),
    collected_count: '0',
    stored_count: '0',
    extracted_count: '0',
    sequenced_count: '0',
    analyzed_count: String(total - failed), // samples 1-16 are analyzed
    failed_count: String(failed),
    discarded_count: '0',
    ...over,
  };
}

const SITE_COUNT_COLUMNS = [
  'site_id',
  'site_name',
  'region_name',
  'habitat_type',
  'total_samples',
  'collected_count',
  'stored_count',
  'extracted_count',
  'sequenced_count',
  'analyzed_count',
  'failed_count',
  'discarded_count',
];

const LATEST_STATUS_COLUMNS = [
  'event_id',
  'site_id',
  'collected_at',
  'sample_id',
  'sample_code',
  'current_status',
  'latest_history_status',
  'last_status_changed_at',
  'last_status_note',
  'status_matches',
];

const MOVING_AVERAGE_COLUMNS = [
  'site_id',
  'site_name',
  'habitat_type',
  'parameter',
  'unit',
  'event_no',
  'collected_at',
  'value',
  'moving_avg',
  'readings_in_window',
  'deviation_from_avg',
];

// Exact decimal arithmetic for the moving-average oracle: values are scaled to integers of 1e-4.
const SCALE = 10000n;
const toScaled = (text) => {
  const [whole, frac = ''] = text.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(whole.replace('-', '')) * SCALE + BigInt(frac.padEnd(4, '0').slice(0, 4)));
};
// a / b rounded half away from zero (numeric ROUND semantics)
const roundDiv = (a, b) => {
  const neg = a < 0n !== b < 0n;
  const abs = (x) => (x < 0n ? -x : x);
  const q = (2n * abs(a) + abs(b)) / (2n * abs(b));
  return neg ? -q : q;
};
const fromScaled = (n) => {
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / SCALE}.${String(abs % SCALE).padStart(4, '0')}`;
};

describe.skipIf(!dbAvailable)('field queries', () => {
  let s;
  beforeAll(async () => {
    s = await openQuerySession('field');
  });
  afterAll(async () => {
    await s?.close();
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------
  describe('field: field_site_sample_counts', () => {
    // Oracle: one COUNT per (site, status) with comma joins, no FILTER and no LEFT JOIN.
    async function oracleSiteCounts(regionId) {
      const sites = await s.sql(
        `SELECT ss.site_id, ss.name, r.name AS region_name, ss.habitat_type
           FROM sampling_sites ss, regions r
          WHERE r.region_id = ss.region_id AND ($1::bigint IS NULL OR ss.region_id = $1)
          ORDER BY ss.site_id`,
        [regionId],
      );
      const out = [];
      for (const site of sites) {
        const row = {
          site_id: site.site_id,
          site_name: site.name,
          region_name: site.region_name,
          habitat_type: site.habitat_type,
        };
        const [all] = await s.sql(
          `SELECT count(*) AS n FROM samples sa, collection_events ce
            WHERE sa.event_id = ce.event_id AND ce.site_id = $1`,
          [site.site_id],
        );
        row.total_samples = all.n;
        for (const status of STATUSES) {
          const [c] = await s.sql(
            `SELECT count(*) AS n FROM samples sa, collection_events ce
              WHERE sa.event_id = ce.event_id AND ce.site_id = $1 AND sa.status = $2`,
            [site.site_id, status],
          );
          row[`${status}_count`] = c.n;
        }
        out.push(row);
      }
      return out;
    }

    // A. golden (derivation: SITE_TOTALS above; region 2 holds sites 1-3, region 3 sites 4-5)
    it('NULL -> five sites with total/analyzed/failed counts 5/4/1, 4/4/0, 4/4/0, 2/2/0, 2/2/0', async () => {
      await acrossSettings(s, async () => {
        expect(await s.execute('field_site_sample_counts', [null])).toEqual(
          [1, 2, 3, 4, 5].map((id) => siteCountsRow(id)),
        );
      });
    });
    it('region 2 (Yamuna River Basin) -> sites 1, 2, 3; region 3 (Hooghly Estuary) -> sites 4, 5', async () => {
      expect(await s.execute('field_site_sample_counts', [2])).toEqual(
        [1, 2, 3].map((id) => siteCountsRow(id)),
      );
      expect(await s.execute('field_site_sample_counts', [3])).toEqual(
        [4, 5].map((id) => siteCountsRow(id)),
      );
    });

    // B. oracle
    it.each([null, 1, 2, 3, 999])('region %s -> equals the oracle', async (regionId) => {
      expect(await s.execute('field_site_sample_counts', [regionId])).toEqual(
        await oracleSiteCounts(regionId),
      );
    });

    // C. filters
    it('region 1 (India, no site attached directly) and unknown regions -> zero rows', async () => {
      expect(await s.execute('field_site_sample_counts', [1])).toEqual([]);
      expect(await s.execute('field_site_sample_counts', [999])).toEqual([]);
    });
    it('the per-region results partition the unfiltered result', async () => {
      const all = await s.execute('field_site_sample_counts', [null]);
      const parts = [];
      for (const id of [1, 2, 3])
        parts.push(...(await s.execute('field_site_sample_counts', [id])));
      expect(parts).toEqual(all);
    });
    it('the status columns sum to total_samples on every site', async () => {
      for (const r of await s.execute('field_site_sample_counts', [null])) {
        const sum = STATUSES.reduce((acc, st) => acc + Number(r[`${st}_count`]), 0);
        expect(sum).toBe(Number(r.total_samples));
      }
    });

    // D. metamorphic
    it('moving one sample to a later status changes exactly two counts by one; the total is unchanged', async () => {
      await s.rollback(async (db) => {
        const sample = await newSample(db, { event_id: 1 }); // site 1, status collected
        let [site1] = await s.execute('field_site_sample_counts', [2]);
        expect(site1).toEqual(siteCountsRow(1, { total_samples: '6', collected_count: '1' }));
        await updateRow(db, 'samples', 'sample_id', sample.sample_id, { status: 'stored' });
        [site1] = await s.execute('field_site_sample_counts', [2]);
        expect(site1).toEqual(siteCountsRow(1, { total_samples: '6', stored_count: '1' }));
        await updateRow(db, 'samples', 'sample_id', sample.sample_id, { status: 'discarded' });
        [site1] = await s.execute('field_site_sample_counts', [2]);
        expect(site1).toEqual(siteCountsRow(1, { total_samples: '6', discarded_count: '1' }));
        // the other four sites did not move
        const rest = (await s.execute('field_site_sample_counts', [null])).slice(1);
        expect(rest).toEqual([2, 3, 4, 5].map((id) => siteCountsRow(id)));
      });
    });

    it('a site with no events appears with zero counts and only under its own region filter', async () => {
      await s.rollback(async (db) => {
        const site = await newSite(db, { region_id: 3, habitat_type: 'marine' });
        const [row] = (await s.execute('field_site_sample_counts', [3])).filter(
          (r) => r.site_id === site.site_id,
        );
        expect(row).toEqual({
          site_id: site.site_id,
          site_name: site.name,
          region_name: 'Hooghly Estuary',
          habitat_type: 'marine',
          total_samples: '0',
          collected_count: '0',
          stored_count: '0',
          extracted_count: '0',
          sequenced_count: '0',
          analyzed_count: '0',
          failed_count: '0',
          discarded_count: '0',
        });
        expect(
          (await s.execute('field_site_sample_counts', [2])).map((r) => r.site_id),
        ).not.toContain(site.site_id);
        expect(await s.execute('field_site_sample_counts', [null])).toHaveLength(6);
      });
    });

    it('an event without samples changes no count', async () => {
      await s.rollback(async (db) => {
        await newEvent(db, { project_id: 1, site_id: 2, collected_at: '2026-06-01T00:00:00Z' });
        expect(await s.execute('field_site_sample_counts', [null])).toEqual(
          [1, 2, 3, 4, 5].map((id) => siteCountsRow(id)),
        );
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('field_site_sample_counts', [null]);
      expect(cols.map((c) => c.name)).toEqual(SITE_COUNT_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        site_id: 'bigint',
        site_name: 'text',
        region_name: 'text',
        habitat_type: 'habitat_type',
        total_samples: 'bigint',
        failed_count: 'bigint',
      });
    });

    // F. determinism
    it('two executions are identical; generic and custom plans agree', async () => {
      const first = await s.execute('field_site_sample_counts', [null]);
      expect(await s.execute('field_site_sample_counts', [null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('field_site_sample_counts', [null])).toEqual(first);
          expect(await s.execute('field_site_sample_counts', [2])).toEqual(first.slice(0, 3));
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('field: field_event_samples_latest_status', () => {
    // Seed 020 history: samples 1-8 reach `analyzed` on 2026-04-02 11:30 UTC, samples 9-16 on
    // 2026-04-25 14:00 UTC (note 'Taxonomic assignment approved'); sample 17's last row is `failed` on
    // 2025-05-20 16:00 UTC with note 'Extraction failed concentration QC check'.
    const expectedRow = ([sampleId, eventId, code]) => {
      const failed = sampleId === 17;
      return {
        event_id: String(eventId),
        site_id: EVENTS[eventId][0],
        collected_at: EVENTS[eventId][2],
        sample_id: String(sampleId),
        sample_code: code,
        current_status: failed ? 'failed' : 'analyzed',
        latest_history_status: failed ? 'failed' : 'analyzed',
        last_status_changed_at: failed
          ? '2025-05-20T16:00:00.000Z'
          : sampleId <= 8
            ? '2026-04-02T11:30:00.000Z'
            : '2026-04-25T14:00:00.000Z',
        last_status_note: failed
          ? 'Extraction failed concentration QC check'
          : 'Taxonomic assignment approved',
        status_matches: true,
      };
    };
    // seed order: event_id, then sample_id
    const ORDERED = [...SAMPLES].sort((a, b) => a[1] - b[1] || a[0] - b[0]);

    // Oracle: latest history row by a correlated "no later row exists" test instead of row_number.
    async function oracleLatest(eventId) {
      return s.sql(
        `SELECT ce.event_id, ce.site_id, ce.collected_at, sa.sample_id, sa.sample_code,
                sa.status AS current_status, h.new_status AS latest_history_status,
                h.changed_at AS last_status_changed_at, h.note AS last_status_note,
                (sa.status = h.new_status) AS status_matches
           FROM samples sa
           JOIN collection_events ce ON ce.event_id = sa.event_id
           LEFT JOIN sample_status_history h ON h.sample_id = sa.sample_id
            AND NOT EXISTS (SELECT 1 FROM sample_status_history h2
                             WHERE h2.sample_id = h.sample_id
                               AND (h2.changed_at > h.changed_at
                                    OR (h2.changed_at = h.changed_at AND h2.history_id > h.history_id)))
          WHERE ($1::bigint IS NULL OR ce.event_id = $1)
          ORDER BY ce.event_id, sa.sample_id`,
        [eventId],
      );
    }

    // A. golden
    it('NULL -> 17 rows ordered by event then sample, every status matches its history', async () => {
      await acrossSettings(s, async () => {
        expect(await s.execute('field_event_samples_latest_status', [null])).toEqual(
          ORDERED.map(expectedRow),
        );
      });
    });
    it.each([
      [1, [1, 2, 17]],
      [4, [7, 8]],
      [8, [15, 16]],
    ])('event %i -> samples %j', async (eventId, sampleIds) => {
      const rows = await s.execute('field_event_samples_latest_status', [eventId]);
      expect(rows).toEqual(ORDERED.filter((r) => sampleIds.includes(r[0])).map(expectedRow));
    });

    // B. oracle: every event and the unfiltered call
    it.each([null, 1, 2, 3, 4, 5, 6, 7, 8, 999])(
      'event %s -> equals the oracle',
      async (eventId) => {
        expect(await s.execute('field_event_samples_latest_status', [eventId])).toEqual(
          await oracleLatest(eventId),
        );
      },
    );

    // C. filters
    it('unknown event -> zero rows; per-event results partition the unfiltered result', async () => {
      expect(await s.execute('field_event_samples_latest_status', [999])).toEqual([]);
      const all = await s.execute('field_event_samples_latest_status', [null]);
      const parts = [];
      for (let id = 1; id <= 8; id += 1)
        parts.push(...(await s.execute('field_event_samples_latest_status', [id])));
      expect(parts).toEqual(all);
      expect(all.every((r) => r.status_matches === true)).toBe(true);
    });
    it('the latest history status equals samples.status for all 17 samples', async () => {
      const rows = await s.execute('field_event_samples_latest_status', [null]);
      expect(rows).toHaveLength(17);
      for (const r of rows) expect(r.latest_history_status).toBe(r.current_status);
    });

    // D. metamorphic
    it('a real status change adds a history row, which becomes the latest', async () => {
      await s.rollback(async (db) => {
        // sample 1 is `analyzed` (terminal), so use a new sample on event 1: collected -> stored
        const sample = await newSample(db, { event_id: 1 });
        await updateRow(db, 'samples', 'sample_id', sample.sample_id, { status: 'stored' });
        const rows = await s.execute('field_event_samples_latest_status', [1]);
        const row = rows.find((r) => r.sample_id === sample.sample_id);
        const [newest] = await s.sql(
          `SELECT new_status, changed_at FROM sample_status_history WHERE sample_id = $1
            ORDER BY changed_at DESC, history_id DESC LIMIT 1`,
          [sample.sample_id],
        );
        expect(newest.new_status).toBe('stored');
        expect(row.current_status).toBe('stored');
        expect(row.latest_history_status).toBe('stored');
        expect(row.last_status_changed_at).toBe(newest.changed_at);
        expect(row.status_matches).toBe(true);
        // the three seeded samples of the event are untouched
        expect(
          rows.filter((r) => r.sample_id !== sample.sample_id).map((r) => r.latest_history_status),
        ).toEqual(['analyzed', 'analyzed', 'failed']);
      });
    });

    it('a history row that disagrees with samples.status shows status_matches = false', async () => {
      await s.rollback(async (db) => {
        await insertRow(db, 'sample_status_history', {
          sample_id: 2,
          old_status: 'analyzed',
          new_status: 'discarded',
          changed_by: 3,
          changed_at: '2030-01-01T00:00:00Z',
          note: 'drift',
        });
        const rows = await s.execute('field_event_samples_latest_status', [1]);
        const row = rows.find((r) => r.sample_id === '2');
        expect(row).toMatchObject({
          current_status: 'analyzed',
          latest_history_status: 'discarded',
          last_status_changed_at: '2030-01-01T00:00:00.000Z',
          last_status_note: 'drift',
          status_matches: false,
        });
        expect(rows.filter((r) => r.status_matches).map((r) => r.sample_id)).toEqual(['1', '17']);
      });
    });

    it('two history rows at the same instant: the higher history_id wins', async () => {
      await s.rollback(async (db) => {
        for (const note of ['first', 'second']) {
          await insertRow(db, 'sample_status_history', {
            sample_id: 3,
            old_status: 'analyzed',
            new_status: 'analyzed',
            changed_at: '2031-01-01T00:00:00Z',
            note,
          });
        }
        const row = (await s.execute('field_event_samples_latest_status', [2])).find(
          (r) => r.sample_id === '3',
        );
        expect(row.last_status_note).toBe('second');
      });
    });

    it('a sample without any history appears with NULL history columns and a NULL status_matches', async () => {
      await s.rollback(async (db) => {
        // the status-history trigger records the insert; remove that row to get a history-less sample
        const sample = await newSample(db, { event_id: 7 });
        await db.query('DELETE FROM sample_status_history WHERE sample_id = $1', [
          sample.sample_id,
        ]);
        const row = (await s.execute('field_event_samples_latest_status', [7])).find(
          (r) => r.sample_id === sample.sample_id,
        );
        expect(row).toMatchObject({
          current_status: 'collected',
          latest_history_status: null,
          last_status_changed_at: null,
          last_status_note: null,
          status_matches: null,
        });
      });
    });

    it('an event without samples yields no row', async () => {
      await s.rollback(async (db) => {
        const e = await newEvent(db, {
          project_id: 1,
          site_id: 3,
          collected_at: '2026-07-01T00:00:00Z',
        });
        expect(await s.execute('field_event_samples_latest_status', [e.event_id])).toEqual([]);
        expect(await s.execute('field_event_samples_latest_status', [null])).toHaveLength(17);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('field_event_samples_latest_status', [null]);
      expect(cols.map((c) => c.name)).toEqual(LATEST_STATUS_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        event_id: 'bigint',
        collected_at: 'timestamp with time zone',
        current_status: 'sample_status',
        last_status_changed_at: 'timestamp with time zone',
        status_matches: 'boolean',
      });
    });

    // F. determinism and time zones
    it('identical on repeat, under both plan modes and in every session time zone', async () => {
      const first = await s.execute('field_event_samples_latest_status', [null]);
      expect(await s.execute('field_event_samples_latest_status', [null])).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(await s.execute('field_event_samples_latest_status', [null])).toEqual(first);
        });
      }
      for (const tz of TIME_ZONES) {
        await s.withTimeZone(tz, async () => {
          expect(await s.execute('field_event_samples_latest_status', [null])).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('field: field_readings_moving_average', () => {
    // Seed 020 temperature_c by site in time order (events 1-8): site 1: 24.5, 19.5; site 2: 28.2,
    // 23.4; site 3: 26.8, 22.1; site 4: 26.0; site 5: 27.5. Default window = 3 readings.
    const row = (
      site,
      no,
      at,
      value,
      avg,
      n,
      dev,
      parameter = 'temperature_c',
      unit = 'celsius',
    ) => ({
      site_id: String(site),
      site_name: SITES[site][0],
      habitat_type: SITES[site][2],
      parameter,
      unit,
      event_no: String(no),
      collected_at: at,
      value,
      moving_avg: avg,
      readings_in_window: String(n),
      deviation_from_avg: dev,
    });
    const TEMPERATURE = [
      row(1, 1, EVENTS[1][2], '24.5', '24.5000', 1, '0.0000'),
      // (24.5 + 19.5) / 2 = 22.0; 19.5 - 22.0 = -2.5
      row(1, 2, EVENTS[4][2], '19.5', '22.0000', 2, '-2.5000'),
      row(2, 1, EVENTS[2][2], '28.2', '28.2000', 1, '0.0000'),
      // (28.2 + 23.4) / 2 = 25.8; 23.4 - 25.8 = -2.4
      row(2, 2, EVENTS[5][2], '23.4', '25.8000', 2, '-2.4000'),
      row(3, 1, EVENTS[3][2], '26.8', '26.8000', 1, '0.0000'),
      // (26.8 + 22.1) / 2 = 24.45; 22.1 - 24.45 = -2.35
      row(3, 2, EVENTS[6][2], '22.1', '24.4500', 2, '-2.3500'),
      row(4, 1, EVENTS[7][2], '26.0', '26.0000', 1, '0.0000'),
      row(5, 1, EVENTS[8][2], '27.5', '27.5000', 1, '0.0000'),
    ];

    // Oracle: exact integer arithmetic over the raw readings, no window function.
    async function oracleMovingAverage(parameter, siteId, size) {
      const readings = await s.sql(
        `SELECT ss.site_id, ss.name AS site_name, ss.habitat_type, em.parameter, em.unit,
                ce.collected_at, em.value
           FROM environmental_measurements em, collection_events ce, sampling_sites ss
          WHERE ce.event_id = em.event_id AND ss.site_id = ce.site_id AND em.parameter = $1
            AND ($2::bigint IS NULL OR ss.site_id = $2)
          ORDER BY ss.site_id, ce.collected_at`,
        [parameter, siteId],
      );
      const window = Math.max(size ?? 3, 1);
      const bySite = new Map();
      for (const r of readings) bySite.set(r.site_id, [...(bySite.get(r.site_id) ?? []), r]);
      const out = [];
      for (const list of bySite.values()) {
        list.forEach((r, i) => {
          const inWindow = list
            .slice(Math.max(0, i - window + 1), i + 1)
            .map((x) => toScaled(x.value));
          const sum = inWindow.reduce((a, b) => a + b, 0n);
          const n = BigInt(inWindow.length);
          out.push({
            site_id: r.site_id,
            site_name: r.site_name,
            habitat_type: r.habitat_type,
            parameter: r.parameter,
            unit: r.unit,
            event_no: String(i + 1),
            collected_at: r.collected_at,
            value: r.value,
            moving_avg: fromScaled(roundDiv(sum, n)),
            readings_in_window: String(inWindow.length),
            deviation_from_avg: fromScaled(roundDiv(toScaled(r.value) * n - sum, n)),
          });
        });
      }
      return out;
    }

    // A. golden
    it("('temperature_c', NULL, NULL) -> 8 readings with the default window of 3", async () => {
      await acrossSettings(s, async () => {
        expect(
          await s.execute('field_readings_moving_average', ['temperature_c', null, null]),
        ).toEqual(TEMPERATURE);
      });
    });
    it("('ph', 1, NULL) -> site 1 pH 7.8 then 8.1: average 7.95, deviation 0.15", async () => {
      expect(await s.execute('field_readings_moving_average', ['ph', 1, null])).toEqual([
        row(1, 1, EVENTS[1][2], '7.8', '7.8000', 1, '0.0000', 'ph', 'pH'),
        row(1, 2, EVENTS[4][2], '8.1', '7.9500', 2, '0.1500', 'ph', 'pH'),
      ]);
    });
    it("('turbidity_ntu', 5, 2) -> a single reading: the average is the reading", async () => {
      expect(await s.execute('field_readings_moving_average', ['turbidity_ntu', 5, 2])).toEqual([
        row(5, 1, EVENTS[8][2], '20.0', '20.0000', 1, '0.0000', 'turbidity_ntu', 'NTU'),
      ]);
    });

    // B. oracle: every parameter x site x window size
    it.each(['temperature_c', 'ph', 'dissolved_oxygen_mg_l', 'turbidity_ntu'])(
      '%s -> equals the exact-arithmetic oracle for every site and window size',
      async (parameter) => {
        for (const siteId of [null, 1, 2, 3, 4, 5]) {
          for (const size of [null, 1, 2, 3, 5]) {
            expect(
              await s.execute('field_readings_moving_average', [parameter, siteId, size]),
            ).toEqual(await oracleMovingAverage(parameter, siteId, size));
          }
        }
      },
    );

    // C. filters
    it('unknown parameter, unknown site and NULL parameter -> zero rows, no error', async () => {
      expect(await s.execute('field_readings_moving_average', ['salinity', null, null])).toEqual(
        [],
      );
      expect(await s.execute('field_readings_moving_average', ['temperature_c', 99, null])).toEqual(
        [],
      );
      expect(await s.execute('field_readings_moving_average', [null, null, null])).toEqual([]);
      expect(
        await s.execute('field_readings_moving_average', ['Temperature_C', null, null]),
      ).toEqual([]);
    });
    it('per-site results partition the all-sites result; rows are ordered by site then time', async () => {
      const all = await s.execute('field_readings_moving_average', ['temperature_c', null, null]);
      const parts = [];
      for (const id of [1, 2, 3, 4, 5])
        parts.push(
          ...(await s.execute('field_readings_moving_average', ['temperature_c', id, null])),
        );
      expect(parts).toEqual(all);
      expect(all.map((r) => r.site_id)).toEqual(['1', '1', '2', '2', '3', '3', '4', '5']);
    });
    it('window size 0, 1, a negative size and NULL: 0/1/-5 behave as 1, NULL as 3', async () => {
      const one = await s.execute('field_readings_moving_average', ['temperature_c', null, 1]);
      expect(
        one.every((r) => r.readings_in_window === '1' && r.deviation_from_avg === '0.0000'),
      ).toBe(true);
      expect(one.map((r) => r.moving_avg)).toEqual([
        '24.5000',
        '19.5000',
        '28.2000',
        '23.4000',
        '26.8000',
        '22.1000',
        '26.0000',
        '27.5000',
      ]);
      expect(await s.execute('field_readings_moving_average', ['temperature_c', null, 0])).toEqual(
        one,
      );
      expect(await s.execute('field_readings_moving_average', ['temperature_c', null, -5])).toEqual(
        one,
      );
      expect(
        await s.execute('field_readings_moving_average', ['temperature_c', null, null]),
      ).toEqual(await s.execute('field_readings_moving_average', ['temperature_c', null, 3]));
    });

    // D. metamorphic: a four-reading series gives the window size something to do
    async function addSite1Readings(db) {
      // site 1 series becomes 24.5 (2025-05-15), 19.5 (2026-03-10), 20.0 (2026-04-01), 21.5 (2026-05-01)
      for (const [at, value] of [
        ['2026-04-01T00:00:00Z', '20.0'],
        ['2026-05-01T00:00:00Z', '21.5'],
      ]) {
        const e = await newEvent(db, { project_id: 1, site_id: 1, collected_at: at });
        await insertRow(db, 'environmental_measurements', {
          event_id: e.event_id,
          parameter: 'temperature_c',
          value,
          unit: 'celsius',
        });
      }
    }
    it('window 3 over 24.5, 19.5, 20.0, 21.5: 24.5, 22.0, 21.3333 (64/3), 20.3333 (61/3)', async () => {
      await s.rollback(async (db) => {
        await addSite1Readings(db);
        const rows = await s.execute('field_readings_moving_average', ['temperature_c', 1, 3]);
        expect(
          rows.map((r) => [
            r.event_no,
            r.value,
            r.moving_avg,
            r.readings_in_window,
            r.deviation_from_avg,
          ]),
        ).toEqual([
          ['1', '24.5', '24.5000', '1', '0.0000'],
          ['2', '19.5', '22.0000', '2', '-2.5000'],
          // (24.5 + 19.5 + 20.0) / 3 = 21.33333.. ; 20.0 - 21.33333.. = -1.33333..
          ['3', '20.0', '21.3333', '3', '-1.3333'],
          // (19.5 + 20.0 + 21.5) / 3 = 20.33333.. ; 21.5 - 20.33333.. = 1.16666.. -> 1.1667
          ['4', '21.5', '20.3333', '3', '1.1667'],
        ]);
      });
    });
    it('window 2 over the same series: 24.5, 22.0, 19.75 (39.5/2), 20.75 (41.5/2)', async () => {
      await s.rollback(async (db) => {
        await addSite1Readings(db);
        const rows = await s.execute('field_readings_moving_average', ['temperature_c', 1, 2]);
        expect(rows.map((r) => [r.moving_avg, r.readings_in_window, r.deviation_from_avg])).toEqual(
          [
            ['24.5000', '1', '0.0000'],
            ['22.0000', '2', '-2.5000'],
            ['19.7500', '2', '0.2500'],
            ['20.7500', '2', '0.7500'],
          ],
        );
      });
    });
    it('a reading added between two others re-numbers the later ones and changes their window', async () => {
      await s.rollback(async (db) => {
        const e = await newEvent(db, {
          project_id: 1,
          site_id: 2,
          collected_at: '2025-12-01T00:00:00Z',
        });
        await insertRow(db, 'environmental_measurements', {
          event_id: e.event_id,
          parameter: 'temperature_c',
          value: '10.0',
          unit: 'celsius',
        });
        const rows = await s.execute('field_readings_moving_average', ['temperature_c', 2, 3]);
        // 28.2 (2025-05-18), 10.0 (2025-12-01), 23.4 (2026-03-12): the 3-window mean at the last is 20.5333
        expect(rows.map((r) => [r.event_no, r.value, r.moving_avg, r.readings_in_window])).toEqual([
          ['1', '28.2', '28.2000', '1'],
          ['2', '10.0', '19.1000', '2'],
          ['3', '23.4', '20.5333', '3'],
        ]);
      });
    });
    it('other parameters of the same events do not leak into the series', async () => {
      await s.rollback(async (db) => {
        await addSite1Readings(db);
        const ph = await s.execute('field_readings_moving_average', ['ph', 1, null]);
        expect(ph).toHaveLength(2);
        expect(ph.every((r) => r.parameter === 'ph')).toBe(true);
      });
    });
    it('a site with events but no reading of that parameter, and a new site, yield no rows', async () => {
      await s.rollback(async (db) => {
        const site = await newSite(db);
        await insertRow(db, 'project_sites', { project_id: 1, site_id: site.site_id });
        await newEvent(db, {
          project_id: 1,
          site_id: site.site_id,
          collected_at: '2026-06-01T00:00:00Z',
        });
        expect(
          await s.execute('field_readings_moving_average', ['temperature_c', site.site_id, null]),
        ).toEqual([]);
        expect(
          await s.execute('field_readings_moving_average', ['temperature_c', null, null]),
        ).toHaveLength(8);
      });
    });

    // E. shape
    it('returns exactly the documented columns, in order, with the documented types', async () => {
      const cols = await s.columns('field_readings_moving_average', ['ph', null, null]);
      expect(cols.map((c) => c.name)).toEqual(MOVING_AVERAGE_COLUMNS);
      expect(Object.fromEntries(cols.map((c) => [c.name, c.type]))).toMatchObject({
        site_id: 'bigint',
        event_no: 'bigint',
        collected_at: 'timestamp with time zone',
        value: 'numeric',
        moving_avg: 'numeric',
        readings_in_window: 'bigint',
        deviation_from_avg: 'numeric',
      });
    });

    // F. determinism
    it('identical on repeat and under both plan modes; zones do not change the series', async () => {
      const first = await s.execute('field_readings_moving_average', ['temperature_c', null, null]);
      expect(
        await s.execute('field_readings_moving_average', ['temperature_c', null, null]),
      ).toEqual(first);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await s.withPlanMode(mode, async () => {
          expect(
            await s.execute('field_readings_moving_average', ['temperature_c', null, null]),
          ).toEqual(first);
        });
      }
      for (const tz of TIME_ZONES) {
        await s.withTimeZone(tz, async () => {
          expect(
            await s.execute('field_readings_moving_average', ['temperature_c', null, null]),
          ).toEqual(first);
        });
      }
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('field: v_sample_registry', () => {
    it('has 17 rows: 13 in project 1, 4 in project 2; 16 analyzed and 1 failed', async () => {
      const rows = await s.queryView('v_sample_registry', { orderBy: 'sample_id' });
      expect(rows).toHaveLength(17);
      expect(rows.filter((r) => r.project_id === '1')).toHaveLength(13);
      expect(rows.filter((r) => r.project_id === '2')).toHaveLength(4);
      expect(rows.filter((r) => r.status === 'analyzed')).toHaveLength(16);
      expect(rows.filter((r) => r.status === 'failed').map((r) => r.sample_id)).toEqual(['17']);
    });

    it('sample 1, sample 16 and the failed sample 17 carry every documented column', async () => {
      const get = async (id) =>
        (await s.queryView('v_sample_registry', { where: 'sample_id = $1', params: [id] }))[0];
      expect(await get(1)).toEqual({
        sample_id: '1',
        sample_code: 'EB-20250515-0001-001',
        status: 'analyzed',
        sample_type: 'water',
        event_id: '1',
        site_id: '1',
        site_name: 'Dakpathar Barrage',
        project_id: '1',
        project_title: 'Yamuna Biodiversity Survey',
        collected_at: '2025-05-15T08:30:00.000Z',
        volume_ml: '1000.00',
        depth_m: '0.50',
        storage_location: 'Freezer A-1',
      });
      expect(await get(16)).toEqual({
        sample_id: '16',
        sample_code: 'EB-20260408-0008-002',
        status: 'analyzed',
        sample_type: 'water',
        event_id: '8',
        site_id: '5',
        site_name: 'Kakdwip Bay',
        project_id: '2',
        project_title: 'Coastal Estuary Pilot',
        collected_at: '2026-04-08T11:30:00.000Z',
        volume_ml: '1000.00',
        depth_m: '1.50',
        storage_location: 'Freezer C-1',
      });
      expect(await get(17)).toMatchObject({
        sample_code: 'EB-20250515-0001-003',
        status: 'failed',
        event_id: '1',
        volume_ml: '500.00',
      });
    });

    it('oracle: every sample joins to the event, site and project the seed assigns', async () => {
      const rows = await s.queryView('v_sample_registry', { orderBy: 'sample_id' });
      const byId = new Map(rows.map((r) => [Number(r.sample_id), r]));
      for (const [sampleId, eventId, code] of SAMPLES) {
        expect(byId.get(sampleId)).toMatchObject({
          sample_code: code,
          event_id: String(eventId),
          site_id: EVENTS[eventId][0],
          project_id: EVENTS[eventId][1],
          site_name: SITES[EVENTS[eventId][0]][0],
          collected_at: EVENTS[eventId][2],
        });
      }
    });

    it('a new sample appears once with its type, event and project; a status change shows', async () => {
      await s.rollback(async (db) => {
        const code = unique('QA-REG');
        const sample = await newSample(db, {
          event_id: 7,
          sample_type_id: 3,
          sample_code: code,
          depth_m: '2.25',
        });
        const rows = await s.queryView('v_sample_registry', {
          where: 'sample_code = $1',
          params: [code],
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          sample_id: sample.sample_id,
          sample_type: 'sediment',
          status: 'collected',
          site_id: '4',
          project_id: '2',
          depth_m: '2.25',
        });
        await updateRow(db, 'samples', 'sample_id', sample.sample_id, { status: 'stored' });
        expect(
          (
            await s.queryView('v_sample_registry', {
              where: 'sample_id = $1',
              params: [sample.sample_id],
            })
          )[0].status,
        ).toBe('stored');
        expect(await s.queryView('v_sample_registry')).toHaveLength(18);
      });
    });

    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_sample_registry')).map((c) => c.name)).toEqual([
        'sample_id',
        'sample_code',
        'status',
        'sample_type',
        'event_id',
        'site_id',
        'site_name',
        'project_id',
        'project_title',
        'collected_at',
        'volume_ml',
        'depth_m',
        'storage_location',
      ]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('field: v_site_sample_summary', () => {
    // event_count per site: site 1 has events 1 and 4, site 2 events 2 and 5, site 3 events 3 and 6,
    // sites 4 and 5 one each. latest_collection_date = the later event's collected_at.
    const EVENT_COUNT = { 1: '2', 2: '2', 3: '2', 4: '1', 5: '1' };
    const LATEST = {
      1: EVENTS[4][2],
      2: EVENTS[5][2],
      3: EVENTS[6][2],
      4: EVENTS[7][2],
      5: EVENTS[8][2],
    };
    const summaryRow = (siteId, over = {}) => ({
      site_id: String(siteId),
      site_name: SITES[siteId][0],
      region_id: SITES[siteId][3],
      region_name: SITES[siteId][1],
      habitat_type: SITES[siteId][2],
      event_count: EVENT_COUNT[siteId],
      total_samples: String(SITE_TOTALS[siteId]),
      collected_count: '0',
      stored_count: '0',
      extracted_count: '0',
      sequenced_count: '0',
      analyzed_count: String(SITE_TOTALS[siteId] - (siteId === 1 ? 1 : 0)),
      failed_count: siteId === 1 ? '1' : '0',
      discarded_count: '0',
      latest_collection_date: LATEST[siteId],
      ...over,
    });

    it('five rows with the hand-derived counts, event counts and latest collection time', async () => {
      await acrossSettings(s, async () => {
        expect(await s.queryView('v_site_sample_summary', { orderBy: 'site_id' })).toEqual(
          [1, 2, 3, 4, 5].map((id) => summaryRow(id)),
        );
      });
    });

    it('agrees with field_site_sample_counts on every shared column', async () => {
      const view = await s.queryView('v_site_sample_summary', { orderBy: 'site_id' });
      const query = await s.execute('field_site_sample_counts', [null]);
      for (const [i, q] of query.entries()) {
        for (const col of SITE_COUNT_COLUMNS) expect(view[i][col], col).toBe(q[col]);
      }
    });

    it('a new site shows zero counts and NULL latest date; an empty event raises event_count only', async () => {
      await s.rollback(async (db) => {
        const site = await newSite(db);
        let [row] = await s.queryView('v_site_sample_summary', {
          where: 'site_id = $1',
          params: [site.site_id],
        });
        expect(row).toMatchObject({
          event_count: '0',
          total_samples: '0',
          latest_collection_date: null,
        });
        await newEvent(db, { project_id: 1, site_id: 1, collected_at: '2026-09-01T00:00:00Z' });
        [row] = await s.queryView('v_site_sample_summary', { where: 'site_id = 1' });
        expect(row).toEqual(
          summaryRow(1, { event_count: '3', latest_collection_date: '2026-09-01T00:00:00.000Z' }),
        );
      });
    });

    it('a status change moves one sample between the status columns', async () => {
      await s.rollback(async (db) => {
        // a new sample on event 7 (site 4): collected -> stored -> discarded
        const sample = await newSample(db, { event_id: 7 });
        let [row] = await s.queryView('v_site_sample_summary', { where: 'site_id = 4' });
        expect(row).toEqual(summaryRow(4, { total_samples: '3', collected_count: '1' }));
        await updateRow(db, 'samples', 'sample_id', sample.sample_id, { status: 'stored' });
        [row] = await s.queryView('v_site_sample_summary', { where: 'site_id = 4' });
        expect(row).toEqual(summaryRow(4, { total_samples: '3', stored_count: '1' }));
        await updateRow(db, 'samples', 'sample_id', sample.sample_id, { status: 'discarded' });
        [row] = await s.queryView('v_site_sample_summary', { where: 'site_id = 4' });
        expect(row).toEqual(summaryRow(4, { total_samples: '3', discarded_count: '1' }));
      });
    });

    it('returns exactly the documented columns, in order', async () => {
      expect((await s.viewColumns('v_site_sample_summary')).map((c) => c.name)).toEqual([
        'site_id',
        'site_name',
        'region_id',
        'region_name',
        'habitat_type',
        'event_count',
        'total_samples',
        'collected_count',
        'stored_count',
        'extracted_count',
        'sequenced_count',
        'analyzed_count',
        'failed_count',
        'discarded_count',
        'latest_collection_date',
      ]);
    });
  });
});
