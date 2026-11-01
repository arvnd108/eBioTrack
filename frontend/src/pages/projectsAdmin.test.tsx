// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Projects, project detail and Administration pages, through the real routes (mock mode)

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../services/apiClient';
import { renderApp, resetMock, signInAs } from '../test/renderApp';
import type { AuditEntry } from '../types';
import { summarizeChange } from './admin/AuditPanel';
import { SitePicker, type useSiteList } from './projects/Pickers';
import { checkProject } from './projects/projectRules';

beforeEach(resetMock);
afterEach(cleanup);

const table = (name: string) => screen.getByRole('table', { name });
const rowsOf = async (name: string) => {
  await waitFor(() => expect(within(table(name)).getAllByRole('row').length).toBeGreaterThan(1));
  return within(table(name)).getAllByRole('row').slice(1);
};
const rowFor = async (name: string, text: string) =>
  (await rowsOf(name)).find((row) => row.textContent?.includes(text))!;

describe('Projects page', () => {
  it('lists the projects a member belongs to, with their role, and no New project button', async () => {
    await signInAs('viewer');
    renderApp('/projects');
    await screen.findByRole('heading', { name: 'Projects' });
    const rows = await rowsOf('Projects');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Yamuna Biodiversity Survey');
    expect(rows[0]?.textContent).toContain('Viewer');
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('shows every project to an administrator, marked as administrator access', async () => {
    await signInAs('administrator');
    renderApp('/projects');
    const rows = await rowsOf('Projects');
    expect(rows.map((r) => (r as HTMLTableRowElement).cells[0].textContent)).toEqual([
      'Coastal Estuary Pilot',
      'Yamuna Biodiversity Survey',
    ]);
    expect(rows[0]?.textContent).toContain('Administrator access');
  });

  it('filters by status', async () => {
    await signInAs('principal_investigator');
    renderApp('/projects');
    await rowsOf('Projects');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Status'), 'completed');
    await screen.findByText('No completed projects');
  });

  it('checks the new project form, refuses a taken title, then opens the new project', async () => {
    await signInAs('principal_investigator');
    const { router } = renderApp('/projects');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const form = screen.getByRole('form', { name: 'New project' });

    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(within(form).getByText('Enter a title.')).toBeTruthy();

    await user.type(within(form).getByLabelText(/Title/), 'Yamuna Biodiversity Survey');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(
      await within(form).findByText(
        'A project with this title already exists. Choose another title.',
      ),
    ).toBeTruthy();

    await user.clear(within(form).getByLabelText(/Title/));
    await user.type(within(form).getByLabelText(/Title/), 'Ganga Headwaters');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await screen.findByRole('heading', { name: 'Ganga Headwaters' });
    expect(router.state.location.pathname).toMatch(/^\/projects\/\d+$/);
    expect(screen.getByText('Your role:').parentElement?.textContent).toContain('Owner');
  });
});

describe('Project detail page', () => {
  it('shows details, members and sites read-only to a project viewer', async () => {
    await signInAs('viewer');
    renderApp('/projects/1');
    await screen.findByRole('heading', { name: 'Yamuna Biodiversity Survey' });
    expect(await rowsOf('Members')).toHaveLength(5);
    expect(await rowsOf('Sites')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add member' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Link site' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('lists members owner first, and the owner cannot be removed', async () => {
    await signInAs('principal_investigator');
    renderApp('/projects/1');
    const rows = await rowsOf('Members');
    expect(rows[0]?.textContent).toContain('Pranav Investigator');
    expect(rows[0]?.textContent).toContain('Owner');
    expect(within(rows[0]).queryByRole('button')).toBeNull();
    expect(rows[4]?.textContent).toContain('Vikram Viewer');
  });

  it('lets the owner edit details, and says when nothing changed', async () => {
    await signInAs('principal_investigator');
    renderApp('/projects/1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit details' }));
    const form = screen.getByRole('form', { name: 'Edit project' });

    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByText('Nothing has changed.')).toBeTruthy();

    await user.type(within(form).getByLabelText('End date'), '2024-12-31');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(
      within(form).getByText(/^End date must be on or after the start date \(.+2025\)\.$/),
    ).toBeTruthy();

    await user.clear(within(form).getByLabelText('End date'));
    await user.selectOptions(within(form).getByLabelText('Status'), 'completed');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit project' })).toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).nextElementSibling?.textContent).toContain(
      'Completed',
    );
  });

  it('adds a member by user ID for a principal investigator, and refuses a duplicate', async () => {
    await signInAs('principal_investigator');
    renderApp('/projects/2');
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Add member' });
    expect(
      within(form).getByText('Only administrators can browse users; ask one for the user ID.'),
    ).toBeTruthy();

    await user.click(within(form).getByRole('button', { name: 'Add member' }));
    expect(within(form).getByText('Enter the person’s user ID.')).toBeTruthy();

    await user.type(within(form).getByLabelText(/Person/), '3');
    await user.click(within(form).getByRole('button', { name: 'Add member' }));
    expect(
      await within(form).findByText('This person is already a member of the project.'),
    ).toBeTruthy();

    await user.clear(within(form).getByLabelText(/Person/));
    await user.type(within(form).getByLabelText(/Person/), '4');
    await user.selectOptions(within(form).getByLabelText('Project role'), 'manager');
    await user.click(within(form).getByRole('button', { name: 'Add member' }));
    const added = await rowFor('Members', 'Lakshmi Lab');
    expect(added?.textContent).toContain('Manager');
  });

  it('gives an administrator a list of active users who are not yet members', async () => {
    await signInAs('administrator');
    renderApp('/projects/2');
    const form = await screen.findByRole('form', { name: 'Add member' });
    const select = await within(form).findByRole('combobox', { name: /Person/ });
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options[0]).toBe('Choose a person…');
    expect(options.some((o) => o?.startsWith('Farah Field'))).toBe(false); // already a member
    expect(options.some((o) => o?.startsWith('Lakshmi Lab'))).toBe(true);
  });

  it('removes a member after a second click', async () => {
    await signInAs('principal_investigator');
    renderApp('/projects/1');
    const user = userEvent.setup();
    await rowsOf('Members');
    await user.click(screen.getByRole('button', { name: 'Remove Vikram Viewer' }));
    await user.click(screen.getByRole('button', { name: 'Remove member?' }));
    await waitFor(async () => expect(await rowsOf('Members')).toHaveLength(4));
  });

  it('explains why a site with collection events cannot be unlinked, and links another', async () => {
    await signInAs('principal_investigator');
    renderApp('/projects/1');
    const user = userEvent.setup();
    await rowsOf('Sites');
    await user.click(screen.getByRole('button', { name: 'Unlink Dakpathar Barrage' }));
    await user.click(screen.getByRole('button', { name: 'Unlink site?' }));
    expect(
      await screen.findByText('Site has collection events in this project and cannot be removed'),
    ).toBeTruthy();
    expect(await rowsOf('Sites')).toHaveLength(3);

    const form = screen.getByRole('form', { name: 'Link site' });
    const select = await within(form).findByRole('combobox', { name: /Site/ });
    expect(within(select).queryByRole('option', { name: /Dakpathar/ })).toBeNull();
    const option = within(select).getAllByRole('option')[1] as HTMLOptionElement;
    await user.selectOptions(select, option.value);
    await user.click(within(form).getByRole('button', { name: 'Link site' }));
    await waitFor(async () => expect(await rowsOf('Sites')).toHaveLength(4));
  });

  it('treats a project the user is not in like a missing one', async () => {
    await signInAs('lab_technician');
    renderApp('/projects/2');
    expect(await screen.findByText('Could not open this project')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Coastal Estuary Pilot' })).toBeNull();
  });

  it('does not ask the API about an invalid project ID', async () => {
    await signInAs('viewer');
    renderApp('/projects/abc');
    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeTruthy();
  });
});

describe('Administration page', () => {
  it('gives an administrator Users and Audit log tabs', async () => {
    await signInAs('administrator');
    renderApp('/admin');
    await screen.findByRole('heading', { name: 'Administration' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Users', 'Audit log']);
    expect(await rowsOf('Users')).toHaveLength(6);

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Audit log' }));
    const first = (await rowsOf('Audit entries'))[0];
    expect(first?.textContent).toContain('Asha Admin');
    expect(first?.textContent).toContain('Signed in');
  });

  it('shows a principal investigator only the audit log, with user IDs instead of names', async () => {
    await signInAs('principal_investigator');
    await api.patch('/projects/1', { status: 'completed' });
    renderApp('/admin');
    await screen.findByText('The audit log for your projects.');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Users' })).toBeNull();
    const rows = await rowsOf('Audit entries');
    expect(rows).toHaveLength(1); // their sign-in is not project data
    expect(rows[0].textContent).toContain('User 2');
    expect(rows[0].textContent).toContain('Projects #1');
    expect(rows[0].textContent).toContain('status: active → completed');
  });

  it('filters the audit log and rejects a reversed day range', async () => {
    await signInAs('administrator');
    renderApp('/admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Audit log' }));
    await rowsOf('Audit entries');
    const form = screen.getByRole('form', { name: 'Filter audit log' });

    await user.type(within(form).getByLabelText('From day'), '2026-02-02');
    await user.type(within(form).getByLabelText('To day'), '2026-02-01');
    await user.click(within(form).getByRole('button', { name: 'Apply' }));
    expect(within(form).getByText('The "from" day must not be after the "to" day.')).toBeTruthy();

    await user.click(within(form).getByRole('button', { name: 'Clear' }));
    await user.selectOptions(within(form).getByLabelText('Record type'), 'taxa');
    await user.click(within(form).getByRole('button', { name: 'Apply' }));
    await screen.findByText('No entries match these filters');
  });

  it('checks the new user form, then creates the user', async () => {
    await signInAs('administrator');
    renderApp('/admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New user' }));
    const form = screen.getByRole('form', { name: 'New user' });

    await user.click(within(form).getByRole('button', { name: 'Create user' }));
    expect(within(form).getByText('Enter the full name.')).toBeTruthy();
    expect(within(form).getByText('Enter an email address.')).toBeTruthy();
    expect(within(form).getByText('Password must be at least 8 characters.')).toBeTruthy();
    expect(within(form).getByText('Choose at least one role.')).toBeTruthy();

    await user.type(within(form).getByLabelText(/Full name/), 'Meera Field');
    await user.type(within(form).getByLabelText(/Email/), 'viewer@ebiotrack.test');
    await user.type(within(form).getByLabelText(/Password/), 'a-long-password');
    await user.click(within(form).getByRole('checkbox', { name: /Field researcher/ }));
    await user.click(within(form).getByRole('button', { name: 'Create user' }));
    expect(
      await within(form).findByText('A user with this email address already exists.'),
    ).toBeTruthy();

    await user.clear(within(form).getByLabelText(/Email/));
    await user.type(within(form).getByLabelText(/Email/), 'meera@ebiotrack.test');
    await user.click(within(form).getByRole('button', { name: 'Create user' }));
    expect(await screen.findByText('Created Meera Field.')).toBeTruthy();
    expect((await rowFor('Users', 'Meera Field')).textContent).toContain('Field researcher');
  });

  it('stops an administrator locking themselves out, and deactivates someone else', async () => {
    await signInAs('administrator');
    renderApp('/admin');
    const user = userEvent.setup();
    await rowsOf('Users');

    await user.click(screen.getByRole('button', { name: 'Edit Asha Admin' }));
    let form = screen.getByRole('form', { name: 'Edit Asha Admin' });
    expect(
      (within(form).getByRole('checkbox', { name: 'Active' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(form).getByRole('checkbox', { name: /Administrator/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Edit Vikram Viewer' }));
    form = screen.getByRole('form', { name: 'Edit Vikram Viewer' });
    await user.click(within(form).getByRole('checkbox', { name: 'Active' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved changes to Vikram Viewer.')).toBeTruthy();
    await waitFor(async () =>
      expect((await rowFor('Users', 'Vikram Viewer')).textContent).toContain('Inactive'),
    );
  });
});

describe('helpers', () => {
  const entry = (action: AuditEntry['action'], details: AuditEntry['details']): AuditEntry => ({
    audit_id: 1,
    actor_id: 1,
    entity_type: 'projects',
    entity_id: 1,
    action,
    details,
    created_at: '2026-01-01T00:00:00Z',
  });

  it('summarizes audit details in the trigger’s three shapes', () => {
    expect(summarizeChange(entry('login', null))).toBe('Signed in');
    expect(summarizeChange(entry('update', { status: { old: 'active', new: 'completed' } }))).toBe(
      'status: active → completed',
    );
    expect(summarizeChange(entry('insert', { title: { new: 'X' }, end_date: { new: null } }))).toBe(
      'title: X; end_date: ∅',
    );
    expect(summarizeChange(entry('delete', { user_id: { old: 4 } }))).toBe('user_id: 4');
    expect(summarizeChange(entry('update', {}))).toBe('—');
  });

  it('checks project fields like the API', () => {
    expect(checkProject({ title: ' ', objectives: '' })).toEqual({ title: 'Enter a title.' });
    expect(checkProject({ title: 'x'.repeat(301), objectives: 'y'.repeat(5001) })).toEqual({
      title: 'Title must be at most 300 characters.',
      objectives: 'Objectives must be at most 5000 characters.',
    });
    expect(checkProject({ title: 'x', objectives: '', start_date: '2025-02-30' })).toEqual({
      start_date: 'Enter a real date.',
    });
    expect(
      checkProject({
        title: 'x',
        objectives: '',
        end_date: '2025-01-15',
        savedStartDate: '2025-01-15',
      }),
    ).toEqual({});
  });

  it('falls back to a site ID box while GET /api/sites is not available', async () => {
    const sites = { status: 'error' } as ReturnType<typeof useSiteList>;
    let value = '';
    render(
      <SitePicker
        value={value}
        onChange={(v) => (value = v)}
        exclude={[]}
        sites={sites}
        aria-label="Site"
      />,
    );
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Site' }), '4');
    expect(value).toBe('4');
  });
});
