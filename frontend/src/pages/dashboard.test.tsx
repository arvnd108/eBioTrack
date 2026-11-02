// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Dashboard page through the real routes (mock mode, which follows the real API)

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../services/apiClient';
import { renderApp, resetMock, signInAs } from '../test/renderApp';
import type { AuditEntry } from '../types';
import {
  activityLink,
  describeAction,
  describeDetail,
  entityLabel,
  withoutDuplicateDecisions,
} from './dashboard/activity';

beforeEach(resetMock);
afterEach(cleanup);

/** The four count tiles as their text and links. */
async function tiles() {
  const group = await screen.findByRole('group', { name: 'At a glance' });
  return within(group)
    .getAllByRole('link')
    .map((a) => ({ text: a.textContent ?? '', href: a.getAttribute('href') }));
}
const waiting = () =>
  within(screen.getByRole('heading', { name: 'Waiting for you' }).closest('section')!)
    .getAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('href')]);
const activity = () =>
  within(screen.getByRole('list', { name: 'Recent activity' })).getAllByRole('listitem');

/** Farah records event 1000 with one sample in project 1 and stores it. */
async function farahStoresASample() {
  await signInAs('field_researcher');
  await api.post('/events', {
    project_id: 1,
    site_id: 1,
    collected_at: '2026-10-30T08:00:00Z',
    samples: [{ sample_type_id: 1 }],
  });
  await api.patch('/samples/1000/status', { new_status: 'stored', note: 'Freezer B' });
  await api.post('/auth/logout');
}

async function newUser(roleIds: number[], email: string) {
  await signInAs('administrator');
  await api.post('/users', {
    full_name: 'New Person',
    email,
    password: 'new-person-password',
    role_ids: roleIds,
  });
  await api.post('/auth/logout');
  await api.post('/auth/login', { email, password: 'new-person-password' });
}

describe('Dashboard', () => {
  it('counts what a principal investigator can see and links each count to its page', async () => {
    await farahStoresASample();
    await signInAs('principal_investigator');
    renderApp('/');
    expect(
      await screen.findByText(/Welcome back, Pranav\. Your projects at a glance\./),
    ).toBeTruthy();
    expect(await tiles()).toEqual([
      { text: 'Projects2All the projects you are in', href: '/projects' },
      { text: 'Sites5See them on the sampling map', href: '/map' },
      { text: 'Samples18Every sample, in any status', href: '/samples' },
      { text: 'Approved detections24Approved analyses, QC flag pass', href: '/analytics' },
    ]);
    await waitFor(() =>
      expect(waiting()).toEqual([
        ['Analyses waiting for approvalIn all your projects1', '/analyses/import?status=imported'],
        [
          'Draft analyses waiting for their CSVIn all your projects1',
          '/analyses/import?status=draft',
        ],
        ['Extractions waiting for a QC verdictIn all your projects0', '/lab?qc_status=pending'],
        ['Samples collected but not yet storedIn all your projects0', '/samples?status=collected'],
      ]),
    );
    // Farah's work in project 1, newest first, named although the PI cannot list users.
    const items = activity();
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toMatch(
      /^Farah Field changed sample #1000status: collected → stored/,
    );
    expect(within(items[0]).getByRole('link').getAttribute('href')).toBe('/samples/1000');
    expect(items[1].textContent).toMatch(/^Farah Field created sample #1000EB-20261030-1000-001/);
    expect(items[2].textContent).toMatch(/^Farah Field created collection event #1000/);
    expect(within(items[2]).getByRole('link').getAttribute('href')).toBe('/events/1000');
    expect(screen.getByRole('link', { name: 'Full audit log' }).getAttribute('href')).toBe(
      '/admin?tab=audit',
    );
    expect(screen.getByRole('note').textContent).toContain(
      'Detection does not indicate abundance; non-detection does not indicate absence.',
    );
  });

  it('narrows everything to the chosen project and keeps it in the URL', async () => {
    await signInAs('principal_investigator');
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await tiles();
    await waitFor(() =>
      expect(screen.getByLabelText('Project').querySelectorAll('option').length).toBe(3),
    );
    await user.selectOptions(screen.getByLabelText('Project'), '2');
    expect(router.state.location.search).toBe('?project_id=2');
    await waitFor(async () =>
      expect((await tiles()).map((t) => t.text)).toEqual([
        'Project1Open the project',
        'Sites2See them on the sampling map',
        'Samples4Every sample, in any status',
        'Approved detections4Approved analyses, QC flag pass',
      ]),
    );
    expect((await tiles()).map((t) => t.href)).toEqual([
      '/projects/2',
      '/map?project_id=2',
      '/samples?project_id=2',
      '/analytics?project_id=2',
    ]);
    expect(screen.getByText(/: Active, you are its owner\./)).toBeTruthy();
    expect(screen.getByText('No activity in Coastal Estuary Pilot yet.')).toBeTruthy();
    await waitFor(() =>
      expect(waiting().at(-1)).toEqual([
        'Samples collected but not yet storedIn Coastal Estuary Pilot0',
        '/samples?status=collected&project_id=2',
      ]),
    );
    const goTo = within(screen.getByRole('navigation', { name: 'Go to' }));
    expect(goTo.getByRole('link', { name: 'Samples' }).getAttribute('href')).toBe(
      '/samples?project_id=2',
    );
    expect(goTo.getByRole('link', { name: 'Lab processing' }).getAttribute('href')).toBe('/lab');
  });

  it('counts collected samples in the chosen project only', async () => {
    await signInAs('field_researcher');
    await api.post('/events', {
      project_id: 1,
      site_id: 1,
      collected_at: '2026-10-30T08:00:00Z',
      samples: [{ sample_type_id: 1 }, { sample_type_id: 1 }],
    });
    renderApp('/');
    await waitFor(() =>
      expect(waiting()).toEqual([
        ['Samples collected but not yet storedIn all your projects2', '/samples?status=collected'],
      ]),
    );
    cleanup();
    renderApp('/?project_id=2');
    await waitFor(() =>
      expect(waiting()).toEqual([
        [
          'Samples collected but not yet storedIn Coastal Estuary Pilot0',
          '/samples?status=collected&project_id=2',
        ],
      ]),
    );
  });

  it('links an approval in the activity to the analysis', async () => {
    await signInAs('principal_investigator');
    await api.post('/analyses/3/approve');
    renderApp('/?project_id=1');
    await tiles();
    await waitFor(() => expect(activity()[0].textContent).toMatch(/^You approved analysis #3/));
    expect(activity()[0].textContent).toContain('15 detections'); // every row, any QC flag
    expect(within(activity()[0]).getByRole('link').getAttribute('href')).toBe(
      '/analyses/import?analysis_id=3',
    );
  });

  it('gives a viewer the counts without work or activity', async () => {
    await signInAs('viewer');
    renderApp('/');
    expect((await tiles()).map((t) => t.text)).toEqual([
      'Project1All the projects you are in',
      'Sites3See them on the sampling map',
      'Samples13Every sample, in any status',
      'Approved detections20Approved analyses, QC flag pass',
    ]);
    expect(screen.queryByRole('heading', { name: 'Waiting for you' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull();
  });

  it('shows a lab technician the extractions waiting for QC', async () => {
    await farahStoresASample();
    await signInAs('lab_technician');
    await api.post('/extractions', { sample_id: 1000, batch_id: 2 });
    renderApp('/');
    await tiles();
    await waitFor(() =>
      expect(waiting()).toEqual([
        ['Extractions waiting for a QC verdictIn all your projects1', '/lab?qc_status=pending'],
        ['Samples collected but not yet storedIn all your projects0', '/samples?status=collected'],
      ]),
    );
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull();
  });

  it('shows an analyst the drafts waiting for their CSV, not the approvals', async () => {
    await signInAs('analyst');
    renderApp('/');
    await tiles();
    await waitFor(() =>
      expect(waiting()).toEqual([
        [
          'Draft analyses waiting for their CSVIn all your projects1',
          '/analyses/import?status=draft',
        ],
      ]),
    );
  });

  it('says how to start when the user is in no project', async () => {
    await newUser([6], 'nobody@example.test');
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'You are not in a project yet' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Ask a principal investigator to add you to their project\./),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Go to projects' })).toBeNull();
    expect(screen.queryByText('Approved detections')).toBeNull();
    cleanup();
    await newUser([2], 'newpi@example.test');
    renderApp('/');
    expect(await screen.findByText(/Create your first project to start\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to projects' }).getAttribute('href')).toBe(
      '/projects',
    );
  });

  it('points to the first collection event of a project with no samples', async () => {
    await signInAs('principal_investigator');
    const made = await api.post<{ project_id: number }>('/projects', { title: 'Chambal Pilot' });
    renderApp(`/?project_id=${made.data.project_id}`);
    expect(await screen.findByText(/No samples yet in Chambal Pilot\./)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Record a collection event' }).getAttribute('href'),
    ).toBe('/events');
    expect((await tiles()).map((t) => t.text)).toEqual([
      'Project1Open the project',
      'Sites0See them on the sampling map',
      'Samples0Every sample, in any status',
      'Approved detections0Approved analyses, QC flag pass',
    ]);
    // Creating the project also made its creator the owner, in the same transaction.
    expect(activity()[0].textContent).toMatch(/^You added a member to project #1000You as owner/);
    expect(activity()[1].textContent).toMatch(/^You created project #1000Chambal Pilot/);
  });

  it('says when samples have no approved detections yet', async () => {
    await signInAs('principal_investigator');
    const made = await api.post<{ project_id: number }>('/projects', { title: 'Chambal Pilot' });
    const id = made.data.project_id;
    await api.post(`/projects/${id}/sites`, { site_id: 1 });
    await api.post('/events', {
      project_id: id,
      site_id: 1,
      collected_at: '2026-10-30T08:00:00Z',
      samples: [{ sample_type_id: 1 }],
    });
    renderApp(`/?project_id=${id}`);
    expect(await screen.findByText(/No approved detections yet\./)).toBeTruthy();
    expect(screen.queryByText(/No samples yet/)).toBeNull();
  });

  it('reports a project the user cannot see', async () => {
    await signInAs('lab_technician');
    renderApp('/?project_id=2');
    expect(await screen.findByText('Could not load the dashboard')).toBeTruthy();
    expect(screen.getByText('Project not found')).toBeTruthy();
  });

  it('shows the administrator’s own sign-in as "You"', async () => {
    await signInAs('administrator');
    renderApp('/');
    await tiles();
    expect(activity()[0].textContent).toMatch(/^You signed in/);
    expect(within(activity()[0]).queryByRole('link')).toBeNull();
  });

  it('opens the audit log tab from its link', async () => {
    await signInAs('administrator');
    renderApp('/admin?tab=audit');
    expect(
      (await screen.findByRole('tab', { name: 'Audit log' })).getAttribute('aria-selected'),
    ).toBe('true');
    expect(await screen.findByRole('table', { name: 'Audit entries' })).toBeTruthy();
  });
});

describe('activity lines', () => {
  const entry = (over: Partial<AuditEntry>): AuditEntry => ({
    audit_id: 1,
    actor_id: 2,
    actor_name: 'Pranav Investigator',
    entity_type: 'samples',
    entity_id: 7,
    action: 'update',
    details: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  });
  const access = { canOpenAnalyses: true, canManageUsers: false };

  it('words each action and table', () => {
    expect(describeAction(entry({ action: 'login', entity_type: 'users' }))).toBe('signed in');
    expect(describeAction(entry({ action: 'insert' }))).toBe('created sample #7');
    expect(describeAction(entry({ action: 'delete', entity_type: 'project_members' }))).toBe(
      'removed a member from project #7',
    );
    expect(describeAction(entry({ action: 'approve', entity_type: 'analysis_runs' }))).toBe(
      'approved analysis #7',
    );
    expect(entityLabel('new_table')).toBe('new table');
    expect(describeAction(entry({ action: 'insert', entity_type: 'project_sites' }))).toBe(
      'added a site to project #7',
    );
    expect(describeAction(entry({ action: 'update', entity_type: 'project_members' }))).toBe(
      "changed a member's role in project #7",
    );
    expect(describeAction(entry({ action: 'delete', entity_type: 'user_roles' }))).toBe(
      'took a role from user #7',
    );
    // A link row without its own phrase for that action falls back to the table's label.
    expect(describeAction(entry({ action: 'update', entity_type: 'project_sites' }))).toBe(
      'changed the sites of project #7',
    );
  });

  it('names the member of a membership row when it can, else shows the id', () => {
    const added = entry({
      action: 'insert',
      entity_type: 'project_members',
      details: { user_id: { new: 5 }, project_role: { new: 'analyst' } },
    });
    expect(describeDetail(added)).toBe('user #5 as analyst');
    expect(describeDetail(added, (id) => (id === 5 ? 'Anil Analyst' : 'x'))).toBe(
      'Anil Analyst as analyst',
    );
  });

  it('drops the status change an approval or rejection already reports', () => {
    const changed = (id: number, to: string, audit_id: number) =>
      entry({
        audit_id,
        entity_type: 'analysis_runs',
        entity_id: id,
        action: 'update',
        details: { status: { old: 'imported', new: to } },
      });
    const feed = [
      entry({ audit_id: 1, entity_type: 'analysis_runs', entity_id: 3, action: 'approve' }),
      changed(3, 'approved', 2),
      changed(4, 'approved', 3), // no approve entry for #4 in the feed: stays
      entry({ audit_id: 4, entity_type: 'analysis_runs', entity_id: 5, action: 'reject' }),
      changed(5, 'rejected', 5),
      changed(5, 'imported', 6), // an unrelated change to #5: stays
    ];
    expect(withoutDuplicateDecisions(feed).map((e) => e.audit_id)).toEqual([1, 3, 4, 6]);
  });

  it('summarises the details', () => {
    expect(describeDetail(entry({}))).toBeNull();
    expect(
      describeDetail(
        entry({
          details: {
            status: { old: 'stored', new: 'extracted' },
            storage_location: { old: null, new: 'B' },
            volume_ml: { old: 1, new: 2 },
          },
        }),
      ),
    ).toBe('status: stored → extracted; storage_location: none → B and 1 more');
    expect(
      describeDetail(
        entry({ details: { from_status: 'approved', to_status: 'superseded', superseded_by: 9 } }),
      ),
    ).toBe('status: approved → superseded');
    expect(describeDetail(entry({ action: 'reject', details: { reason: 'Wrong marker' } }))).toBe(
      'Reason: Wrong marker',
    );
    expect(describeDetail(entry({ action: 'approve', details: { detection_count: 14 } }))).toBe(
      '14 detections',
    );
    expect(describeDetail(entry({ action: 'delete', details: { title: { old: 'Gone' } } }))).toBe(
      'Gone',
    );
    expect(describeDetail(entry({ action: 'insert', details: { x: { new: 1 } } }))).toBeNull();
    const link = (entity_type: string, details: Record<string, unknown>, action = 'insert') =>
      describeDetail(entry({ entity_type, details, action: action as AuditEntry['action'] }));
    expect(
      link('project_members', { user_id: { new: 3 }, project_role: { new: 'contributor' } }),
    ).toBe('user #3 as contributor');
    expect(link('project_sites', { site_id: { old: 4 } }, 'delete')).toBe('site #4');
    expect(link('user_roles', { role_id: { new: 5 } })).toBe('role #5');
    expect(
      link('project_members', { project_role: { old: 'viewer', new: 'manager' } }, 'update'),
    ).toBe('project_role: viewer → manager');
    expect(
      describeDetail(
        entry({ details: { approved_at: { old: null, new: '2026-11-02T15:29:34+00:00' } } }),
      ),
    ).toMatch(/^approved_at: none → (?!2026-11-02T)/); // shown in local time, not raw
    expect(describeDetail(entry({ details: { p: { old: { a: 1 }, new: { a: 2 } } } }))).toBe(
      'p: {"a":1} → {"a":2}',
    );
  });

  it('links to the page that shows the record', () => {
    const link = (over: Partial<AuditEntry>, a = access) => activityLink(entry(over), a);
    expect(link({ entity_type: 'projects' })).toBe('/projects/7');
    expect(link({ entity_type: 'project_sites' })).toBe('/projects/7');
    expect(link({ entity_type: 'collection_events' })).toBe('/events/7');
    expect(link({ entity_type: 'sampling_sites' })).toBe('/map?site_id=7');
    expect(link({ entity_type: 'sequencing_runs' })).toBe('/lab/runs/7');
    expect(link({ entity_type: 'quality_control_results' })).toBe('/lab?tab=qc');
    expect(link({ entity_type: 'analysis_runs' })).toBe('/analyses/import?analysis_id=7');
    expect(
      link({ entity_type: 'analysis_runs' }, { canOpenAnalyses: false, canManageUsers: false }),
    ).toBeNull();
    expect(link({ entity_type: 'users' })).toBeNull();
    expect(link({ entity_type: 'users' }, { canOpenAnalyses: false, canManageUsers: true })).toBe(
      '/admin',
    );
    expect(link({ action: 'delete' })).toBeNull();
    expect(link({ entity_type: 'dna_extractions' })).toBeNull();
  });
});
