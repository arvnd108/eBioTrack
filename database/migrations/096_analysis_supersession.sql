-- Owner: A (Backend)
-- Purpose: analysis_runs.supersedes_analysis_id: the link from a correction to the run it replaces
--
-- CONTRACT 1.3 (sections 3 and 4.4). A correction is a NEW analysis run that names the approved run
-- it corrects here; when the correction is approved, approve_analysis() moves that run to
-- 'superseded' in the same transaction. NULL for ordinary runs. This is a follow-up to 040 (already
-- applied everywhere), so it is its own numbered migration instead of an edit of 040.
--
--   UNIQUE   a run is superseded by at most one correction (several NULLs are allowed)
--   CHECK    a run cannot supersede itself
--   FK       the referenced run must exist; ON DELETE RESTRICT as everywhere (D19)
-- That the referenced run is 'approved' is a status rule, enforced when the correction is approved
-- (approve_analysis() and the T17-A trigger), not by a constraint.

ALTER TABLE analysis_runs
    ADD COLUMN supersedes_analysis_id bigint;

ALTER TABLE analysis_runs
    ADD CONSTRAINT fk_analysis_runs_supersedes_analysis_id FOREIGN KEY (supersedes_analysis_id)
        REFERENCES analysis_runs (analysis_id) ON DELETE RESTRICT,
    ADD CONSTRAINT uq_analysis_runs_supersedes_analysis_id UNIQUE (supersedes_analysis_id),
    ADD CONSTRAINT ck_analysis_runs_supersedes_not_self CHECK (
        supersedes_analysis_id IS NULL OR supersedes_analysis_id <> analysis_id
    );

COMMENT ON COLUMN analysis_runs.supersedes_analysis_id IS
    'The approved run this correction replaces; NULL for ordinary runs. The old run becomes superseded when this one is approved.';
