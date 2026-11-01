# T28 screenshots: Analysis import, Species explorer, Biodiversity analytics

For the user guide (T46). Taken at 1280 px wide from the real API (`VITE_USE_MOCK=false`) on a freshly migrated and seeded Postgres 16, in the Asia/Kolkata time zone, signed in as each seeded user (all share the development password in `tests/fixtures/README.md`). Some content was created through the app first, as the screenshots show: Anil Analyst (analyst) created analysis #1000 for RUN-001, checked `tests/fixtures/detections_invalid_row.csv` (one row error), then checked and imported `tests/fixtures/detections_valid.csv`; Pranav Investigator (principal investigator) approved #1000, rejected the seeded imported analysis #3 with a reason, and created and imported #1001 for RUN-002 himself (so he may not approve it). Names come from the API, so every role sees them (you see "You" for your own entries).

| File                                      | Shows                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `01-analyses-list.png`                    | Analysis import: every analysis of the user's projects, with status, what it waits for, run, marker, pipeline and people     |
| `02-new-analysis-form.png`                | New analysis: run (with its library codes), marker, pipeline, reference database, parameters as JSON                         |
| `03-draft-import-step.png`                | A draft: the CSV rules, a template download, Check file and Import                                                           |
| `04-dry-run-errors.png`                   | Check file found a problem: row 8 uses a library of another run; nothing is saved and Import stays off                       |
| `05-dry-run-clean.png`                    | A clean check: "All 14 rows are valid", Import 14 detections                                                                 |
| `06-imported.png`                         | After the import: status Imported, 10 pass / 2 warn / 2 fail, waiting for a principal investigator                           |
| `07-approve-or-reject.png`                | Principal investigator: Approve (only pass detections will count) or Reject with a reason                                    |
| `08-approved.png`                         | Approved, with who approved it and when                                                                                      |
| `09-rejected.png`                         | Rejected #3 with the reason, who and when                                                                                    |
| `10-importer-cannot-approve.png`          | The person who imported an analysis cannot approve it (another principal investigator must); Reject is still offered         |
| `11-rejection-seen-by-analyst.png`        | The analyst sees why #3 was rejected                                                                                         |
| `12-correction-form.png`                  | Start a correction of approved #2: settings copied, "Corrects analysis #2"; #2 is superseded when the correction is approved |
| `13-species-search-and-detections.png`    | Species explorer: search "rohita", lineage, caveat, detection frequency by site, detections with links to their samples      |
| `14-species-genus.png`                    | A genus: lower taxa, and no detections identified only to the genus                                                          |
| `15-species-download.png`                 | Download CSV for one project, with the caveat next to the downloaded file                                                    |
| `16-analytics-by-year.png`                | Biodiversity analytics: observed species per year and site, sampling effort in the caveat, chart and table                   |
| `17-analytics-by-site-with-frequency.png` | Grouped by site for one project (richness CSV download), and the detection frequency of Cirrhinus mrigala                    |
| `18a`, `18b`                              | Administrator: draft #4 (import and reject), analytics                                                                       |
| `19a`, `19b`                              | Principal investigator: same controls in their projects                                                                      |
| `20a`, `20b`                              | Field researcher: Analysis import is not permitted (no sidebar link either); analytics read-only                             |
| `21a`, `21b`                              | Lab technician: as the field researcher, project 1 only                                                                      |
| `22a`, `22b`                              | Analyst: import into draft #4, no approve or reject; analytics of project 1                                                  |
| `23a`, `23b`                              | Viewer: Analysis import not permitted; analytics read-only                                                                   |
