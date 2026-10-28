-- Owner: B (Frontend)
-- Purpose: 3 complex queries: Laboratory & Sequencing
--
-- Issue #18 / T14-B. Each query is a prepared statement: the SQL between AS and the semicolon is
-- exactly what the backend sends through `pg` with $1, $2 placeholders (D9), and the EXECUTE
-- line under it runs the documented example. Run the whole file with:
--
--   psql "$DATABASE_URL" -f database/queries/lab_queries.sql
--
-- Pass NULL for an optional filter to mean "all". Expected results are for the seeded fixture
-- world (seeds 010 to 040; lab rows from 030_seed_lab.sql) and were worked out by hand from the
-- seed files, then confirmed by running this file.

DEALLOCATE ALL;  -- lets the file run more than once in the same session

-- ============================================================================================
-- Q1. Extractions per batch with QC pass rate
-- ============================================================================================
-- Question: for each extraction batch, which lab ran it, how many extractions did it hold, and
--           what share passed QC?
-- Parameters: $1 lab_id (bigint, NULL = all labs)
-- DBMS concepts: inner + LEFT OUTER JOIN (a batch with no extractions still appears with 0),
--           GROUP BY with aggregate FILTER clauses, NULLIF to avoid division by zero.
-- Note: pass_rate_pct is over all extractions in the batch, pending ones included, so an
--       unfinished batch shows a lower rate rather than a misleading 100%.
--
-- Expected (all labs):
--   batch_id | lab_name                  | extraction_date | extractions | passed | failed | pending | pass_rate_pct
--   1        | Dehradun eDNA Laboratory  | 2025-05-20      | 7           | 6      | 1      | 0       | 85.7
--   2        | Dehradun eDNA Laboratory  | 2026-03-16      | 6           | 6      | 0      | 0       | 100.0
--   3        | Kolkata Estuarine Gen...  | 2026-04-10      | 4           | 4      | 0      | 0       | 100.0
--   (batch 1 = samples 1-6 and 17; 6 of 7 passed = 85.7%. With $1 = 1: batches 1 and 2 only.)

PREPARE q1_extraction_qc_by_batch(bigint) AS
SELECT
    b.batch_id,
    l.name                                                       AS lab_name,
    b.extraction_date,
    b.kit_name,
    COUNT(x.extraction_id)                                       AS extractions,
    COUNT(x.extraction_id) FILTER (WHERE x.qc_status = 'pass')   AS passed,
    COUNT(x.extraction_id) FILTER (WHERE x.qc_status = 'fail')   AS failed,
    COUNT(x.extraction_id) FILTER (WHERE x.qc_status = 'pending') AS pending,
    ROUND(
        100.0 * COUNT(x.extraction_id) FILTER (WHERE x.qc_status = 'pass')
              / NULLIF(COUNT(x.extraction_id), 0),
        1
    )                                                            AS pass_rate_pct
FROM extraction_batches b
JOIN laboratories l          ON l.lab_id = b.lab_id
LEFT JOIN dna_extractions x  ON x.batch_id = b.batch_id
WHERE ($1::bigint IS NULL OR b.lab_id = $1)
GROUP BY b.batch_id, l.name, b.extraction_date, b.kit_name
ORDER BY b.extraction_date, b.batch_id;

EXECUTE q1_extraction_qc_by_batch(NULL);

-- ============================================================================================
-- Q2. Libraries per run with their source samples
-- ============================================================================================
-- Question: for a sequencing run, which libraries did it hold, and which extraction attempt,
--           sample, collection date and site does each library trace back to?
-- Parameters: $1 run_id (bigint, NULL = all runs)
-- DBMS concepts: a six-table join following the foreign-key chain
--           run -> library -> extraction -> sample -> collection event -> site (provenance),
--           and a window function (COUNT(*) OVER (PARTITION BY run)) that puts the run's
--           library count on every row without collapsing the rows as GROUP BY would.
--
-- Expected (all runs): 16 rows, ordered by run then library.
--   run_code | run_date   | libraries_in_run | library_code | extraction_id | attempt_number | sample_code          | collected_at (UTC)  | site_name
--   RUN-001  | 2026-03-25 | 8                | LIB-0001     | 1             | 1              | EB-20250515-0001-001 | 2025-05-15 08:30:00 | Dakpathar Barrage
--   ...      |            |                  | LIB-0008     | 8             | 1              | EB-20260310-0004-002 | 2026-03-10 08:00:00 | Dakpathar Barrage
--   RUN-002  | 2026-04-18 | 8                | LIB-0009     | 9             | 1              | EB-20260312-0005-001 | 2026-03-12 09:30:00 | Okhla Barrage
--   ...      |            |                  | LIB-0016     | 16            | 1              | EB-20260408-0008-002 | 2026-04-08 11:30:00 | Kakdwip Bay
--   Library n comes from extraction n and sample n (sample codes from 020). Run 1 covers events
--   1-4 (sites 1, 2, 3, 1), run 2 covers events 5-8 (sites 2, 3, 4, 5). Sample 17 never appears:
--   its extraction failed and no library was built. With $1 = 2: the 8 RUN-002 rows only.

PREPARE q2_run_libraries_with_samples(bigint) AS
SELECT
    r.run_code,
    r.run_date,
    r.status                                        AS run_status,
    COUNT(*) OVER (PARTITION BY r.run_id)           AS libraries_in_run,
    lib.library_code,
    x.extraction_id,
    x.attempt_number,
    s.sample_code,
    e.collected_at,
    site.name                                       AS site_name
FROM sequencing_runs r
JOIN sequencing_libraries lib ON lib.run_id = r.run_id
JOIN dna_extractions x        ON x.extraction_id = lib.extraction_id
JOIN samples s                ON s.sample_id = x.sample_id
JOIN collection_events e      ON e.event_id = s.event_id
JOIN sampling_sites site      ON site.site_id = e.site_id
WHERE ($1::bigint IS NULL OR r.run_id = $1)
ORDER BY r.run_id, lib.library_code;

EXECUTE q2_run_libraries_with_samples(NULL);

-- ============================================================================================
-- Q3. Samples with failed or contaminated QC
-- ============================================================================================
-- Question: which samples have a QC problem (a failed extraction, or a 'fail'/'warn' QC
--           result), why, and did they still go on to sequencing?
-- Parameters: $1 project_id (bigint, NULL = all projects)
-- DBMS concepts: CTE, UNION ALL of two differently shaped sources into one (sample, severity,
--           reason) list, string_agg to collect every reason per sample, an aggregate that
--           ranks severity (fail beats warn), and a correlated EXISTS subquery for "was a
--           library ever built from this sample".
-- Note: QC rows linked only to an analysis (analysis_id set, sample_id NULL) are not
--       per-sample and are left out.
--
-- Expected (all projects): 2 rows, failures first.
--   sample_id | sample_code          | sample_status | site_name         | severity | problems | reasons                                                                                            | sequenced
--   17        | EB-20250515-0001-003 | failed        | Dakpathar Barrage | fail     | 3        | concentration fail (0.350): Below 1.0 ng/uL...; contamination_check fail: Low yield...; extraction attempt 1 failed QC | f
--   12        | EB-20260315-0006-002 | analyzed      | Sangam Prayagraj  | warn     | 1        | negative_control warn (0.080): Faint band in PCR negative; within tolerance, kept                | t
--   (Both samples are in project 1, so $1 = 1 gives the same 2 rows and $1 = 2 gives none.)

PREPARE q3_samples_with_qc_problems(bigint) AS
WITH problems AS (
    -- Extractions that failed QC
    SELECT
        x.sample_id,
        'fail'::text                                                     AS severity,
        'extraction attempt ' || x.attempt_number || ' failed QC'        AS reason
    FROM dna_extractions x
    WHERE x.qc_status = 'fail'

    UNION ALL

    -- QC results recorded as fail or warn against a sample
    SELECT
        q.sample_id,
        q.result::text                                                   AS severity,
        q.qc_type || ' ' || q.result
            || COALESCE(' (' || q.metric_value || ')', '')
            || COALESCE(': ' || q.notes, '')                             AS reason
    FROM quality_control_results q
    WHERE q.result IN ('fail', 'warn')
      AND q.sample_id IS NOT NULL
)
SELECT
    s.sample_id,
    s.sample_code,
    s.status                                                             AS sample_status,
    site.name                                                            AS site_name,
    CASE WHEN bool_or(p.severity = 'fail') THEN 'fail' ELSE 'warn' END   AS severity,
    COUNT(*)                                                             AS problems,
    string_agg(p.reason, '; ' ORDER BY p.reason)                         AS reasons,
    EXISTS (
        SELECT 1
        FROM dna_extractions x2
        JOIN sequencing_libraries lib ON lib.extraction_id = x2.extraction_id
        WHERE x2.sample_id = s.sample_id
    )                                                                    AS sequenced
FROM problems p
JOIN samples s           ON s.sample_id = p.sample_id
JOIN collection_events e ON e.event_id = s.event_id
JOIN sampling_sites site ON site.site_id = e.site_id
WHERE ($1::bigint IS NULL OR e.project_id = $1)
GROUP BY s.sample_id, s.sample_code, s.status, site.name
ORDER BY bool_or(p.severity = 'fail') DESC, s.sample_id;

EXECUTE q3_samples_with_qc_problems(NULL);
