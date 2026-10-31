# Field & Samples

> **Owner:** D (Docs & Demo)
>
> **Related task:** T15-D, GitHub issue [#24](https://github.com/arvnd108/eBioTrack/issues/24)

This slice records where samples are collected, when collection events happen, and the basic details of each sample. The views below give API routes and pages a consistent read-only shape without repeating joins and aggregation logic.

## Views

### `v_sample_registry`

**Purpose:** one row per sample, including its collection details.

| Column | Meaning |
|---|---|
| `sample_id` | Unique database ID for the sample. |
| `sample_code` | Human-readable, unique sample code. |
| `status` | Current sample status: `collected`, `stored`, `extracted`, `sequenced`, `analyzed`, `failed`, or `discarded`. |
| `sample_type` | Sample type name, such as water, soil, sediment, or air. |
| `event_id` | ID of the collection event that produced the sample. |
| `site_id` | ID of the sampling site. |
| `site_name` | Name of the sampling site. |
| `project_id` | ID of the project associated with the collection event. |
| `project_title` | Project title. |
| `collected_at` | Collection date and time (`timestamptz`, stored in UTC). |
| `volume_ml` | Sample volume in millilitres; may be NULL if not recorded. |
| `depth_m` | Collection depth in metres; may be NULL if not recorded. |
| `storage_location` | Where the sample is stored; may be NULL if not recorded. |

**What the view hides:** it joins `samples` to `sample_types`, `collection_events`, `sampling_sites`, and `projects`. A consumer can display the sample and its related names without writing those joins again.

**Who uses it:** sample registry pages, sample API routes, and reporting/export code. It includes samples in every status, including failed samples; it does not silently filter them out.

**Expected fixture count:** 17 rows, one per seeded sample.

Example:

```sql
SELECT sample_id, sample_code, status, sample_type, site_name, project_title
FROM v_sample_registry
ORDER BY sample_id;
```

### `v_site_sample_summary`

**Purpose:** one row per sampling site, with collection activity and sample counts.

| Column | Meaning |
|---|---|
| `site_id` | Unique database ID for the site. |
| `site_name` | Sampling site name. |
| `region_id` | ID of the region containing the site. |
| `region_name` | Region name. |
| `habitat_type` | Site habitat, such as river or estuary. |
| `event_count` | Number of distinct collection events at the site. |
| `total_samples` | Total number of samples collected at the site. |
| `collected_count` | Samples currently in `collected` status. |
| `stored_count` | Samples currently in `stored` status. |
| `extracted_count` | Samples currently in `extracted` status. |
| `sequenced_count` | Samples currently in `sequenced` status. |
| `analyzed_count` | Samples currently in `analyzed` status. |
| `failed_count` | Samples currently in `failed` status. |
| `discarded_count` | Samples currently in `discarded` status. |
| `latest_collection_date` | Latest event collection timestamp; NULL if the site has no events. |

**What the view hides:** it joins sites to regions, collection events and samples, then groups the records by site and counts events and samples by status. It uses LEFT JOINs for events and samples, so a site with no collection activity still appears with zero counts.

**Who uses it:** site overview pages, dashboards and API routes that need a quick summary of collection activity.

**Expected fixture counts:** five site rows and 17 samples in total. For the current seed:

| Site | Events | Samples | Analyzed | Failed |
|---|---:|---:|---:|---:|
| Dakpathar Barrage | 2 | 5 | 4 | 1 |
| Okhla Barrage | 2 | 4 | 4 | 0 |
| Sangam Prayagraj | 2 | 4 | 4 | 0 |
| Diamond Harbour | 1 | 2 | 2 | 0 |
| Kakdwip Bay | 1 | 2 | 2 | 0 |
| **Total** | **8** | **17** | **16** | **1** |

Example:

```sql
SELECT site_name, event_count, total_samples, analyzed_count, failed_count,
       latest_collection_date
FROM v_site_sample_summary
ORDER BY site_id;
```

## Transaction scenario (T18-D)

`database/transactions/field_transaction.sql`. Scenario: **register a collection event with its samples and environmental measurements atomically**: one `collection_events` row, four `environmental_measurements` rows and three samples created through `register_sample()`, as one transaction that either commits completely or leaves no trace, audit rows and status-history rows included. This is the order `POST /api/events` follows (CONTRACT 10: event with created samples and measurements, one transaction). The script is a standalone demonstration run by hand with `psql`; `database/transactions/` is not run by the migration runner. It creates and deletes nothing: every transaction ends in `ROLLBACK`, so it can be run repeatedly and leaves the database unchanged (it asserts this itself, `audit_logs` included). Generated ids move on, since PostgreSQL never reuses a consumed identity value.

```bash
docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/field_transaction.sql
psql "$DATABASE_URL" -f database/transactions/field_transaction.sql
psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/field_transaction.sql   # COMMIT Part 1 only; test database only, reset afterwards
```

Every transaction starts with `SET LOCAL app.current_user_id = '3'` (field researcher, the collector), as the backend does, and runs at the default READ COMMITTED level. Part 0 stops with a message if the fixture world is missing, or if a previous `keep=1` run left the demo event behind (reset the test database first). Each check prints one `PASS:` or `FAIL:` line.

| Part | What it does | Expected SQLSTATE | What is undone |
| --- | --- | --- | --- |
| 1, commit path | Insert the event, four measurements, three `register_sample()` calls; check rows, codes, history and audit | none | Default `ROLLBACK`: everything, including 3 history rows and 4 audit rows. With `keep=1` it is committed |
| 2, rollback A | Second `ph` measurement for the same event | `23505` (`uq_environmental_measurements_event_parameter`), then `25P02` | Event, four measurements and the event audit row |
| 3, B1 | Event for project 2 at site 1 | `23503` (`fk_collection_events_project_site`) | Nothing was written |
| 3, B2 | `collected_at` three days ahead | `23514` (`ck_collection_events_collected_at`) | Nothing was written |
| 3, B3 | Sample 1 fine, then sample type 999 | `23503` | Event, sample 1, its history row and audit rows |
| 3, B4 / B5 | Negative volume / negative depth | `23514` (raised by `register_sample`) | The event |
| 3, B6 | `UPDATE ... SET status = 'analyzed'` on a `collected` sample | `EB001` | The whole event and sample |
| 4, savepoint | Bad sample type, `ROLLBACK TO SAVEPOINT`, corrected sample | `23503` | Only the bad call; the event and sample 1 survive and the corrected sample reuses sequence `002` |
| 5, locking | Two sessions call `register_sample()` on the same event (protocol in the script comments) | none | See below |

Excerpt from a real run (default mode, development database after `npm run db:reset`; ids and codes differ per run):

```text
 event_id | project_id | site_id | collector_id |      collected_at      |         notes
     1000 |          1 |       1 |            3 | 2026-06-15 08:00:00+00 | T18-D field trip demo

 sample_id |     sample_code      |  status   | sample_type_id | volume_ml | depth_m | storage_location
      1000 | EB-20260615-1000-001 | collected |              1 |   1000.00 |    0.50 |
      1001 | EB-20260615-1000-002 | collected |              1 |    500.00 |    1.00 |
      1002 | EB-20260615-1000-003 | collected |              3 |           |         | Freezer D-1

    entity_type    | action | actor_id | rows
 collection_events | insert |        3 |    1
 samples           | insert |        3 |    3

 PASS: 4 audit rows (1 event insert + 3 sample inserts), all with actor 3
 PASS: v_site_sample_summary for site 1 gained 1 event and 3 samples
 PASS: B3 raised 23503 (sample type 999 does not exist)
 PASS: events, samples, measurements, history and audit rows all equal the baseline
```

`environmental_measurements` and `sample_status_history` have no audit trigger, so only the event and the three samples appear in the audit rows. `register_sample()` writes each sample's first history row; the update trigger adds none (three history rows for three samples).

### Two-session protocol (Part 5)

A single script cannot run two sessions, so Part 5 is a copy-paste protocol in the script. S1 runs `register_sample(1, ...)` and keeps the transaction open; S2 calls it for the same event and **blocks** on the `FOR UPDATE` lock on the event row (`pg_stat_activity` shows `wait_event_type = Lock`, `wait_event = transactionid`). When S1 commits, S2 unblocks at once and gets the next sequence number; when S1 rolls back, S2 gets the number S1 had. Never a duplicate code, never `23505` on `samples_sample_code_key`. Under READ COMMITTED S2 does not see S1's uncommitted sample. The second protocol (status against status) shows S2 blocked on the sample row until S1 commits, then refused with `EB001: Invalid sample status transition: stored -> collected`. The committed helper sample from that protocol is removed by resetting the test database (no `DELETE`, D19).

### ACID mapping

| Property | Where shown |
| --- | --- |
| Atomicity | Part 1 (event + 4 measurements + 3 samples + 3 history rows + 4 audit rows together), Parts 2 and 3 (nothing remains after the failure) |
| Consistency | Part 3 (foreign key, CHECK, procedure validation, `EB001` transition trigger) |
| Isolation | Part 5 (blocking on the event row lock, no duplicate sample codes, invisibility of uncommitted work) |
| Durability | Part 1 with `keep=1` (the committed event survives the session; a reset removes it) |

Part 4 adds a `SAVEPOINT` variant: it recovers from one bad sample without redoing the event, and is not needed for the all-or-nothing guarantee. The automated versions of these assertions are the field cases of T32 (transactions) and T34 (concurrency).

## Design notes

- Both views are read-only query interfaces; they do not replace the normalized source tables.
- View names follow the project contract's `v_<name>` convention.
- Column names use `snake_case`, consistent with the database and API contract.
- No `ORDER BY` is built into either view. A query using a view should specify its own ordering.
- The site summary uses `COUNT(DISTINCT ce.event_id)` so an event is counted once even when it has multiple samples. Sample counts are calculated from `samples`, not from event counts.
- The SQL is designed to be safely re-applied by the project's database object runner. If a future change renames or removes a view column, the existing view must be dropped before recreating it because PostgreSQL's `CREATE OR REPLACE VIEW` cannot remove or rename existing columns.

## Indexes (T19-D)

`database/indexes/field_indexes.sql` (issue #40, applied by hand and safe to run twice) covers two indexes: the unique index `samples_sample_code_key` that already exists, and the new `idx_collection_events_site_id_collected_at`. The full `EXPLAIN (ANALYZE, BUFFERS)` evidence, the variants tried and the write cost are in the comment blocks of that file; the exact statements are labelled `FQ1` to `FQ5` in `tests/performance/explain-benchmarks.sql`. All figures: `ebiotrack_test` (PostgreSQL 16, collation `en_US.utf8`), `npm run volume:load -- --scale medium` (20 008 events, 100 017 samples, 400 084 status-history rows) plus 80 000 generated measurements, because the volume generator creates none; median of 5 runs after one warm-up, baseline taken before the index.

| Index                                                                | Table               | Serves                                                                           | Size    | Before -> after                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `samples_sample_code_key` (`sample_code`), from the `UNIQUE`         | `samples`           | exact code lookup (FQ1), uniqueness of codes                                     | 3984 kB | without it: Seq Scan, 1344 buffers, 3.095 ms; with it: Index Scan, 4 buffers, 0.007 ms (about 440x)                                                       |
| `idx_collection_events_site_id_collected_at` (site_id, collected_at) | `collection_events` | events of a site in a date range, T14 Q3 with a site, `GET /api/events?site_id=` | 632 kB  | one year (78 events) 0.751 -> 0.036 ms (188 -> 66 buffers); one month 0.963 -> 0.010 ms; whole site 0.464 -> 0.039 ms; T14 Q3, one site 0.596 -> 0.168 ms |

Write cost of the new index (bulk insert of 20 008 rows into a temporary copy, median of 5): 8.353 -> 15.715 ms (+88%, about 0.37 microseconds a row). Events are entered one at a time, so this is negligible. Row counts and `md5` checksums of the results are identical with and without the index.

Findings:

- **The composite index helps the filter, not the sort.** After the index the plan is a Bitmap Heap Scan followed by a Sort of the 78 rows: they are spread over 64 pages, so the planner fetches them in page order and sorts. A date range without a `site_id` (FQ3d) and the T14 query for all sites (FQ4b, which reads every event) cannot use it: 0.819 ms and 24.824 ms stay unchanged.
- **Prefix search needs `text_pattern_ops` unless the column collation is `C`.** The unique index is not used for `LIKE 'EB-2026%'` under `en_US.utf8`: Seq Scan, 1334 buffers, 3.447 ms. An experimental `text_pattern_ops` index (3992 kB, dropped again) gives 0.008 ms and 4 buffers (about 430x); a 12% prefix improves 3.3x; and the planner correctly ignores it when the prefix matches 88% of the table. A plain btree on a copy of the column declared `COLLATE "C"` also serves the prefix (0.006 ms), which confirms the locale rule. A substring search (`LIKE '%x%'`) is served by neither. Judge a prefix index with a selective prefix: one that matches almost every row, such as `EB-2019%` (88% of the volume data), cannot show a benefit.
- **Not created, with numbers.** Because T19 asks for two indexes, three more are reported as recommended for whoever builds the routes (T21):
  - `CREATE INDEX idx_samples_sample_code_pattern ON samples (sample_code text_pattern_ops)` for `GET /api/samples?q=` if `q` is a prefix search.
  - `CREATE INDEX idx_samples_event_id ON samples (event_id)`: the samples of one event take 3.436 ms and 1334 buffers without it and 0.004 ms and 3 buffers with it (about 860x); `v_site_sample_summary` for one site goes 6.780 -> 0.220 ms; `register_sample()` counts the event's samples on every registration.
  - `CREATE INDEX idx_sample_status_history_sample_id ON sample_status_history (sample_id)`: Q2 for one event takes 62.745 ms (5160 buffers). With this index 2.155 ms; with both this and `samples (event_id)` 0.061 ms (about 1000x). With `samples (event_id)` alone nothing changes.
- T35 should repeat these with the audit and history triggers enabled.
