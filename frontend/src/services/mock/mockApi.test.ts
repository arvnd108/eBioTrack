// Owner: B (Frontend)
// Purpose: Mock API covers every CONTRACT section 10 GET endpoint with section 11 shapes

import { beforeEach, describe, expect, it } from 'vitest';
import { api, setMockMode, type ApiError } from '../apiClient';
import { resetMockState, setMockDelay } from './mockApi';
import { DEV_PASSWORD } from './fixtures';
import {
  EDNA_CAVEAT,
  type AuditEntry,
  type User,
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
  await api.post('/auth/login', { email: `${role}@ebiotrack.test`, password: DEV_PASSWORD });
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
    '/analytics/detection-frequency?taxon_id=7',
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

  it('richness rows carry the caveat and count every sample as effort (CONTRACT 1.4)', async () => {
    await signIn('principal_investigator');
    const res = await api.get<RichnessRow[], CaveatMeta>('/analytics/richness', {
      project_id: 1,
      group_by: 'year',
    });
    expect(res.meta?.caveat).toBe(EDNA_CAVEAT);
    const site1In2025 = res.data.find((r) => r.group === '2025' && r.site_id === 1);
    // Event 1 has samples 1, 2 and the failed sample 17: all three are sampling effort.
    expect(site1In2025).toMatchObject({ sample_count: 3 });
    expect(site1In2025!.observed_taxa).toBeGreaterThan(0);
  });

  it('richness answers match the 040 seed (approved analyses, qc pass only)', async () => {
    await signIn('administrator');
    const res = await api.get<RichnessRow[], CaveatMeta>('/analytics/richness', {
      group_by: 'year',
    });
    const byKey = Object.fromEntries(
      res.data.map((r) => [`${r.site_id}/${r.group}`, r.observed_taxa]),
    );
    expect(byKey).toMatchObject({
      '1/2025': 2,
      '1/2026': 2,
      '2/2025': 2,
      '2/2026': 1,
      '3/2025': 2,
      '3/2026': 2,
      '4/2026': 2,
      '5/2026': 1,
    });
  });

  it('lab and analysis rows match seeds 030 and 040', async () => {
    await signIn('administrator');
    const runs = await api.get<{ run_code: string; run_date: string }[]>('/sequencing-runs');
    expect(runs.data.map((r) => [r.run_code, r.run_date])).toEqual([
      ['RUN-001', '2026-03-25'],
      ['RUN-002', '2026-04-18'],
    ]);
    const qc = await api.get<unknown[], PageMeta>('/qc-results', { limit: 100 });
    expect(qc.meta?.total).toBe(23);
    const analyses =
      await api.get<{ analysis_id: number; approved_at: string | null }[]>('/analyses');
    expect(analyses.data.find((a) => a.analysis_id === 1)?.approved_at).toBe(
      '2026-04-02T11:30:00Z',
    );
    const detail = await api.get<{ assignment_counts: Record<string, number> }>('/analyses/3');
    expect(detail.data.assignment_counts).toEqual({ pass: 12, warn: 1, fail: 2 });
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

  it('import dry run checks the file like the API (multipart body)', async () => {
    await signIn('analyst');
    const upload = (text: string) => {
      const form = new FormData();
      form.append('analysis_id', '4');
      form.append('file', new Blob([text], { type: 'text/csv' }), 'd.csv');
      return api.post<ImportDryRunResult>('/analyses/import?dry_run=true', form);
    };
    const header = (await upload('library_code,scientific_name\n')).data;
    expect(header.valid_rows).toBe(0);
    expect(header.errors.map((e) => `${e.row} ${e.field} ${e.message}`)).toEqual([
      '1 taxon_rank column is missing',
      '1 read_count column is missing',
      '1 confidence column is missing',
      '1 qc_flag column is missing',
    ]);
    const rows = (
      await upload(
        'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag\n' +
          'LIB-0001,Labeo rohita,species,10,0.9,pass\n' +
          'LIB-0009,Labeo rohita,species,10,1.5,pass\n' +
          'LIB-0002,Labeo nova,species,10,0.9,pass\n',
      )
    ).data;
    expect(rows).toEqual({
      valid_rows: 1,
      errors: [
        { row: 3, field: 'confidence', message: 'must be a number between 0 and 1' },
        {
          row: 4,
          field: 'scientific_name',
          message: 'no taxon "Labeo nova" with rank species (taxa are never created by an import)',
        },
      ],
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

describe('auth answers match the real API (backend auth.routes.js and auth.controller.js)', () => {
  const login = (email: string, password: unknown) => api.post('/auth/login', { email, password });

  it('rejects a wrong password with the same 401 as an unknown email', async () => {
    const wrong = await login('viewer@ebiotrack.test', 'not-the-password').catch((e: unknown) => e);
    const unknown = await login('nobody@ebiotrack.test', DEV_PASSWORD).catch((e: unknown) => e);
    for (const err of [wrong, unknown]) {
      expect(err).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
        message: 'Invalid email or password',
      });
    }
  });

  it('validates with the same field names and messages as the zod schema', async () => {
    const empty = (await login('', '').catch((e: unknown) => e)) as ApiError;
    expect(empty).toMatchObject({ status: 422, code: 'validation_error' });
    expect(empty.details).toEqual([
      { field: 'email', message: 'Invalid email address' },
      { field: 'password', message: 'Too small: expected string to have >=1 characters' },
    ]);

    const missing = (await api.post('/auth/login', {}).catch((e: unknown) => e)) as ApiError;
    expect(missing.fieldMessage('email')).toBe(
      'Invalid input: expected string, received undefined',
    );

    const long = (await login('viewer@ebiotrack.test', 'x'.repeat(73)).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(long.details).toEqual([{ field: 'password', message: 'must be at most 72 bytes' }]);
  });

  it('accepts the email with spaces and capitals, as the API trims and lowercases it', async () => {
    const res = await login('  Viewer@EBioTrack.test ', DEV_PASSWORD);
    expect(res.data).toMatchObject({ user_id: 6 });
  });

  it('locks an email out after 5 failures with 429 and Retry-After, until the window ends', async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(login('analyst@ebiotrack.test', 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    const locked = (await login('analyst@ebiotrack.test', DEV_PASSWORD).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(locked).toMatchObject({
      status: 429,
      code: 'too_many_attempts',
      message: 'Too many failed sign-in attempts. Try again later.',
    });
    expect(locked.retryAfter).toBeGreaterThan(14 * 60);
    // Other emails are not affected.
    await expect(login('viewer@ebiotrack.test', DEV_PASSWORD)).resolves.toBeDefined();
  });

  it('clears the failure count after a successful sign-in', async () => {
    for (let i = 0; i < 4; i += 1) {
      await expect(login('analyst@ebiotrack.test', 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    await login('analyst@ebiotrack.test', DEV_PASSWORD);
    await api.post('/auth/logout');
    await expect(login('analyst@ebiotrack.test', 'wrong')).rejects.toMatchObject({ status: 401 });
    await expect(login('analyst@ebiotrack.test', DEV_PASSWORD)).resolves.toBeDefined();
  });

  it('answers 401 unauthenticated and 403 forbidden with the API messages', async () => {
    await expect(api.get('/auth/me')).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
      message: 'Authentication required',
    });
    await signIn('viewer');
    await expect(api.get('/users')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'You do not have permission to do this',
    });
  });
});

describe('T20 write rules match the real API (values checked against backend PR #137)', () => {
  const as = async (role: string) => {
    await api.post('/auth/logout').catch(() => undefined);
    await signIn(role);
  };
  const failure = (promise: Promise<unknown>) =>
    promise.catch((e: unknown) => e) as Promise<ApiError>;

  it('creates a project with the caller as owner, and refuses a taken title', async () => {
    await as('principal_investigator');
    const created = await api.post<{ project_id: number; your_role: string; status: string }>(
      '/projects',
      { title: 'New survey', start_date: '2026-01-15' },
    );
    expect(created.data).toMatchObject({ your_role: 'owner', status: 'planned' });
    expect(created.data.project_id).toBeGreaterThanOrEqual(1000);

    const taken = await failure(api.post('/projects', { title: 'Yamuna Biodiversity Survey' }));
    expect(taken).toMatchObject({
      status: 409,
      code: 'duplicate',
      message: 'Project titles are unique.',
    });

    await as('viewer');
    expect(await failure(api.post('/projects', { title: 'x' }))).toMatchObject({ status: 403 });
  });

  it('applies the edit_project gate: role 403, non-member 404, project viewer 403', async () => {
    await as('lab_technician');
    expect(await failure(api.patch('/projects/1', { status: 'active' }))).toMatchObject({
      status: 403,
    });

    // A second principal investigator who is not on project 1 gets 404, as the API hides it.
    await as('administrator');
    const pi = await api.post<User>('/users', {
      full_name: 'Second PI',
      email: 'pi2@ebiotrack.test',
      password: 'long-enough-pw',
      role_ids: [2],
    });
    await api.post('/auth/logout');
    await api.post('/auth/login', { email: 'pi2@ebiotrack.test', password: 'long-enough-pw' });
    expect(await failure(api.patch('/projects/1', { status: 'active' }))).toMatchObject({
      status: 404,
    });

    // Added as a project viewer, the same person may read but not edit.
    await as('principal_investigator');
    await api.post('/projects/1/members', { user_id: pi.data.user_id, project_role: 'viewer' });
    await api.post('/auth/logout');
    await api.post('/auth/login', { email: 'pi2@ebiotrack.test', password: 'long-enough-pw' });
    await expect(api.get('/projects/1')).resolves.toBeDefined();
    expect(await failure(api.patch('/projects/1', { status: 'active' }))).toMatchObject({
      status: 403,
    });

    // An administrator passes every gate.
    await as('administrator');
    await expect(api.patch('/projects/1', { objectives: 'Admin edit' })).resolves.toBeDefined();
  });

  it('validates project edits like the API', async () => {
    await as('principal_investigator');
    expect(await failure(api.patch('/projects/1', {}))).toMatchObject({
      status: 422,
      details: [
        {
          field: 'root',
          message: 'at least one of title, objectives, status, end_date is required',
        },
      ],
    });
    expect(await failure(api.patch('/projects/1', { end_date: '2024-12-31' }))).toMatchObject({
      status: 422,
      message: 'end_date must not be before start_date',
      details: [{ field: 'end_date', message: 'must be on or after 2025-01-15' }],
    });
    expect(
      await failure(api.patch('/projects/1', { title: 'Coastal Estuary Pilot' })),
    ).toMatchObject({
      status: 409,
      message: 'Key (title)=(Coastal Estuary Pilot) already exists.',
    });
    const saved = await api.patch<{ status: string; end_date: string }>('/projects/1', {
      status: 'completed',
      end_date: '2026-12-31',
    });
    expect(saved.data).toMatchObject({ status: 'completed', end_date: '2026-12-31' });
  });

  it('keeps the member rules: one owner, active users only, no duplicates', async () => {
    await as('principal_investigator');
    expect(
      await failure(api.post('/projects/1/members', { user_id: 1, project_role: 'owner' })),
    ).toMatchObject({
      status: 422,
      code: 'rule_violation',
      message: 'A project has one owner, set when it is created; owner cannot be assigned here',
    });
    expect(
      await failure(api.post('/projects/1/members', { user_id: 99, project_role: 'viewer' })),
    ).toMatchObject({
      status: 422,
      code: 'invalid_reference',
      message: 'User 99 does not exist',
    });
    expect(
      await failure(api.post('/projects/1/members', { user_id: 3, project_role: 'viewer' })),
    ).toMatchObject({
      status: 409,
      code: 'duplicate',
    });
    expect(await failure(api.delete('/projects/1/members/2'))).toMatchObject({
      status: 422,
      message: 'The project owner cannot be removed',
    });
    await api.post('/projects/2/members', { user_id: 4, project_role: 'manager' });
    await api.delete('/projects/2/members/4');
    expect(await failure(api.delete('/projects/2/members/4'))).toMatchObject({
      status: 404,
      message: 'Membership not found',
    });
  });

  it('refuses to unlink a site that events in the project use', async () => {
    await as('principal_investigator');
    expect(await failure(api.delete('/projects/1/sites/1'))).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Site has collection events in this project and cannot be removed',
    });
    expect(await failure(api.delete('/projects/1/sites/5'))).toMatchObject({
      status: 404,
      message: 'Site is not linked to this project',
    });
    expect(await failure(api.post('/projects/1/sites', { site_id: 999 }))).toMatchObject({
      status: 422,
      code: 'invalid_reference',
      message: 'Site 999 does not exist',
    });
  });

  it('creates users and enforces the administrator lock-out rules', async () => {
    await as('administrator');
    const bad = await failure(
      api.post('/users', {
        full_name: 'P',
        email: 'p@ebiotrack.test',
        password: 'short',
        role_ids: [],
      }),
    );
    expect(bad.details).toEqual([
      { field: 'password', message: 'must be at least 8 characters' },
      { field: 'role_ids', message: 'at least one role is required' },
    ]);
    const created = await api.post<User>('/users', {
      full_name: 'New Person',
      email: 'New@EBioTrack.test',
      password: 'long-enough-pw',
      role_ids: [6],
    });
    expect(created.data).toMatchObject({
      email: 'new@ebiotrack.test',
      roles: ['viewer'],
      active: true,
    });

    expect(await failure(api.patch('/users/1', { active: false }))).toMatchObject({
      status: 422,
      code: 'rule_violation',
      message: 'You cannot deactivate your own account',
    });
    expect(await failure(api.patch('/users/1', { role_ids: [2] }))).toMatchObject({
      message: 'You cannot remove your own administrator role',
    });

    // The new user can sign in with the password set for them.
    await api.post('/auth/logout');
    await expect(
      api.post('/auth/login', { email: 'new@ebiotrack.test', password: 'long-enough-pw' }),
    ).resolves.toBeDefined();
  });

  it('writes audit entries like the trigger and scopes them for a principal investigator', async () => {
    await as('principal_investigator');
    await api.patch('/projects/1', { status: 'completed' });
    const audit = await api.get<AuditEntry[]>('/audit', { entity_type: 'projects' });
    expect(audit.data[0]).toMatchObject({
      actor_id: 2,
      entity_type: 'projects',
      entity_id: 1,
      action: 'update',
      details: { status: { old: 'active', new: 'completed' } },
    });
    // A PI sees nothing about users (not project data); an administrator does.
    expect((await api.get<AuditEntry[]>('/audit', { entity_type: 'users' })).data).toEqual([]);
    await as('administrator');
    const logins = await api.get<AuditEntry[]>('/audit', { entity_type: 'users' });
    expect(logins.data[0]).toMatchObject({ action: 'login', actor_id: 1, entity_id: 1 });
  });

  it('lists sites by name for anyone, and checks project access when filtering', async () => {
    await as('lab_technician');
    const sites = await api.get<{ name: string }[]>('/sites', { limit: 100, sort: 'name' });
    const names = sites.data.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(await failure(api.get('/sites', { project_id: 2 }))).toMatchObject({
      status: 404,
      message: 'Project not found',
    });
    expect(await failure(api.get('/sites', { sort: 'habitat_type' }))).toMatchObject({
      status: 422,
      message: 'Invalid sort field: habitat_type',
    });
  });

  it('searches samples by code prefix only, case-insensitive', async () => {
    await as('viewer');
    const prefix = await api.get<{ sample_code: string }[]>('/samples', { q: 'eb-2026031' });
    expect(prefix.data).toHaveLength(6);
    expect((await api.get<unknown[]>('/samples', { q: '0001' })).data).toEqual([]);
  });

  it('refuses writes from a project viewer whose global role could write (403)', async () => {
    await as('principal_investigator');
    await api.delete('/projects/2/members/3');
    await api.post('/projects/2/members', { user_id: 3, project_role: 'viewer' });
    await as('field_researcher');
    const forbidden = { status: 403, code: 'forbidden' };
    const at = { project_id: 2, site_id: 4, collected_at: '2026-04-05T10:00:00Z' };
    expect(await failure(api.post('/events', at))).toMatchObject(forbidden);
    expect(await failure(api.post('/samples', { event_id: 7, sample_type_id: 1 }))).toMatchObject(
      forbidden,
    );
    expect(
      await failure(api.patch('/samples/13/status', { new_status: 'discarded' })),
    ).toMatchObject(forbidden);
    // Reading stays open.
    await expect(api.get('/samples/13')).resolves.toBeDefined();
  });

  it('follows the status transitions of CONTRACT section 3 and records each change', async () => {
    await as('field_researcher');
    const created = await api.post<{ sample_id: number; sample_code: string }>('/samples', {
      event_id: 1,
      sample_type_id: 3,
      depth_m: 0,
    });
    expect(created.data.sample_code).toBe('EB-20250515-0001-004');
    const id = created.data.sample_id;
    expect(
      await failure(api.patch(`/samples/${id}/status`, { new_status: 'analyzed' })),
    ).toMatchObject({
      status: 409,
      message: 'Invalid sample status transition: collected -> analyzed',
    });
    expect(
      await failure(api.patch(`/samples/${id}/status`, { new_status: 'collected' })),
    ).toMatchObject({
      status: 409,
      message: 'Sample is already collected',
    });
    await api.patch(`/samples/${id}/status`, {
      new_status: 'stored',
      note: '  in the cold room  ',
    });
    const detail = await api.get<{
      status_history: { new_status: string; note: string | null; changed_by_name: string }[];
    }>(`/samples/${id}`);
    expect(
      detail.data.status_history.map((h) => [h.new_status, h.note, h.changed_by_name]),
    ).toEqual([
      ['collected', null, 'Farah Field'],
      ['stored', 'in the cold room', 'Farah Field'],
    ]);
  });

  it('sorts lists through ?sort and rejects fields the API does not allow', async () => {
    await as('administrator');
    const users = await api.get<User[]>('/users', { sort: '-full_name', limit: 3 });
    expect(users.data.map((u) => u.full_name)).toEqual([
      'Vikram Viewer',
      'Pranav Investigator',
      'Lakshmi Lab',
    ]);
    expect(await failure(api.get('/users', { sort: 'role' }))).toMatchObject({
      status: 422,
      message: 'Invalid sort field: role',
    });
  });
});

describe('T22 lab rules match the real API (values checked against backend PR #140)', () => {
  const as = async (role: string) => {
    await api.post('/auth/logout').catch(() => undefined);
    await signIn(role);
  };
  const failure = (promise: Promise<unknown>) =>
    promise.catch((e: unknown) => e) as Promise<ApiError>;
  const forbidden = { status: 403, code: 'forbidden' };

  /** A stored sample in project 1, ready to extract (the seeded ones are analyzed or failed). */
  async function storedSample(): Promise<number> {
    await as('field_researcher');
    const event = await api.post<{ samples: { sample_id: number }[] }>('/events', {
      project_id: 1,
      site_id: 1,
      collected_at: '2026-10-30T08:00:00Z',
      samples: [{ sample_type_id: 1 }],
    });
    const id = event.data.samples[0].sample_id;
    await api.patch(`/samples/${id}/status`, { new_status: 'stored' });
    await as('lab_technician');
    return id;
  }

  it('names operators, recorders and samples for every role (CONTRACT 1.7)', async () => {
    await as('viewer');
    const batches = await api.get<{ operator_name: string }[]>('/extraction-batches');
    expect(batches.data[0]).toMatchObject({ operator_id: 4, operator_name: 'Lakshmi Lab' });
    const extractions = await api.get<Record<string, unknown>[]>('/extractions', { limit: 1 });
    expect(extractions.data[0]).toMatchObject({
      sample_id: 1,
      sample_code: 'EB-20250515-0001-001',
      active_run_id: null,
      active_run_code: null,
    });
    const qc = await api.get<Record<string, unknown>[]>('/qc-results', { result: 'warn' });
    expect(qc.data[0]).toMatchObject({
      recorded_by_name: 'Lakshmi Lab',
      sample_code: 'EB-20260315-0006-002',
    });
  });

  it('records extractions: role and project checks, failed samples, numbering, stored -> extracted', async () => {
    const sampleId = await storedSample();
    await as('field_researcher');
    expect(
      await failure(api.post('/extractions', { sample_id: sampleId, batch_id: 1 })),
    ).toMatchObject(forbidden);
    await as('lab_technician');
    expect(await failure(api.post('/extractions', { sample_id: 13, batch_id: 1 }))).toMatchObject({
      status: 404,
      message: 'Sample not found',
    });
    expect(await failure(api.post('/extractions', { sample_id: 17, batch_id: 1 }))).toMatchObject({
      status: 422,
      code: 'rule_violation',
      message: 'Sample is failed; it cannot be extracted',
    });
    expect(
      await failure(api.post('/extractions', { sample_id: sampleId, batch_id: 999 })),
    ).toMatchObject({
      status: 422,
      code: 'invalid_reference',
      message: 'Key (batch_id)=(999) is not present in table "extraction_batches".',
    });
    const first = await api.post<{
      extraction_id: number;
      attempt_number: number;
      concentration_ng_ul: number;
    }>('/extractions', { sample_id: sampleId, batch_id: 1, concentration_ng_ul: 12.3456 });
    // The refused insert used up id 1000, as a PostgreSQL sequence does.
    expect(first.data).toMatchObject({
      extraction_id: 1001,
      attempt_number: 1,
      concentration_ng_ul: 12.346,
    });
    const second = await api.post<{ attempt_number: number }>('/extractions', {
      sample_id: sampleId,
      batch_id: 1,
    });
    expect(second.data.attempt_number).toBe(2);
    const sample = await api.get<{
      status: string;
      status_history: { new_status: string; changed_by: number }[];
    }>(`/samples/${sampleId}`);
    expect(sample.data.status).toBe('extracted');
    expect(sample.data.status_history.at(-1)).toMatchObject({
      new_status: 'extracted',
      changed_by: 4,
    });
  });

  it('makes the QC verdict final but keeps measurements editable', async () => {
    const sampleId = await storedSample();
    const made = await api.post<{ extraction_id: number }>('/extractions', {
      sample_id: sampleId,
      batch_id: 1,
    });
    const id = made.data.extraction_id;
    expect(await failure(api.patch(`/extractions/${id}`, {}))).toMatchObject({
      status: 422,
      message: 'at least one of qc_status, concentration_ng_ul, purity_a260_280 is required',
    });
    expect(await failure(api.patch(`/extractions/${id}`, { qc_status: 'pending' }))).toMatchObject({
      status: 422,
      message: 'Invalid option: expected one of "pass"|"fail"',
    });
    await api.patch(`/extractions/${id}`, { qc_status: 'pass' });
    expect(await failure(api.patch(`/extractions/${id}`, { qc_status: 'fail' }))).toMatchObject({
      status: 409,
      code: 'invalid_transition',
      message: `Extraction ${id} cannot move from QC status pass to fail`,
    });
    const edited = await api.patch<{ purity_a260_280: number; qc_status: string }>(
      `/extractions/${id}`,
      {
        qc_status: 'pass',
        purity_a260_280: 1.876,
      },
    );
    expect(edited.data).toMatchObject({ qc_status: 'pass', purity_a260_280: 1.88 });
  });

  it('books passed, free extractions into runs, all or nothing, and shows the active run', async () => {
    const sampleId = await storedSample();
    const ok1 = (
      await api.post<{ extraction_id: number }>('/extractions', {
        sample_id: sampleId,
        batch_id: 1,
      })
    ).data.extraction_id;
    const failed = (
      await api.post<{ extraction_id: number }>('/extractions', {
        sample_id: sampleId,
        batch_id: 1,
      })
    ).data.extraction_id;
    await api.patch(`/extractions/${ok1}`, { qc_status: 'pass' });
    await api.patch(`/extractions/${failed}`, { qc_status: 'fail' });
    const body = { lab_id: 1, platform: ' Illumina NovaSeq ', run_date: '2026-11-01' };

    expect(
      await failure(api.post('/sequencing-runs', { ...body, extraction_ids: [ok1, failed] })),
    ).toMatchObject({
      status: 422,
      code: 'rule_violation',
      message: `Extraction ${failed} has not passed QC (qc_status fail)`,
    });
    expect(
      await failure(api.post('/sequencing-runs', { ...body, extraction_ids: [ok1, 13] })),
    ).toMatchObject({
      status: 404,
      message: 'Extraction not found',
    });
    const run = await api.post<{
      run_id: number;
      run_code: string;
      platform: string;
      libraries: { library_code: string }[];
    }>('/sequencing-runs', { ...body, extraction_ids: [ok1, 1] });
    expect(run.data).toMatchObject({
      run_code: 'RUN-1000',
      platform: 'Illumina NovaSeq',
      status: 'planned',
    });
    expect(run.data.libraries.map((l) => l.library_code)).toEqual(['LIB-1000', 'LIB-1001']);
    expect(
      await failure(api.post('/sequencing-runs', { ...body, extraction_ids: [1] })),
    ).toMatchObject({
      status: 422,
      message: 'Extraction 1 is already booked on run RUN-1000 (planned)',
    });
    const listed = await api.get<{ extraction_id: number; active_run_code: string | null }[]>(
      '/extractions',
      {
        sample_id: sampleId,
      },
    );
    expect(listed.data.map((x) => [x.extraction_id, x.active_run_code])).toEqual([
      [ok1, 'RUN-1000'],
      [failed, null],
    ]);
  });

  it('moves runs through planned -> running -> completed, and adds libraries to planned runs only', async () => {
    await as('lab_technician');
    const run = await api.post<{ run_id: number }>('/sequencing-runs', {
      lab_id: 2,
      platform: 'MiSeq',
      run_date: '2026-11-01',
      extraction_ids: [2],
    });
    const id = run.data.run_id;
    expect(
      await failure(api.patch(`/sequencing-runs/${id}`, { status: 'completed' })),
    ).toMatchObject({
      status: 409,
      message: 'Run RUN-1000 cannot move from planned to completed',
    });
    await expect(
      api.post(`/sequencing-runs/${id}/libraries`, { extraction_id: 3 }),
    ).resolves.toBeDefined();
    await api.patch(`/sequencing-runs/${id}`, { status: 'running' });
    expect(await failure(api.patch(`/sequencing-runs/${id}`, { status: 'running' }))).toMatchObject(
      {
        status: 409,
        message: 'Run is already running',
      },
    );
    expect(
      await failure(api.post(`/sequencing-runs/${id}/libraries`, { extraction_id: 4 })),
    ).toMatchObject({
      status: 409,
      message: 'Run RUN-1000 is running; libraries can only be added to a planned run',
    });
    await api.patch(`/sequencing-runs/${id}`, { status: 'completed' });
    // A finished run frees its extractions.
    const freed = await api.get<{ active_run_id: number | null }[]>('/extractions', {
      sample_id: 2,
    });
    expect(freed.data[0].active_run_id).toBeNull();
    await as('analyst');
    expect(await failure(api.patch(`/sequencing-runs/${id}`, { status: 'failed' }))).toMatchObject(
      forbidden,
    );
  });

  it('shows a lab technician only the libraries of their projects', async () => {
    await as('lab_technician'); // project 1 only
    const run = await api.get<{ libraries: unknown[] }>('/sequencing-runs/2');
    expect(run.data.libraries).toHaveLength(4);
    await as('administrator');
    expect(
      (await api.get<{ libraries: unknown[] }>('/sequencing-runs/2')).data.libraries,
    ).toHaveLength(8);
  });

  it('records QC results for a sample or an analysis, newest first', async () => {
    await as('lab_technician');
    expect(
      await failure(api.post('/qc-results', { qc_type: 'concentration', result: 'pass' })),
    ).toMatchObject({
      status: 422,
      details: [{ field: 'sample_id', message: 'sample_id or analysis_id is required' }],
    });
    const made = await api.post<Record<string, unknown>>('/qc-results', {
      sample_id: 1,
      qc_type: 'concentration',
      result: 'warn',
      metric_value: 3.5,
      notes: ' Qubit ',
    });
    expect(made.data).toMatchObject({
      qc_id: 1000,
      notes: 'Qubit',
      recorded_by_name: 'Lakshmi Lab',
    });
    const list = await api.get<{ qc_id: number }[]>('/qc-results', { limit: 1 });
    expect(list.data[0].qc_id).toBe(1000);
    await as('analyst');
    expect(
      await failure(
        api.post('/qc-results', { sample_id: 1, qc_type: 'concentration', result: 'pass' }),
      ),
    ).toMatchObject(forbidden);
  });
});

describe('T23 analysis, taxa and export rules match the real API (checked against backend PR #142)', () => {
  const as = async (role: string) => {
    await api.post('/auth/logout').catch(() => undefined);
    await signIn(role);
  };
  const failure = (promise: Promise<unknown>) =>
    promise.catch((e: unknown) => e) as Promise<ApiError>;
  const upload = (id: number, text: string, dry = false) => {
    const form = new FormData();
    form.append('analysis_id', String(id));
    form.append('file', new Blob([text], { type: 'text/csv' }), 'd.csv');
    return api.post<Record<string, unknown>>(`/analyses/import${dry ? '?dry_run=true' : ''}`, form);
  };
  const ROWS =
    'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag\n' +
    'LIB-0001,Labeo bata,species,500,0.9,pass\nLIB-0002,Labeo bata,species,20,0.6,warn\n';

  it('hides unapproved analyses from roles that may not read them (404, absent from lists)', async () => {
    await as('viewer');
    const list = await api.get<{ analysis_id: number }[]>('/analyses');
    expect(list.data.map((a) => a.analysis_id)).toEqual([1, 2]);
    expect(await failure(api.get('/analyses/3'))).toMatchObject({
      status: 404,
      message: 'Analysis not found',
    });
    await as('analyst');
    expect((await api.get<unknown[]>('/analyses')).data).toHaveLength(4);
  });

  it('imports, approves and counts a species at once; keeps the rejection reason', async () => {
    await as('analyst');
    const made = await api.post<{ analysis_id: number }>('/analyses', {
      run_id: 1,
      marker_id: 1,
      pipeline_name: 'x',
      pipeline_version: '1',
      reference_db: 'y',
    });
    const id = made.data.analysis_id;
    expect(id).toBe(1000);
    expect((await upload(id, ROWS, true)).data).toEqual({ valid_rows: 2, errors: [] });
    expect((await upload(id, ROWS)).data).toEqual({ inserted: 2 });
    expect(await failure(upload(id, ROWS))).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Analysis 1000 is already imported',
    });
    expect(await failure(api.post(`/analyses/${id}/approve`))).toMatchObject({ status: 403 });
    await as('principal_investigator');
    const approved = await api.post<Record<string, unknown>>(`/analyses/${id}/approve`);
    expect(approved.data).toMatchObject({
      status: 'approved',
      imported_by_name: 'Anil Analyst',
      approved_by_name: 'Pranav Investigator',
      run_code: 'RUN-001',
      marker_name: '12S',
      rejection: null,
    });
    const bata = await api.get<{ sample_id: number; read_count: number }[]>('/taxa/9/detections');
    expect(bata.data).toEqual([expect.objectContaining({ sample_id: 1, read_count: 500 })]);

    const rejected = await api.post<{ rejection: Record<string, unknown> }>('/analyses/3/reject', {
      reason: ' Wrong marker ',
    });
    expect(rejected.data.rejection).toMatchObject({
      reason: 'Wrong marker',
      rejected_by: 2,
      rejected_by_name: 'Pranav Investigator',
    });
  });

  it('refuses the importer’s own approval and a correction of a correction’s target twice', async () => {
    await as('principal_investigator');
    const body = {
      run_id: 1,
      marker_id: 1,
      pipeline_name: 'x',
      pipeline_version: '1',
      reference_db: 'y',
    };
    const own = (await api.post<{ analysis_id: number }>('/analyses', body)).data.analysis_id;
    await upload(own, ROWS);
    expect(await failure(api.post(`/analyses/${own}/approve`))).toMatchObject({
      status: 422,
      code: 'rule_violation',
      message: 'The importer may not approve their own analysis',
      details: [{ message: `User 2 imported analysis ${own}.` }],
    });
    await api.post('/analyses', { ...body, supersedes_analysis_id: 1 });
    expect(
      await failure(api.post('/analyses', { ...body, supersedes_analysis_id: 1 })),
    ).toMatchObject({ status: 409, code: 'duplicate' });
  });

  it('downloads an export only for the person who asked for it', async () => {
    await as('viewer');
    const made = await api.post<{ export_id: number; row_count: number }>('/exports', {
      export_type: 'richness_csv',
      project_id: 1,
      filters: { group_by: 'site' },
    });
    expect(made.data).toEqual({ export_id: 1000, row_count: 3 });
    const file = await api.download('/exports/1000/download');
    expect(file).toMatchObject({
      filename: 'ebiotrack-richness_csv-1000.csv',
      rowCount: 3,
      caveat: EDNA_CAVEAT,
    });
    expect(file.text.split('\r\n')[1]).toBe('Dakpathar Barrage,1,2,5');
    await as('analyst');
    expect(await failure(api.download('/exports/1000/download'))).toMatchObject({
      status: 404,
      message: 'Export not found',
    });
  });
});
