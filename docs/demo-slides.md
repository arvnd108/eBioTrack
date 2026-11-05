# eBioTrack demo slides — presenter outline

Use this as a slide-ready outline alongside [the timed demo script](demo-script.md). Visuals come from the finished UI: the screenshots under `docs/screenshots/` (T25 to T29) are ready to paste; label any capture as a capture when it is shown instead of the live page.

## Slide 1 — eBioTrack: traceable eDNA research (D, 1 min)
- Problem: records are fragmented across field, lab, and analysis.
- Promise: linked provenance and controlled review—not sequencing or species-abundance measurement.
- **Visual:** one-line workflow from site to approved detection.

## Slide 2 — Relational model and normalization (D, 1 min 15 sec)
- Show project → site → event → sample → extraction → library → analysis → assignment → taxon.
- Call out primary/foreign keys, many-to-many relationships, and sample-code uniqueness.
- **Visual:** combined ER diagram; avoid unreadable full-schema zoom.

## Slide 3 — Field collection (D + B, 1 min 45 sec)
- Site/event/sample; generated sample code; status timeline and environmental measurements.
- Atomic event + samples + measurements.
- **Visual:** `screenshots/t26-map-events-samples/04-new-event-form.png` and `05-event-detail.png`.

## Slide 4 — Lab processing and QC (B, 1 min 15 sec)
- Extraction batch, QC, sequencing library/run.
- Contrast sample 1 (passing path) with sample 17 (failed QC, no library).
- **Visual:** `screenshots/t27-lab-processing/01-extractions.png` and `09-run-planned.png`.

## Slide 5 — Import, approval, and provenance (A, 2 min)
- Valid CSV import; invalid-row all-or-nothing rollback.
- Trace an approved, QC-passing detection back to its field sample.
- **Visual:** `screenshots/t28-analysis-species-analytics/04-dry-run-errors.png`, `06-imported.png` and `13-species-search-and-detections.png`.

## Slide 6 — Audit and authorization (C, 1 min 15 sec)
- Audit trail records changes; project membership and role checks gate access.
- Demonstrate a safe denied action if the UI/test environment supports it.
- **Visual:** `screenshots/t25-projects-admin/08-admin-audit-log-administrator.png` and the role table of the user guide; no credentials on screen.

## Slide 7 — DBMS evidence and recovery (all, 2 min 45 sec)
- Each member: one object/concept and one recorded query-plan improvement.
- C: backup is a verified snapshot; restore target must be safe/empty; no point-in-time recovery.
- **Visual:** concept-to-object table, before/after plan excerpt, recovery flow.

## Slide 8 — Scientific interpretation and close (D, 45 sec)
- Only approved analyses with passing QC enter documented summaries.
- Detection is not abundance; non-detection is not confirmed absence.
- **Visual:** concise takeaways and questions.
