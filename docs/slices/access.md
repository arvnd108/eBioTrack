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

### 3. Proposed `audit_logs.details` shape (decision for T17-C)

CONTRACT 4.1 only says `details` is a JSON object of changed columns with old and new values. Proposal for `audit_row_change()`, so that `changed_fields` in the trail query is meaningful:

| Action                                 | `details`                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `insert`                               | `{ "<column>": { "new": v }, ... }` for the inserted columns                 |
| `update`                               | `{ "<column>": { "old": v1, "new": v2 }, ... }` for **changed** columns only |
| `delete`                               | `{ "<column>": { "old": v }, ... }`                                          |
| `login`, `export`, `approve`, `reject` | `NULL` or a small object chosen by the caller                                |

Top-level keys are column names, so the trail query's `changed_fields` is exactly the set of changed columns. The query reads no key itself, so a different shape would not break it, only make `changed_fields` less useful. This is a proposal, not part of the contract.

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
