# T25 screenshots: Projects and Administration

For the user guide (T46). Taken at 1280 px wide from the real API (`VITE_USE_MOCK=false`) on a freshly migrated and seeded Postgres 16, signed in as each seeded user (all share the development password in `tests/fixtures/README.md`). One extra project, "Chilika Lagoon Pilot", and one extra user, "Meera Nair", were created through the app first so the lists and the audit log have content.

| File | Shows |
|---|---|
| `01-login.png` | Sign-in page (real API, so no mock-user panel) |
| `02-projects-list-administrator.png` | Project list: an administrator sees every project |
| `03-new-project-form-administrator.png` | New project form (administrators and principal investigators) |
| `04-project-detail-administrator.png` | Project detail with members and sites |
| `05-admin-users-administrator.png` | Administration, Users tab |
| `06-admin-new-user-form.png` | New user form |
| `07-admin-edit-own-account-locked-controls.png` | Editing your own account: administrator role and Active are locked, with the reason |
| `08-admin-audit-log-administrator.png` | Audit log tab |
| `09-projects-list-principal-investigator.png` | Project list for a principal investigator (own projects) |
| `10-project-detail-principal-investigator-owner.png` | Project owner: edit, add and remove members, link and unlink sites |
| `11-edit-project-form.png` | Edit project form |
| `12-admin-audit-log-principal-investigator.png` | A principal investigator sees only the audit log, for their own projects |
| `13a`, `13b`, `13c` | Field researcher: project list, project (read-only), Administration (not permitted) |
| `14a`, `14b`, `14c` | Lab technician: same three pages |
| `15a`, `15b`, `15c` | Analyst: same three pages |
| `16a`, `16b`, `16c` | Viewer: same three pages |
