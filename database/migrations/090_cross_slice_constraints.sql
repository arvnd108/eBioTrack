-- Owner: A (Backend)
-- Purpose: Foreign keys across slices, applied last; reviewed by all
--
-- Every foreign key whose target table lives in another slice (CONTRACT section 5), added after
-- 010 to 040 have created all tables. Grouped by the member who owns the source table.
-- Default ON DELETE (NO ACTION) everywhere: scientific records are never hard-deleted (D19).
-- Nullability stays as declared in the slice migrations.

-- C: Access, Projects & Audit (010)
ALTER TABLE project_sites
    ADD CONSTRAINT fk_project_sites_site_id FOREIGN KEY (site_id)
        REFERENCES sampling_sites (site_id);

-- D: Field & Samples (020)
ALTER TABLE sampling_sites
    ADD CONSTRAINT fk_sampling_sites_created_by FOREIGN KEY (created_by)
        REFERENCES users (user_id);

ALTER TABLE collection_events
    ADD CONSTRAINT fk_collection_events_project_id FOREIGN KEY (project_id)
        REFERENCES projects (project_id);

ALTER TABLE collection_events
    ADD CONSTRAINT fk_collection_events_collector_id FOREIGN KEY (collector_id)
        REFERENCES users (user_id);

-- The event's site must be one the project may collect at (pk_project_sites covers the pair).
ALTER TABLE collection_events
    ADD CONSTRAINT fk_collection_events_project_site FOREIGN KEY (project_id, site_id)
        REFERENCES project_sites (project_id, site_id);

ALTER TABLE sample_status_history
    ADD CONSTRAINT fk_sample_status_history_changed_by FOREIGN KEY (changed_by)
        REFERENCES users (user_id);

-- B: Laboratory & Sequencing (030)
ALTER TABLE extraction_batches
    ADD CONSTRAINT fk_extraction_batches_operator_id FOREIGN KEY (operator_id)
        REFERENCES users (user_id);

ALTER TABLE dna_extractions
    ADD CONSTRAINT fk_dna_extractions_sample_id FOREIGN KEY (sample_id)
        REFERENCES samples (sample_id);

ALTER TABLE quality_control_results
    ADD CONSTRAINT fk_quality_control_results_sample_id FOREIGN KEY (sample_id)
        REFERENCES samples (sample_id);

ALTER TABLE quality_control_results
    ADD CONSTRAINT fk_quality_control_results_analysis_id FOREIGN KEY (analysis_id)
        REFERENCES analysis_runs (analysis_id);

ALTER TABLE quality_control_results
    ADD CONSTRAINT fk_quality_control_results_recorded_by FOREIGN KEY (recorded_by)
        REFERENCES users (user_id);

-- A: Analysis, Taxonomy & Analytics (040)
ALTER TABLE analysis_runs
    ADD CONSTRAINT fk_analysis_runs_run_id FOREIGN KEY (run_id)
        REFERENCES sequencing_runs (run_id) ON DELETE RESTRICT;

ALTER TABLE analysis_runs
    ADD CONSTRAINT fk_analysis_runs_imported_by FOREIGN KEY (imported_by)
        REFERENCES users (user_id) ON DELETE RESTRICT;

ALTER TABLE analysis_runs
    ADD CONSTRAINT fk_analysis_runs_approved_by FOREIGN KEY (approved_by)
        REFERENCES users (user_id) ON DELETE RESTRICT;

ALTER TABLE taxon_assignments
    ADD CONSTRAINT fk_taxon_assignments_library_id FOREIGN KEY (library_id)
        REFERENCES sequencing_libraries (library_id) ON DELETE RESTRICT;

ALTER TABLE data_exports
    ADD CONSTRAINT fk_data_exports_requested_by FOREIGN KEY (requested_by)
        REFERENCES users (user_id) ON DELETE RESTRICT;

ALTER TABLE data_exports
    ADD CONSTRAINT fk_data_exports_project_id FOREIGN KEY (project_id)
        REFERENCES projects (project_id) ON DELETE RESTRICT;
