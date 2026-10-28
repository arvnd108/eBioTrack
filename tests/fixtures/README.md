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
