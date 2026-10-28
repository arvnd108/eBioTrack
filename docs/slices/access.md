# access

> **Owner:** C (Testing & QA)
>
> Slice write-up and normalization notes: Access, Projects & Audit

## Schema

Migration `database/migrations/010_access_projects_audit.sql` (CONTRACT 4.1). The normalization write-up follows in T40.

| Table | Primary key | Foreign keys | Other constraints |
| --- | --- | --- | --- |
| `roles` | `pk_roles` (`role_id`) | none | `uq_roles_role_name`, `ck_roles_role_name_lower`, `ck_roles_role_name_not_blank` |
| `users` | `pk_users` (`user_id`) | none | `uq_users_email`, `ck_users_email_lower`, `ck_users_email_format`, `ck_users_full_name_not_blank`, `ck_users_password_hash_not_blank` |
| `user_roles` | `pk_user_roles` (`user_id`, `role_id`) | `fk_user_roles_user_id`, `fk_user_roles_role_id` | index `idx_user_roles_role_id` |
| `projects` | `pk_projects` (`project_id`) | `fk_projects_created_by` | `uq_projects_title`, `ck_projects_title_not_blank`, `ck_projects_dates`, index `idx_projects_created_by` |
| `project_members` | `pk_project_members` (`project_id`, `user_id`) | `fk_project_members_project_id`, `fk_project_members_user_id` | partial unique index `uq_project_members_owner` (one owner per project) |
| `project_sites` | `pk_project_sites` (`project_id`, `site_id`) | `fk_project_sites_project_id`; `site_id` FK is added in 090 | index `idx_project_sites_site_id` |
| `audit_logs` | `pk_audit_logs` (`audit_id`) | `fk_audit_logs_actor_id` (nullable) | `ck_audit_logs_entity_type_not_blank`, `ck_audit_logs_details_object` |

Database roles and grants: `database/roles/grants.sql` (`ebiotrack_readonly`, `ebiotrack_app`, `ebiotrack_admin`).
