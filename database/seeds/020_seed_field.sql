-- Owner: D (Docs & Demo)
-- Purpose: Seed rows: Field & Samples
--
-- Slice: Field & Samples (CONTRACT section 6, Issue #15 / T11-D)
-- Tables seeded:
--   1. regions (IDs 1-3)
--   2. sampling_sites (IDs 1-5)
--   3. project_sites (junction between projects 1-2 and sites 1-5)
--   4. sample_types (IDs 1-4)
--   5. collection_events (IDs 1-8)
--   6. samples (IDs 1-17, codes EB-<YYYYMMDD>-<event 4 digits>-<seq 3 digits>)
--   7. environmental_measurements (IDs 1-32, 4 params per event)
--   8. sample_status_history (IDs 1-84, valid state transition chains)

-- 1. regions
INSERT INTO regions (region_id, name, region_type, parent_region_id) VALUES
    (1, 'India', 'country', NULL),
    (2, 'Yamuna River Basin', 'basin', 1),
    (3, 'Hooghly Estuary', 'other', 1);

-- 2. sampling_sites
INSERT INTO sampling_sites (site_id, region_id, name, latitude, longitude, habitat_type, description, created_by, created_at) VALUES
    (1, 2, 'Dakpathar Barrage', 30.505000, 77.795000, 'river', 'Upper reaches near Yamuna barrage', 3, '2025-01-10 10:00:00+00'),
    (2, 2, 'Okhla Barrage', 28.545000, 77.305000, 'river', 'Middle segment near Delhi NCT', 3, '2025-01-10 10:00:00+00'),
    (3, 2, 'Sangam Prayagraj', 25.425000, 81.885000, 'river', 'Lower confluence segment', 3, '2025-01-10 10:00:00+00'),
    (4, 3, 'Diamond Harbour', 22.195000, 88.195000, 'estuary', 'Upper tidal brackish zone', 3, '2025-01-10 10:00:00+00'),
    (5, 3, 'Kakdwip Bay', 21.875000, 88.185000, 'estuary', 'Lower marine-influence estuary', 3, '2025-01-10 10:00:00+00');

-- 3. project_sites (required by collection_events composite FK fk_collection_events_project_site)
INSERT INTO project_sites (project_id, site_id) VALUES
    (1, 1),
    (1, 2),
    (1, 3),
    (2, 4),
    (2, 5)
ON CONFLICT (project_id, site_id) DO NOTHING;

-- 4. sample_types
INSERT INTO sample_types (sample_type_id, type_name) VALUES
    (1, 'water'),
    (2, 'soil'),
    (3, 'sediment'),
    (4, 'air');

-- 5. collection_events
INSERT INTO collection_events (event_id, project_id, site_id, collector_id, collected_at, notes, created_at) VALUES
    (1, 1, 1, 3, '2025-05-15 08:30:00+00', 'Pre-monsoon survey upper Yamuna', '2025-05-15 08:30:00+00'),
    (2, 1, 2, 3, '2025-05-18 09:15:00+00', 'Pre-monsoon survey mid Yamuna', '2025-05-18 09:15:00+00'),
    (3, 1, 3, 3, '2025-05-22 07:45:00+00', 'Pre-monsoon survey lower Yamuna', '2025-05-22 07:45:00+00'),
    (4, 1, 1, 3, '2026-03-10 08:00:00+00', 'Post-winter monitoring upper Yamuna', '2026-03-10 08:00:00+00'),
    (5, 1, 2, 3, '2026-03-12 09:30:00+00', 'Post-winter monitoring mid Yamuna', '2026-03-12 09:30:00+00'),
    (6, 1, 3, 3, '2026-03-15 08:15:00+00', 'Post-winter monitoring lower Yamuna', '2026-03-15 08:15:00+00'),
    (7, 2, 4, 3, '2026-04-05 10:00:00+00', 'Spring tidal collection upper estuary', '2026-04-05 10:00:00+00'),
    (8, 2, 5, 3, '2026-04-08 11:30:00+00', 'Spring tidal collection lower estuary', '2026-04-08 11:30:00+00');

-- 6. samples
INSERT INTO samples (sample_id, event_id, sample_type_id, sample_code, volume_ml, depth_m, storage_location, status, created_at) VALUES
    (1,  1, 1, 'EB-20250515-0001-001', 1000.00, 0.50, 'Freezer A-1', 'analyzed', '2025-05-15 08:30:00+00'),
    (2,  1, 1, 'EB-20250515-0001-002', 1000.00, 1.00, 'Freezer A-1', 'analyzed', '2025-05-15 08:30:00+00'),
    (3,  2, 1, 'EB-20250518-0002-001', 1000.00, 0.50, 'Freezer A-1', 'analyzed', '2025-05-18 09:15:00+00'),
    (4,  2, 1, 'EB-20250518-0002-002', 1000.00, 1.20, 'Freezer A-1', 'analyzed', '2025-05-18 09:15:00+00'),
    (5,  3, 1, 'EB-20250522-0003-001', 1000.00, 0.50, 'Freezer A-2', 'analyzed', '2025-05-22 07:45:00+00'),
    (6,  3, 1, 'EB-20250522-0003-002', 1000.00, 1.50, 'Freezer A-2', 'analyzed', '2025-05-22 07:45:00+00'),
    (7,  4, 1, 'EB-20260310-0004-001', 1000.00, 0.50, 'Freezer B-1', 'analyzed', '2026-03-10 08:00:00+00'),
    (8,  4, 1, 'EB-20260310-0004-002', 1000.00, 1.00, 'Freezer B-1', 'analyzed', '2026-03-10 08:00:00+00'),
    (9,  5, 1, 'EB-20260312-0005-001', 1000.00, 0.50, 'Freezer B-1', 'analyzed', '2026-03-12 09:30:00+00'),
    (10, 5, 1, 'EB-20260312-0005-002', 1000.00, 1.00, 'Freezer B-1', 'analyzed', '2026-03-12 09:30:00+00'),
    (11, 6, 1, 'EB-20260315-0006-001', 1000.00, 0.50, 'Freezer B-2', 'analyzed', '2026-03-15 08:15:00+00'),
    (12, 6, 1, 'EB-20260315-0006-002', 1000.00, 1.50, 'Freezer B-2', 'analyzed', '2026-03-15 08:15:00+00'),
    (13, 7, 1, 'EB-20260405-0007-001', 1000.00, 0.50, 'Freezer C-1', 'analyzed', '2026-04-05 10:00:00+00'),
    (14, 7, 1, 'EB-20260405-0007-002', 1000.00, 1.00, 'Freezer C-1', 'analyzed', '2026-04-05 10:00:00+00'),
    (15, 8, 1, 'EB-20260408-0008-001', 1000.00, 0.50, 'Freezer C-1', 'analyzed', '2026-04-08 11:30:00+00'),
    (16, 8, 1, 'EB-20260408-0008-002', 1000.00, 1.50, 'Freezer C-1', 'analyzed', '2026-04-08 11:30:00+00'),
    (17, 1, 1, 'EB-20250515-0001-003',  500.00, 0.50, 'Freezer A-1', 'failed',   '2025-05-15 08:30:00+00');

-- 7. environmental_measurements (32 measurements: 4 parameters per event)
INSERT INTO environmental_measurements (measurement_id, event_id, parameter, value, unit, created_at) VALUES
    (1,  1, 'temperature_c',       24.5, 'celsius', '2025-05-15 08:30:00+00'),
    (2,  1, 'ph',                   7.8, 'pH',      '2025-05-15 08:30:00+00'),
    (3,  1, 'dissolved_oxygen_mg_l',6.5, 'mg/L',   '2025-05-15 08:30:00+00'),
    (4,  1, 'turbidity_ntu',       12.0, 'NTU',     '2025-05-15 08:30:00+00'),

    (5,  2, 'temperature_c',       28.2, 'celsius', '2025-05-18 09:15:00+00'),
    (6,  2, 'ph',                   7.4, 'pH',      '2025-05-18 09:15:00+00'),
    (7,  2, 'dissolved_oxygen_mg_l',4.2, 'mg/L',   '2025-05-18 09:15:00+00'),
    (8,  2, 'turbidity_ntu',       28.5, 'NTU',     '2025-05-18 09:15:00+00'),

    (9,  3, 'temperature_c',       26.8, 'celsius', '2025-05-22 07:45:00+00'),
    (10, 3, 'ph',                   7.6, 'pH',      '2025-05-22 07:45:00+00'),
    (11, 3, 'dissolved_oxygen_mg_l',5.8, 'mg/L',   '2025-05-22 07:45:00+00'),
    (12, 3, 'turbidity_ntu',       18.0, 'NTU',     '2025-05-22 07:45:00+00'),

    (13, 4, 'temperature_c',       19.5, 'celsius', '2026-03-10 08:00:00+00'),
    (14, 4, 'ph',                   8.1, 'pH',      '2026-03-10 08:00:00+00'),
    (15, 4, 'dissolved_oxygen_mg_l',7.8, 'mg/L',   '2026-03-10 08:00:00+00'),
    (16, 4, 'turbidity_ntu',        8.5, 'NTU',     '2026-03-10 08:00:00+00'),

    (17, 5, 'temperature_c',       23.4, 'celsius', '2026-03-12 09:30:00+00'),
    (18, 5, 'ph',                   7.3, 'pH',      '2026-03-12 09:30:00+00'),
    (19, 5, 'dissolved_oxygen_mg_l',5.0, 'mg/L',   '2026-03-12 09:30:00+00'),
    (20, 5, 'turbidity_ntu',       22.0, 'NTU',     '2026-03-12 09:30:00+00'),

    (21, 6, 'temperature_c',       22.1, 'celsius', '2026-03-15 08:15:00+00'),
    (22, 6, 'ph',                   7.9, 'pH',      '2026-03-15 08:15:00+00'),
    (23, 6, 'dissolved_oxygen_mg_l',6.9, 'mg/L',   '2026-03-15 08:15:00+00'),
    (24, 6, 'turbidity_ntu',       14.5, 'NTU',     '2026-03-15 08:15:00+00'),

    (25, 7, 'temperature_c',       26.0, 'celsius', '2026-04-05 10:00:00+00'),
    (26, 7, 'ph',                   8.0, 'pH',      '2026-04-05 10:00:00+00'),
    (27, 7, 'dissolved_oxygen_mg_l',6.1, 'mg/L',   '2026-04-05 10:00:00+00'),
    (28, 7, 'turbidity_ntu',       15.0, 'NTU',     '2026-04-05 10:00:00+00'),

    (29, 8, 'temperature_c',       27.5, 'celsius', '2026-04-08 11:30:00+00'),
    (30, 8, 'ph',                   8.2, 'pH',      '2026-04-08 11:30:00+00'),
    (31, 8, 'dissolved_oxygen_mg_l',5.9, 'mg/L',   '2026-04-08 11:30:00+00'),
    (32, 8, 'turbidity_ntu',       20.0, 'NTU',     '2026-04-08 11:30:00+00');

-- 8. sample_status_history
-- Samples 1-16: collected -> stored -> extracted -> sequenced -> analyzed
-- Sample 17:    collected -> stored -> extracted -> failed
INSERT INTO sample_status_history (history_id, sample_id, old_status, new_status, changed_by, changed_at, note) VALUES
    -- Sample 1
    (1,  1, NULL,        'collected', 3, '2025-05-15 08:30:00+00', 'Initial field collection'),
    (2,  1, 'collected', 'stored',    3, '2025-05-15 11:00:00+00', 'Stored at 4C in field depot'),
    (3,  1, 'stored',    'extracted', 4, '2025-05-20 14:00:00+00', 'DNA extraction completed'),
    (4,  1, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (5,  1, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 2
    (6,  2, NULL,        'collected', 3, '2025-05-15 08:30:00+00', 'Initial field collection'),
    (7,  2, 'collected', 'stored',    3, '2025-05-15 11:00:00+00', 'Stored at 4C in field depot'),
    (8,  2, 'stored',    'extracted', 4, '2025-05-20 14:00:00+00', 'DNA extraction completed'),
    (9,  2, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (10, 2, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 3
    (11, 3, NULL,        'collected', 3, '2025-05-18 09:15:00+00', 'Initial field collection'),
    (12, 3, 'collected', 'stored',    3, '2025-05-18 12:00:00+00', 'Stored at 4C in field depot'),
    (13, 3, 'stored',    'extracted', 4, '2025-05-20 15:00:00+00', 'DNA extraction completed'),
    (14, 3, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (15, 3, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 4
    (16, 4, NULL,        'collected', 3, '2025-05-18 09:15:00+00', 'Initial field collection'),
    (17, 4, 'collected', 'stored',    3, '2025-05-18 12:00:00+00', 'Stored at 4C in field depot'),
    (18, 4, 'stored',    'extracted', 4, '2025-05-20 15:00:00+00', 'DNA extraction completed'),
    (19, 4, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (20, 4, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 5
    (21, 5, NULL,        'collected', 3, '2025-05-22 07:45:00+00', 'Initial field collection'),
    (22, 5, 'collected', 'stored',    3, '2025-05-22 10:30:00+00', 'Stored at 4C in field depot'),
    (23, 5, 'stored',    'extracted', 4, '2025-05-25 11:00:00+00', 'DNA extraction completed'),
    (24, 5, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (25, 5, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 6
    (26, 6, NULL,        'collected', 3, '2025-05-22 07:45:00+00', 'Initial field collection'),
    (27, 6, 'collected', 'stored',    3, '2025-05-22 10:30:00+00', 'Stored at 4C in field depot'),
    (28, 6, 'stored',    'extracted', 4, '2025-05-25 11:00:00+00', 'DNA extraction completed'),
    (29, 6, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (30, 6, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 7
    (31, 7, NULL,        'collected', 3, '2026-03-10 08:00:00+00', 'Initial field collection'),
    (32, 7, 'collected', 'stored',    3, '2026-03-10 11:00:00+00', 'Stored at 4C in field depot'),
    (33, 7, 'stored',    'extracted', 4, '2026-03-16 10:00:00+00', 'DNA extraction completed'),
    (34, 7, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (35, 7, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 8
    (36, 8, NULL,        'collected', 3, '2026-03-10 08:00:00+00', 'Initial field collection'),
    (37, 8, 'collected', 'stored',    3, '2026-03-10 11:00:00+00', 'Stored at 4C in field depot'),
    (38, 8, 'stored',    'extracted', 4, '2026-03-16 10:00:00+00', 'DNA extraction completed'),
    (39, 8, 'extracted', 'sequenced', 4, '2026-03-25 14:00:00+00', 'Sequencing run completed'),
    (40, 8, 'sequenced', 'analyzed',  5, '2026-04-02 11:30:00+00', 'Taxonomic assignment approved'),
    -- Sample 9
    (41, 9, NULL,        'collected', 3, '2026-03-12 09:30:00+00', 'Initial field collection'),
    (42, 9, 'collected', 'stored',    3, '2026-03-12 12:30:00+00', 'Stored at 4C in field depot'),
    (43, 9, 'stored',    'extracted', 4, '2026-03-16 11:00:00+00', 'DNA extraction completed'),
    (44, 9, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (45, 9, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 10
    (46, 10, NULL,        'collected', 3, '2026-03-12 09:30:00+00', 'Initial field collection'),
    (47, 10, 'collected', 'stored',    3, '2026-03-12 12:30:00+00', 'Stored at 4C in field depot'),
    (48, 10, 'stored',    'extracted', 4, '2026-03-16 11:00:00+00', 'DNA extraction completed'),
    (49, 10, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (50, 10, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 11
    (51, 11, NULL,        'collected', 3, '2026-03-15 08:15:00+00', 'Initial field collection'),
    (52, 11, 'collected', 'stored',    3, '2026-03-15 11:15:00+00', 'Stored at 4C in field depot'),
    (53, 11, 'stored',    'extracted', 4, '2026-03-16 12:00:00+00', 'DNA extraction completed'),
    (54, 11, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (55, 11, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 12
    (56, 12, NULL,        'collected', 3, '2026-03-15 08:15:00+00', 'Initial field collection'),
    (57, 12, 'collected', 'stored',    3, '2026-03-15 11:15:00+00', 'Stored at 4C in field depot'),
    (58, 12, 'stored',    'extracted', 4, '2026-03-16 12:00:00+00', 'DNA extraction completed'),
    (59, 12, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (60, 12, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 13
    (61, 13, NULL,        'collected', 3, '2026-04-05 10:00:00+00', 'Initial field collection'),
    (62, 13, 'collected', 'stored',    3, '2026-04-05 13:00:00+00', 'Stored at 4C in field depot'),
    (63, 13, 'stored',    'extracted', 4, '2026-04-10 10:30:00+00', 'DNA extraction completed'),
    (64, 13, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (65, 13, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 14
    (66, 14, NULL,        'collected', 3, '2026-04-05 10:00:00+00', 'Initial field collection'),
    (67, 14, 'collected', 'stored',    3, '2026-04-05 13:00:00+00', 'Stored at 4C in field depot'),
    (68, 14, 'stored',    'extracted', 4, '2026-04-10 10:30:00+00', 'DNA extraction completed'),
    (69, 14, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (70, 14, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 15
    (71, 15, NULL,        'collected', 3, '2026-04-08 11:30:00+00', 'Initial field collection'),
    (72, 15, 'collected', 'stored',    3, '2026-04-08 14:30:00+00', 'Stored at 4C in field depot'),
    (73, 15, 'stored',    'extracted', 4, '2026-04-10 11:30:00+00', 'DNA extraction completed'),
    (74, 15, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (75, 15, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 16
    (76, 16, NULL,        'collected', 3, '2026-04-08 11:30:00+00', 'Initial field collection'),
    (77, 16, 'collected', 'stored',    3, '2026-04-08 14:30:00+00', 'Stored at 4C in field depot'),
    (78, 16, 'stored',    'extracted', 4, '2026-04-10 11:30:00+00', 'DNA extraction completed'),
    (79, 16, 'extracted', 'sequenced', 4, '2026-04-18 15:00:00+00', 'Sequencing run completed'),
    (80, 16, 'sequenced', 'analyzed',  5, '2026-04-25 14:00:00+00', 'Taxonomic assignment approved'),
    -- Sample 17 (Failed QC extraction)
    (81, 17, NULL,        'collected', 3, '2025-05-15 08:30:00+00', 'Initial field collection'),
    (82, 17, 'collected', 'stored',    3, '2025-05-15 11:00:00+00', 'Stored at 4C in field depot'),
    (83, 17, 'stored',    'extracted', 4, '2025-05-20 14:00:00+00', 'DNA extraction attempted'),
    (84, 17, 'extracted', 'failed',    4, '2025-05-20 16:00:00+00', 'Extraction failed concentration QC check');
