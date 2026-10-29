# README

> **Owner:** C (Testing & QA)
>
> Fixture conventions: known values, real vs synthetic labeling

## Rules

1. **Known values only, never random.** Use fixed literals; any generator uses a fixed seed.
2. **Label every fixture:** is it **real** or **synthetic**, its **source**, and its **license**. Real data (OBIS/GBIF) is labelled as real (D18).
3. **Synthetic fixture world** follows CONTRACT section 6.
4. **IDs:** seed rows use IDs below 1000; rows created by the app or by tests start at 1000 (D6).
5. Tests never touch the development database (`ebiotrack`); only `ebiotrack_test`.

## Layout

| File                               | Owner | Task | Status |
| ---------------------------------- | ----- | ---- | ------ |
| `detections_valid.csv`             | C     | T12  | done   |
| `detections_invalid_row.csv`       | C     | T12  | done   |
| volume-data generator (fixed seed) | C     | T12  | done   |
| `datasets/sample_detections.csv`   | C     | T12  | done   |

## Load / reset

From the repo root, with the database running (`docker compose up -d db`) and `.env` copied from `.env.example`:

```bash
# Development database (backend/): rebuild schema and load seeds
cd backend && npm run db:reset

# Test database: tests/ suites do this automatically once per run (tests/setup/globalSetup.js).
# From a suite, use the helpers in tests/setup/testDb.js:
#   resetTestDatabase()   drop schema, migrate, seed (full rebuild)
#   reseed()              truncate tables with RESTART IDENTITY and re-run seeds (faster)
#   withRollback(fn)      mutate inside a transaction that is always rolled back
```

## Expected values

Per-slice values are in the seed sections below; T12 adds the fixture-file values. Each row says where the number comes from.

| Quantity                           | Expected          | Derived from                                                   |
| ---------------------------------- | ----------------- | -------------------------------------------------------------- |
| Roles                              | 6                 | CONTRACT 6                                                     |
| Seeded users                       | 6                 | CONTRACT 6                                                     |
| Projects                           | 2                 | CONTRACT 6                                                     |
| Collection events                  | 8                 | CONTRACT 6                                                     |
| Samples                            | 17                | CONTRACT 6                                                     |
| Environmental measurements         | 32                | CONTRACT 6                                                     |
| Detections in seeds (analyses 1-3) | 43                | `SELECT count(*) FROM taxon_assignments`                       |
| Detections in analysis 4           | 0                 | `SELECT count(*) FROM taxon_assignments WHERE analysis_id = 4` |
| Everything else                    | see seed sections | T31 fills in query-level values                                |

## Access slice seed (`database/seeds/010_seed_access.sql`)

**Synthetic** data written for this project (no external source, no license issues). Known values:

| Quantity                                   | Value                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Roles (IDs 1-6)                            | administrator, principal_investigator, field_researcher, lab_technician, analyst, viewer |
| Users (IDs 1-6)                            | user n has role n; email `<role_name>@ebiotrack.test`                                    |
| Projects                                   | 1 Yamuna Biodiversity Survey (active), 2 Coastal Estuary Pilot (active)                  |
| `project_members`                          | 7 rows; user 2 owns both projects                                                        |
| Members of project 1 / 2                   | 5 / 2                                                                                    |
| Projects of users 3 / 4, 5, 6              | 1 and 2 / 1 only                                                                         |
| Projects user 1 (administrator) belongs to | none (access via global role)                                                            |
| `project_sites`                            | 5 rows, inserted by `020_seed_field.sql`: project 1 -> sites 1-3, project 2 -> sites 4-5 |
| `audit_logs`, `data_exports`               | 0 rows                                                                                   |

### Dev-only credentials

**Development and test fixtures only, never a real credential.** All six seeded users share one password: `ebiotrack-dev-2026` (stored only as a bcrypt cost-12 hash in the seed). `last_login_at` is NULL until someone signs in.

## Field & Samples slice seed (`database/seeds/020_seed_field.sql`)

**Synthetic** data written for this project (no external source, no license issues). Known values:

| Quantity                                | Value                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `regions` (IDs 1-3)                     | 1 India (country), 2 Yamuna River Basin (basin, parent 1), 3 Hooghly Estuary (other, parent 1)                                                                                                                |
| `sampling_sites` (IDs 1-5)              | 1 Dakpathar Barrage, 2 Okhla Barrage, 3 Sangam Prayagraj (rivers, region 2); 4 Diamond Harbour, 5 Kakdwip Bay (estuaries, region 3); `created_by` user 3                                                      |
| `sample_types` (IDs 1-4)                | water, soil, sediment, air; all 17 samples are type 1 (water)                                                                                                                                                 |
| `collection_events` (IDs 1-8)           | Project 1: events 1-3 in 2025, 4-6 in 2026 (one per site per year); project 2: events 7 (site 4) and 8 (site 5), both 2026. Collector is user 3                                                               |
| `samples` (IDs 1-17)                    | Event n has samples 2n-1 and 2n; sample 17 is on event 1                                                                                                                                                      |
| Sample codes                            | `EB-<YYYYMMDD>-<event 4 digits>-<seq 3 digits>`; 17 distinct, from `EB-20250515-0001-001` to `EB-20260408-0008-002`; sample 17 is `EB-20250515-0001-003`                                                      |
| Sample statuses                         | Samples 1-16 `analyzed`, sample 17 `failed`. Lab and analysis seeds must agree (extractions 1-16 `pass`, 17 `fail`)                                                                                           |
| Samples per site (all years)            | site 1: 5, site 2: 4, site 3: 4, site 4: 2, site 5: 2                                                                                                                                                         |
| Samples per site and year               | site 1: 3 (2025), 2 (2026); sites 2 and 3: 2 and 2; sites 4 and 5: 2 (2026 only)                                                                                                                              |
| `environmental_measurements` (IDs 1-32) | 4 per event: `temperature_c`, `ph`, `dissolved_oxygen_mg_l`, `turbidity_ntu`                                                                                                                                  |
| `sample_status_history` (IDs 1-84)      | 84 rows; samples 1-16 have 5 rows (`collected` -> `stored` -> `extracted` -> `sequenced` -> `analyzed`), sample 17 has 4 (`collected` -> `stored` -> `extracted` -> `failed`). 17 rows have `old_status` NULL |
| `project_sites`                         | 5 rows (see Access slice seed above)                                                                                                                                                                          |

Every history chain is continuous (each `old_status` equals the previous `new_status`) and only uses transitions allowed in CONTRACT section 3, and each sample's last history row equals `samples.status`.

## Laboratory & Sequencing slice seed (`database/seeds/030_seed_lab.sql`)

**Synthetic** data written for this project. Known values:

| Quantity                                 | Value                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `laboratories` (IDs 1-2)                 | 1 Dehradun eDNA Laboratory (river work), 2 Kolkata Estuarine Genomics Laboratory (estuary work)                                                                         |
| `extraction_batches` (IDs 1-3)           | Operator user 4. Batch 1 (lab 1): samples 1-6 and 17. Batch 2 (lab 1): samples 7-12. Batch 3 (lab 2): samples 13-16                                                     |
| `dna_extractions` (IDs 1-17)             | Extraction n is for sample n, attempt 1. Extractions 1-16 `pass`, extraction 17 `fail` (0.35 ng/uL). `created_at` equals the sample's `extracted` time in the 020 seed  |
| `sequencing_runs` (IDs 1-2)              | `RUN-001` (lab 1, 2026-03-25) and `RUN-002` (lab 2, 2026-04-18), both `completed`, Illumina MiSeq                                                                       |
| `sequencing_libraries` (IDs 1-16)        | Library n is from extraction n, code `LIB-0001` to `LIB-0016`. Run 1 holds libraries 1-8 (events 1-4), run 2 holds 9-16 (events 5-8). Sample 17 has no library          |
| `quality_control_results` (23 rows)      | All linked by `sample_id`, none by `analysis_id`. concentration: 16 `pass` and 1 `fail` (sample 17); extraction_blank: 3 `pass` (one per batch, on samples 1, 7 and 13) |
| QC rows that are not concentration/blank | positive_control: 1 `pass`; negative_control: 1 `warn` (sample 12); contamination_check: 1 `fail` (sample 17)                                                           |
| Results overall                          | 20 `pass`, 1 `warn`, 2 `fail`. Samples with a `fail`: 1 (sample 17). Samples with a `warn`: 1 (sample 12)                                                               |

Sequencing and analysis dates are consistent across seeds: every sample's `sequenced` history row is on or after its run date and its extraction `created_at`, and every `analyzed` row is on or after the analysis `approved_at`.

## Analysis, Taxonomy & Analytics slice seed (`database/seeds/040_seed_analysis.sql`)

**Synthetic** data written for this project. Known values:

| Quantity                       | Value                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dna_markers` (IDs 1-2)        | 1 `12S` (MiFish region), 2 `COI`                                                                                                                                                             |
| `taxa` (IDs 1-15)              | Animalia > Chordata > Actinopterygii > Cypriniformes > Cyprinidae, then genera Labeo (6), Cirrhinus (10), Cyprinus (12); Gambusia (14) is a child of the class. Parents come before children |
| Species                        | 7 Labeo rohita, 8 Labeo calbasu, 9 Labeo bata, 11 Cirrhinus mrigala, 13 Cyprinus carpio, 15 Gambusia affinis. Species 9 and 13 are never detected                                            |
| `analysis_runs` (IDs 1-4)      | 1: run 1, 12S, `approved`. 2: run 2, 12S, `approved`. 3: run 2, COI, `imported`. 4: run 1, COI, `draft` (empty)                                                                              |
| Users on analyses              | Analyses 1-3 `imported_by` user 5; analyses 1-2 `approved_by` user 2. Analysis 3 has `approved_by` NULL, so user 2 can approve it and user 5 (the importer) must not                         |
| Approval times                 | Analysis 1 `approved_at` 2026-04-02 11:30 UTC, analysis 2 `approved_at` 2026-04-25 14:00 UTC; both after their run date                                                                      |
| `taxon_assignments` (43 rows)  | Analysis 1: 17 (libraries 1-8, 3 taxa); analysis 2: 11 (libraries 9-15, 2 taxa); analysis 3: 15 (libraries 9-16, 3 taxa); analysis 4: none. Every library belongs to the analysis's run      |
| `qc_flag` counts per analysis  | Analysis 1: 14 `pass`, 2 `warn`, 1 `fail`. Analysis 2: 10 `pass`, 1 `fail`. Analysis 3: 12 `pass`, 1 `warn`, 2 `fail`                                                                        |
| Non-detections                 | Library 16 has no detection in analysis 2; sample 17 has no library, so no detection anywhere                                                                                                |
| Species 8 and 15               | Species 8 (calbasu) is detected at one site only. Species 15 appears only in analysis 3 (imported), so approved-only views exclude it                                                        |
| Richness (approved, all flags) | site 1: 2 (2025), 3 (2026); site 2: 2 (2025), 1 (2026); site 3: 2 and 2; site 4: 2 (2026); site 5: 2 (2026)                                                                                  |
| Richness (qc `pass` only)      | site 1 2026 drops to 2; site 5 2026 drops to 1; the other values are unchanged                                                                                                               |
| `data_exports`                 | Empty                                                                                                                                                                                        |

## Detection CSV fixtures (T12)

Format is CONTRACT section 12. Both fixtures and the starter dataset target **analysis 4** (draft, run 1, COI, no detections), so they may only name libraries `LIB-0001` to `LIB-0008`. **Synthetic**, written for this project; no external data.

### `tests/fixtures/detections_valid.csv`

Imports cleanly. 14 rows over libraries `LIB-0001` to `LIB-0008`, 6 distinct taxa (Labeo rohita, Labeo calbasu, Cirrhinus mrigala, Cyprinus carpio, Gambusia affinis at species rank, and the genus Labeo). After import, analysis 4 would have: 14 detections, 6 taxa, 10 `pass` / 2 `warn` / 2 `fail`, 76 518 reads in total.

| Case covered                                     | Row(s) (file row, header = 1)                                         |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| All three `qc_flag` values                       | pass: many; warn: rows 9 and 12; fail: rows 10 and 15                 |
| `read_count = 0` and `confidence = 0` (boundary) | row 10 (`LIB-0006`, Gambusia affinis)                                 |
| `confidence = 1` (boundary)                      | row 11 (`LIB-0007`, Labeo rohita)                                     |
| 4-decimal ordinary confidences                   | all other rows                                                        |
| Same taxon in several libraries                  | Labeo rohita in libraries 1, 2, 3, 7; Cirrhinus mrigala in 3, 4, 7, 8 |
| Library with one detection                       | `LIB-0002`, `LIB-0004`, `LIB-0006`                                    |
| Library with several detections                  | `LIB-0007` (3), `LIB-0001`, `LIB-0003`, `LIB-0005`, `LIB-0008` (2)    |
| Genus-rank row                                   | row 9 (`LIB-0005`, Labeo, genus, warn)                                |

Richness by site and year (species rank only): site 1 2025 = 2, site 2 2025 = 2, site 3 2025 = 2, site 1 2026 = 4.

### `tests/fixtures/detections_invalid_row.csv`

Same 14 rows in the same order with **exactly one** changed field. The bad row is in the middle.

| Property         | Value                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bad row          | file row 8 (data row 7): `LIB-0009,Cyprinus carpio,species,3060,0.9015,pass`                                                 |
| Field            | `library_code`: `LIB-0009` exists but belongs to run 2, not run 1 (the run of analysis 4)                                    |
| Why it is useful | It passes a format check and is only caught by the "belongs to the run of the target analysis" rule                          |
| Expected error   | `EB002` (rule violation) from `import_detections()`; the API reports row 8, field `library_code`                             |
| Expected outcome | Whole import rejected: analysis 4 keeps 0 detections and stays `draft`; the 6 valid rows before and 7 after are not inserted |

Suggested extra negative fixtures (not created; the contract names exactly two): unknown taxon (D16), wrong rank for a known name, `confidence` above 1, negative `read_count`, duplicate library + taxon pair.

### Checks

`tests/smoke/fixtures.smoke.test.js` fails if a CSV drifts from the seed (library missing or on the wrong run, taxon or rank unknown, wrong counts, the invalid file differing in more than one field). The import-through-`import_detections()` checks are `it.todo` until that procedure exists (T16-A, T32).

## Starter dataset (`datasets/sample_detections.csv`)

**Synthetic.** Source: written for this project. Licence: the project licence; no external data. Produced 2026-10-29 by a throwaway script with fixed seed `20260101` (not committed) from a hand-designed structure, then committed as a plain file. 32 rows over `LIB-0001` to `LIB-0008`, target analysis 4, imports cleanly.

| Property                             | Value                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Flags                                | 19 `pass`, 5 `warn`, 8 `fail`; total 133 953 reads                                                                      |
| Distribution                         | A few high-read rows (Labeo rohita in every library) and a long tail of low-read rows; confidence rises with read count |
| Several sites                        | Labeo rohita, Cirrhinus mrigala and Cyprinus carpio appear at sites 1, 2 and 3                                          |
| One site only                        | Labeo calbasu (site 1 only) and Gambusia affinis (site 3 only)                                                          |
| Richness by site/year (species rank) | site 1 2025 = 4, site 2 2025 = 3, site 3 2025 = 4, site 1 2026 = 4                                                      |

Demo path (T50): upload, review the `warn`/`fail` rows with the QC filter, approve as user 2 (the importer must be a different user), trace in the explorer.

## Volume data (`tests/fixtures/generate-volume-data.js`)

Purpose: enough rows that a sequential scan is visibly slower than an index scan, for the `EXPLAIN (ANALYZE, BUFFERS)` comparisons in T19 and T35. **Test database only**: the generator calls `assertSafeTarget` and refuses any other database.

```bash
cd tests
npm run volume:load -- --dry-run --scale medium   # planned row counts, writes nothing
npm run volume:load -- --scale small              # also: medium (default), large; --seed N
npm run volume:clean                              # removes only IDs >= 1000000; seed rows stay
```

- **IDs:** every volume row has an explicit ID of 1 000 000 or more. Seed rows are below 1000, rows created by tests start at 1000.
- **Deterministic:** a seeded generator (mulberry32, default seed `20260101`) derives each value from (seed, table, row number); two loads with the same seed and scale are byte-identical.
- **Re-running:** a second `volume:load` while volume rows exist is refused with a message; run `volume:clean` first. `volume:clean` deletes table by table (with a `VACUUM` after each, so foreign-key checks stay fast) and is safe to repeat.
- **Constraints and triggers stay on.** Triggers in `database/triggers/` are not applied by the migration runner and are stubs today, so loading writes no `audit_logs` rows of its own beyond the generated ones.
- **Timing:** `small` under 1 s, `medium` about 15 s, clean of `medium` about 3 s (laptop). Run `ANALYZE` at the end of every load.

| Table                                     | small  | medium  | large     |
| ----------------------------------------- | ------ | ------- | --------- |
| `users`                                   | 200    | 2 000   | 10 000    |
| `projects`                                | 20     | 100     | 500       |
| `project_members`                         | 500    | 20 000  | 200 000   |
| `sampling_sites`                          | 200    | 2 000   | 10 000    |
| `project_sites`                           | 400    | 4 000   | 20 000    |
| `collection_events`                       | 1 000  | 20 000  | 100 000   |
| `samples`                                 | 5 000  | 100 000 | 500 000   |
| `sample_status_history` (4 per sample)    | 20 000 | 400 000 | 2 000 000 |
| `dna_extractions`, `sequencing_libraries` | 5 000  | 100 000 | 500 000   |
| `taxon_assignments`                       | 20 000 | 500 000 | 2 000 000 |
| `audit_logs`                              | 20 000 | 500 000 | 2 000 000 |

Also generated: `extraction_batches`, `sequencing_runs`, `analysis_runs`, `taxa`. Users are 200/2 000/10 000 (more than the 50/200/1 000 first suggested) because a project cannot have more members than there are users.

Skewed columns (the hook for T19):

| Column                                | Skew                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `project_members.user_id`             | Member runs start at skewed positions, so low-ID users sit in many projects  |
| `collection_events.project_id`        | A few busy projects carry most events                                        |
| `audit_logs (entity_type, entity_id)` | Entity IDs follow a cubed-uniform draw: a few hot entities have a long trail |
| `audit_logs.actor_id`                 | Squared-uniform: a few busy actors                                           |
| `taxon_assignments.taxon_id`          | Start taxon per library is cubed-uniform: a few common taxa                  |

Evidence at `medium` (before any index, `EXPLAIN (ANALYZE, BUFFERS)`): "projects of user 1000003" scans `project_members` sequentially (153 pages read), "audit trail of entity 1000010" is a parallel sequential scan of `audit_logs` (about 7 000 buffers), and "assignments of taxon 1000005 with `pass`" is a parallel sequential scan of `taxon_assignments` (about 5 500 buffers). T19 should improve all three.

## Source and licence notes for D (T47)

> **Detection fixtures and starter dataset:** `tests/fixtures/detections_valid.csv`, `tests/fixtures/detections_invalid_row.csv` and `datasets/sample_detections.csv` are **synthetic**, written for this project (starter dataset generated with fixed seed `20260101` from a hand-designed structure, 2026-10-29). They contain no external data and are released under the project licence. **Volume data:** generated by `tests/fixtures/generate-volume-data.js` (seeded, synthetic, IDs >= 1 000 000), for the test database only. No real OBIS/GBIF data is included; if added later it must be labelled real with its source and licence (D18).
