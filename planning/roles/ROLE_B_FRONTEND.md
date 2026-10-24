# Member B — Frontend

**Assigned to:** Bhumi

**Database slice:** Laboratory & Sequencing

Related documents: [TEAM_ROLES](../TEAM_ROLES.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [WORKFLOW](../WORKFLOW.md)

---

## 1. Your role

You build everything users see: the React app, its pages, charts, and the sampling map. You turn the API into forms, tables, timelines, and dashboards, and you make sure scientific caveats (a detection is not abundance, a non-detection is not absence) are visible wherever results are shown. You also own the database slice for the laboratory workflow, which covers extractions, QC, sequencing libraries, and sequencing runs.

## 2. What you need to do

**Frontend**
- App shell, routing, auth-aware layout and protected routes, API client, shared form/table components, loading and error states
- Pages: Login, Dashboard, Projects, Sampling map (Leaflet), Collection events, Samples (registry and detail with status timeline), Lab processing, Analysis import (upload, preview errors, validate, commit), Species explorer, Biodiversity analytics (Recharts), Administration, and optional ML insights
- Caveat banner on analytics and species pages (uncertainty, effort, QC flags, non-detection wording)
- Responsive layout and client-side form validation

**Database slice: Laboratory & Sequencing**

| Tables (6) | `laboratories`, `extraction_batches`, `dna_extractions`, `sequencing_runs`, `sequencing_libraries`, `quality_control_results` |
|---|---|

| Deliverable | Detail |
|---|---|
| Migration and constraints | PK, FK, UNIQUE, CHECK, NOT NULL (`030`); CHECK constraints on concentrations and QC values |
| 3 complex queries | Extractions per batch with QC pass rate; libraries per run with source samples; samples with failed or contaminated QC |
| 2 views | `v_lab_pipeline_status`, `v_failed_qc` |
| 1 stored procedure | `create_sequencing_run()` (assign libraries to a run) |
| 1 trigger | Block adding a library from an extraction that failed QC |
| 1 transaction | Batch extraction entry; row locking so two users cannot assign the same extraction to a run |
| 2 indexes | `dna_extractions(sample_id)`, `sequencing_libraries(run_id)`, justified with `EXPLAIN (ANALYZE, BUFFERS)` |
| Write-up | Slice and normalization notes in `docs/slices/lab.md`, handed to D |

## 3. Files and folders you own

| Area | Path |
|---|---|
| Frontend | `frontend/**` (`package.json`, `index.html`, `src/main.tsx`, `App.tsx`, `routes.tsx`, `context/`, `services/`, `hooks/`, `components/` (layout, common, charts, maps), `pages/`, `types/`, `styles/`) |
| Your slice | `database/migrations/030_lab_sequencing.sql`, `database/seeds/030_seed_lab.sql` |
| | `database/views/lab_views.sql`, `database/procedures/lab_procedures.sql`, `database/triggers/lab_triggers.sql` |
| | `database/queries/lab_queries.sql`, `database/indexes/lab_indexes.sql`, `database/transactions/lab_transaction.sql` |
| Docs input | `docs/slices/lab.md` |

## 4. Your workflow

Task IDs match [WORKFLOW.md](../WORKFLOW.md).

1. **T00** Take part in the contract workshop. Pay particular attention to the endpoint list and response shapes, since your mock API is built from them.
2. **T04** Lab migration.
3. **T08** Frontend scaffold: app shell, routing, API client with a mock mode.
4. **T11** Seed rows for your slice, using the agreed ID ranges (load after the schema is complete).
5. **T24** Shared components, auth context, login page.
6. Your slice SQL, in this order: **T14** queries → **T15** views → **T16** procedure → **T17** trigger (attach A's audit function once it exists) → **T18** transaction → **T19** indexes.
7. **T25 – T28** Pages, using mock responses first, then integrating with the real routes as A delivers them: Projects and Administration; Map, Events, Samples; Lab processing; Analysis import, Species explorer, Analytics.
8. **T29** Dashboard (needs the other pages).
9. **T40** Write up your slice.
10. **T50 – T52** End-to-end run and demo rehearsal.

Branches: `b/<task-id>-<short-name>` (for example `b/t24-shared-ui`). One pull request per task; Arvind reviews and merges it (you cannot merge to `main` yourself).

## 5. Tasks you can start now

After the contract workshop (T00):

- **T04** Lab migration
- **T08** Frontend scaffold with a mock API client, built from the agreed response shapes

You can also draft your slice's queries, views, and procedure from your table design, and build static versions of pages with mock data.

## 6. Tasks that need someone else first

| Your task | Needs | From | While you wait |
|---|---|---|---|
| T11 Load your seeds | T06 schema complete (G1) | A | Write the seed file from the agreed ID ranges |
| T17 Attach audit trigger | T17-A generic audit function | A | Write your own trigger (block library from failed extraction) first |
| T19 Indexes with `EXPLAIN` | T12 volume data | C | Write the index definitions; run the comparison once the data exists |
| T24 Real login | T13 auth | A | Use the mock API client |
| T25 Projects and Administration pages integration | T20 routes | A | Build against mock responses |
| T26 Map, Events, Samples integration | T21 routes | A | Same |
| T27 Lab processing integration | T22 routes (calls your `create_sequencing_run()`, T16-B) | A | Same; deliver your procedure early so A can wire it |
| T28 Import, Explorer, Analytics integration | T23 routes | A | Same |
| T50 End-to-end run | Everyone's work (gates G4, G5) | All | Fix UI bugs |

## 7. Who is waiting on you

| Person | Task | Waiting for |
|---|---|---|
| A | T22 lab routes | Your `create_sequencing_run()` (T16-B) |
| A | T06 cross-slice FKs | Your migration (T04) |
| C | T12 fixtures | Library codes from your seeds (T11) |
| C | T34 concurrency test, T35 benchmarks | Your procedure and indexes (T16-B, T19-B) |
| D | T46 user guide, screenshots | Your pages (T25 – T29) |
| D | T41 normalization report | Your slice write-up (T40) |

## 8. Rules and done criteria

- The frontend talks only to `/api`, never to the database.
- Keep types in `src/types/` in line with the response shapes in the contract. If a shape changes, tell A and D.
- Every analytics page shows the caveat banner and surfaces quality and effort flags.
- Done means: page works against the real route, handles loading, empty, and error states, is merged, and has screenshots for D.
