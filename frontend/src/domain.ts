// Owner: B (Frontend)
// Purpose: Enumerated values and rules from CONTRACT section 3 that several pages use
//
// The database enforces all of this (enums, the samples status trigger); the pages use it to
// offer only valid choices. If section 3 changes, change this file in the same PR.

import type { HabitatType, RegionType, SampleStatus } from './types';

export const HABITAT_TYPES: HabitatType[] = [
  'river',
  'lake',
  'estuary',
  'marine',
  'wetland',
  'groundwater',
  'soil',
  'other',
];

export const REGION_TYPES: RegionType[] = ['country', 'state', 'basin', 'reserve', 'other'];

export const SAMPLE_STATUSES: SampleStatus[] = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];

/** `samples.status` transitions (CONTRACT section 3); anything else is 409 invalid_transition. */
export const SAMPLE_TRANSITIONS: Readonly<Record<SampleStatus, readonly SampleStatus[]>> = {
  collected: ['stored', 'failed', 'discarded'],
  stored: ['extracted', 'failed', 'discarded'],
  extracted: ['sequenced', 'failed', 'discarded'],
  sequenced: ['analyzed', 'failed'],
  analyzed: [],
  failed: ['discarded'],
  discarded: [],
};

/** Standard environmental parameters and their units (CONTRACT section 3 lookup values). */
export const STANDARD_PARAMETERS: readonly { parameter: string; unit: string; label: string }[] = [
  { parameter: 'temperature_c', unit: 'celsius', label: 'Water temperature' },
  { parameter: 'ph', unit: 'pH', label: 'pH' },
  { parameter: 'dissolved_oxygen_mg_l', unit: 'mg/L', label: 'Dissolved oxygen' },
  { parameter: 'turbidity_ntu', unit: 'NTU', label: 'Turbidity' },
  { parameter: 'conductivity_us_cm', unit: 'µS/cm', label: 'Conductivity' },
  { parameter: 'salinity_ppt', unit: 'ppt', label: 'Salinity' },
];
