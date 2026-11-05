# eBioTrack demo script

> **Owner:** D (Docs & Demo)
>
> **Planned run time:** 12 minutes, plus questions. This is a timed run-of-show, not a claim that a rehearsal has been completed. Confirm the event's assigned slot before presenting; shorten the optional benchmark section first if the slot is tighter.

## Before the demo

- Use the isolated demo/test database, never production. Reset and seed it with `cd backend && npm run db:reset`, then start the API (`npm run dev`) and the frontend with `VITE_USE_MOCK=false`. Reset again before every rehearsal and before the real demo: the import step uses up the seeded draft analysis #4.
- Sign in as each seeded user in its own browser profile before you start: `principal_investigator@`, `field_researcher@`, `lab_technician@`, `analyst@`, `viewer@` and `administrator@ebiotrack.test` (development password in `tests/fixtures/README.md`). Never show the password on screen.
- Load the checked-in deterministic synthetic seed data. Do not present it as real field observations.
- Keep `tests/fixtures/detections_valid.csv` and `tests/fixtures/detections_invalid_row.csv` ready to upload (14 valid rows; the invalid file fails on row 8, a library of another run).
- Verify the app, API, database, and projector/network. Every page in the sidebar is implemented against the real API; if one fails on the day, use the screenshots in `docs/screenshots/` (labelled as captures) rather than implying it is live.
- Keep secrets and personal data off-screen. Use the seeded development accounts only.

## Timed running order

| Time | Segment / presenter | What to show and say | Required state |
|---|---|---|---|
| 0:00–1:00 (1 min) | Introduction — D (Krishna) | Frame the problem: preserve traceability from field sample to taxon detection. State that the demo records workflow outputs and does not run sequencing or prove abundance/absence. | Opening slide; synthetic demo database ready. |
| 1:00–2:15 (1 min 15 sec) | Data model — D | Walk the ER diagram from project/site/event/sample through extraction/library/analysis/taxon assignment. Highlight keys and provenance path. | ER diagram and normalization slide. |
| 2:15–4:00 (1 min 45 sec) | Field workflow — D with B (Bhumi) | On **Sampling map** open a site, then **Collection events → New event** (as the field researcher): add one measurement and one sample, save, and point out the generated code and the status history on the sample page. Show that event, sample and measurement are saved together. | Field researcher signed in; project 1 and its sites seeded. The new event is rolled away by the next reset. |
| 4:00–5:15 (1 min 15 sec) | Lab workflow — B | In **Lab processing** (as the lab technician) show sample 1's extraction with a Pass verdict, then **Sequencing runs → RUN-001** with library LIB-0001. Contrast with failed sample 17 (failed extraction, no library) and explain why QC gates sequencing. | Seeded lab records; sample 17 has failed extraction/QC and no library. |
| 5:15–7:15 (2 min) | Analysis import and provenance — A (Arvind) | In **Analysis import** (as the analyst) open draft #4: **Check file** with the invalid fixture (nothing saved, row 8 reported), then the valid fixture and **Import**. Switch to the principal investigator and **Approve** (the importer cannot). In **Species explorer** search "rohita" and follow a detection to its sample, event and site. | Seeded draft analysis #4 (not yet imported) and approved analyses 1 and 2; both fixture files. |
| 7:15–8:30 (1 min 15 sec) | Integrity and access — C (Dhruve) | In **Administration → Audit log** (as the administrator) show the entries for the demo's own changes, with names. Sign in as the viewer to show a page with no action buttons and no **Analysis import** link; explain that the API enforces the same rules. | Audit triggers installed (default); viewer account ready. |
| 8:30–10:30 (2 min) | DBMS concepts and performance — each slice owner | Each owner names one of their own SQL objects (view/procedure/trigger/transaction) and one recorded index result, using [dbms-demonstration.md](dbms-demonstration.md) for a snippet to run live (rolled back) and [query-plan-report.md](query-plan-report.md) for the recorded before/after. Do not run benchmark reset steps live. | DBMS demonstration and query-plan report; benchmark results recorded in repository. |
| 10:30–11:15 (45 sec) | Recovery and close — C, then D | C explains snapshot/restore safeguards and limitations. D closes with provenance, approved-only analytics, and scientific caveats. | Backup/recovery runbook; closing slide. |
| 11:15–12:00 (45 sec) | Buffer / handoff | Use for a slow page transition or one short question; do not start a new workflow. | All presenters ready. |

## Fallback plan

1. **UI/API unavailable:** switch to the labelled screenshots in `docs/screenshots/` or to the SQL snippets in the DBMS demonstration guide. Say that it is a capture; do not claim a live interaction.
2. **Database unavailable:** use the ER diagram, recorded fixture counts, and saved query-plan excerpts. Do not attempt a production connection or reset a shared database.
3. **Import fails:** show the invalid-row fixture and the documented rollback behavior; use the already-seeded approved analysis for the provenance trace.
4. **Presenter or timing issue:** D narrates the absent segment from its slide; skip the optional index-by-index detail and preserve the end-to-end traceability story.
5. **No network/projector:** use local copies of the slides and screenshots; avoid live external data.

## Rehearsal checklist

- Run the sequence once with a stopwatch and record the actual duration here before the demo; target 11–12 minutes. The 12-minute plan is a budget, not a measured time.
- Confirm each member's segment and handoff, including who controls the screen.
- Verify the exact seeded records cited above and reset any disposable writes.
- Check that every chart/table is labelled synthetic or illustrative where applicable.
- Capture unresolved UI gaps and replace any stale screenshots before the presentation.
