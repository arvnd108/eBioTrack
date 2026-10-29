// Owner: B (Frontend)
// Purpose: Shared TypeScript types mirroring API responses
//
// Source of truth: planning/CONTRACT.md (section 3 enums, section 8 envelopes, sections 10–11
// responses).
// Field names are snake_case, exactly as the API sends them (D15). If a shape changes in the
// contract, change it here and tell A and D.

// ---------------------------------------------------------------------------
// Enumerations (CONTRACT section 3)
// ---------------------------------------------------------------------------

export type RoleName =
  | 'administrator'
  | 'principal_investigator'
  | 'field_researcher'
  | 'lab_technician'
  | 'analyst'
  | 'viewer';

export type ProjectStatus = 'planned' | 'active' | 'completed' | 'archived';
export type ProjectRole = 'owner' | 'manager' | 'contributor' | 'viewer';
export type RegionType = 'country' | 'state' | 'basin' | 'reserve' | 'other';
export type HabitatType =
  'river' | 'lake' | 'estuary' | 'marine' | 'wetland' | 'groundwater' | 'soil' | 'other';
export type SampleStatus =
  'collected' | 'stored' | 'extracted' | 'sequenced' | 'analyzed' | 'failed' | 'discarded';
export type QcStatus = 'pending' | 'pass' | 'fail';
export type QcResult = 'pass' | 'warn' | 'fail';
export type QcType =
  | 'extraction_blank'
  | 'negative_control'
  | 'positive_control'
  | 'concentration'
  | 'contamination_check'
  | 'read_quality';
export type RunStatus = 'planned' | 'running' | 'completed' | 'failed';
export type AnalysisStatus = 'draft' | 'imported' | 'approved' | 'rejected' | 'superseded';
export type QcFlag = 'pass' | 'warn' | 'fail';
export type TaxonRank =
  'domain' | 'kingdom' | 'phylum' | 'class' | 'order' | 'family' | 'genus' | 'species';
export type AuditAction =
  'insert' | 'update' | 'delete' | 'approve' | 'reject' | 'login' | 'export';
export type ExportType = 'samples_csv' | 'detections_csv' | 'richness_csv';

// ---------------------------------------------------------------------------
// Envelopes (CONTRACT section 8)
// ---------------------------------------------------------------------------

/** `meta` on paginated lists. */
export interface PageMeta {
  page: number;
  limit: number;
  total: number;
}

/** `meta` on every analytics response. */
export interface CaveatMeta {
  caveat: string;
}

/** Success body: `{ data }`, plus `meta` on lists and analytics. */
export interface ApiResponse<T, M = undefined> {
  data: T;
  meta?: M;
}

export type ListResponse<T> = ApiResponse<T[], PageMeta>;

export interface ApiErrorDetail {
  field: string;
  message: string;
}

/** Error codes the API sends (section 7 SQLSTATE mapping plus auth and HTTP basics). */
export type ApiErrorCode =
  | 'validation_error'
  | 'invalid_transition'
  | 'rule_violation'
  | 'conflict'
  | 'duplicate'
  | 'invalid_reference'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_credentials'
  // Client-side codes (never sent by the server)
  | 'network_error'
  | 'invalid_response'
  | (string & {});

/** Error body: `{ error: { code, message, details? } }`. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetail[];
  };
}

/** Common list query parameters (`?page=1&limit=25&sort=-created_at`). */
export interface PageQuery {
  page?: number;
  limit?: number;
  sort?: string;
}

// ---------------------------------------------------------------------------
// Resources: one type per response in CONTRACT section 10, shapes from section 11 where given.
// Where section 10 names a response without a shape, the fields follow the table in section 4.
// ---------------------------------------------------------------------------

// Auth and users ------------------------------------------------------------

/** `GET /api/auth/me`, `POST /api/auth/login`, `GET /api/users`, `POST/PATCH /api/users`. */
export interface User {
  user_id: number;
  full_name: string;
  email: string;
  roles: RoleName[];
  active: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** `GET /api/roles`. */
export interface Role {
  role_id: number;
  role_name: RoleName;
  description: string | null;
}

// Projects ------------------------------------------------------------------

/** `GET /api/projects`, `POST/PATCH /api/projects`. */
export interface Project {
  project_id: number;
  title: string;
  objectives: string | null;
  start_date: string | null;
  end_date: string | null;
  status: ProjectStatus;
  created_by: number;
  /** The signed-in user's role in this project; null when they see it as an administrator. */
  your_role: ProjectRole | null;
}

/** `POST /api/projects/:id/members`, and each entry of `ProjectDetail.members`. */
export interface ProjectMember {
  project_id: number;
  user_id: number;
  full_name: string;
  email: string;
  project_role: ProjectRole;
  joined_at: string;
}

/** `GET /api/projects/:id`: project with members and sites. */
export interface ProjectDetail extends Project {
  members: ProjectMember[];
  sites: Site[];
}

// Sites and regions -----------------------------------------------------------

/** `GET /api/regions`. */
export interface Region {
  region_id: number;
  name: string;
  region_type: RegionType;
  parent_region_id: number | null;
}

/** `GET /api/sites`, `GET/POST/PATCH /api/sites/:id`. */
export interface Site {
  site_id: number;
  region_id: number;
  name: string;
  latitude: number;
  longitude: number;
  habitat_type: HabitatType;
  description: string | null;
}

// Collection events -----------------------------------------------------------

/** `GET /api/events`. */
export interface CollectionEvent {
  event_id: number;
  project_id: number;
  site_id: number;
  collector_id: number;
  collected_at: string;
  notes: string | null;
  created_at: string;
}

export interface EnvironmentalMeasurement {
  measurement_id: number;
  event_id: number;
  parameter: string;
  value: number;
  unit: string;
}

/** `GET /api/events/:id` and `POST /api/events`: event with samples and measurements. */
export interface CollectionEventDetail extends CollectionEvent {
  samples: Sample[];
  measurements: EnvironmentalMeasurement[];
}

/** `POST /api/events` body (section 11 example). */
export interface CreateEventRequest {
  project_id: number;
  site_id: number;
  collected_at: string;
  notes?: string;
  measurements?: { parameter: string; value: number; unit: string }[];
  samples?: {
    sample_type_id: number;
    volume_ml?: number;
    depth_m?: number;
    storage_location?: string;
  }[];
}

// Samples -----------------------------------------------------------------------

/** `GET /api/sample-types`. */
export interface SampleType {
  sample_type_id: number;
  type_name: string;
}

/** `GET /api/samples`, `POST /api/samples`, `PATCH /api/samples/:id/status`. */
export interface Sample {
  sample_id: number;
  event_id: number;
  sample_type_id: number;
  sample_code: string;
  volume_ml: number | null;
  depth_m: number | null;
  storage_location: string | null;
  status: SampleStatus;
  created_at: string;
}

export interface SampleStatusChange {
  old_status: SampleStatus | null;
  new_status: SampleStatus;
  changed_at: string;
  changed_by: number | null;
  note?: string | null;
}

/** `GET /api/samples/:id` (section 11 example). */
export interface SampleDetail {
  sample_id: number;
  sample_code: string;
  status: SampleStatus;
  sample_type: string;
  volume_ml: number | null;
  depth_m: number | null;
  event: { event_id: number; collected_at: string; project_id: number };
  site: { site_id: number; name: string };
  extractions: { extraction_id: number; attempt_number: number; qc_status: QcStatus }[];
  status_history: SampleStatusChange[];
}

// Laboratory ---------------------------------------------------------------------

/** `GET /api/labs`. */
export interface Laboratory {
  lab_id: number;
  name: string;
  location: string | null;
}

/** `GET /api/markers`. */
export interface DnaMarker {
  marker_id: number;
  marker_name: string;
  target_region: string | null;
}

/** `GET/POST /api/extraction-batches`. */
export interface ExtractionBatch {
  batch_id: number;
  lab_id: number;
  operator_id: number;
  extraction_date: string;
  kit_name: string | null;
  notes: string | null;
  created_at: string;
}

/** `GET/POST /api/extractions`, `PATCH /api/extractions/:id`. */
export interface DnaExtraction {
  extraction_id: number;
  sample_id: number;
  batch_id: number;
  attempt_number: number;
  concentration_ng_ul: number | null;
  purity_a260_280: number | null;
  qc_status: QcStatus;
  created_at: string;
}

/** `GET/POST /api/qc-results`. */
export interface QualityControlResult {
  qc_id: number;
  sample_id: number | null;
  analysis_id: number | null;
  qc_type: QcType;
  result: QcResult;
  metric_value: number | null;
  notes: string | null;
  recorded_by: number | null;
  recorded_at: string;
}

/** `GET /api/sequencing-runs`, `PATCH /api/sequencing-runs/:id`. */
export interface SequencingRun {
  run_id: number;
  run_code: string;
  lab_id: number;
  platform: string;
  run_date: string | null;
  status: RunStatus;
  created_at: string;
}

/** `POST /api/sequencing-runs/:id/libraries`. */
export interface SequencingLibrary {
  library_id: number;
  library_code: string;
  extraction_id: number;
  run_id: number;
  created_at: string;
}

/** `GET /api/sequencing-runs/:id`, `POST /api/sequencing-runs`: run with libraries and source samples. */
export interface SequencingRunDetail extends SequencingRun {
  libraries: (SequencingLibrary & { sample_id: number; sample_code: string })[];
}

// Analyses and detections ---------------------------------------------------------

/** `GET/POST /api/analyses`, `POST /api/analyses/:id/approve|reject`. */
export interface AnalysisRun {
  analysis_id: number;
  run_id: number;
  marker_id: number;
  pipeline_name: string;
  pipeline_version: string;
  reference_db: string;
  reference_db_version: string | null;
  parameters: Record<string, unknown>;
  status: AnalysisStatus;
  imported_by: number | null;
  approved_by: number | null;
  approved_at: string | null;
  created_at: string;
}

/** `GET /api/analyses/:id`: analysis with assignment counts by `qc_flag`. */
export interface AnalysisDetail extends AnalysisRun {
  assignment_counts: Record<QcFlag, number>;
}

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

/** `POST /api/analyses/import?dry_run=true` (section 11 example). */
export interface ImportDryRunResult {
  valid_rows: number;
  errors: ImportRowError[];
}

/** `POST /api/analyses/import` (real import). */
export interface ImportResult {
  inserted: number;
}

// Taxa ------------------------------------------------------------------------------

/** `GET /api/taxa`. */
export interface Taxon {
  taxon_id: number;
  scientific_name: string;
  rank: TaxonRank;
  parent_taxon_id: number | null;
  external_id: string | null;
}

/** `GET /api/taxa/:id`: taxon with lineage, root first. */
export interface TaxonDetail extends Taxon {
  lineage: Pick<Taxon, 'taxon_id' | 'scientific_name' | 'rank'>[];
}

/** `GET /api/taxa/:id/detections` (section 11 example). Approved, passing detections only. */
export interface TaxonDetection {
  site_id: number;
  site_name: string;
  sample_code: string;
  collected_at: string;
  analysis_id: number;
  read_count: number;
  confidence: number;
  qc_flag: QcFlag;
}

// Analytics, dashboard, exports, audit ----------------------------------------------

/** `GET /api/analytics/richness` rows (section 11 example). Response meta: `CaveatMeta`. */
export interface RichnessRow {
  group: string;
  site_id?: number;
  observed_taxa: number;
  sample_count: number;
}

/** `GET /api/analytics/detection-frequency` rows. Response meta: `CaveatMeta`. */
export interface DetectionFrequencyRow {
  site_id: number;
  detections: number;
  samples_total: number;
}

/** `GET /api/audit`, and `DashboardSummary.recent_activity`. */
export interface AuditEntry {
  audit_id: number;
  actor_id: number | null;
  entity_type: string;
  entity_id: number;
  action: AuditAction;
  details: Record<string, unknown> | null;
  created_at: string;
}

/** `GET /api/dashboard/summary`. */
export interface DashboardSummary {
  projects: number;
  sites: number;
  samples: number;
  approved_detections: number;
  recent_activity: AuditEntry[];
}

/** `POST /api/exports` body. */
export interface CreateExportRequest {
  export_type: ExportType;
  project_id: number;
  filters?: Record<string, unknown>;
}

/** `POST /api/exports`. */
export interface ExportResult {
  export_id: number;
  row_count: number;
}

/** The fixed analytics caveat (CONTRACT section 10). */
export const EDNA_CAVEAT =
  'Detection does not indicate abundance; non-detection does not indicate absence.';
