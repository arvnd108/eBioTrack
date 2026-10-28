# Member A — Backend (platform/DevOps, and optional ML)

**Assigned to:** Arvind

**Database slice:** Analysis, Taxonomy & Analytics

Related documents: [TEAM_ROLES](../TEAM_ROLES.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [WORKFLOW](../WORKFLOW.md) · [CONTRACT](../CONTRACT.md)

---

## 1. Your role

You build the server that everything else talks to and the foundation the team develops on. That means the repository setup, the migration runner, the Express API, authentication and authorization, and every API route for all slices. You also own the database slice for analysis, taxonomy, and analytics, which holds the most join-heavy queries and the transactional import and approval workflow, and you own the optional ML module.

You are also the repository owner: you review and merge every pull request.

The frontend (B) calls your routes, the tests (C) exercise them, and the docs (D) describe them, so consistency matters more than speed.

## 2. What you need to do

**Platform**
- Repo scaffold, `.env` handling, `docker-compose.yml` for local PostgreSQL, `.gitignore`
- DB connection pool, parameterized-query and transaction helpers
- Migration runner that applies `database/migrations/` in numeric order, then `090`, then seeds
- Request validation, a consistent error format, pagination, response helpers

**Security**
- Sessions, password hashing, role and project-level authorization middleware

**API (all slices)**
- Routes, controllers, and services for: auth, projects, audit, sites, events, samples, extractions, sequencing, analyses (import and approve), taxa, analytics, exports
- CSV import validation and CSV export
- Call each member's stored procedures and transactions from the services

**Optional ML module**
- Anomaly-detection experiment (Python) on approved richness data, with model versions, input dataset versions, and evaluation metrics stored. Output is always labelled exploratory, never a verified occurrence.

**Database slice: Analysis, Taxonomy & Analytics**

| Tables (5) | `dna_markers`, `analysis_runs`, `taxa`, `taxon_assignments`, `data_exports` |
|---|---|

| Deliverable | Detail |
|---|---|
| Migration and constraints | PK, FK, UNIQUE, CHECK, NOT NULL (`040`) |
| 3 complex queries | Taxa detected at a site; taxon richness by site and year; detection history for a taxon (recursive CTE over the taxonomy) |
| 2 views | `v_approved_detections`, `v_site_richness` |
| 1 stored procedure | `approve_analysis()`: `SELECT ... FOR UPDATE`, insert detections, mark approved, write audit (plus `import_detections()` and `reject_analysis()` from the contract) |
| 1 trigger | Block edits to approved results |
| 1 transaction | CSV import where an invalid row rolls back the whole import; double-approval protection |
| 2 indexes | `taxon_assignments(taxon_id)`, `taxon_assignments(analysis_id)`, justified with `EXPLAIN (ANALYZE, BUFFERS)` |
| Write-up | Slice and normalization notes in `docs/slices/analysis.md`, handed to D |

## 3. Files and folders you own

| Area | Path |
|---|---|
| Backend | `backend/**` (everything: config, db, middleware, utils, routes, controllers, services, `package.json`) |
| Root config | `.gitignore`, `.env.example`, `docker-compose.yml` |
| Shared migrations | `database/migrations/001_extensions_and_enums.sql`, `database/migrations/090_cross_slice_constraints.sql` |
| Your slice | `database/migrations/040_analysis_taxonomy.sql`, `database/seeds/040_seed_analysis.sql` |
| | `database/views/analysis_views.sql`, `database/procedures/analysis_procedures.sql`, `database/triggers/analysis_triggers.sql` |
| | `database/queries/analysis_queries.sql`, `database/indexes/analysis_indexes.sql`, `database/transactions/analysis_transaction.sql` |
| Optional ML | `ml/**` |
| Docs input | `docs/slices/analysis.md` |

`090_cross_slice_constraints.sql` is shared: you maintain it, but each member adds their own cross-slice foreign keys through a pull request.

## 4. Your workflow

Follow this order. Task IDs match [WORKFLOW.md](../WORKFLOW.md).

1. **T00** Take part in the contract workshop (tables, keys, statuses, endpoint list). Everyone does this first.
2. **T01** Repo setup, pool, query helpers, migration runner. Merge early; the others need the runner.
3. **T05** Analysis migration.
4. **T10** API foundation: validation, errors, pagination.
5. **T06** Cross-slice constraints, once C, D, and B have merged their migrations. Confirm the database builds from scratch (gate G1).
6. **T11** Seed rows for your slice, using the agreed ID ranges.
7. **T13** Auth: sessions, password hashing, authorize middleware. It reads the users and roles tables, so it needs C's Access migration (T02).
8. Your slice SQL, in this order: **T14** queries → **T15** views → **T16** procedures (`approve_analysis()` needs T06 and C's audit function T17-C) → **T17** trigger → **T18** transaction → **T19** indexes. Queries and views need all four slices seeded (G2).
9. **T20 – T23** API routes as the stored procedures land: projects/audit, then sites/events/samples, then extractions/sequencing, then analyses/taxa/analytics/exports.
10. **T38** Optional anomaly-detection experiment, once approved detections exist.
11. **T40** Write up your slice.
12. **T50 – T52** End-to-end run and demo rehearsal with everyone.

Branches: `a/<task-id>-<short-name>` (for example `a/t13-auth`). One pull request per task. You are the only reviewer: you review and merge everyone's pull requests, and your own are merged by you once CI passes.

## 5. Tasks you can start now

After the contract workshop (T00), these have no other prerequisites:

- **T01** Repo setup, `docker-compose`, pool, migration runner
- **T05** Analysis migration (`040`)
- **T10** API foundation (once T01 is merged)

You can also begin drafting your slice's queries, views, and procedures from your table design, and stub route handlers using the agreed endpoint list.

## 6. Tasks that need someone else first

| Your task | Needs | From | While you wait |
|---|---|---|---|
| T06 Cross-slice FKs | T02, T03, T04 (their migrations) | C, D, B | Finish T05, T10 |
| T13 Auth | T02 Access migration (users and roles tables) | C | Build the session and middleware scaffolding; plug in the queries when T02 lands |
| T14 / T15 Cross-slice queries and views | G2: all four seed files loaded | C, B, D | Write the SQL against the schema; verify when seeds load |
| T16 `approve_analysis()` | T06 and the audit function (T17-C) | C | Write the locking and import logic; plug in the audit call when available |
| T19 Indexes with `EXPLAIN` | T12 volume data | C | Write the index definitions; run the comparison once the data exists |
| T20 Projects and audit routes | T13 and `create_project_with_owner()` (T16-C) | C | Build the routes against the agreed signature with a stub |
| T21 Sites, events, samples routes | T16-D `register_sample()` | D | Same: use the agreed signature |
| T22 Extractions and sequencing routes | T16-B `create_sequencing_run()` | B | Same |
| T23 Analyses, taxa, analytics routes | T12 import fixtures for CSV validation | C | Build CSV validation against the contract |
| T38 Optional ML | Approved detections (G2 plus your T23) | You | Prototype on the fixture dataset |
| T50 End-to-end run | Everyone's work (gates G4, G5) | All | Fix bugs in your routes |

## 7. Who is waiting on you

| Person | Task | Waiting for |
|---|---|---|
| Everyone | Running migrations locally | T01 migration runner |
| B, C, D | Loading seeds | T06 (G1) |
| B | T24 real login | T13 auth |
| B | T25 – T28 integrate pages | T20 – T23 routes |
| C | T33 authorization tests | T13, T20 |
| C | T34 concurrency tests, T35 benchmarks | Your `approve_analysis()` (T16-A) and indexes (T19-A) |
| D | T21-related and T42 final `api.md` | T20 – T23 routes |
| D | T41 normalization report | Your slice write-up (T40) |

If you are late on T01 or T13, the whole team is blocked, so give those priority.

## 8. Rules and done criteria

- Controllers contain no SQL. Services use parameterized queries, views, and stored procedures only.
- Every protected route passes `auth` and `authorize`.
- If a route's request or response shape changes from the contract, tell B and D and update the contract in one pull request.
- Done means: merged, covered by tests (C), documented in your slice write-up, and listed in the progress tracker.
