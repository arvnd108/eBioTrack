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

| File                               | Owner | Task | Status  |
| ---------------------------------- | ----- | ---- | ------- |
| `detections_valid.csv`             | C     | T12  | planned |
| `detections_invalid_row.csv`       | C     | T12  | planned |
| volume-data generator (fixed seed) | C     | T12  | planned |
| `datasets/sample_detections.csv`   | C     | T12  | planned |

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

_To be filled in T11/T31 once the seeds are merged. Do not invent numbers._

| Quantity                   | Expected | Derived from |
| -------------------------- | -------- | ------------ |
| Roles                      | 6        | CONTRACT 6   |
| Seeded users               | 6        | CONTRACT 6   |
| Projects                   | 2        | CONTRACT 6   |
| Collection events          | 8        | CONTRACT 6   |
| Samples                    | 17       | CONTRACT 6   |
| Environmental measurements | 32       | CONTRACT 6   |
| Everything else            | TBD      | T11/T31      |

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
