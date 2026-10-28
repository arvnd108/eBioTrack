// Owner: B (Frontend)
// Purpose: Mock API data, following the fixture world in CONTRACT section 6
//
// Access and Field & Samples rows copy database/seeds/010 and 020, so mock pages show the same
// names and IDs as the real database. Lab and Analysis rows follow the section 6 description
// until seeds 030 and 040 exist; update them to match those seeds when they land.

import type {
  AnalysisRun,
  AuditEntry,
  CollectionEvent,
  DnaExtraction,
  DnaMarker,
  EnvironmentalMeasurement,
  ExtractionBatch,
  Laboratory,
  Project,
  ProjectRole,
  QcFlag,
  QualityControlResult,
  Region,
  Role,
  Sample,
  SampleStatusChange,
  SampleType,
  SequencingLibrary,
  SequencingRun,
  Site,
  Taxon,
  User,
} from '../../types';

// ---------------------------------------------------------------------------
// Access, Projects & Audit (seed 010)
// ---------------------------------------------------------------------------

export const mockRoles: Role[] = [
  { role_id: 1, role_name: 'administrator', description: 'Manages users, roles, and settings' },
  {
    role_id: 2,
    role_name: 'principal_investigator',
    description: 'Leads projects and approves analyses',
  },
  { role_id: 3, role_name: 'field_researcher', description: 'Records sites, events, and samples' },
  {
    role_id: 4,
    role_name: 'lab_technician',
    description: 'Records extractions, QC, and sequencing',
  },
  { role_id: 5, role_name: 'analyst', description: 'Imports and reviews taxonomic assignments' },
  { role_id: 6, role_name: 'viewer', description: 'Read-only access' },
];

const userRow = (id: number, full_name: string): User => {
  const role = mockRoles[id - 1].role_name;
  return { user_id: id, full_name, email: `${role}@ebiotrack.test`, roles: [role], active: true };
};

/** Users 1–6, one per role, in role order. */
export const mockUsers: User[] = [
  userRow(1, 'Asha Admin'),
  userRow(2, 'Pranav Investigator'),
  userRow(3, 'Farah Field'),
  userRow(4, 'Lakshmi Lab'),
  userRow(5, 'Anil Analyst'),
  userRow(6, 'Vikram Viewer'),
];

/** Projects 1–2. `your_role` is filled in per user by the mock API. */
export const mockProjects: Omit<Project, 'your_role'>[] = [
  {
    project_id: 1,
    title: 'Yamuna Biodiversity Survey',
    objectives:
      'Track fish and invertebrate biodiversity along the Yamuna using eDNA from three river sites, sampled once a year.',
    start_date: '2025-01-15',
    end_date: null,
    status: 'active',
    created_by: 2,
  },
  {
    project_id: 2,
    title: 'Coastal Estuary Pilot',
    objectives: 'Pilot eDNA sampling at two estuary sites to test the protocol before scaling up.',
    start_date: '2026-01-10',
    end_date: null,
    status: 'active',
    created_by: 2,
  },
];

/** project_members: project_id -> user_id -> project role (user 1 is admin by global role). */
export const mockMemberships: Record<number, Record<number, ProjectRole>> = {
  1: { 2: 'owner', 3: 'contributor', 4: 'contributor', 5: 'contributor', 6: 'viewer' },
  2: { 2: 'owner', 3: 'contributor' },
};

// ---------------------------------------------------------------------------
// Field & Samples (seed 020)
// ---------------------------------------------------------------------------

export const mockRegions: Region[] = [
  { region_id: 1, name: 'India', region_type: 'country', parent_region_id: null },
  { region_id: 2, name: 'Yamuna River Basin', region_type: 'basin', parent_region_id: 1 },
  { region_id: 3, name: 'Hooghly Estuary', region_type: 'other', parent_region_id: 1 },
];

export const mockSites: Site[] = [
  {
    site_id: 1,
    region_id: 2,
    name: 'Dakpathar Barrage',
    latitude: 30.505,
    longitude: 77.795,
    habitat_type: 'river',
    description: 'Upper reaches near Yamuna barrage',
  },
  {
    site_id: 2,
    region_id: 2,
    name: 'Okhla Barrage',
    latitude: 28.545,
    longitude: 77.305,
    habitat_type: 'river',
    description: 'Middle segment near Delhi NCT',
  },
  {
    site_id: 3,
    region_id: 2,
    name: 'Sangam Prayagraj',
    latitude: 25.425,
    longitude: 81.885,
    habitat_type: 'river',
    description: 'Lower confluence segment',
  },
  {
    site_id: 4,
    region_id: 3,
    name: 'Diamond Harbour',
    latitude: 22.195,
    longitude: 88.195,
    habitat_type: 'estuary',
    description: 'Upper tidal brackish zone',
  },
  {
    site_id: 5,
    region_id: 3,
    name: 'Kakdwip Bay',
    latitude: 21.875,
    longitude: 88.185,
    habitat_type: 'estuary',
    description: 'Lower marine-influence estuary',
  },
];

/** project_sites. */
export const mockProjectSites: Record<number, number[]> = { 1: [1, 2, 3], 2: [4, 5] };

export const mockSampleTypes: SampleType[] = [
  { sample_type_id: 1, type_name: 'water' },
  { sample_type_id: 2, type_name: 'soil' },
  { sample_type_id: 3, type_name: 'sediment' },
  { sample_type_id: 4, type_name: 'air' },
];

const eventRow = (
  event_id: number,
  project_id: number,
  site_id: number,
  collected_at: string,
  notes: string,
): CollectionEvent => ({
  event_id,
  project_id,
  site_id,
  collector_id: 3,
  collected_at,
  notes,
  created_at: collected_at,
});

export const mockEvents: CollectionEvent[] = [
  eventRow(1, 1, 1, '2025-05-15T08:30:00Z', 'Pre-monsoon survey upper Yamuna'),
  eventRow(2, 1, 2, '2025-05-18T09:15:00Z', 'Pre-monsoon survey mid Yamuna'),
  eventRow(3, 1, 3, '2025-05-22T07:45:00Z', 'Pre-monsoon survey lower Yamuna'),
  eventRow(4, 1, 1, '2026-03-10T08:00:00Z', 'Post-winter monitoring upper Yamuna'),
  eventRow(5, 1, 2, '2026-03-12T09:30:00Z', 'Post-winter monitoring mid Yamuna'),
  eventRow(6, 1, 3, '2026-03-15T08:15:00Z', 'Post-winter monitoring lower Yamuna'),
  eventRow(7, 2, 4, '2026-04-05T10:00:00Z', 'Spring tidal collection upper estuary'),
  eventRow(8, 2, 5, '2026-04-08T11:30:00Z', 'Spring tidal collection lower estuary'),
];

/** Sample code format: EB-<YYYYMMDD>-<event, 4 digits>-<sequence, 3 digits> (section 4.2). */
export function sampleCode(event: CollectionEvent, sequence: number): string {
  const day = event.collected_at.slice(0, 10).replace(/-/g, '');
  return `EB-${day}-${String(event.event_id).padStart(4, '0')}-${String(sequence).padStart(3, '0')}`;
}

const DEPTHS = [0.5, 1.0, 0.5, 1.2, 0.5, 1.5, 0.5, 1.0, 0.5, 1.0, 0.5, 1.5, 0.5, 1.0, 0.5, 1.5];
const STORAGE = [
  'Freezer A-1',
  'Freezer A-1',
  'Freezer A-2',
  'Freezer B-1',
  'Freezer B-1',
  'Freezer B-2',
  'Freezer C-1',
  'Freezer C-1',
];

/** Samples 1–16 (event n has samples 2n−1 and 2n), plus sample 17 on event 1 that failed. */
export const mockSamples: Sample[] = [
  ...Array.from({ length: 16 }, (_, i): Sample => {
    const event = mockEvents[Math.floor(i / 2)];
    return {
      sample_id: i + 1,
      event_id: event.event_id,
      sample_type_id: 1,
      sample_code: sampleCode(event, (i % 2) + 1),
      volume_ml: 1000,
      depth_m: DEPTHS[i],
      storage_location: STORAGE[Math.floor(i / 2)],
      status: 'analyzed',
      created_at: event.collected_at,
    };
  }),
  {
    sample_id: 17,
    event_id: 1,
    sample_type_id: 1,
    sample_code: sampleCode(mockEvents[0], 3),
    volume_ml: 500,
    depth_m: 0.5,
    storage_location: 'Freezer A-1',
    status: 'failed',
    created_at: mockEvents[0].collected_at,
  },
];

const MEASUREMENTS: [number, number, number, number][] = [
  // temperature_c, ph, dissolved_oxygen_mg_l, turbidity_ntu per event 1–8
  [24.5, 7.8, 6.5, 12.0],
  [28.2, 7.4, 4.2, 28.5],
  [26.8, 7.6, 5.8, 18.0],
  [19.5, 8.1, 7.8, 8.5],
  [23.4, 7.3, 5.0, 22.0],
  [22.1, 7.9, 6.9, 14.5],
  [26.0, 8.0, 6.1, 15.0],
  [27.5, 8.2, 5.9, 20.0],
];
const PARAMETERS: [string, string][] = [
  ['temperature_c', 'celsius'],
  ['ph', 'pH'],
  ['dissolved_oxygen_mg_l', 'mg/L'],
  ['turbidity_ntu', 'NTU'],
];

export const mockMeasurements: EnvironmentalMeasurement[] = MEASUREMENTS.flatMap((values, e) =>
  values.map((value, p) => ({
    measurement_id: e * 4 + p + 1,
    event_id: e + 1,
    parameter: PARAMETERS[p][0],
    value,
    unit: PARAMETERS[p][1],
  })),
);

/** Status history consistent with each sample's current status. */
export function statusHistoryFor(sample: Sample): SampleStatusChange[] {
  const t = sample.created_at;
  if (sample.status === 'failed') {
    return [
      {
        old_status: null,
        new_status: 'collected',
        changed_at: t,
        changed_by: 3,
        note: 'Initial field collection',
      },
      {
        old_status: 'collected',
        new_status: 'stored',
        changed_at: t,
        changed_by: 3,
        note: 'Stored at 4C in field depot',
      },
      {
        old_status: 'stored',
        new_status: 'failed',
        changed_at: t,
        changed_by: 4,
        note: 'Extraction failed QC',
      },
    ];
  }
  const steps: [SampleStatusChange['new_status'], number, string][] = [
    ['collected', 3, 'Initial field collection'],
    ['stored', 3, 'Stored at 4C in field depot'],
    ['extracted', 4, 'DNA extraction completed'],
    ['sequenced', 4, 'Sequencing run completed'],
    ['analyzed', 5, 'Taxonomic assignment approved'],
  ];
  return steps.map(([new_status, changed_by, note], i) => ({
    old_status: i === 0 ? null : steps[i - 1][0],
    new_status,
    changed_at: t,
    changed_by,
    note,
  }));
}

// ---------------------------------------------------------------------------
// Laboratory & Sequencing (section 6; replace with seed 030 values when it lands)
// ---------------------------------------------------------------------------

export const mockLabs: Laboratory[] = [
  { lab_id: 1, name: 'Dehradun eDNA Lab', location: 'Dehradun, Uttarakhand' },
  { lab_id: 2, name: 'Kolkata Marine Genomics Lab', location: 'Kolkata, West Bengal' },
];

export const mockBatches: ExtractionBatch[] = [
  {
    batch_id: 1,
    lab_id: 1,
    operator_id: 4,
    extraction_date: '2025-05-20',
    kit_name: 'DNeasy PowerWater',
    notes: null,
    created_at: '2025-05-20T14:00:00Z',
  },
  {
    batch_id: 2,
    lab_id: 1,
    operator_id: 4,
    extraction_date: '2025-05-25',
    kit_name: 'DNeasy PowerWater',
    notes: null,
    created_at: '2025-05-25T11:00:00Z',
  },
  {
    batch_id: 3,
    lab_id: 2,
    operator_id: 4,
    extraction_date: '2026-03-16',
    kit_name: 'DNeasy PowerWater',
    notes: null,
    created_at: '2026-03-16T10:00:00Z',
  },
];

/** Extraction n for sample n; 1–16 pass, 17 fails. */
export const mockExtractions: DnaExtraction[] = mockSamples.map((s) => {
  const failed = s.sample_id === 17;
  return {
    extraction_id: s.sample_id,
    sample_id: s.sample_id,
    batch_id: s.sample_id <= 4 || failed ? 1 : s.sample_id <= 6 ? 2 : 3,
    attempt_number: 1,
    concentration_ng_ul: failed ? 0.4 : Number((8 + (s.sample_id % 5) * 1.7).toFixed(3)),
    purity_a260_280: failed ? 1.21 : Number((1.78 + (s.sample_id % 4) * 0.04).toFixed(2)),
    qc_status: failed ? 'fail' : 'pass',
    created_at: s.created_at,
  };
});

export const mockRuns: SequencingRun[] = [
  {
    run_id: 1,
    run_code: 'RUN-0001',
    lab_id: 1,
    platform: 'Illumina MiSeq',
    run_date: '2025-06-02',
    status: 'completed',
    created_at: '2025-06-01T09:00:00Z',
  },
  {
    run_id: 2,
    run_code: 'RUN-0002',
    lab_id: 2,
    platform: 'Illumina MiSeq',
    run_date: '2026-03-25',
    status: 'completed',
    created_at: '2026-03-24T09:00:00Z',
  },
];

/** Library n from extraction n; run 1 holds libraries 1–8, run 2 holds 9–16. */
export const mockLibraries: SequencingLibrary[] = Array.from({ length: 16 }, (_, i) => ({
  library_id: i + 1,
  library_code: `LIB-${String(i + 1).padStart(4, '0')}`,
  extraction_id: i + 1,
  run_id: i < 8 ? 1 : 2,
  created_at: i < 8 ? '2025-06-01T09:00:00Z' : '2026-03-24T09:00:00Z',
}));

export const mockQcResults: QualityControlResult[] = [
  {
    qc_id: 1,
    sample_id: 1,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 9.7,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-20T15:00:00Z',
  },
  {
    qc_id: 2,
    sample_id: 5,
    analysis_id: null,
    qc_type: 'extraction_blank',
    result: 'pass',
    metric_value: 0.02,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-25T12:00:00Z',
  },
  {
    qc_id: 3,
    sample_id: 17,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'fail',
    metric_value: 0.4,
    notes: 'Below 1 ng/µL; re-extract',
    recorded_by: 4,
    recorded_at: '2025-05-20T15:10:00Z',
  },
  {
    qc_id: 4,
    sample_id: 12,
    analysis_id: null,
    qc_type: 'contamination_check',
    result: 'warn',
    metric_value: 0.8,
    notes: 'Faint band in negative control',
    recorded_by: 4,
    recorded_at: '2026-03-16T12:00:00Z',
  },
  {
    qc_id: 5,
    sample_id: null,
    analysis_id: 1,
    qc_type: 'read_quality',
    result: 'pass',
    metric_value: 34.2,
    notes: 'Mean Q score',
    recorded_by: 5,
    recorded_at: '2025-06-05T10:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Analysis & Taxonomy (section 6; replace with seed 040 values when it lands)
// ---------------------------------------------------------------------------

export const mockMarkers: DnaMarker[] = [
  { marker_id: 1, marker_name: '12S', target_region: '12S rRNA (MiFish)' },
  { marker_id: 2, marker_name: 'COI', target_region: 'Cytochrome c oxidase I' },
];

const analysisRow = (
  analysis_id: number,
  run_id: number,
  marker_id: number,
  status: AnalysisRun['status'],
  created_at: string,
): AnalysisRun => ({
  analysis_id,
  run_id,
  marker_id,
  pipeline_name: 'nf-core/ampliseq',
  pipeline_version: '2.11.0',
  reference_db: marker_id === 1 ? 'MitoFish' : 'BOLD',
  reference_db_version: '2025-01',
  parameters: {},
  status,
  imported_by: 5,
  approved_by: status === 'approved' ? 2 : null,
  approved_at: status === 'approved' ? created_at : null,
  created_at,
});

/** 1, 2: 12S approved. 3: COI imported (awaiting approval). 4: COI draft (empty). */
export const mockAnalyses: AnalysisRun[] = [
  analysisRow(1, 1, 1, 'approved', '2025-06-10T10:15:00Z'),
  analysisRow(2, 2, 1, 'approved', '2026-04-02T11:30:00Z'),
  analysisRow(3, 2, 2, 'imported', '2026-04-03T09:00:00Z'),
  analysisRow(4, 1, 2, 'draft', '2026-04-04T09:00:00Z'),
];

const taxonRow = (
  taxon_id: number,
  scientific_name: string,
  rank: Taxon['rank'],
  parent_taxon_id: number | null,
): Taxon => ({ taxon_id, scientific_name, rank, parent_taxon_id, external_id: null });

export const mockTaxa: Taxon[] = [
  taxonRow(1, 'Animalia', 'kingdom', null),
  taxonRow(2, 'Chordata', 'phylum', 1),
  taxonRow(3, 'Actinopterygii', 'class', 2),
  taxonRow(4, 'Cypriniformes', 'order', 3),
  taxonRow(5, 'Cyprinidae', 'family', 4),
  taxonRow(6, 'Labeo', 'genus', 5),
  taxonRow(7, 'Catla', 'genus', 5),
  taxonRow(8, 'Labeo rohita', 'species', 6),
  taxonRow(9, 'Catla catla', 'species', 7),
  taxonRow(10, 'Siluriformes', 'order', 3),
  taxonRow(11, 'Bagridae', 'family', 10),
  taxonRow(12, 'Sperata', 'genus', 11),
  taxonRow(13, 'Sperata aor', 'species', 12),
  taxonRow(14, 'Mammalia', 'class', 2),
  taxonRow(15, 'Platanista gangetica', 'species', 14),
];

export interface MockAssignment {
  assignment_id: number;
  analysis_id: number;
  library_id: number;
  taxon_id: number;
  read_count: number;
  confidence: number;
  qc_flag: QcFlag;
}

/** Detections: which species each library's sample shows, per analysis. */
const DETECTED: Record<number, number[]> = {
  // library -> species taxon ids (river sites see more taxa upstream)
  1: [8, 9, 13],
  2: [8, 9],
  3: [8, 13],
  4: [9],
  5: [8, 9, 15],
  6: [8],
  7: [8, 9, 13],
  8: [8, 13],
  9: [8],
  10: [8, 9],
  11: [9, 13, 15],
  12: [8, 9],
  13: [13],
  14: [13, 15],
  15: [13],
  16: [15],
};

export const mockAssignments: MockAssignment[] = (() => {
  const rows: MockAssignment[] = [];
  const add = (analysis_id: number, library_id: number, taxon_id: number, qc_flag: QcFlag) =>
    rows.push({
      assignment_id: rows.length + 1,
      analysis_id,
      library_id,
      taxon_id,
      read_count: 200 + ((library_id * 37 + taxon_id * 53) % 1500),
      confidence: Number((0.82 + ((library_id + taxon_id) % 17) / 100).toFixed(4)),
      qc_flag,
    });
  for (const [lib, taxa] of Object.entries(DETECTED)) {
    const library_id = Number(lib);
    const analysis_id = library_id <= 8 ? 1 : 2;
    taxa.forEach((taxon_id, i) =>
      add(analysis_id, library_id, taxon_id, i === 2 ? 'warn' : 'pass'),
    );
  }
  // Analysis 3 (COI, imported, not yet approved) on run 2, one failing row.
  add(3, 9, 9, 'pass');
  add(3, 10, 13, 'pass');
  add(3, 11, 8, 'fail');
  return rows;
})();

export const mockAudit: AuditEntry[] = [
  {
    audit_id: 5,
    actor_id: 2,
    entity_type: 'analysis_runs',
    entity_id: 2,
    action: 'approve',
    details: { status: { old: 'imported', new: 'approved' } },
    created_at: '2026-04-02T11:30:00Z',
  },
  {
    audit_id: 4,
    actor_id: 5,
    entity_type: 'analysis_runs',
    entity_id: 3,
    action: 'insert',
    details: null,
    created_at: '2026-04-03T09:00:00Z',
  },
  {
    audit_id: 3,
    actor_id: 3,
    entity_type: 'collection_events',
    entity_id: 8,
    action: 'insert',
    details: null,
    created_at: '2026-04-08T11:30:00Z',
  },
  {
    audit_id: 2,
    actor_id: 4,
    entity_type: 'sequencing_runs',
    entity_id: 2,
    action: 'update',
    details: { status: { old: 'running', new: 'completed' } },
    created_at: '2026-03-25T14:00:00Z',
  },
  {
    audit_id: 1,
    actor_id: 1,
    entity_type: 'users',
    entity_id: 6,
    action: 'login',
    details: null,
    created_at: '2026-03-01T08:00:00Z',
  },
];

export function hasAnyRole(user: User, roles: User['roles']): boolean {
  return user.roles.some((r) => roles.includes(r));
}
