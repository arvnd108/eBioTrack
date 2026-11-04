# eBioTrack demo script

> **Owner:** D (Docs & Demo)
>
> **Planned run time:** 12 minutes, plus questions. This is a timed run-of-show, not a claim that a rehearsal has been completed. Confirm the event's assigned slot before presenting; shorten the optional benchmark section first if the slot is tighter.

## Before the demo

- Use the isolated demo/test database, never production. Reset and seed it from the repository's documented workflow.
- Confirm the four members can sign in and that each role's access is ready.
- Load the checked-in deterministic synthetic seed data. Do not present it as real field observations.
- Prepare the approved-analysis view and a known sample detection; keep the CSV import fixture and invalid-row fixture ready.
- Verify the app, API, database, and projector/network. If a UI route is not implemented in the current build, use the documented API/SQL evidence or a clearly labelled static capture—do not imply a mock is live functionality.
- Keep secrets and personal data off-screen. Use the seeded development accounts only.

## Timed running order

| Time | Segment / presenter | What to show and say | Required state |
|---|---|---|---|
| 0:00–1:00 (1 min) | Introduction — D (Krishna) | Frame the problem: preserve traceability from field sample to taxon detection. State that the demo records workflow outputs and does not run sequencing or prove abundance/absence. | Opening slide; synthetic demo database ready. |
| 1:00–2:15 (1 min 15 sec) | Data model — D | Walk the ER diagram from project/site/event/sample through extraction/library/analysis/taxon assignment. Highlight keys and provenance path. | ER diagram and normalization slide. |
| 2:15–4:00 (1 min 45 sec) | Field workflow — D with B (Bhumi) | Show/select a site, create or inspect a collection event, register a sample, and point out generated unique code and status history. Show event/sample/measurement atomicity. | UI/API operational, or seeded event 1 and sample 1 available; use a disposable transaction for any live create. |
| 4:00–5:15 (1 min 15 sec) | Lab workflow — B | Trace sample 1 through extraction, QC, library LIB-0001, and RUN-001. Contrast a passing sample with failed sample 17 and explain why QC matters. | Seeded lab records; sample 17 has failed extraction/QC and no library. |
| 5:15–7:15 (2 min) | Analysis import and provenance — A (Arvind) | Show valid CSV validation/import and explain all-or-nothing rollback using the invalid-row fixture. Trace a passing detection from approved analysis 1 through library/sample/event/site. | Valid and invalid import fixtures; approved analysis 1 and its assignments seeded. Use test DB or rollback-safe demo. |
| 7:15–8:30 (1 min 15 sec) | Integrity and access — C (Dhruve) | Show audit history for a change and explain server-side role/project checks. If possible, demonstrate a viewer's denied write without exposing credentials. | Audit trigger enabled; role matrix/accounts prepared; safe disposable write. |
| 8:30–10:30 (2 min) | DBMS concepts and performance — each slice owner | Each owner names one of their own SQL objects (view/procedure/trigger/transaction) and one recorded index result. Use the query-plan report's recorded evidence; do not run destructive benchmark reset steps live. | DBMS demonstration and query-plan report; benchmark results recorded in repository. |
| 10:30–11:15 (45 sec) | Recovery and close — C, then D | C explains snapshot/restore safeguards and limitations. D closes with provenance, approved-only analytics, and scientific caveats. | Backup/recovery runbook; closing slide. |
| 11:15–12:00 (45 sec) | Buffer / handoff | Use for a slow page transition or one short question; do not start a new workflow. | All presenters ready. |

## Fallback plan

1. **UI/API unavailable:** switch to prepared, clearly labelled screenshots or the repository's SQL/API evidence. Explain that the current build does not expose the unavailable step; do not claim a live interaction.
2. **Database unavailable:** use the ER diagram, recorded fixture counts, and saved query-plan excerpts. Do not attempt a production connection or reset a shared database.
3. **Import fails:** show the invalid-row fixture and the documented rollback behavior; use the already-seeded approved analysis for the provenance trace.
4. **Presenter or timing issue:** D narrates the absent segment from its slide; skip the optional index-by-index detail and preserve the end-to-end traceability story.
5. **No network/projector:** use local copies of the slides and screenshots; avoid live external data.

## Rehearsal checklist

- Run the sequence once with a stopwatch and record actual duration; target 11–12 minutes.
- Confirm each member's segment and handoff, including who controls the screen.
- Verify the exact seeded records cited above and reset any disposable writes.
- Check that every chart/table is labelled synthetic or illustrative where applicable.
- Capture unresolved UI gaps and replace any stale screenshots before the presentation.
