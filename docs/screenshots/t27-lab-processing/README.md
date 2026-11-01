# T27 screenshots: Lab processing

For the user guide (T46). Taken at 1280 px wide from the real API (`VITE_USE_MOCK=false`) on a freshly migrated and seeded Postgres 16, in the Asia/Kolkata time zone, signed in as each seeded user (all share the development password in `tests/fixtures/README.md`). Some content was created through the app first, as the screenshots show: Farah Field (field researcher) recorded event 1000 with two samples and stored them; Lakshmi Lab (lab technician) then created batch #1000, recorded an extraction of each sample, passed one and failed the other, recorded a contamination check, created RUN-1000 from three passed extractions, added a fourth library and started the run. Names come from the API, so every role sees them (you see "You" for your own entries).

| File                            | Shows                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `01-extractions.png`            | Extractions tab: sample, attempt, batch, measurements, QC verdict, the run an extraction is booked on, Edit |
| `02-record-extraction-form.png` | Record an extraction: project, sample (failed and discarded samples are not offered), batch, measurements   |
| `03-qc-verdict-confirm.png`     | Pass / Fail on a pending extraction, with the second click that makes the verdict final                     |
| `04-new-batch-form.png`         | New extraction batch: lab, date (2000-01-01 to tomorrow), kit, notes                                        |
| `05-extraction-batches.png`     | Extraction batches, with the operator and a link to each batch's extractions                                |
| `06-qc-results.png`             | QC results tab, newest first, with sample codes and who recorded them                                       |
| `07-record-qc-result-form.png`  | Record a QC result for a sample (or, with the radio button, for an analysis)                                |
| `08-new-run-form.png`           | New sequencing run: lab, platform, date, and a choice of QC-passed extractions not booked on another run    |
| `09-run-planned.png`            | A planned run: Start run / Mark failed, libraries with their source samples, Add library                    |
| `10-run-running.png`            | The run after Start run: Mark completed / Mark failed; no more libraries can be added                       |
| `11-runs-list.png`              | Sequencing runs tab with lab and status filters                                                             |
| `12a`, `12b`                    | Administrator: Extractions tab, RUN-002 (all 8 libraries, status controls)                                  |
| `13a`, `13b`                    | Principal investigator: same pages, same controls in their projects                                         |
| `14a`, `14b`                    | Field researcher: read-only (record_lab is for principal investigators and lab technicians)                 |
| `15a`, `15b`                    | Analyst: read-only; RUN-002 shows only the libraries of their project                                       |
| `16a`, `16b`                    | Viewer: read-only                                                                                           |
