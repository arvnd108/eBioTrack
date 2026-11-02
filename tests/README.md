# README

> **Owner:** C (Testing & QA)
>
> How to run the `tests/` suites

```bash
docker compose up -d db && cp -n .env.example .env   # once, from the repo root
cd tests && npm ci
npm test                    # everything (serial; migrates and seeds ebiotrack_test first)
npm run test:smoke          # one suite (also: integrity, queries, transactions, concurrency, authorization, recovery)
npm run lint && npm run format
```

If the database is unreachable, DB suites are skipped locally with a message. With `CI=true` the run fails instead.

## Integrity suite (`integrity/`, T30)

Proves that the database itself refuses bad data: NOT NULL, PRIMARY KEY, UNIQUE, FOREIGN KEY and CHECK violations (SQLSTATE and constraint name), enum values, the state machines of CONTRACT 3 (`samples`, `analysis_runs`, `sequencing_runs`, `dna_extractions.qc_status`; every (from, to) pair, `EB001`) and the business-rule triggers (`EB002`).

```bash
npm run test:integrity                                  # the four slice files, the guard and audit-trigger.test.js
npx vitest run integrity/lab                            # one slice
INTEGRITY_REPORT=1 npx vitest run integrity/constraint-coverage --reporter=verbose   # name -> file table
```

**Add a case.** Every test runs inside `withRollback(...)`; nothing is committed. Use the helpers in `setup/integrity.js`:

- `inSavepoint(client, fn)` keeps the transaction usable after an error (`{ keep: false }` rolls a successful probe back too).
- `expectViolation(promise, code, constraint?, messageFragment?)` asserts the SQLSTATE and, for constraints, `err.constraint`; always pass the constraint name.
- `insertRow` / `updateRow` take column objects (bound parameters); `newProject`, `newSample`, `newAnalysis`, ... build valid rows with ids captured by `RETURNING`. Build a negative row from a valid one and break exactly one thing.
- New constraint or CHECK: add the name to the matching table in the slice file (the `fks`, `pks`, `checks` arrays or a dedicated `it`), with the allowed counterpart and, for CHECKs, both sides of the boundary.

**Coverage guard (`integrity/constraint-coverage.test.js`).** Reads `pg_constraint` (`pk_`, `fk_`, `uq_`, `ck_`), `uq_` unique indexes and user triggers, and fails, listing the names, when no integrity file mentions one as a plain string. Add the test, or (rarely, with a reason) an entry to `ALLOWLIST`. Stale allowlist entries fail too.

**Defects and gaps.** A test written from the spec that fails because the database is wrong stays as it is, marked `it.fails(...)` with `// DEFECT: ... (owner: X)`; remove the marker when fixed. Spec silences are marked `// CONTRACT GAP`.

## Query suites (`queries/`, T31)

Proves that every prepared statement in `database/queries/*_queries.sql` and every view in `database/views/*.sql` returns the right rows on the fixture world. Each query has one `describe` block with: A golden values derived by hand (derivation in comments), B an oracle written differently (plain joins, filtering and grouping in JavaScript), C filters and NULL parameters, D metamorphic cases (a change inside a rolled-back transaction moves the result as predicted), E documented columns and types, F determinism (repeat, generic and custom plan, several session time zones for date-sensitive cases).

```bash
npm run test:queries                                    # the four slice files, the guard
npx vitest run queries/analysis --reporter=verbose      # one slice
QUERY_REPORT=1 npx vitest run queries/query-coverage    # name -> file table
```

**Helpers (`setup/queries.js`).** `openQuerySession(slice)` runs the committed file on a dedicated connection (prepared statements are per session) and returns `execute(name, params)`, `columns`, `queryView(view, { where, params, orderBy })`, `sql` for oracle SQL, and `rollback(fn)`. Make fixture changes inside `session.rollback(async (db) => ...)` so they run on the same connection as the statements; do not use `withRollback`, which takes a different connection. `acrossSettings(session, check, { zones })` repeats a check per time zone and plan mode. Types: bigint and numeric are strings, int4 a number, `date` the `YYYY-MM-DD` text, timestamptz an ISO UTC string.

**Coverage guard (`queries/query-coverage.test.js`).** Reads the PREPARE names and view names from the SQL and fails, listing them, when no `describe` title in the query suites contains one. Add the block or (rarely, with a reason) an `ALLOWLIST` entry.

**Defects and gaps.** As for integrity: `it.fails(...)` with `// DEFECT:` and `// CONTRACT GAP` markers. The helper has a self-test in `smoke/queries-helpers.smoke.test.js`.
