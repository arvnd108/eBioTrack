// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Sampling map, Collection events and Samples pages, through the real routes (mock mode)

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../services/apiClient';
import { renderApp, resetMock, signInAs } from '../test/renderApp';
import {
  checkCollectedAt,
  checkMeasurements,
  checkSample,
  localDateTimeToIso,
  newMeasurement,
  newSample,
  placeServerDetails,
} from './events/eventRules';

beforeEach(resetMock);
afterEach(cleanup);

/** Farah (field researcher) becomes a project viewer on project 2: read-only there. */
async function makeFarahViewerOfProject2() {
  await signInAs('principal_investigator');
  await api.delete('/projects/2/members/3');
  await api.post('/projects/2/members', { user_id: 3, project_role: 'viewer' });
  // A sample on project 2 that can still change status (the seeded ones are final).
  const sample = await api.post<{ sample_id: number }>('/samples', {
    event_id: 7,
    sample_type_id: 1,
  });
  await api.post('/auth/logout');
  await signInAs('field_researcher');
  return sample.data.sample_id;
}

const table = (name: string) => screen.getByRole('table', { name });
const rowsOf = async (name: string) => {
  await waitFor(() => expect(within(table(name)).getAllByRole('row').length).toBeGreaterThan(1));
  return within(table(name)).getAllByRole('row').slice(1);
};
const texts = (rows: HTMLElement[], column = 0) =>
  rows.map((r) => (r as HTMLTableRowElement).cells[column].textContent);
const search = (router: { state: { location: { search: string } } }) =>
  new URLSearchParams(router.state.location.search);

describe('Samples page', () => {
  it('lists the samples of the projects a user belongs to', async () => {
    await signInAs('viewer'); // member of project 1 only
    renderApp('/samples');
    const rows = await rowsOf('Samples');
    expect(rows).toHaveLength(13);
    expect(texts(rows)).not.toContain('EB-20260405-0007-001'); // project 2
  });

  it('opens already filtered from the URL, and searches by code prefix', async () => {
    await signInAs('field_researcher');
    renderApp('/samples?status=failed');
    expect(texts(await rowsOf('Samples'))).toEqual(['EB-20250515-0001-003']);
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('failed');

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Status'), '');
    await user.type(screen.getByLabelText('Sample code starts with'), 'eb-2026031');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(async () => expect(await rowsOf('Samples')).toHaveLength(6));
  });

  it('shows the event filter as a chip that can be removed', async () => {
    await signInAs('field_researcher');
    const { router } = renderApp('/samples?event_id=1');
    expect(await rowsOf('Samples')).toHaveLength(3);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Show samples from every event' }));
    await waitFor(async () => expect(await rowsOf('Samples')).toHaveLength(17));
    expect(search(router).get('event_id')).toBeNull();
  });

  it('clears the site when the project changes, in one URL update', async () => {
    await signInAs('field_researcher');
    const { router } = renderApp('/samples?site_id=4');
    expect(await rowsOf('Samples')).toHaveLength(2);
    await userEvent.setup().selectOptions(await screen.findByLabelText('Project'), '1');
    await waitFor(() => expect(search(router).get('project_id')).toBe('1'));
    expect(search(router).get('site_id')).toBeNull();
    await waitFor(async () => expect(await rowsOf('Samples')).toHaveLength(13));
  });

  it('sorts through the API', async () => {
    await signInAs('field_researcher');
    renderApp('/samples');
    await rowsOf('Samples');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Sample code/ }));
    await user.click(screen.getByRole('button', { name: /Sample code/ }));
    await waitFor(async () =>
      expect(texts(await rowsOf('Samples'))[0]).toBe('EB-20260408-0008-002'),
    );
  });
});

describe('Sample detail page', () => {
  it('shows the sample, its timeline and extractions', async () => {
    await signInAs('viewer');
    renderApp('/samples/17');
    await screen.findByRole('heading', { name: 'EB-20250515-0001-003' });
    const timeline = screen.getByRole('list', { name: 'Status history' });
    const steps = within(timeline).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent?.split(/registered|from/)[0])).toEqual([
      'Collected',
      'Stored',
      'Extracted',
      'Failed',
    ]);
    expect(steps[3].textContent).toContain('Extraction failed concentration QC check');
    // Every role sees who did it: the API sends the name (a viewer cannot call GET /api/users).
    expect(steps[3].textContent).toContain('Lakshmi Lab');
    expect(within(table('DNA extractions')).getByText('Fail')).toBeTruthy();
    // A project viewer may read but not change the status.
    expect(screen.queryByRole('form', { name: 'Change status' })).toBeNull();
  });

  it('offers only the allowed next statuses, then records the change', async () => {
    await signInAs('field_researcher');
    renderApp('/samples/17');
    const form = await screen.findByRole('form', { name: 'Change status' });
    const select = within(form).getByLabelText(/New status/);
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose…', 'Discarded']);
    const user = userEvent.setup();
    await user.click(within(form).getByRole('button', { name: 'Change status' }));
    expect(within(form).getByText('Choose the new status.')).toBeTruthy();

    await user.selectOptions(select, 'discarded');
    expect(within(form).getByText(/Discarded is final/)).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Change status' }));
    await screen.findByText('Discarded is a final status, so it cannot be changed.');
    const steps = within(screen.getByRole('list', { name: 'Status history' })).getAllByRole(
      'listitem',
    );
    expect(steps).toHaveLength(5);
    expect(steps[4].textContent).toContain('from Failed');
    expect(steps[4].textContent).toContain('You');
  });

  it('stores an optional note with the change and shows it in the history', async () => {
    await signInAs('field_researcher');
    const created = await api.post<{ sample_id: number }>('/samples', {
      event_id: 1,
      sample_type_id: 1,
    });
    renderApp(`/samples/${created.data.sample_id}`);
    const form = await screen.findByRole('form', { name: 'Change status' });
    const user = userEvent.setup();
    await user.selectOptions(within(form).getByLabelText(/New status/), 'stored');
    fireEvent.change(within(form).getByLabelText('Note'), { target: { value: 'x'.repeat(1001) } });
    await user.click(within(form).getByRole('button', { name: 'Change status' }));
    expect(within(form).getByText('Note must be at most 1000 characters.')).toBeTruthy();

    fireEvent.change(within(form).getByLabelText('Note'), {
      target: { value: '  Cold room, shelf 2  ' },
    });
    await user.click(within(form).getByRole('button', { name: 'Change status' }));
    await waitFor(() => {
      const steps = within(screen.getByRole('list', { name: 'Status history' })).getAllByRole(
        'listitem',
      );
      expect(steps).toHaveLength(2);
      expect(steps[1].textContent).toContain('Cold room, shelf 2');
    });
    expect((within(form).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('');
  });

  it('explains a 409 when the sample changed meanwhile, and shows the new status', async () => {
    await signInAs('field_researcher');
    const created = await api.post<{ sample_id: number }>('/samples', {
      event_id: 1,
      sample_type_id: 1,
    });
    const id = created.data.sample_id;
    renderApp(`/samples/${id}`);
    const form = await screen.findByRole('form', { name: 'Change status' });
    await api.patch(`/samples/${id}/status`, { new_status: 'discarded' }); // someone else

    const user = userEvent.setup();
    await user.selectOptions(within(form).getByLabelText(/New status/), 'stored');
    await user.click(within(form).getByRole('button', { name: 'Change status' }));
    expect(
      await screen.findByText(/Invalid sample status transition: discarded -> stored\. The sample/),
    ).toBeTruthy();
    await screen.findByText('Discarded is a final status, so it cannot be changed.');
  });

  it('hides the control from a field researcher who is only a viewer of the project', async () => {
    const id = await makeFarahViewerOfProject2();
    renderApp(`/samples/${id}`);
    await screen.findByRole('heading', { name: 'EB-20260405-0007-003' });
    await screen.findByText('Coastal Estuary Pilot');
    expect(screen.queryByRole('form', { name: 'Change status' })).toBeNull();
    cleanup();
    renderApp('/samples/17'); // failed, on project 1 where she contributes
    expect(await screen.findByRole('form', { name: 'Change status' })).toBeTruthy();
  });

  it('hides the control from roles that cannot change a status', async () => {
    await signInAs('analyst');
    renderApp('/samples/1');
    await screen.findByRole('heading', { name: 'EB-20250515-0001-001' });
    await screen.findByText('Yamuna Biodiversity Survey');
    expect(screen.queryByRole('form', { name: 'Change status' })).toBeNull();
  });

  it('treats a sample in another project like a missing one, and skips an invalid id', async () => {
    await signInAs('lab_technician');
    renderApp('/samples/13');
    expect(await screen.findByText('Could not open this sample')).toBeTruthy();
    cleanup();
    renderApp('/samples/abc');
    expect(await screen.findByRole('heading', { name: 'Sample not found' })).toBeTruthy();
  });
});

describe('Collection events page', () => {
  it('lists events newest first, with project, site and collector names', async () => {
    await signInAs('administrator');
    renderApp('/events');
    const rows = await rowsOf('Collection events');
    expect(texts(rows, 1)).toEqual(['#8', '#7', '#6', '#5', '#4', '#3', '#2', '#1']);
    await waitFor(() => expect(rows[0].textContent).toContain('Kakdwip Bay'));
    expect(rows[0].textContent).toContain('Coastal Estuary Pilot');
    await waitFor(() => expect(rows[0].textContent).toContain('Farah Field'));
  });

  it('names the collector for roles that cannot list users', async () => {
    await signInAs('lab_technician');
    renderApp('/events');
    const rows = await rowsOf('Collection events');
    expect(rows[0].textContent).toContain('Farah Field');
    expect(rows[0].textContent).not.toContain('User 3');
  });

  it('filters by site from the URL and rejects a reversed day range', async () => {
    await signInAs('field_researcher');
    renderApp('/events?site_id=2');
    expect(texts(await rowsOf('Collection events'), 1)).toEqual(['#5', '#2']);
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText('From day'), { target: { value: '2026-03-12' } });
    fireEvent.change(screen.getByLabelText('To day'), { target: { value: '2026-03-01' } });
    expect(await screen.findByText('The "from" day must not be after the "to" day.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    await waitFor(async () => expect(await rowsOf('Collection events')).toHaveLength(8));
  });

  it('shows New event only to roles that may record events', async () => {
    for (const [role, shown] of [
      ['viewer', false],
      ['lab_technician', true], // project contributor
      ['analyst', true], // project contributor
      ['field_researcher', true],
      ['principal_investigator', true],
    ] as const) {
      resetMock();
      await signInAs(role);
      renderApp('/events');
      await rowsOf('Collection events');
      expect(!!screen.queryByRole('button', { name: 'New event' })).toBe(shown);
      cleanup();
    }
  });

  it('checks the new event form, then saves the event with measurements and samples', async () => {
    await signInAs('field_researcher');
    const { router } = renderApp('/events');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New event' }));
    const form = screen.getByRole('form', { name: 'New collection event' });

    // Farah belongs to both projects, so she must choose one; a site comes from that project.
    await user.click(within(form).getByRole('button', { name: 'Add measurement' }));
    await user.click(within(form).getByRole('button', { name: 'Add measurement' }));
    await user.type(within(form).getByLabelText('Parameter, row 1'), 'ph');
    expect((within(form).getByLabelText('Unit, row 1') as HTMLInputElement).value).toBe('pH');
    await user.type(within(form).getByLabelText('Value, row 1'), '7.4');
    await user.type(within(form).getByLabelText('Parameter, row 2'), 'ph');
    await user.type(within(form).getByLabelText('Value, row 2'), 'high');
    await user.type(within(form).getByLabelText('Volume (mL), sample 1'), '0');
    await user.click(within(form).getByRole('button', { name: 'Save event' }));

    expect(within(form).getByText('Choose the project.')).toBeTruthy();
    expect(within(form).getByText('Choose the site.')).toBeTruthy();
    expect(within(form).getByText('This parameter is already in the list.')).toBeTruthy();
    expect(within(form).getByText('Enter a number.')).toBeTruthy();
    expect(within(form).getByText('Must be greater than 0.')).toBeTruthy();
    expect(within(form).getByRole('alert').textContent).toBe('Check the highlighted fields.');

    await user.selectOptions(within(form).getByLabelText(/Project/), '2');
    expect(within(form).queryByText('Choose the project.')).toBeNull(); // cleared once edited
    expect(within(form).getByText('Choose the site.')).toBeTruthy();
    const site = within(form).getByLabelText(/^Site/);
    await waitFor(() => expect(within(site).getAllByRole('option')).toHaveLength(3));
    await user.selectOptions(site, '4');
    await user.click(within(form).getByRole('button', { name: 'Remove measurement 2' }));
    // Row 1 kept its (empty) errors; the removed row's messages are gone.
    expect(within(form).queryByText('This parameter is already in the list.')).toBeNull();
    expect(within(form).getByText('Must be greater than 0.')).toBeTruthy();
    await user.clear(within(form).getByLabelText('Volume (mL), sample 1'));
    await user.type(within(form).getByLabelText('Volume (mL), sample 1'), '750');
    await user.click(within(form).getByRole('button', { name: 'Add sample' }));
    await user.selectOptions(within(form).getByLabelText('Sample type, sample 2'), '3');
    await user.click(within(form).getByRole('button', { name: 'Save event' }));

    await screen.findByRole('heading', { name: /^Event 1000: Diamond Harbour/ });
    expect(router.state.location.pathname).toBe('/events/1000');
    const samples = await rowsOf('Samples');
    expect(texts(samples)[0]).toMatch(/^EB-\d{8}-1000-001$/);
    expect(samples[1].textContent).toContain('Sediment');
    const measurements = await rowsOf('Environmental measurements');
    expect(measurements.map((r) => r.textContent)).toEqual(['pH7.4pH']);
  });

  it('offers only projects where the user may record events', async () => {
    await makeFarahViewerOfProject2();
    renderApp('/events');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New event' }));
    const project = within(
      screen.getByRole('form', { name: 'New collection event' }),
    ).getByLabelText(/Project/) as HTMLSelectElement;
    expect(
      within(project)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a project…', 'Yamuna Biodiversity Survey']);
    expect(project.value).toBe('1'); // the only choice is preselected
  });

  it('shows an event and lets a contributor add a sample', async () => {
    await signInAs('field_researcher');
    renderApp('/events/1');
    await screen.findByRole('heading', { name: 'Event 1: Dakpathar Barrage' });
    expect(await rowsOf('Environmental measurements')).toHaveLength(4);
    expect(await rowsOf('Samples')).toHaveLength(3);
    const form = screen.getByRole('form', { name: 'Add sample' });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText('Depth (m)'), '-1');
    await user.click(within(form).getByRole('button', { name: 'Add sample' }));
    expect(within(form).getByText('Must be 0 or more.')).toBeTruthy();
    await user.clear(within(form).getByLabelText('Depth (m)'));
    await user.type(within(form).getByLabelText('Storage location'), 'Shelf 2');
    await user.click(within(form).getByRole('button', { name: 'Add sample' }));
    expect(await screen.findByText('Registered sample EB-20250515-0001-004.')).toBeTruthy();
    await waitFor(async () => expect(await rowsOf('Samples')).toHaveLength(4));
  });

  it('hides Add sample from a field researcher who is only a viewer of the project', async () => {
    await makeFarahViewerOfProject2();
    renderApp('/events/7');
    await screen.findByRole('heading', { name: 'Event 7: Diamond Harbour' });
    await screen.findByText('Coastal Estuary Pilot');
    expect(screen.queryByRole('form', { name: 'Add sample' })).toBeNull();
  });

  it('keeps events of other projects hidden, and the add form from viewers', async () => {
    await signInAs('viewer');
    renderApp('/events/1');
    await screen.findByRole('heading', { name: 'Event 1: Dakpathar Barrage' });
    await screen.findByText('Yamuna Biodiversity Survey');
    expect(screen.queryByRole('form', { name: 'Add sample' })).toBeNull();
    cleanup();
    renderApp('/events/7');
    expect(await screen.findByText('Could not open this event')).toBeTruthy();
  });
});

describe('Sampling map page', () => {
  it('lists the sites with filters, and selects one from the table', async () => {
    await signInAs('viewer'); // a project viewer: read-only, no New site / Edit
    const { router, container } = renderApp('/map');
    expect(texts(await rowsOf('Sites'))).toEqual([
      'Dakpathar Barrage',
      'Diamond Harbour',
      'Kakdwip Bay',
      'Okhla Barrage',
      'Sangam Prayagraj',
    ]);
    await waitFor(() =>
      expect(container.querySelectorAll('path.leaflet-interactive')).toHaveLength(5),
    );
    expect(screen.queryByRole('button', { name: 'New site' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Habitat'), 'estuary');
    await waitFor(async () => expect(await rowsOf('Sites')).toHaveLength(2));
    await waitFor(() =>
      expect(container.querySelectorAll('path.leaflet-interactive')).toHaveLength(2),
    );
    await user.click(screen.getByRole('button', { name: 'Show Kakdwip Bay on the map' }));
    expect(search(router).get('site_id')).toBe('5');
  });

  it('shows a site summary in its popup, with counts from the user’s projects', async () => {
    await signInAs('viewer'); // project 1 only, read-only
    renderApp('/map?site_id=1');
    const popup = await waitFor(() => {
      const element = document.querySelector('.leaflet-popup-content');
      if (!element) throw new Error('no popup yet');
      return element as HTMLElement;
    });
    await within(popup).findByText('Dakpathar Barrage');
    const counts = within(popup).getByText('Events').closest('dl')!;
    await waitFor(() => expect(counts.textContent).toBe('Events2Samples5'));
    expect(within(popup).getByRole('link', { name: 'Samples here' }).getAttribute('href')).toBe(
      '/samples?site_id=1',
    );
    expect(within(popup).queryByRole('button', { name: 'Edit site' })).toBeNull();
  });

  it('keeps the site filter when a popup link leaves the map', async () => {
    await signInAs('lab_technician');
    const { router } = renderApp('/map?site_id=1');
    const link = await waitFor(() => {
      const element = document.querySelector('.leaflet-popup-content a[href="/events?site_id=1"]');
      if (!element) throw new Error('no popup yet');
      return element as HTMLElement;
    });
    await userEvent.setup().click(link);
    await screen.findByRole('heading', { name: 'Collection events' });
    expect(router.state.location.pathname + router.state.location.search).toBe('/events?site_id=1');
    expect(texts(await rowsOf('Collection events'), 1)).toEqual(['#4', '#1']);
  });

  it('creates a site, refusing a name its region already has', async () => {
    await signInAs('field_researcher');
    renderApp('/map');
    await rowsOf('Sites');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New site' }));
    const form = screen.getByRole('form', { name: 'New site' });
    await user.type(within(form).getByLabelText(/Latitude/), '95');
    await user.click(within(form).getByRole('button', { name: 'Create site' }));
    expect(within(form).getByText('Enter the site name.')).toBeTruthy();
    expect(within(form).getByText('Latitude must be between -90 and 90.')).toBeTruthy();
    expect(within(form).getByText('Enter a number, or click the map.')).toBeTruthy();

    await user.type(within(form).getByLabelText(/Name/), 'Okhla Barrage');
    await user.selectOptions(within(form).getByLabelText(/Region/), '2');
    await user.clear(within(form).getByLabelText(/Latitude/));
    await user.type(within(form).getByLabelText(/Latitude/), '30.437');
    await user.type(within(form).getByLabelText(/Longitude/), '77.624');
    await user.selectOptions(within(form).getByLabelText(/Habitat/), 'river');
    await user.click(within(form).getByRole('button', { name: 'Create site' }));
    expect(
      await within(form).findByText('This region already has a site with this name.'),
    ).toBeTruthy();

    await user.clear(within(form).getByLabelText(/Name/));
    await user.type(within(form).getByLabelText(/Name/), 'Paonta Sahib');
    await user.click(within(form).getByRole('button', { name: 'Create site' }));
    expect(await screen.findByText('Created Paonta Sahib.')).toBeTruthy();
    await waitFor(async () => expect(texts(await rowsOf('Sites'))).toContain('Paonta Sahib'));
  });

  it('edits a site, sending only what changed', async () => {
    await signInAs('principal_investigator');
    renderApp('/map');
    await rowsOf('Sites');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit Okhla Barrage' }));
    const form = screen.getByRole('form', { name: 'Edit Okhla Barrage' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByText('Nothing has changed.')).toBeTruthy();
    await user.clear(within(form).getByLabelText(/Description/));
    await user.type(within(form).getByLabelText(/Description/), 'Below the barrage');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved Okhla Barrage.')).toBeTruthy();
    const site = await api.get<{ description: string }>('/sites/2');
    expect(site.data.description).toBe('Below the barrage');
  });
});

describe('event form rules', () => {
  it('limits the collection time to one day ahead', () => {
    const now = Date.parse('2026-03-12T10:00:00Z');
    expect(checkCollectedAt('', now)).toBe('Enter when the samples were collected.');
    expect(checkCollectedAt('2026-02-30T10:00', now)).toBe('Enter a real date and time.');
    const tomorrow = new Date(now + 23 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(checkCollectedAt(local(tomorrow), now)).toBeUndefined();
    expect(checkCollectedAt(local(new Date(now + 25 * 3600 * 1000)), now)).toBe(
      'Must not be more than one day in the future.',
    );
    expect(localDateTimeToIso('2026-03-12T09:30')).toBe(new Date('2026-03-12T09:30').toISOString());
  });

  it('checks measurements and samples like the API', () => {
    const rows = [
      { ...newMeasurement('ph', 'pH'), value: '7' },
      { ...newMeasurement(' ph ', ''), value: '1e3' },
    ];
    expect(checkMeasurements(rows)).toEqual([
      {},
      { parameter: 'This parameter is already in the list.', unit: 'Enter the unit.' },
    ]);
    expect(checkSample({ ...newSample(''), volume_ml: '-1', depth_m: 'deep' })).toEqual({
      sample_type_id: 'Choose the sample type.',
      volume_ml: 'Must be greater than 0.',
      depth_m: 'Enter a number.',
    });
  });

  it('places the API’s row details on their rows', () => {
    expect(
      placeServerDetails([
        { field: 'site_id', message: 'is not attached to this project' },
        { field: 'measurements[1].parameter', message: 'appears more than once in this request' },
        { field: 'samples[0].volume_ml', message: 'must be greater than 0' },
        { message: 'no field' },
      ]),
    ).toEqual({
      top: { site_id: 'is not attached to this project' },
      measurements: { 1: { parameter: 'appears more than once in this request' } },
      samples: { 0: { volume_ml: 'must be greater than 0' } },
    });
  });
});
