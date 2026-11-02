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

## Transaction suites (`transactions/`, T32)

Proves, with real commits and rollbacks over real connections, that the multi-step operations are atomic, consistent, isolated and durable: the import and approval of detections (`import-rollback.test.js`), project onboarding (`project-create.test.js`) and the Lab and Field scenarios (`scenario-parity.test.js`). They are the automated twin of `database/transactions/*.sql`; unlike the integrity and query suites they COMMIT.

```bash
npm run test:transactions
npx vitest run transactions/project --reporter=verbose
```

| Scenario                                                                         | T18 script part it mirrors               |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| Analysis: valid import commits 14, approval is one unit, audit rows              | `analysis_transaction.sql` Part 1        |
| Analysis: the bad row and the injected-error matrix leave nothing                | Part 2, Part 3                           |
| Analysis: savepoint recovery (bad file, then the good one)                       | Part 4                                   |
| Access: onboarding commits 1 project, 4 members, 2 sites, 7 audit rows           | `access_transaction.sql` Part 1          |
| Access: second owner, unknown site or member, procedure errors, injected failure | Part 2, Part 3                           |
| Access: savepoint around one bad member                                          | Part 4                                   |
| Lab: run with libraries, failed-QC extraction, already-booked extraction         | `lab_transaction.sql` Parts 1, 3, 4      |
| Field: event + measurements + samples, bad sample undoes the event               | `field_transaction.sql` Parts 1, 2, 3, 4 |

**Helper (`setup/transactions.js`).**

- `runTransaction(fn, { actorId })` mirrors the backend `withTransaction` line by line (the table is in the file's header comment): the original error is rethrown unchanged, so `expect(err).toBe(injected)` works.
- `observer()` is a second autocommit connection (READ COMMITTED, `lock_timeout` 5 s) that never joins the transaction. It proves "invisible before COMMIT, visible after, gone after ROLLBACK".
- `snapshot(client)` returns row counts of every table, max primary keys and md5 fingerprints of the tables under test; "nothing happened" means snapshot before equals snapshot after. Never compare generated ids for equality.
- `committed()` marks a test as committing; `restoreIfCommitted()` (in `afterAll`) reseeds. Group committing scenarios in one `describe` with a `beforeAll` commit and many read-only assertions, so a file reseeds once or twice. The last `afterAll` of every file checks the seeded counts (2 projects, 17 samples, 43 detections, 0 audit rows).
- `assertGlobalInvariants(client)` runs after every test: one owner per project, approved analyses have approver and time, draft analyses have no detections, history matches sample status, audit details are objects.
- `csvToRows(csvText, client)` builds the payload the backend service builds from a CSV.

**Rules.** Audit rows are counted by `audit_id > baseline`, never as absolute numbers. Assert the first error's SQLSTATE and a message fragment (a later `25P02` is a consequence). Concurrency races are T34, not here. The helper has a self-test in `smoke/transactions-helpers.smoke.test.js`.

`applyGrants()` (in `setup/transactions.js`) runs `database/roles/grants.sql`. Neither `migrate.js` nor CI applies that file and `smoke/harness` recreates the schema, so any test that uses the `ebiotrack_app` role applies it first.

## Authorization suites (`authorization/`, T33)

Everything goes through the real Express app over HTTP (`fetch` against `http.createServer(app).listen(0)`) with the real session cookie, on the test database. `setup/api.js` refuses to start unless `NODE_ENV=test` and the backend database is the test database.

| File                        | What it proves                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `permission-matrix.test.js` | CONTRACT 9 as a typed table, six roles x every CONTRACT 10 endpoint (denied is exactly 403), multi-role users, administrator bypass    |
| `session-auth.test.js`      | 401 everywhere, login errors and lockout (429), cookie flags, fixation, logout, immediate effect of deactivation and role change, CSRF |
| `project-access.test.js`    | Membership: non-member 404, viewer read-only, manager and owner rules, scoped lists, audit scope, project creation                     |
| `data-scope.test.js`        | IDOR across projects, exports of the requester only, unapproved detections, mass assignment, D17 approver rule, hostile input, verbs   |

**Matrix source.** `MATRIX` in `setup/api.js` is typed by hand from CONTRACT section 9 (it is never imported from `backend/src/middleware/permissions.js`, which is the thing under test). Coverage guards fail if a CONTRACT 10 endpoint, a mounted route or a matrix row has no counterpart; the only allowlisted route is `GET /api/health`. To add an endpoint, add a row to `ENDPOINTS` with its action and a probe that passes the gate and then fails validation, so no data changes.

**Helper (`setup/api.js`).**

- `startApi()` / `stopApi()` start and close the in-process server; one pair per file, inside a single `describe.skipIf(!dbAvailable)`.
- `loginAll()` returns one client per seeded role (`users.viewer.get(...)`); `anonymous()` has no cookie. Clients keep a cookie jar, `opts.cookie` overrides it.
- `assertNo5xx()` (in `afterEach` and `afterAll`) fails on any 5xx seen since the last call.
- `addGlobalRole`, `setProjectRole`, `setActive`, `expireSessions` change the world by SQL and mark the test as committing; `restoreIfCommitted()` reseeds in `afterAll`. `limiter().clear()` ends a lockout window without waiting.
- Passwords, cookies and session ids are never logged; `session-auth` scans every observed body for hashes and the dev password.

**Findings** are listed in the PR: defects are `it.fails` with `// DEFECT: ... (owner: A)`, spec silence is a `// CONTRACT GAP` comment.

## Concurrency suites (`concurrency/`, T34)

Every race is run twice: against the stored functions with real parallel database connections (the guarantee), and through the HTTP API with parallel requests (the guarantee as the product exposes it: `409`/`422` instead of a `500`). Assertions are invariants (exactly one success, the documented SQLSTATE for every loser, the final state), never timing or "who wins".

| File                      | Races                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `double-approval.test.js` | approve x20, approve vs reject, approve vs insert of a detection (both lock orders), double import, supersession, REPEATABLE READ, deadlock check        |
| `run-assignment.test.js`  | one extraction on N runs, overlapping lists in opposite order, create vs assign, run leaving `planned`, QC verdict vs booking, isolation levels, `55P03` |
| `other-races.test.js`     | helper self-test, same-title projects, owner deactivated mid-creation (`FOR SHARE`), parallel `register_sample`, parallel sample status                  |

**Claim -> proof.**

| Claim (source)                                                                          | Test                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 20 approvals: 1 success, 19 `EB003`, one audit footprint (analysis header, T18 Part 6)  | `double-approval` A, API "10 parallel approves"                         |
| The loser really waits on the winner's row lock                                         | `double-approval` B, `run-assignment` C (hold + `waitUntilBlocked(by)`) |
| Approved result never changes under the approver (`FOR SHARE` in the detection trigger) | `double-approval` D                                                     |
| Correction locks itself, then the old run; old run superseded once                      | `double-approval` F, H                                                  |
| Extraction rows locked `FOR UPDATE` in ascending id order: no deadlock                  | `run-assignment` B                                                      |
| One planned/running run per extraction; losers `EB002`, nothing partial                 | `run-assignment` A, D, API                                              |
| REPEATABLE READ refused, SERIALIZABLE safe, READ COMMITTED never `40001`                | `run-assignment` F, `double-approval` G                                 |
| Same title: one wins, `23505` (409 `duplicate`)                                         | `other-races` Access                                                    |
| Owner row `FOR SHARE`: no deactivation between the checks and the membership insert     | `other-races` "owner deactivated"                                       |
| Event row `FOR UPDATE`: distinct, gapless sample codes                                  | `other-races` Field                                                     |

**Helper (`setup/concurrency.js`).**

- `openSessions(n)` opens `n` dedicated `pg.Client`s (not the pool) at READ COMMITTED with `lock_timeout` 10 s and `statement_timeout` 20 s; close them in `finally` / `afterAll` (`closeSessions`). Keep `n` at or below 20 (`max_connections` is 100).
- `race(sessions, calls, { actor, isolation })`: every session `BEGIN`s and sets the actor first, then one shared promise releases all calls in the same tick; COMMIT after a success, ROLLBACK after an error. Results are `{ ok, value }` or `{ ok: false, code, message, detail }`; `summarise()` and `forbiddenCodes()` (`40P01`, `40001`) read them.
- Hold pattern: `await a.begin(2); await a.query(...)` keeps A's locks; start B with `settle(...)`, `await waitUntilBlocked(observer, b.pid, { by: a.pid })` (bounded polling of `pg_stat_activity` and `pg_blocking_pids`, fails with the activity list), then `a.commit()` or `a.rollback()`.
- Fixture factories create fresh committed rows through the real procedures: `newImportedAnalysis`, `newApprovedAnalysis`, `newDraftAnalysis`, `newPassedExtractions(n, { qc })`, `newEvent`. `prng()`/`shuffled()` replace `Math.random`.
- Everything commits, so each file ends with `restoreIfCommitted()` (reseed). The API session cookies die with the reseed: each file logs in again in `beforeAll`.

**Proving the tests can fail.** `setupTestDatabase` re-applies `database/procedures/*.sql` on every run, so a broken variant must be edited into the repo file (never committed), the suite run, then `git checkout` the file. Removing `FOR UPDATE` from `fn_analysis_lock` turns 11 `double-approval` tests red; locking extractions in the caller's order (no sort) turns both `B` tests red with `40P01`.
