# access

> **Owner:** C (Testing & QA)
>
> Slice write-up and normalization notes: Access, Projects & Audit

## Schema

Migration `database/migrations/010_access_projects_audit.sql` (CONTRACT 4.1). The normalization write-up follows in T40.

| Table             | Primary key                                    | Foreign keys                                                  | Other constraints                                                                                                                     |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`           | `pk_roles` (`role_id`)                         | none                                                          | `uq_roles_role_name`, `ck_roles_role_name_lower`, `ck_roles_role_name_not_blank`                                                      |
| `users`           | `pk_users` (`user_id`)                         | none                                                          | `uq_users_email`, `ck_users_email_lower`, `ck_users_email_format`, `ck_users_full_name_not_blank`, `ck_users_password_hash_not_blank` |
| `user_roles`      | `pk_user_roles` (`user_id`, `role_id`)         | `fk_user_roles_user_id`, `fk_user_roles_role_id`              | index `idx_user_roles_role_id`                                                                                                        |
| `projects`        | `pk_projects` (`project_id`)                   | `fk_projects_created_by`                                      | `uq_projects_title`, `ck_projects_title_not_blank`, `ck_projects_dates`, index `idx_projects_created_by`                              |
| `project_members` | `pk_project_members` (`project_id`, `user_id`) | `fk_project_members_project_id`, `fk_project_members_user_id` | partial unique index `uq_project_members_owner` (one owner per project)                                                               |
| `project_sites`   | `pk_project_sites` (`project_id`, `site_id`)   | `fk_project_sites_project_id`; `site_id` FK is added in 090   | index `idx_project_sites_site_id`                                                                                                     |
| `audit_logs`      | `pk_audit_logs` (`audit_id`)                   | `fk_audit_logs_actor_id` (nullable)                           | `ck_audit_logs_entity_type_not_blank`, `ck_audit_logs_details_object`                                                                 |

Database roles and grants: `database/roles/grants.sql` (`ebiotrack_readonly`, `ebiotrack_app`, `ebiotrack_admin`).

## Queries and open decisions (T14-C)

Queries live in `database/queries/access_queries.sql`; expected results for the seed are in the file and in `tests/fixtures/README.md`.

| Statement                   | Parameters                                                  | Used by                                                  |
| --------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| `access_user_projects`      | `$1` user_id, `$2` project_status or NULL                   | `GET /api/projects` (T20), `v_user_project_access` (T15) |
| `access_project_members`    | `$1` project_id or NULL                                     | `GET /api/projects/:id` (T20), `v_project_summary` (T15) |
| `access_entity_audit_trail` | `$1` entity_type, `$2` entity_id, `$3`/`$4` from/to or NULL | `GET /api/audit` (T20)                                   |

### 1. Inactive users (decision for A / Arvind)

`access_user_projects` returns zero rows for an unknown or `users.active = false` user. `authorize.js` does not check `active` (login does), so a deactivated user with an open session still passes `requireProjectAccess`. Proposed fix, in A's files (not changed here): reject inactive users where the session is loaded, or add `AND u.active` to the membership lookup in `requireProjectAccess` and to `accessibleProjectIds`:

```sql
SELECT pm.project_role
  FROM projects p
  JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = $2
  JOIN users u ON u.user_id = pm.user_id AND u.active
 WHERE p.project_id = $1
```

Until then the middleware is more permissive than the query; the query is the safer reference.

### 2. Audit "own" scoping (T20)

`access_entity_audit_trail` is unscoped. For a `principal_investigator` the caller must first check that the entity belongs to one of their projects (`accessibleProjectIds(user)` gives the project ids; map the entity to its project, for example `samples` via `collection_events.project_id`, `projects` directly) and return 404 otherwise. Administrators are unrestricted; other roles cannot read audit (CONTRACT 9).

### 3. `audit_logs.details` shape (decided in T17-C)

CONTRACT 4.1 only says `details` is a JSON object of changed columns with old and new values. Decision, implemented by `audit_row_change()`:

| Action                                 | `details`                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `insert`                               | `{ "<column>": { "new": v }, ... }` for the inserted columns                                           |
| `update`                               | `{ "<column>": { "old": v1, "new": v2 }, ... }` for **changed** columns only                           |
| `delete`                               | `{ "<column>": { "old": v }, ... }`                                                                    |
| `login`, `export`, `approve`, `reject` | `NULL` or a small object chosen by the caller (written by procedures or the app, never by the trigger) |

Top-level keys are column names, so the trail query's `changed_fields` is exactly the set of changed columns. Rules: `password_hash` is never logged, and neither are columns passed as extra trigger arguments; an update that changes nothing (after those exclusions) writes no row; for composite-key link tables `entity_id` is the parent id and the whole row is in `details`.

## Views (T15-C)

Defined in `database/views/access_views.sql` (`CREATE OR REPLACE VIEW`, read-only, no `password_hash`). Installed by `migrate.js` (views and procedures after the migrations, triggers after the seeds, re-applied on every run); to apply by hand, `psql -f database/views/access_views.sql`. Views have no order; consumers add `ORDER BY`. If a column list changes later, `DROP VIEW` first.

### `v_user_project_access`

One row per (user, project) the user can access. `SELECT ... FROM v_user_project_access WHERE user_id = $1` returns the same rows as `access_user_projects($1, NULL)` (checked for users 1-6 and 999; Query 1 columns `title`/`status` are `project_title`/`project_status` here).

| Column                            | Type                 | Meaning / source                                                             |
| --------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `user_id`, `full_name`, `email`   | bigint, text, text   | `users`; active users only                                                   |
| `project_id`                      | bigint               | `projects.project_id`                                                        |
| `project_title`, `project_status` | text, project_status | `projects.title`, `projects.status`                                          |
| `access_via`                      | text                 | `'administrator'` (global role) or `'membership'`                            |
| `project_role`                    | project_role         | `project_members.project_role`; NULL for an administrator with no membership |
| `can_edit`                        | boolean              | administrator, or project role owner/manager                                 |

Rules: administrators see every project; others only their memberships; an administrator who is also a member appears once, as `administrator`; inactive users have no rows. **Contains emails**: keep behind `authorize` (administrator, or the caller's own `user_id`). Seed: 9 rows (user 1: projects 1, 2; users 2, 3: 1, 2; users 4, 5, 6: project 1).

```sql
SELECT project_id, project_title, access_via, project_role, can_edit
  FROM v_user_project_access WHERE user_id = 3 ORDER BY project_id;
```

### `v_project_summary`

One row per project, including projects with no members, sites or events (counts are 0, owner NULL). Each child table is aggregated separately, so counts are not multiplied.

| Column                                                                  | Type         | Meaning / source                                                                              |
| ----------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `project_id`, `title`, `status`, `start_date`, `end_date`, `created_by` |              | `projects`                                                                                    |
| `owner_id`, `owner_name`                                                | bigint, text | the member with role `owner`; NULL if none                                                    |
| `member_count`, `manager_count`, `contributor_count`, `viewer_count`    | bigint       | `project_members` (owner counted in `member_count` only); agree with `access_project_members` |
| `site_count`                                                            | bigint       | `project_sites`                                                                               |
| `event_count`                                                           | bigint       | `collection_events.project_id`                                                                |
| `sample_count`                                                          | bigint       | `samples` of those events                                                                     |

Seed: project 1: 5 members (0 manager, 3 contributor, 1 viewer), 3 sites, 6 events, 13 samples; project 2: 2 members (0, 1, 0), 2 sites, 2 events, 4 samples (17 in total).

```sql
SELECT project_id, title, owner_name, member_count, sample_count
  FROM v_project_summary ORDER BY project_id;
```

### Installation and grants

`migrate.js` applies `database/views/*.sql` right after the migrations, so a freshly migrated database and the test database have the views. `ebiotrack_readonly` has SELECT on both views. `ebiotrack_app` has SELECT only: `grants.sql` revokes the INSERT/UPDATE/DELETE that table-level grants would give it, and neither view is automatically updatable anyway. Default privileges give new views write rights again, so re-run `database/roles/grants.sql` after views are created or re-created. Both views are owned by `ebiotrack`, the role named in the default privileges.

## Procedure (T16-C)

`create_project_with_owner(p_title text, p_objectives text, p_start_date date, p_owner_id bigint) RETURNS bigint` in `database/procedures/access_procedures.sql` (installed by `migrate.js`, `SECURITY INVOKER`, no dynamic SQL). It inserts a `planned` project (`created_by` = owner) and the `owner` membership, and returns the new `project_id` (ids start at 1000 and can have gaps). Every project must be created through it: `uq_project_members_owner` only guarantees at most one owner, this function guarantees at least one.

Checks run in this order and stop at the first problem:

| Problem                                                          | SQLSTATE | API mapping             |
| ---------------------------------------------------------------- | -------- | ----------------------- |
| Title `NULL` or blank                                            | `23514`  | 422 `validation_error`  |
| Title already used (also a concurrent duplicate)                 | `23505`  | 409 `duplicate`         |
| `p_owner_id` `NULL`                                              | `EB002`  | 422 `rule_violation`    |
| Owner does not exist                                             | `23503`  | 422 `invalid_reference` |
| Owner deactivated (`users.active = false`)                       | `EB002`  | 422 `rule_violation`    |
| Owner holds neither `administrator` nor `principal_investigator` | `EB002`  | 422 `rule_violation`    |

**Role check is an interpretation** (CONTRACT 9 says who may create projects; the signature has one `p_owner_id`, which is both creator and owner). `authorize('create_project')` must stay on the route. To drop the check, delete the "Allowed to create projects" block in the function.

All or nothing holds as long as the caller's transaction ends in `COMMIT` or `ROLLBACK` (a failed membership insert aborts the transaction; no `EXCEPTION` block swallows errors). Concurrent calls with the same title: the second blocks on `uq_projects_title`, then fails with `23505` if the first committed, or succeeds if it rolled back. The owner row is locked `FOR SHARE` so the checks and the insert see the same user. If `app.current_user_id` is not set, the owner is recorded as the actor.

```sql
SELECT create_project_with_owner('New survey', 'Objectives', DATE '2026-06-01', 2);  -- new project_id
```

From the backend: `callProcedure('create_project_with_owner', [title, objectives, startDate, req.user.user_id], client)` inside `withTransaction`.

## Audit trigger (T17-C)

`audit_row_change()` in `database/triggers/access_triggers.sql` is an `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW` trigger function (`SECURITY INVOKER`, no dynamic SQL). It writes one `audit_logs` row per changed row: `entity_type` = table name, `entity_id` = the key column named by `TG_ARGV[0]`, `action` = `insert`/`update`/`delete`, `actor_id` from `app.current_user_id`, `details` as decided above. Attached here to `users` (leaving out `last_login_at`), `user_roles`, `projects`, `project_members` and `project_sites`.

**Attach it from your slice** (A, B, D), after the table's own status-transition trigger:

```sql
CREATE OR REPLACE TRIGGER trg_<table>_audit
    AFTER INSERT OR UPDATE OR DELETE ON <table>
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('<pk_column>');
```

Optional extra arguments are columns to leave out of the log (a noisy timestamp). For a composite key pass the parent id column. Never attach it to `audit_logs`, `schema_migrations`, `schema_seeds` or `sessions`. `access_triggers.sql` must sort first (the runner applies triggers alphabetically); do not rename it.

Behaviour and traps:

- **Actor:** unset or empty `app.current_user_id` gives `actor_id` NULL (system action); digits give that user; anything else gives NULL plus a `WARNING`. A well-formed id that is not a user (for example `99999`) fails with `23503` and rolls back the business write, on purpose.
- **Seeds:** triggers are installed after the seeds, so a fresh `db:reset --seed` leaves `audit_logs` empty. `reseed()` (tests) re-runs seeds with the triggers present, so it truncates `audit_logs` (restarting the identity) at the end.
- **Append-only:** the trigger runs as the caller; `ebiotrack_app` can insert audit rows but `UPDATE`/`DELETE` on `audit_logs` fail with `42501`.
- **Volume data:** `generate-volume-data.js` disables the audit triggers while loading and cleaning (and re-enables them), so synthetic rows are not audited. Performance runs (T35) should measure with the triggers present and absent.
- **Misuse** (no key argument, key column missing, statement-level trigger) raises `22023` naming the table.

## Transaction scenario (T18-C)

`database/transactions/access_transaction.sql` is a demonstration script (not a migration, not a test; the runner never executes it). Scenario: **project onboarding**. User 2 creates a project with its owner (`create_project_with_owner()`), adds users 3 and 4 as contributors and user 6 as viewer, and links sites 1 and 4, in one transaction that either commits completely or leaves no trace, audit rows included.

Run it by hand (`ON_ERROR_STOP` stays off because the script fails on purpose):

```bash
docker compose exec -T db psql -U ebiotrack -d ebiotrack -f - < database/transactions/access_transaction.sql
psql "$DATABASE_URL" -f database/transactions/access_transaction.sql
psql "$TEST_DATABASE_URL" -v keep=1 -f database/transactions/access_transaction.sql   # test database only
```

Every transaction ends in `ROLLBACK`, so the default run leaves the database unchanged and can be repeated (generated ids move on, which is normal). With `-v keep=1` the Part 1 transaction ends in `COMMIT` to show durability; a second `keep=1` run stops in Part 0 because the project exists. Remove it by resetting the test database; never use `keep=1` on the development database. Isolation is the default `READ COMMITTED`, like the backend; each transaction starts with `SET LOCAL app.current_user_id = '2'`, like `withTransaction`.

| Part | What it shows |
|---|---|
| 0 | Preflight (objects, fixtures, no leftover demo project) and the baseline counts, including the highest `audit_id` |
| 1 | Commit path: project, 4 members (one owner), 2 sites, **7 audit rows** all with actor 2 and the project id as `entity_id`; `ROLLBACK` by default, `COMMIT` with `keep=1` |
| 2 | Rollback A: after project, members and a site succeeded, a second owner fails with `23505` on `uq_project_members_owner`; the next statement fails with `25P02`; after `ROLLBACK` nothing remains, not even audit rows |
| 3 | Rollback B (five transactions): viewer as owner `EB002`, seeded title `23505`, blank title `23514`, unknown site `23503` on `fk_project_sites_site_id` (the project created one statement earlier disappears too), and B5: unknown member 999 without a savepoint, `23503` on `fk_project_members_user_id`, no project or members remain |
| 4 | `SAVEPOINT`: unknown member 999 fails (`23503`), `ROLLBACK TO SAVEPOINT`, user 3 is added; the failed insert left no audit row |
| 5 | Two-session protocol in comments: duplicate title blocks on `uq_projects_title`, uncommitted work is invisible, `FOR SHARE` on the owner blocks `UPDATE users SET active = false` |

| Property | Where shown |
|---|---|
| Atomicity | Part 1 (7 audit rows with 1 project), Parts 2 and 3 (nothing remains after the failure) |
| Consistency | Part 3 (constraints and procedure rules, CONTRACT 7 codes) |
| Isolation | Part 5 (blocking on the unique index, invisibility of uncommitted work, `FOR SHARE` on the owner) |
| Durability | Part 1 with `keep=1` (committed project survives the session; reset removes it) |

Excerpt of a default run (26 checks, 0 failed):

```
PASS: 7 audit rows (1 project, 4 members, 2 sites), all actor 2, all entity_id = the project
ROLLBACK
PASS: projects, members, sites and audit rows are back at the baseline
Caught SQLSTATE 23505 duplicate key value violates unique constraint "uq_project_members_owner"
PASS: the aborted transaction refused the next statement with 25P02
PASS: B4 raised 23503 on fk_project_sites_site_id
PASS: the project created before the failing statement is gone
Summary: 26 checks passed, 0 checks failed.
```

Notes:

- Part 2 adds user 5 as a second owner, not user 3 again: re-adding an existing member fails first on the primary key `pk_project_members`, so only a non-member reaches `uq_project_members_owner`.
- B2 checks the SQLSTATE; the constraint name `uq_projects_title` is printed by the verbose error (the procedure raises it with that constraint field), not by `LAST_ERROR_MESSAGE`.
- With `keep=1`, Parts 2 to 4 use the title `T18 onboarding demo project (after commit)` because the first title is taken by then.
- T32 (`tests/transactions/project-create.test.js`) automates the Part 2 and 3 assertions; the Part 5 duplicate-title race becomes the project-creation case of T34.
