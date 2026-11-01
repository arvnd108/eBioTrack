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

/**
 * The one development password every seeded user shares (tests/fixtures/README.md). Mock mode
 * checks it exactly like the real API, so a wrong password gives the same 401 in both modes.
 * Development and test only, never a real credential.
 */
export const DEV_PASSWORD = 'ebiotrack-dev-2026';

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
// Laboratory & Sequencing (copies seed 030, database/seeds/030_seed_lab.sql)
// ---------------------------------------------------------------------------

export const mockLabs: Laboratory[] = [
  { lab_id: 1, name: 'Dehradun eDNA Laboratory', location: 'Dehradun, Uttarakhand' },
  { lab_id: 2, name: 'Kolkata Estuarine Genomics Laboratory', location: 'Kolkata, West Bengal' },
];

export const mockBatches: ExtractionBatch[] = [
  {
    batch_id: 1,
    lab_id: 1,
    operator_id: 4,
    extraction_date: '2025-05-20',
    kit_name: 'DNeasy PowerWater Kit',
    notes: '2025 pre-monsoon river samples',
    created_at: '2025-05-20T13:30:00Z',
  },
  {
    batch_id: 2,
    lab_id: 1,
    operator_id: 4,
    extraction_date: '2026-03-16',
    kit_name: 'DNeasy PowerWater Kit',
    notes: '2026 post-winter river samples',
    created_at: '2026-03-16T09:30:00Z',
  },
  {
    batch_id: 3,
    lab_id: 2,
    operator_id: 4,
    extraction_date: '2026-04-10',
    kit_name: 'DNeasy PowerWater Kit',
    notes: '2026 spring estuary samples',
    created_at: '2026-04-10T10:00:00Z',
  },
];

/** Extraction n for sample n (seed 030); 1–16 pass, 17 fails. */
export const mockExtractions: DnaExtraction[] = [
  {
    extraction_id: 1,
    sample_id: 1,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 18.42,
    purity_a260_280: 1.86,
    qc_status: 'pass',
    created_at: '2025-05-20T14:00:00Z',
  },
  {
    extraction_id: 2,
    sample_id: 2,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 15.73,
    purity_a260_280: 1.84,
    qc_status: 'pass',
    created_at: '2025-05-20T14:00:00Z',
  },
  {
    extraction_id: 3,
    sample_id: 3,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 22.91,
    purity_a260_280: 1.88,
    qc_status: 'pass',
    created_at: '2025-05-20T15:00:00Z',
  },
  {
    extraction_id: 4,
    sample_id: 4,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 12.05,
    purity_a260_280: 1.81,
    qc_status: 'pass',
    created_at: '2025-05-20T15:00:00Z',
  },
  {
    extraction_id: 5,
    sample_id: 5,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 27.36,
    purity_a260_280: 1.9,
    qc_status: 'pass',
    created_at: '2025-05-25T11:00:00Z',
  },
  {
    extraction_id: 6,
    sample_id: 6,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 9.88,
    purity_a260_280: 1.79,
    qc_status: 'pass',
    created_at: '2025-05-25T11:00:00Z',
  },
  {
    extraction_id: 7,
    sample_id: 7,
    batch_id: 2,
    attempt_number: 1,
    concentration_ng_ul: 31.24,
    purity_a260_280: 1.92,
    qc_status: 'pass',
    created_at: '2026-03-16T10:00:00Z',
  },
  {
    extraction_id: 8,
    sample_id: 8,
    batch_id: 2,
    attempt_number: 1,
    concentration_ng_ul: 24.67,
    purity_a260_280: 1.87,
    qc_status: 'pass',
    created_at: '2026-03-16T10:00:00Z',
  },
  {
    extraction_id: 9,
    sample_id: 9,
    batch_id: 2,
    attempt_number: 1,
    concentration_ng_ul: 14.12,
    purity_a260_280: 1.83,
    qc_status: 'pass',
    created_at: '2026-03-16T11:00:00Z',
  },
  {
    extraction_id: 10,
    sample_id: 10,
    batch_id: 2,
    attempt_number: 1,
    concentration_ng_ul: 11.59,
    purity_a260_280: 1.8,
    qc_status: 'pass',
    created_at: '2026-03-16T11:00:00Z',
  },
  {
    extraction_id: 11,
    sample_id: 11,
    batch_id: 2,
    attempt_number: 1,
    concentration_ng_ul: 19.33,
    purity_a260_280: 1.85,
    qc_status: 'pass',
    created_at: '2026-03-16T12:00:00Z',
  },
  {
    extraction_id: 12,
    sample_id: 12,
    batch_id: 2,
    attempt_number: 1,
    concentration_ng_ul: 8.76,
    purity_a260_280: 1.77,
    qc_status: 'pass',
    created_at: '2026-03-16T12:00:00Z',
  },
  {
    extraction_id: 13,
    sample_id: 13,
    batch_id: 3,
    attempt_number: 1,
    concentration_ng_ul: 16.48,
    purity_a260_280: 1.84,
    qc_status: 'pass',
    created_at: '2026-04-10T10:30:00Z',
  },
  {
    extraction_id: 14,
    sample_id: 14,
    batch_id: 3,
    attempt_number: 1,
    concentration_ng_ul: 13.91,
    purity_a260_280: 1.82,
    qc_status: 'pass',
    created_at: '2026-04-10T10:30:00Z',
  },
  {
    extraction_id: 15,
    sample_id: 15,
    batch_id: 3,
    attempt_number: 1,
    concentration_ng_ul: 21.05,
    purity_a260_280: 1.89,
    qc_status: 'pass',
    created_at: '2026-04-10T11:30:00Z',
  },
  {
    extraction_id: 16,
    sample_id: 16,
    batch_id: 3,
    attempt_number: 1,
    concentration_ng_ul: 10.27,
    purity_a260_280: 1.78,
    qc_status: 'pass',
    created_at: '2026-04-10T11:30:00Z',
  },
  {
    extraction_id: 17,
    sample_id: 17,
    batch_id: 1,
    attempt_number: 1,
    concentration_ng_ul: 0.35,
    purity_a260_280: 1.32,
    qc_status: 'fail',
    created_at: '2025-05-20T14:00:00Z',
  },
];

export const mockRuns: SequencingRun[] = [
  {
    run_id: 1,
    run_code: 'RUN-001',
    lab_id: 1,
    platform: 'Illumina MiSeq',
    run_date: '2026-03-25',
    status: 'completed',
    created_at: '2026-03-24T09:00:00Z',
  },
  {
    run_id: 2,
    run_code: 'RUN-002',
    lab_id: 2,
    platform: 'Illumina MiSeq',
    run_date: '2026-04-18',
    status: 'completed',
    created_at: '2026-04-17T09:00:00Z',
  },
];

/** Library n from extraction n; run 1 holds libraries 1–8, run 2 holds 9–16. */
export const mockLibraries: SequencingLibrary[] = Array.from({ length: 16 }, (_, i) => ({
  library_id: i + 1,
  library_code: `LIB-${String(i + 1).padStart(4, '0')}`,
  extraction_id: i + 1,
  run_id: i < 8 ? 1 : 2,
  created_at: i < 8 ? '2026-03-24T10:00:00Z' : '2026-04-17T10:00:00Z',
}));

/** Seed 030: all linked by sample_id; analysis-linked QC rows are not seeded. */
export const mockQcResults: QualityControlResult[] = [
  {
    qc_id: 1,
    sample_id: 1,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 18.42,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-20T15:30:00Z',
  },
  {
    qc_id: 2,
    sample_id: 2,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 15.73,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-20T15:30:00Z',
  },
  {
    qc_id: 3,
    sample_id: 3,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 22.91,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-20T16:30:00Z',
  },
  {
    qc_id: 4,
    sample_id: 4,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 12.05,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-20T16:30:00Z',
  },
  {
    qc_id: 5,
    sample_id: 5,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 27.36,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-25T12:30:00Z',
  },
  {
    qc_id: 6,
    sample_id: 6,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 9.88,
    notes: null,
    recorded_by: 4,
    recorded_at: '2025-05-25T12:30:00Z',
  },
  {
    qc_id: 7,
    sample_id: 7,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 31.24,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-03-16T11:30:00Z',
  },
  {
    qc_id: 8,
    sample_id: 8,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 24.67,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-03-16T11:30:00Z',
  },
  {
    qc_id: 9,
    sample_id: 9,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 14.12,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-03-16T12:30:00Z',
  },
  {
    qc_id: 10,
    sample_id: 10,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 11.59,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-03-16T12:30:00Z',
  },
  {
    qc_id: 11,
    sample_id: 11,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 19.33,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-03-16T13:30:00Z',
  },
  {
    qc_id: 12,
    sample_id: 12,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 8.76,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-03-16T13:30:00Z',
  },
  {
    qc_id: 13,
    sample_id: 13,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 16.48,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-04-10T12:00:00Z',
  },
  {
    qc_id: 14,
    sample_id: 14,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 13.91,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-04-10T12:00:00Z',
  },
  {
    qc_id: 15,
    sample_id: 15,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 21.05,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-04-10T13:00:00Z',
  },
  {
    qc_id: 16,
    sample_id: 16,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'pass',
    metric_value: 10.27,
    notes: null,
    recorded_by: 4,
    recorded_at: '2026-04-10T13:00:00Z',
  },
  {
    qc_id: 17,
    sample_id: 17,
    analysis_id: null,
    qc_type: 'concentration',
    result: 'fail',
    metric_value: 0.35,
    notes: 'Below 1.0 ng/uL; sample marked failed',
    recorded_by: 4,
    recorded_at: '2025-05-20T15:30:00Z',
  },
  {
    qc_id: 18,
    sample_id: 1,
    analysis_id: null,
    qc_type: 'extraction_blank',
    result: 'pass',
    metric_value: 0.02,
    notes: 'Batch 1 blank',
    recorded_by: 4,
    recorded_at: '2025-05-20T15:45:00Z',
  },
  {
    qc_id: 19,
    sample_id: 7,
    analysis_id: null,
    qc_type: 'extraction_blank',
    result: 'pass',
    metric_value: 0.03,
    notes: 'Batch 2 blank',
    recorded_by: 4,
    recorded_at: '2026-03-16T11:45:00Z',
  },
  {
    qc_id: 20,
    sample_id: 13,
    analysis_id: null,
    qc_type: 'extraction_blank',
    result: 'pass',
    metric_value: 0.01,
    notes: 'Batch 3 blank',
    recorded_by: 4,
    recorded_at: '2026-04-10T12:15:00Z',
  },
  {
    qc_id: 21,
    sample_id: 7,
    analysis_id: null,
    qc_type: 'positive_control',
    result: 'pass',
    metric_value: 1,
    notes: 'Mock community amplified as expected',
    recorded_by: 4,
    recorded_at: '2026-03-16T14:00:00Z',
  },
  {
    qc_id: 22,
    sample_id: 12,
    analysis_id: null,
    qc_type: 'negative_control',
    result: 'warn',
    metric_value: 0.08,
    notes: 'Faint band in PCR negative; within tolerance, kept',
    recorded_by: 4,
    recorded_at: '2026-03-16T14:00:00Z',
  },
  {
    qc_id: 23,
    sample_id: 17,
    analysis_id: null,
    qc_type: 'contamination_check',
    result: 'fail',
    metric_value: null,
    notes: 'Low yield and A260/280 1.32 suggest inhibitors',
    recorded_by: 4,
    recorded_at: '2025-05-20T15:50:00Z',
  },
];

// ---------------------------------------------------------------------------
// Analysis & Taxonomy (copies seed 040, database/seeds/040_seed_analysis.sql)
// ---------------------------------------------------------------------------

export const mockMarkers: DnaMarker[] = [
  { marker_id: 1, marker_name: '12S', target_region: 'Mitochondrial 12S rRNA (MiFish region)' },
  {
    marker_id: 2,
    marker_name: 'COI',
    target_region: 'Mitochondrial cytochrome c oxidase subunit I',
  },
];

const analysisRow = (
  fields: Pick<AnalysisRun, 'analysis_id' | 'run_id' | 'marker_id' | 'status' | 'created_at'> &
    Partial<AnalysisRun>,
): AnalysisRun => {
  const twelveS = fields.marker_id === 1;
  return {
    pipeline_name: 'OBITools3',
    pipeline_version: twelveS ? '3.0.1' : '3.1.0',
    reference_db: twelveS ? 'MitoFish' : 'BOLD Systems',
    reference_db_version: twelveS ? (fields.analysis_id === 1 ? '2025-06' : '2026-01') : '2026-01',
    parameters: twelveS
      ? { min_length: 100, min_quality: 30, identity_cutoff: 0.97 }
      : { min_length: 250, min_quality: 28, identity_cutoff: 0.95 },
    imported_by: 5,
    approved_by: null,
    approved_at: null,
    ...fields,
  };
};

/** 1, 2: 12S approved. 3: COI imported (awaiting approval). 4: COI draft (empty, no importer). */
export const mockAnalyses: AnalysisRun[] = [
  analysisRow({
    analysis_id: 1,
    run_id: 1,
    marker_id: 1,
    status: 'approved',
    approved_by: 2,
    approved_at: '2026-04-02T11:30:00Z',
    created_at: '2026-03-30T09:00:00Z',
  }),
  analysisRow({
    analysis_id: 2,
    run_id: 2,
    marker_id: 1,
    status: 'approved',
    approved_by: 2,
    approved_at: '2026-04-25T14:00:00Z',
    created_at: '2026-04-22T09:00:00Z',
  }),
  analysisRow({
    analysis_id: 3,
    run_id: 2,
    marker_id: 2,
    status: 'imported',
    created_at: '2026-04-27T09:00:00Z',
  }),
  analysisRow({
    analysis_id: 4,
    run_id: 1,
    marker_id: 2,
    status: 'draft',
    imported_by: null,
    created_at: '2026-04-27T09:30:00Z',
  }),
];

const taxonRow = (
  taxon_id: number,
  scientific_name: string,
  rank: Taxon['rank'],
  parent_taxon_id: number | null,
  external_id: string | null = null,
): Taxon => ({ taxon_id, scientific_name, rank, parent_taxon_id, external_id });

export const mockTaxa: Taxon[] = [
  taxonRow(1, 'Animalia', 'kingdom', null, '33208'),
  taxonRow(2, 'Chordata', 'phylum', 1, '7711'),
  taxonRow(3, 'Actinopterygii', 'class', 2, '7898'),
  taxonRow(4, 'Cypriniformes', 'order', 3, '7952'),
  taxonRow(5, 'Cyprinidae', 'family', 4, '7953'),
  taxonRow(6, 'Labeo', 'genus', 5),
  taxonRow(7, 'Labeo rohita', 'species', 6, '84645'),
  taxonRow(8, 'Labeo calbasu', 'species', 6),
  taxonRow(9, 'Labeo bata', 'species', 6),
  taxonRow(10, 'Cirrhinus', 'genus', 5),
  taxonRow(11, 'Cirrhinus mrigala', 'species', 10),
  taxonRow(12, 'Cyprinus', 'genus', 5),
  taxonRow(13, 'Cyprinus carpio', 'species', 12, '7962'),
  taxonRow(14, 'Gambusia', 'genus', 3),
  taxonRow(15, 'Gambusia affinis', 'species', 14, '33528'),
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

/** Seed 040: [assignment_id, analysis_id, library_id, taxon_id, read_count, confidence, qc_flag]. */
const ASSIGNMENTS: [number, number, number, number, number, number, QcFlag][] = [
  [1, 1, 1, 7, 18420, 0.9812, 'pass'],
  [2, 1, 1, 8, 2310, 0.934, 'pass'],
  [3, 1, 2, 7, 15210, 0.9755, 'pass'],
  [4, 1, 3, 7, 12480, 0.9677, 'pass'],
  [5, 1, 3, 11, 6420, 0.9215, 'pass'],
  [6, 1, 4, 7, 9860, 0.9602, 'pass'],
  [7, 1, 4, 11, 5130, 0.912, 'pass'],
  [8, 1, 5, 7, 8810, 0.9544, 'pass'],
  [9, 1, 5, 11, 4470, 0.9033, 'pass'],
  [10, 1, 6, 7, 6390, 0.942, 'pass'],
  [11, 1, 6, 11, 12, 0.612, 'warn'],
  [12, 1, 7, 7, 22650, 0.9901, 'pass'],
  [13, 1, 7, 8, 3120, 0.9482, 'pass'],
  [14, 1, 7, 11, 95, 0.521, 'warn'],
  [15, 1, 8, 7, 19870, 0.983, 'pass'],
  [16, 1, 8, 8, 2750, 0.9411, 'pass'],
  [17, 1, 8, 11, 41, 0.4388, 'fail'],
  [18, 2, 9, 7, 17340, 0.9788, 'pass'],
  [19, 2, 10, 7, 14020, 0.9731, 'pass'],
  [20, 2, 11, 7, 10240, 0.965, 'pass'],
  [21, 2, 11, 11, 5560, 0.915, 'pass'],
  [22, 2, 12, 7, 7720, 0.95, 'pass'],
  [23, 2, 12, 11, 4890, 0.908, 'pass'],
  [24, 2, 13, 11, 3350, 0.901, 'pass'],
  [25, 2, 13, 7, 5120, 0.938, 'pass'],
  [26, 2, 14, 7, 4470, 0.929, 'pass'],
  [27, 2, 15, 7, 2150, 0.882, 'pass'],
  [28, 2, 15, 11, 38, 0.471, 'fail'],
  [29, 3, 9, 7, 9120, 0.964, 'pass'],
  [30, 3, 9, 15, 2410, 0.93, 'pass'],
  [31, 3, 10, 7, 7230, 0.951, 'pass'],
  [32, 3, 10, 15, 1890, 0.915, 'pass'],
  [33, 3, 11, 7, 8450, 0.956, 'pass'],
  [34, 3, 11, 11, 3120, 0.904, 'pass'],
  [35, 3, 12, 7, 6010, 0.942, 'pass'],
  [36, 3, 12, 15, 220, 0.71, 'warn'],
  [37, 3, 13, 15, 5230, 0.947, 'pass'],
  [38, 3, 13, 11, 2170, 0.886, 'pass'],
  [39, 3, 14, 15, 4180, 0.938, 'pass'],
  [40, 3, 14, 7, 1260, 0.831, 'pass'],
  [41, 3, 15, 15, 3340, 0.925, 'pass'],
  [42, 3, 15, 7, 25, 0.402, 'fail'],
  [43, 3, 16, 15, 14, 0.351, 'fail'],
];

export const mockAssignments: MockAssignment[] = ASSIGNMENTS.map(
  ([assignment_id, analysis_id, library_id, taxon_id, read_count, confidence, qc_flag]) => ({
    assignment_id,
    analysis_id,
    library_id,
    taxon_id,
    read_count,
    confidence,
    qc_flag,
  }),
);

export const mockAudit: AuditEntry[] = [
  {
    audit_id: 5,
    actor_id: 5,
    entity_type: 'analysis_runs',
    entity_id: 3,
    action: 'insert',
    details: null,
    created_at: '2026-04-27T09:00:00Z',
  },
  {
    audit_id: 4,
    actor_id: 2,
    entity_type: 'analysis_runs',
    entity_id: 2,
    action: 'approve',
    details: { status: { old: 'imported', new: 'approved' } },
    created_at: '2026-04-25T14:00:00Z',
  },
  {
    audit_id: 3,
    actor_id: 4,
    entity_type: 'sequencing_runs',
    entity_id: 2,
    action: 'update',
    details: { status: { old: 'running', new: 'completed' } },
    created_at: '2026-04-18T15:00:00Z',
  },
  {
    audit_id: 2,
    actor_id: 3,
    entity_type: 'collection_events',
    entity_id: 8,
    action: 'insert',
    details: null,
    created_at: '2026-04-08T11:30:00Z',
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
