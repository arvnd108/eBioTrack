-- Owner: A (Backend)
-- Purpose: Extensions and shared enum types (agreed by all)
--
-- Extensions: none. The contract needs no extension (no PostGIS per D5, passwords are
-- hashed in the API per D12). Add one here only with a justification in CONTRACT.md.
--
-- Enum names and values are copied from CONTRACT.md section 3. Adding a value later
-- needs a new migration.

CREATE TYPE project_status  AS ENUM ('planned', 'active', 'completed', 'archived');
CREATE TYPE project_role    AS ENUM ('owner', 'manager', 'contributor', 'viewer');
CREATE TYPE region_type     AS ENUM ('country', 'state', 'basin', 'reserve', 'other');
CREATE TYPE habitat_type    AS ENUM ('river', 'lake', 'estuary', 'marine', 'wetland', 'groundwater', 'soil', 'other');
CREATE TYPE sample_status   AS ENUM ('collected', 'stored', 'extracted', 'sequenced', 'analyzed', 'failed', 'discarded');
CREATE TYPE qc_status       AS ENUM ('pending', 'pass', 'fail');
CREATE TYPE qc_result       AS ENUM ('pass', 'warn', 'fail');
CREATE TYPE qc_type         AS ENUM ('extraction_blank', 'negative_control', 'positive_control', 'concentration', 'contamination_check', 'read_quality');
CREATE TYPE run_status      AS ENUM ('planned', 'running', 'completed', 'failed');
CREATE TYPE analysis_status AS ENUM ('draft', 'imported', 'approved', 'rejected', 'superseded');
CREATE TYPE qc_flag         AS ENUM ('pass', 'warn', 'fail');
CREATE TYPE taxon_rank      AS ENUM ('domain', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species');
CREATE TYPE audit_action    AS ENUM ('insert', 'update', 'delete', 'approve', 'reject', 'login', 'export');
CREATE TYPE export_type     AS ENUM ('samples_csv', 'detections_csv', 'richness_csv');
