// Owner: B (Frontend)
// Purpose: Mock API covers every CONTRACT section 10 GET endpoint with section 11 shapes

import { beforeEach, describe, expect, it } from 'vitest';
import { api, setMockMode } from '../apiClient';
import { resetMockState, setMockDelay } from './mockApi';
import {
  EDNA_CAVEAT,
  type CaveatMeta,
  type CollectionEventDetail,
  type ImportDryRunResult,
  type PageMeta,
  type ProjectDetail,
  type RichnessRow,
  type SampleDetail,
  type TaxonDetail,
  type TaxonDetection,
} from '../../types';

async function signIn(role: string) {
  await api.post('/auth/login', { email: `${role}@ebiotrack.test`, password: 'x' });
}

beforeEach(() => {
  setMockMode(true);
  setMockDelay(0);
  resetMockState();
});

describe('every GET endpoint in CONTRACT section 10', () => {
  const paths = [
    '/auth/me',
    '/users',
    '/roles',
    '/projects',
    '/projects/1',
    '/regions',
    '/sites',
    '/sites/1',
    '/events',
    '/events/1',
    '/sample-types',
    '/samples',
    '/samples/7',
    '/labs',
    '/markers',
    '/extraction-batches',
    '/extractions',
    '/qc-results',
    '/sequencing-runs',
    '/sequencing-runs/1',
    '/analyses',
    '/analyses/1',
    '/taxa',
    '/taxa/8',
    '/taxa/8/detections',
    '/analytics/richness',
    '/analytics/detection-frequency',
    '/dashboard/summary',
    '/audit',
  ];

  it.each(paths)('GET %s answers with a data envelope', async (path) => {
    await signIn('administrator');
    const res = await api.get<unknown>(path);
    expect(res.data).toBeDefined();
  });
});

describe('section 11 example shapes', () => {
  it('sample detail joins event, site, extractions, and status history (seed values)', async () => {
    await signIn('lab_technician');
    const { data } = await api.get<SampleDetail>('/samples/7');
    expect(data).toMatchObject({
      sample_id: 7,
      sample_code: 'EB-20260310-0004-001',
      status: 'analyzed',
      sample_type: 'water',
      event: { event_id: 4, project_id: 1 },
      site: { site_id: 1, name: 'Dakpathar Barrage' },
      extractions: [{ extraction_id: 7, attempt_number: 1, qc_status: 'pass' }],
    });
    expect(data.status_history[0]).toMatchObject({ old_status: null, new_status: 'collected' });
    expect(data.status_history.at(-1)?.new_status).toBe('analyzed');
  });

  it('richness rows carry the caveat and skip failed samples', async () => {
    await signIn('principal_investigator');
    const res = await api.get<RichnessRow[], CaveatMeta>('/analytics/richness', {
      project_id: 1,
      group_by: 'year',
    });
    expect(res.meta?.caveat).toBe(EDNA_CAVEAT);
    const site1In2025 = res.data.find((r) => r.group === '2025' && r.site_id === 1);
    // Event 1 has samples 1, 2 and the failed sample 17.
    expect(site1In2025).toMatchObject({ sample_count: 2 });
    expect(site1In2025!.observed_taxa).toBeGreaterThan(0);
  });

  it('taxon detections only include approved analyses with qc_flag pass', async () => {
    await signIn('analyst');
    const res = await api.get<TaxonDetection[], PageMeta>('/taxa/8/detections');
    expect(res.data.length).toBe(res.meta?.total);
    expect(res.data.every((d) => d.qc_flag === 'pass' && d.analysis_id !== 3)).toBe(true);
    expect(res.data[0]).toMatchObject({
      site_name: expect.any(String),
      sample_code: expect.any(String),
    });
  });

  it('taxon lineage runs from the root down', async () => {
    await signIn('viewer');
    const { data } = await api.get<TaxonDetail>('/taxa/8');
    expect(data.lineage.map((t) => t.rank)).toEqual([
      'kingdom',
      'phylum',
      'class',
      'order',
      'family',
      'genus',
      'species',
    ]);
  });

  it('import dry run returns the contract example (multipart body)', async () => {
    await signIn('analyst');
    const form = new FormData();
    form.append('analysis_id', '4');
    form.append(
      'file',
      new Blob(['library_code,scientific_name\n'], { type: 'text/csv' }),
      'd.csv',
    );
    const res = await api.post<ImportDryRunResult>('/analyses/import?dry_run=true', form);
    expect(res.data).toEqual({
      valid_rows: 38,
      errors: [{ row: 12, field: 'confidence', message: 'must be between 0 and 1' }],
    });
  });

  it('creates an event with samples and measurements in one call', async () => {
    await signIn('field_researcher');
    const res = await api.post<CollectionEventDetail>('/events', {
      project_id: 1,
      site_id: 1,
      collected_at: '2026-03-12T09:30:00Z',
      notes: 'Clear water',
      measurements: [{ parameter: 'ph', value: 7.4, unit: 'pH' }],
      samples: [
        { sample_type_id: 1, volume_ml: 1000, depth_m: 0.5, storage_location: 'Freezer A' },
      ],
    });
    expect(res.data.samples[0]).toMatchObject({
      sample_code: `EB-20260312-${String(res.data.event_id).padStart(4, '0')}-001`,
      status: 'collected',
    });
    expect(res.data.measurements).toHaveLength(1);
    const listed = await api.get<unknown[], PageMeta>('/events', { project_id: 1 });
    expect(listed.meta?.total).toBe(7);
  });

  it('project detail lists members and sites', async () => {
    await signIn('principal_investigator');
    const { data } = await api.get<ProjectDetail>('/projects/2');
    expect(data.your_role).toBe('owner');
    expect(data.members.map((m) => m.user_id)).toEqual([2, 3]);
    expect(data.sites.map((s) => s.site_id)).toEqual([4, 5]);
  });
});

describe('access rules', () => {
  it('hides other projects and their samples', async () => {
    await signIn('lab_technician'); // member of project 1 only
    await expect(api.get('/samples/13')).rejects.toMatchObject({ status: 404 });
    const res = await api.get<unknown[], PageMeta>('/samples', { limit: 100 });
    expect(res.meta?.total).toBe(13); // samples 1–12 and 17
  });

  it('returns 403 for endpoints above the role', async () => {
    await signIn('viewer');
    await expect(api.get('/users')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(api.post('/events', {})).rejects.toMatchObject({ status: 403 });
  });

  it('validates required fields with details', async () => {
    await signIn('field_researcher');
    const err = await api.post('/events', { project_id: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'validation_error' });
  });
});
