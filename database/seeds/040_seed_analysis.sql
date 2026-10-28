-- Owner: A (Backend)
-- Purpose: Seed rows: Analysis, Taxonomy & Analytics
--
-- Fixture world per CONTRACT section 6. Explicit IDs below 1000, fixed timestamps, no random()
-- or now(), so every rebuild is identical. References users 1-6, sequencing runs 1-2 and
-- libraries 1-16 from the 010 and 030 seeds. data_exports is not seeded.
--
-- Library -> event -> site/year (two libraries per event):
--   run 1: libs 1-2 ev1 site1 2025 | 3-4 ev2 site2 2025 | 5-6 ev3 site3 2025 | 7-8 ev4 site1 2026
--   run 2: libs 9-10 ev5 site2 2026 | 11-12 ev6 site3 2026 | 13-14 ev7 site4 | 15-16 ev8 site5
--
-- Designed answers (species ids: 7 rohu, 8 calbasu, 11 mrigal, 15 mosquitofish):
--   Richness, all flags, approved analyses 1+2:  site1 2025=2, 2026=3 (up); site2 2025=2, 2026=1 (down);
--     site3 2025=2, 2026=2; site4 2026=2; site5 2026=2.
--   Richness, qc pass only: site1 2026 drops to 2 (mrigal there is warn/fail only); site5 2026 drops to 1.
--   Species 8 (calbasu) is detected at one site only. Species 15 appears only in analysis 3 (imported),
--   so approved-only views exclude it. Species 9 and 13 are never detected. Library 16 has no
--   detection in analysis 2 (non-detection). Analysis 4 (draft) and sample 17 (no library) have none.

INSERT INTO dna_markers (marker_id, marker_name, target_region) VALUES
    (1, '12S', 'Mitochondrial 12S rRNA (MiFish region)'),
    (2, 'COI', 'Mitochondrial cytochrome c oxidase subunit I');

-- Parents come before children. Intermediate ranks are omitted for Gambusia (parent is the class).
INSERT INTO taxa (taxon_id, scientific_name, rank, parent_taxon_id, external_id) VALUES
    (1,  'Animalia',            'kingdom', NULL, '33208'),
    (2,  'Chordata',            'phylum',  1,    '7711'),
    (3,  'Actinopterygii',      'class',   2,    '7898'),
    (4,  'Cypriniformes',       'order',   3,    '7952'),
    (5,  'Cyprinidae',          'family',  4,    '7953'),
    (6,  'Labeo',               'genus',   5,    NULL),
    (7,  'Labeo rohita',        'species', 6,    '84645'),
    (8,  'Labeo calbasu',       'species', 6,    NULL),
    (9,  'Labeo bata',          'species', 6,    NULL),
    (10, 'Cirrhinus',           'genus',   5,    NULL),
    (11, 'Cirrhinus mrigala',   'species', 10,   NULL),
    (12, 'Cyprinus',            'genus',   5,    NULL),
    (13, 'Cyprinus carpio',     'species', 12,   '7962'),
    (14, 'Gambusia',            'genus',   3,    NULL),
    (15, 'Gambusia affinis',    'species', 14,   '33528');

INSERT INTO analysis_runs (analysis_id, run_id, marker_id, pipeline_name, pipeline_version, reference_db,
                           reference_db_version, parameters, status, imported_by, approved_by, approved_at, created_at) VALUES
    (1, 1, 1, 'OBITools3', '3.0.1', 'MitoFish', '2025-06',
        '{"min_length": 100, "min_quality": 30, "identity_cutoff": 0.97}',
        'approved', 5, 2, '2026-03-20 10:00:00+00', '2026-03-18 09:00:00+00'),
    (2, 2, 1, 'OBITools3', '3.0.1', 'MitoFish', '2026-01',
        '{"min_length": 100, "min_quality": 30, "identity_cutoff": 0.97}',
        'approved', 5, 2, '2026-03-27 10:00:00+00', '2026-03-25 09:00:00+00'),
    (3, 2, 2, 'OBITools3', '3.1.0', 'BOLD Systems', '2026-01',
        '{"min_length": 250, "min_quality": 28, "identity_cutoff": 0.95}',
        'imported', 5, NULL, NULL, '2026-04-02 09:00:00+00'),
    (4, 1, 2, 'OBITools3', '3.1.0', 'BOLD Systems', '2026-01',
        '{"min_length": 250, "min_quality": 28, "identity_cutoff": 0.95}',
        'draft', NULL, NULL, NULL, '2026-04-02 09:30:00+00');

-- Detections. assignment_id, analysis_id, library_id, taxon_id, read_count, confidence, qc_flag.
-- created_at follows the analysis run so the rows are deterministic.
INSERT INTO taxon_assignments (assignment_id, analysis_id, library_id, taxon_id, read_count, confidence, qc_flag, created_at)
SELECT v.assignment_id, v.analysis_id, v.library_id, v.taxon_id, v.read_count, v.confidence, v.qc_flag::qc_flag, ar.created_at
FROM (VALUES
    -- Analysis 1 (12S, run 1), event 1 / site 1 / 2025: libs 1-2
    (1,  1, 1,  7, 18420, 0.9812, 'pass'),
    (2,  1, 1,  8,  2310, 0.9340, 'pass'),
    (3,  1, 2,  7, 15210, 0.9755, 'pass'),
    -- event 2 / site 2 / 2025: libs 3-4
    (4,  1, 3,  7, 12480, 0.9677, 'pass'),
    (5,  1, 3, 11,  6420, 0.9215, 'pass'),
    (6,  1, 4,  7,  9860, 0.9602, 'pass'),
    (7,  1, 4, 11,  5130, 0.9120, 'pass'),
    -- event 3 / site 3 / 2025: libs 5-6 (mrigal in one replicate only, few reads)
    (8,  1, 5,  7,  8810, 0.9544, 'pass'),
    (9,  1, 5, 11,  4470, 0.9033, 'pass'),
    (10, 1, 6,  7,  6390, 0.9420, 'pass'),
    (11, 1, 6, 11,    12, 0.6120, 'warn'),
    -- event 4 / site 1 / 2026: libs 7-8 (mrigal only with warn/fail flags)
    (12, 1, 7,  7, 22650, 0.9901, 'pass'),
    (13, 1, 7,  8,  3120, 0.9482, 'pass'),
    (14, 1, 7, 11,    95, 0.5210, 'warn'),
    (15, 1, 8,  7, 19870, 0.9830, 'pass'),
    (16, 1, 8,  8,  2750, 0.9411, 'pass'),
    (17, 1, 8, 11,    41, 0.4388, 'fail'),
    -- Analysis 2 (12S, run 2), event 5 / site 2 / 2026: libs 9-10
    (18, 2, 9,  7, 17340, 0.9788, 'pass'),
    (19, 2, 10, 7, 14020, 0.9731, 'pass'),
    -- event 6 / site 3 / 2026: libs 11-12
    (20, 2, 11, 7, 10240, 0.9650, 'pass'),
    (21, 2, 11, 11, 5560, 0.9150, 'pass'),
    (22, 2, 12, 7,  7720, 0.9500, 'pass'),
    (23, 2, 12, 11, 4890, 0.9080, 'pass'),
    -- event 7 / site 4 / 2026: libs 13-14 (mrigal in one replicate only)
    (24, 2, 13, 11, 3350, 0.9010, 'pass'),
    (25, 2, 13, 7,  5120, 0.9380, 'pass'),
    (26, 2, 14, 7,  4470, 0.9290, 'pass'),
    -- event 8 / site 5 / 2026: lib 15 detections, lib 16 none (non-detection)
    (27, 2, 15, 7,  2150, 0.8820, 'pass'),
    (28, 2, 15, 11,   38, 0.4710, 'fail'),
    -- Analysis 3 (COI, run 2, imported), libs 9-16; species 15 appears only here
    (29, 3, 9,  7,  9120, 0.9640, 'pass'),
    (30, 3, 9, 15,  2410, 0.9300, 'pass'),
    (31, 3, 10, 7,  7230, 0.9510, 'pass'),
    (32, 3, 10, 15, 1890, 0.9150, 'pass'),
    (33, 3, 11, 7,  8450, 0.9560, 'pass'),
    (34, 3, 11, 11, 3120, 0.9040, 'pass'),
    (35, 3, 12, 7,  6010, 0.9420, 'pass'),
    (36, 3, 12, 15,  220, 0.7100, 'warn'),
    (37, 3, 13, 15, 5230, 0.9470, 'pass'),
    (38, 3, 13, 11, 2170, 0.8860, 'pass'),
    (39, 3, 14, 15, 4180, 0.9380, 'pass'),
    (40, 3, 14, 7,  1260, 0.8310, 'pass'),
    (41, 3, 15, 15, 3340, 0.9250, 'pass'),
    (42, 3, 15, 7,    25, 0.4020, 'fail'),
    (43, 3, 16, 15,   14, 0.3510, 'fail')
) AS v (assignment_id, analysis_id, library_id, taxon_id, read_count, confidence, qc_flag)
JOIN analysis_runs ar ON ar.analysis_id = v.analysis_id;
