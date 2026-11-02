# T29 screenshots: Dashboard

For the user guide (T46). Taken at 1280 px wide from the real API (`VITE_USE_MOCK=false`) on a freshly migrated and seeded Postgres 16, in the Asia/Kolkata time zone, signed in as each seeded user (all share the development password in `tests/fixtures/README.md`). Some content was created first, each step with that person's own session and the same API calls the pages make: Farah Field (field researcher) recorded event 1000 at Okhla Barrage with two samples and stored one; Lakshmi Lab (lab technician) recorded an extraction of it (QC pending); Anil Analyst (analyst) created analysis #1000 and imported `tests/fixtures/detections_valid.csv`; Pranav Investigator (principal investigator) approved it and created the project "Chambal Pilot"; the administrator added Meera Student, a viewer in no project yet.

| File                                         | Shows                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `01-principal-investigator-all-projects.png` | Counts for all the user's projects (each opens its page), the caveat, "Waiting for you" and the five newest audit entries with names |
| `02-principal-investigator-one-project.png`  | The project selector: the same counts and activity for one project, kept in the URL (`?project_id=1`)                                |
| `03-new-project-without-samples.png`         | A new project: zero counts and a link to record its first collection event                                                           |
| `04-administrator.png`                       | Administrator: every project and every audit entry (their own sign-in shows as "You")                                                |
| `05-field-researcher.png`                    | Field researcher: counts, samples waiting to be stored; no audit activity (not their role)                                           |
| `06-lab-technician.png`                      | Lab technician: extractions waiting for a QC verdict, samples waiting to be stored                                                   |
| `07-analyst.png`                             | Analyst: draft analyses waiting for their CSV                                                                                        |
| `08-viewer.png`                              | Viewer: counts and links only                                                                                                        |
| `09-user-in-no-project.png`                  | Someone in no project yet: what to do next instead of zeros                                                                          |
| `10-full-audit-log-link.png`                 | "Full audit log" opens the Administration page on its Audit log tab (`/admin?tab=audit`)                                             |
