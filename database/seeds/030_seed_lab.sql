-- Owner: B (Frontend)
-- Purpose: Seed rows: Laboratory & Sequencing
--
-- Fixture world (CONTRACT 6, issue #13 / T11-B). SYNTHETIC data, development and test only.
-- Explicit IDs below 1000, fixed literal timestamps (UTC), no now()/random(), so every rebuild is
-- identical. Loads after 010 and 020 (and after 090, so every foreign key is checked).
--
-- Designed answers:
--   laboratories ............................ 2 (lab 1 river work, lab 2 estuary work)
--   extraction_batches ...................... 3, operator user 4 (lab technician)
--   dna_extractions ......................... 17: extraction n for sample n, attempt 1;
--                                             1-16 'pass', 17 'fail' (0.35 ng/uL)
--   sequencing_runs ......................... 2, both 'completed'
--   sequencing_libraries .................... 16: library n from extraction n, code LIB-000n;
--                                             run 1 holds 1-8 (events 1-4), run 2 holds 9-16
--                                             (events 5-8); sample 17 has no library
--   quality_control_results ................. 23, all linked by sample_id (none by analysis_id:
--                                             analysis rows load later, in 040):
--                                               concentration: 16 pass, 1 fail (sample 17)
--                                               extraction_blank: 3 pass (one per batch)
--                                               positive_control: 1 pass
--                                               negative_control: 1 warn (sample 12)
--                                               contamination_check: 1 fail (sample 17)
--   samples with a 'fail' QC result ......... 1 (sample 17); with 'warn' ......... 1 (sample 12)
--
-- Dates follow sample_status_history in 020 (extracted / sequenced times), so every library's
-- sample was collected and extracted before its run:
--   batch 1: lab 1, 2025-05-20, samples 1-6 and 17 (samples 5-6 extracted 2025-05-25 within it)
--   batch 2: lab 1, 2026-03-16, samples 7-12
--   batch 3: lab 2, 2026-04-10, samples 13-16
--   run 1: 2026-03-25 (latest sequencing date of its samples 1-8)
--   run 2: 2026-04-18 (latest sequencing date of its samples 9-16; events 7-8 were collected
--          in April 2026, so the run cannot be earlier)

-- 1. laboratories
INSERT INTO laboratories (lab_id, name, location) VALUES
    (1, 'Dehradun eDNA Laboratory',          'Dehradun, Uttarakhand'),
    (2, 'Kolkata Estuarine Genomics Laboratory', 'Kolkata, West Bengal');

-- 2. extraction_batches (operator: user 4, lab technician)
INSERT INTO extraction_batches (batch_id, lab_id, operator_id, extraction_date, kit_name, notes, created_at) VALUES
    (1, 1, 4, '2025-05-20', 'DNeasy PowerWater Kit', '2025 pre-monsoon river samples',  '2025-05-20 13:30:00+00'),
    (2, 1, 4, '2026-03-16', 'DNeasy PowerWater Kit', '2026 post-winter river samples',  '2026-03-16 09:30:00+00'),
    (3, 2, 4, '2026-04-10', 'DNeasy PowerWater Kit', '2026 spring estuary samples',     '2026-04-10 10:00:00+00');

-- 3. dna_extractions (extraction n for sample n; created_at = the 'extracted' time in 020)
INSERT INTO dna_extractions (extraction_id, sample_id, batch_id, attempt_number, concentration_ng_ul, purity_a260_280, qc_status, created_at) VALUES
    (1,  1,  1, 1, 18.420, 1.86, 'pass', '2025-05-20 14:00:00+00'),
    (2,  2,  1, 1, 15.730, 1.84, 'pass', '2025-05-20 14:00:00+00'),
    (3,  3,  1, 1, 22.910, 1.88, 'pass', '2025-05-20 15:00:00+00'),
    (4,  4,  1, 1, 12.050, 1.81, 'pass', '2025-05-20 15:00:00+00'),
    (5,  5,  1, 1, 27.360, 1.90, 'pass', '2025-05-25 11:00:00+00'),
    (6,  6,  1, 1,  9.880, 1.79, 'pass', '2025-05-25 11:00:00+00'),
    (7,  7,  2, 1, 31.240, 1.92, 'pass', '2026-03-16 10:00:00+00'),
    (8,  8,  2, 1, 24.670, 1.87, 'pass', '2026-03-16 10:00:00+00'),
    (9,  9,  2, 1, 14.120, 1.83, 'pass', '2026-03-16 11:00:00+00'),
    (10, 10, 2, 1, 11.590, 1.80, 'pass', '2026-03-16 11:00:00+00'),
    (11, 11, 2, 1, 19.330, 1.85, 'pass', '2026-03-16 12:00:00+00'),
    (12, 12, 2, 1,  8.760, 1.77, 'pass', '2026-03-16 12:00:00+00'),
    (13, 13, 3, 1, 16.480, 1.84, 'pass', '2026-04-10 10:30:00+00'),
    (14, 14, 3, 1, 13.910, 1.82, 'pass', '2026-04-10 10:30:00+00'),
    (15, 15, 3, 1, 21.050, 1.89, 'pass', '2026-04-10 11:30:00+00'),
    (16, 16, 3, 1, 10.270, 1.78, 'pass', '2026-04-10 11:30:00+00'),
    (17, 17, 1, 1,  0.350, 1.32, 'fail', '2025-05-20 14:00:00+00');

-- 4. sequencing_runs
INSERT INTO sequencing_runs (run_id, run_code, lab_id, platform, run_date, status, created_at) VALUES
    (1, 'RUN-001', 1, 'Illumina MiSeq', '2026-03-25', 'completed', '2026-03-24 09:00:00+00'),
    (2, 'RUN-002', 2, 'Illumina MiSeq', '2026-04-18', 'completed', '2026-04-17 09:00:00+00');

-- 5. sequencing_libraries (library n from extraction n; run 1: 1-8, run 2: 9-16; none for 17)
INSERT INTO sequencing_libraries (library_id, library_code, extraction_id, run_id, created_at) VALUES
    (1,  'LIB-0001', 1,  1, '2026-03-24 10:00:00+00'),
    (2,  'LIB-0002', 2,  1, '2026-03-24 10:00:00+00'),
    (3,  'LIB-0003', 3,  1, '2026-03-24 10:00:00+00'),
    (4,  'LIB-0004', 4,  1, '2026-03-24 10:00:00+00'),
    (5,  'LIB-0005', 5,  1, '2026-03-24 10:00:00+00'),
    (6,  'LIB-0006', 6,  1, '2026-03-24 10:00:00+00'),
    (7,  'LIB-0007', 7,  1, '2026-03-24 10:00:00+00'),
    (8,  'LIB-0008', 8,  1, '2026-03-24 10:00:00+00'),
    (9,  'LIB-0009', 9,  2, '2026-04-17 10:00:00+00'),
    (10, 'LIB-0010', 10, 2, '2026-04-17 10:00:00+00'),
    (11, 'LIB-0011', 11, 2, '2026-04-17 10:00:00+00'),
    (12, 'LIB-0012', 12, 2, '2026-04-17 10:00:00+00'),
    (13, 'LIB-0013', 13, 2, '2026-04-17 10:00:00+00'),
    (14, 'LIB-0014', 14, 2, '2026-04-17 10:00:00+00'),
    (15, 'LIB-0015', 15, 2, '2026-04-17 10:00:00+00'),
    (16, 'LIB-0016', 16, 2, '2026-04-17 10:00:00+00');

-- 6. quality_control_results (all by sample_id; analysis-linked QC rows belong at the end of 040)
INSERT INTO quality_control_results (qc_id, sample_id, analysis_id, qc_type, result, metric_value, notes, recorded_by, recorded_at) VALUES
    -- Concentration check on every extraction (metric = ng/uL; pass threshold 1.0)
    (1,  1,  NULL, 'concentration', 'pass', 18.420, NULL, 4, '2025-05-20 15:30:00+00'),
    (2,  2,  NULL, 'concentration', 'pass', 15.730, NULL, 4, '2025-05-20 15:30:00+00'),
    (3,  3,  NULL, 'concentration', 'pass', 22.910, NULL, 4, '2025-05-20 16:30:00+00'),
    (4,  4,  NULL, 'concentration', 'pass', 12.050, NULL, 4, '2025-05-20 16:30:00+00'),
    (5,  5,  NULL, 'concentration', 'pass', 27.360, NULL, 4, '2025-05-25 12:30:00+00'),
    (6,  6,  NULL, 'concentration', 'pass',  9.880, NULL, 4, '2025-05-25 12:30:00+00'),
    (7,  7,  NULL, 'concentration', 'pass', 31.240, NULL, 4, '2026-03-16 11:30:00+00'),
    (8,  8,  NULL, 'concentration', 'pass', 24.670, NULL, 4, '2026-03-16 11:30:00+00'),
    (9,  9,  NULL, 'concentration', 'pass', 14.120, NULL, 4, '2026-03-16 12:30:00+00'),
    (10, 10, NULL, 'concentration', 'pass', 11.590, NULL, 4, '2026-03-16 12:30:00+00'),
    (11, 11, NULL, 'concentration', 'pass', 19.330, NULL, 4, '2026-03-16 13:30:00+00'),
    (12, 12, NULL, 'concentration', 'pass',  8.760, NULL, 4, '2026-03-16 13:30:00+00'),
    (13, 13, NULL, 'concentration', 'pass', 16.480, NULL, 4, '2026-04-10 12:00:00+00'),
    (14, 14, NULL, 'concentration', 'pass', 13.910, NULL, 4, '2026-04-10 12:00:00+00'),
    (15, 15, NULL, 'concentration', 'pass', 21.050, NULL, 4, '2026-04-10 13:00:00+00'),
    (16, 16, NULL, 'concentration', 'pass', 10.270, NULL, 4, '2026-04-10 13:00:00+00'),
    (17, 17, NULL, 'concentration', 'fail',  0.350, 'Below 1.0 ng/uL; sample marked failed', 4, '2025-05-20 15:30:00+00'),
    -- Extraction blank per batch (metric = ng/uL in the blank; pass below 0.1), recorded on the first sample of the batch
    (18, 1,  NULL, 'extraction_blank', 'pass', 0.020, 'Batch 1 blank', 4, '2025-05-20 15:45:00+00'),
    (19, 7,  NULL, 'extraction_blank', 'pass', 0.030, 'Batch 2 blank', 4, '2026-03-16 11:45:00+00'),
    (20, 13, NULL, 'extraction_blank', 'pass', 0.010, 'Batch 3 blank', 4, '2026-04-10 12:15:00+00'),
    -- Controls and contamination
    (21, 7,  NULL, 'positive_control',    'pass', 1.000, 'Mock community amplified as expected', 4, '2026-03-16 14:00:00+00'),
    (22, 12, NULL, 'negative_control',    'warn', 0.080, 'Faint band in PCR negative; within tolerance, kept', 4, '2026-03-16 14:00:00+00'),
    (23, 17, NULL, 'contamination_check', 'fail', NULL,  'Low yield and A260/280 1.32 suggest inhibitors', 4, '2025-05-20 15:50:00+00');
