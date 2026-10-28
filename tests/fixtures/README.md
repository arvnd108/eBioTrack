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

| Quantity                                   | Value                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `regions` (IDs 1-3)                        | 1 India (country), 2 Yamuna River Basin (basin, parent 1), 3 Hooghly Estuary (other, parent 1)                       |
| `sampling_sites` (IDs 1-5)                 | 1 Dakpathar Barrage, 2 Okhla Barrage, 3 Sangam Prayagraj (rivers, region 2); 4 Diamond Harbour, 5 Kakdwip Bay (estuaries, region 3); `created_by` user 3 |
| `sample_types` (IDs 1-4)                   | water, soil, sediment, air; all 17 samples are type 1 (water)                                                        |
| `collection_events` (IDs 1-8)              | Project 1: events 1-3 in 2025, 4-6 in 2026 (one per site per year); project 2: events 7 (site 4) and 8 (site 5), both 2026. Collector is user 3 |
| `samples` (IDs 1-17)                       | Event n has samples 2n-1 and 2n; sample 17 is on event 1                                                             |
| Sample codes                               | `EB-<YYYYMMDD>-<event 4 digits>-<seq 3 digits>`; 17 distinct, from `EB-20250515-0001-001` to `EB-20260408-0008-002`; sample 17 is `EB-20250515-0001-003` |
| Sample statuses                            | Samples 1-16 `analyzed`, sample 17 `failed`. Lab and analysis seeds must agree (extractions 1-16 `pass`, 17 `fail`)  |
| Samples per site (all years)               | site 1: 5, site 2: 4, site 3: 4, site 4: 2, site 5: 2                                                                |
| Samples per site and year                  | site 1: 3 (2025), 2 (2026); sites 2 and 3: 2 and 2; sites 4 and 5: 2 (2026 only)                                     |
| `environmental_measurements` (IDs 1-32)    | 4 per event: `temperature_c`, `ph`, `dissolved_oxygen_mg_l`, `turbidity_ntu`                                         |
| `sample_status_history` (IDs 1-84)         | 84 rows; samples 1-16 have 5 rows (`collected` -> `stored` -> `extracted` -> `sequenced` -> `analyzed`), sample 17 has 4 (`collected` -> `stored` -> `extracted` -> `failed`). 17 rows have `old_status` NULL |
| `project_sites`                            | 5 rows (see Access slice seed above)                                                                                 |

Every history chain is continuous (each `old_status` equals the previous `new_status`) and only uses transitions allowed in CONTRACT section 3, and each sample's last history row equals `samples.status`.

