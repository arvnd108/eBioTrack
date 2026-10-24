# Member A — Backend (and platform/DevOps)

**Assigned to:** Dhruve

**Database slice:** Access, Projects & Audit

Related documents: [TEAM_ROLES](../TEAM_ROLES.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [WORKFLOW](../WORKFLOW.md)

---

## 1. Your role

You build the server that everything else talks to and the foundation the team develops on. That means the repository setup, the migration runner, the Express API, authentication and authorization, and every API route for all slices. You also own the database slice for users, roles, projects, and audit, which is the part of the schema the rest of the system depends on for security.

The frontend (B) calls your routes, the tests (C) exercise them, and the docs (D) describe them, so consistency matters more than speed.

## 2. What you need to do

**Platform**
- Repo scaffold, `.env` handling, `docker-compose.yml` for local PostgreSQL, `.gitignore`
- DB connection pool, parameterized-query and transaction helpers
- Migration runner that applies `database/migrations/` in numeric order
- Request validation, a consistent error format, pagination, response helpers

**Security**
- Sessions, password hashing, role and project-level authorization middleware
- Database roles and grants

**API (all slices)**
- Routes, controllers, and services for: auth, projects, audit, sites, events, samples, extractions, sequencing, analyses (import and approve), taxa, analytics, exports
- CSV import validation and CSV export
- Call each member's stored procedures and transactions from the services

**Database slice: Access, Projects & Audit**

| Tables (7) | `users`, `roles`, `user_roles`, `projects`, `project_members`, `project_sites`, `audit_logs` |
|---|---|

| Deliverable | Detail |
|---|---|
| Migration and constraints | PK, FK, UNIQUE, CHECK, NOT NULL for the slice (`010`), plus shared extensions/enums (`001`) and cross-slice FKs (`090`) |
| 3 complex queries | Projects a user can access via role and membership; members per project; audit trail of one entity over time |
| 2 views | `v_user_project_access`, `v_project_summary` |
| 1 stored procedure | `create_project_with_owner()` |
| 1 trigger | Generic audit trigger function writing to `audit_logs`. Other members attach it to their tables |
| 1 transaction | Create a project and add members atomically; roll back on a bad member |
| 2 indexes | `project_members(user_id, project_id)`, `audit_logs(entity_type, entity_id, created_at)`, justified with `EXPLAIN (ANALYZE, BUFFERS)` |
| Extras | Backup and restore scripts, database roles and grants |
| Write-up | Slice and normalization notes in `docs/slices/access.md`, handed to D |

## 3. Files and folders you own

| Area | Path |
|---|---|
| Backend | `backend/**` (everything: config, db, middleware, utils, routes, controllers, services, `package.json`) |
| Root config | `.gitignore`, `.env.example`, `docker-compose.yml` |
| Shared migrations | `database/migrations/001_extensions_and_enums.sql`, `database/migrations/090_cross_slice_constraints.sql` |
| Your slice | `database/migrations/010_access_projects_audit.sql`, `database/seeds/010_seed_access.sql` |
| | `database/views/access_views.sql`, `database/procedures/access_procedures.sql`, `database/triggers/access_triggers.sql` |
| | `database/queries/access_queries.sql`, `database/indexes/access_indexes.sql`, `database/transactions/access_transaction.sql` |
| Security and recovery | `database/roles/grants.sql`, `database/backup/backup.sh`, `database/backup/restore.sh` |
| Docs input | `docs/slices/access.md` |

`090_cross_slice_constraints.sql` is shared: you maintain it, but each member adds their own cross-slice foreign keys through a pull request.

## 4. Your workflow

Follow this order. Task IDs match [WORKFLOW.md](../WORKFLOW.md).

1. **T00** Take part in the contract workshop (tables, keys, statuses, endpoint list). Everyone does this first.
2. **T01** Repo setup, pool, query helpers, migration runner. Merge early; the others need the runner.
3. **T02** Access migration and DB roles/grants.
4. **T10** API foundation: validation, errors, pagination.
5. **T06** Cross-slice constraints, once D, B, and C have merged their migrations. Confirm the database builds from scratch (gate G1).
6. **T11** Seed rows for your slice, using the agreed ID ranges.
7. **T13** Auth: sessions, password hashing, authorize middleware.
8. Your slice SQL, in this order: **T14** queries → **T15** views → **T16** procedure → **T17** audit trigger function (merge this first so others can attach it) → **T18** transaction → **T19** indexes.
9. **T37** Backup and restore scripts.
10. **T20 – T23** API routes as the stored procedures land: projects/audit, then sites/events/samples, then extractions/sequencing, then analyses/taxa/analytics/exports.
11. **T40** Write up your slice.
12. **T50 – T52** End-to-end run and demo rehearsal with everyone.

Branches: `a/<task-id>-<short-name>` (for example `a/t13-auth`). One pull request per task; Arvind reviews and merges it (you cannot merge to `main` yourself).

## 5. Tasks you can start now

After the contract workshop (T00), these have no other prerequisites:

- **T01** Repo setup, `docker-compose`, pool, migration runner
- **T02** Access migration (`010`) and DB roles/grants
- **T10** API foundation (once T01 is merged)

You can also begin drafting your slice's queries, views, and procedure from your table design, and stub route handlers using the agreed endpoint list.

## 6. Tasks that need someone else first

| Your task | Needs | From | While you wait |
|---|---|---|---|
| T06 Cross-slice FKs | T03, T04, T05 (their migrations) | D, B, C | Finish T02, T10, T13 |
| T21 Sites, events, samples routes | T16-D `register_sample()` | D | Build the route and service against the agreed procedure signature with a stub |
| T22 Extractions and sequencing routes | T16-B `create_sequencing_run()` | B | Same: use the agreed signature |
| T23 Analyses, taxa, analytics routes | T16-C `approve_analysis()` and T12 import fixtures | C | Build CSV validation and routes against the contract |
| T37 Backup and restore | T06 (your own) and a seeded database | You | Write the scripts, test once seeds load |
| T50 End-to-end run | Everyone's work (gates G4, G5) | All | Fix bugs in your routes |

Your own prerequisites inside your slice (for example T13 after T02, T01, T10; T20 after T13 and T16-A) are in [WORKFLOW.md](../WORKFLOW.md).

## 7. Who is waiting on you

| Person | Task | Waiting for |
|---|---|---|
| Everyone | Running migrations locally | T01 migration runner |
| B, C, D | Loading seeds | T06 (G1) |
| B | T24 real login | T13 auth |
| B | T25 – T28 integrate pages | T20 – T23 routes |
| C | T33 authorization tests | T13, T20 |
| B, C, D | Attaching the audit trigger to their tables | T17-A audit function |
| C, D | T36 recovery test, T44 backup doc | T37 scripts |
| D | T42 final `api.md` | T20 – T23 routes |

If you are late on T01, T13, or T17-A, the whole team is blocked, so give those priority.

## 8. Rules and done criteria

- Controllers contain no SQL. Services use parameterized queries, views, and stored procedures only.
- Every protected route passes `auth` and `authorize`.
- If a route's request or response shape changes from the contract, tell B and D and update the contract in one pull request.
- Done means: merged, covered by tests (C), documented in your slice write-up, and listed in the progress tracker.
