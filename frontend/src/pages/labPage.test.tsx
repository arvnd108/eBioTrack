// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Lab processing page and run page, through the real routes (mock mode)

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../services/apiClient';
import { renderApp, resetMock, signInAs } from '../test/renderApp';
import { checkBatchDate, checkMeasurement, latestBatchDate } from './lab/labRules';
import { bookingBlock } from './lab/RunsSection';
import type { DnaExtraction } from '../types';

beforeEach(resetMock);
afterEach(cleanup);

const table = (name: string) => screen.getByRole('table', { name });
const rowsOf = async (name: string) => {
  await waitFor(() => expect(within(table(name)).getAllByRole('row').length).toBeGreaterThan(1));
  return within(table(name)).getAllByRole('row').slice(1);
};
const rowFor = async (name: string, text: string) => {
  let found: HTMLElement | undefined;
  await waitFor(async () => {
    found = (await rowsOf(name)).find((r) => r.textContent?.includes(text));
    expect(found).toBeTruthy();
  });
  return found!;
};
const cells = (row: HTMLElement) =>
  [...(row as HTMLTableRowElement).cells].map((c) => c.textContent);
/** The row whose cell `column` reads exactly `text`. */
const rowWhere = async (name: string, column: number, text: string) => {
  let found: HTMLElement | undefined;
  await waitFor(async () => {
    found = (await rowsOf(name)).find((r) => cells(r)[column] === text);
    expect(found).toBeTruthy();
  });
  return found!;
};
const button = (name: string | RegExp) => screen.queryByRole('button', { name });

/** A stored sample in project 1, ready to extract (the seeded ones are analyzed or failed). */
async function storedSample(): Promise<{ id: number; code: string }> {
  await signInAs('field_researcher');
  const event = await api.post<{ samples: { sample_id: number; sample_code: string }[] }>(
    '/events',
    {
      project_id: 1,
      site_id: 1,
      collected_at: '2026-10-30T08:00:00Z',
      samples: [{ sample_type_id: 1 }],
    },
  );
  const { sample_id: id, sample_code: code } = event.data.samples[0];
  await api.patch(`/samples/${id}/status`, { new_status: 'stored' });
  await api.post('/auth/logout');
  return { id, code };
}

/** A pending extraction of a fresh stored sample (as the lab technician). */
async function pendingExtraction() {
  const sample = await storedSample();
  await signInAs('lab_technician');
  const made = await api.post<{ extraction_id: number }>('/extractions', {
    sample_id: sample.id,
    batch_id: 2,
  });
  return { ...sample, extractionId: made.data.extraction_id };
}

describe('Lab processing: who sees what', () => {
  it('gives a lab technician the write controls in their project', async () => {
    await signInAs('lab_technician');
    renderApp('/lab');
    await screen.findByRole('heading', { name: 'Lab processing' });
    const rows = await rowsOf('DNA extractions');
    expect(rows).toHaveLength(13); // project 1 only
    expect(button('Record extraction')).toBeTruthy();
    expect(button('New batch')).toBeTruthy();
    expect(within(rows[0]).getByRole('button', { name: /^Edit the measurements/ })).toBeTruthy();
    // Every seeded verdict is decided, so no Pass / Fail buttons.
    expect(button(/as passed QC/)).toBeNull();
  });

  it('shows administrators every extraction, with names for the operator', async () => {
    await signInAs('administrator');
    renderApp('/lab');
    expect(await rowsOf('DNA extractions')).toHaveLength(17);
    const batch = await rowFor('Extraction batches', '#1');
    expect(batch.textContent).toContain('Lakshmi Lab');
  });

  it.each(['analyst', 'viewer', 'field_researcher'])(
    'keeps %s read-only on every tab',
    async (role) => {
      await signInAs(role);
      renderApp('/lab');
      await rowsOf('DNA extractions');
      expect(button('Record extraction')).toBeNull();
      expect(button('New batch')).toBeNull();
      expect(button(/^Edit the measurements/)).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: 'QC results' }));
      await rowsOf('QC results');
      expect(button('Record QC result')).toBeNull();
      await user.click(screen.getByRole('tab', { name: 'Sequencing runs' }));
      await rowsOf('Sequencing runs');
      expect(button('New run')).toBeNull();
    },
  );

  it('hides the row controls from a lab technician who is only a viewer of the project', async () => {
    await signInAs('principal_investigator');
    await api.delete('/projects/1/members/4');
    await api.post('/projects/1/members', { user_id: 4, project_role: 'viewer' });
    await api.post('/auth/logout');
    await signInAs('lab_technician');
    renderApp('/lab');
    await rowsOf('DNA extractions');
    expect(button(/^Edit the measurements/)).toBeNull();
    expect(button('Record extraction')).toBeNull();
    // A batch belongs to no project, so the lab role alone may create one.
    expect(button('New batch')).toBeTruthy();
  });

  it('names the batch operator for roles that cannot list users', async () => {
    await signInAs('viewer');
    renderApp('/lab');
    const batch = await rowWhere('Extraction batches', 0, '#1');
    expect(batch.textContent).toContain('Lakshmi Lab');
    expect(batch.textContent).not.toContain('User 4');
  });

  it('opens from a sample page on that sample’s extractions', async () => {
    await signInAs('lab_technician');
    const { router } = renderApp('/samples/7');
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'Extractions in Lab processing' }));
    await screen.findByRole('heading', { name: 'Lab processing' });
    expect(router.state.location.search).toBe('?sample_id=7');
    await waitFor(async () =>
      expect((await rowsOf('DNA extractions')).map((r) => cells(r)[0])).toEqual(['#7']),
    );
    expect(button('Show extractions of every sample')).toBeTruthy();
  });

  it('keeps the tab and its filters in the URL, and a new tab drops them', async () => {
    await signInAs('lab_technician');
    const { router } = renderApp('/lab?qc_status=fail');
    expect((await rowsOf('DNA extractions')).map((r) => cells(r)[0])).toEqual(['#17']);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'QC results' }));
    await rowsOf('QC results');
    expect(router.state.location.search).toBe('?tab=qc');
  });
});

describe('Extractions tab', () => {
  it('records an extraction for a stored sample, which becomes extracted', async () => {
    const sample = await storedSample();
    await signInAs('lab_technician');
    renderApp('/lab');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Record extraction' }));
    const form = screen.getByRole('form', { name: 'Record extraction' });

    await user.type(within(form).getByLabelText('Purity (A260/280)'), '1000');
    await user.click(within(form).getByRole('button', { name: 'Record extraction' }));
    expect(within(form).getByText('Choose the sample.')).toBeTruthy();
    expect(within(form).getByText('Choose the batch.')).toBeTruthy();
    expect(within(form).getByText('Must be at most 999.99.')).toBeTruthy();

    // Her only writable project is preselected; failed samples are not offered.
    const sampleSelect = within(form).getByLabelText(/^Sample/);
    await waitFor(() =>
      expect(
        within(sampleSelect).getByRole('option', { name: `${sample.code} (Stored)` }),
      ).toBeTruthy(),
    );
    expect(within(sampleSelect).queryByRole('option', { name: /EB-20250515-0001-003/ })).toBeNull();
    await user.selectOptions(sampleSelect, String(sample.id));
    await user.selectOptions(within(form).getByLabelText(/^Batch/), '2');
    await user.clear(within(form).getByLabelText('Purity (A260/280)'));
    await user.type(within(form).getByLabelText('Purity (A260/280)'), '1.876');
    await user.type(within(form).getByLabelText('Concentration (ng/µL)'), '12.3456');
    await user.click(within(form).getByRole('button', { name: 'Record extraction' }));

    expect(
      await screen.findByText(`Recorded extraction #1000 for ${sample.code} (attempt 1).`),
    ).toBeTruthy();
    const row = await rowFor('DNA extractions', sample.code);
    expect(row.textContent).toContain('12.346');
    expect(row.textContent).toContain('1.88');
    expect(row.textContent).toContain('Pending');
    const detail = await api.get<{ status: string }>(`/samples/${sample.id}`);
    expect(detail.data.status).toBe('extracted');
  });

  it('records a final QC verdict after a second click', async () => {
    const { code, extractionId } = await pendingExtraction();
    renderApp('/lab');
    const row = await rowFor('DNA extractions', code);
    const user = userEvent.setup();
    await user.click(
      within(row).getByRole('button', { name: `Mark extraction ${extractionId} as passed QC` }),
    );
    await user.click(within(row).getByRole('button', { name: 'Confirm pass' }));
    expect(
      await screen.findByText(
        `Extraction #${extractionId} (${code}) passed QC and can now be sequenced.`,
      ),
    ).toBeTruthy();
    await waitFor(async () =>
      expect((await rowFor('DNA extractions', code)).textContent).toContain('Pass'),
    );
    expect(button(`Mark extraction ${extractionId} as passed QC`)).toBeNull();
  });

  it('explains a verdict someone else recorded first (409) and shows it', async () => {
    const { code, extractionId } = await pendingExtraction();
    renderApp('/lab');
    const row = await rowFor('DNA extractions', code);
    await api.patch(`/extractions/${extractionId}`, { qc_status: 'pass' }); // someone else
    const user = userEvent.setup();
    await user.click(
      within(row).getByRole('button', { name: `Mark extraction ${extractionId} as failed QC` }),
    );
    await user.click(within(row).getByRole('button', { name: 'Confirm fail' }));
    expect(
      await screen.findByText(`Extraction ${extractionId} cannot move from QC status pass to fail`),
    ).toBeTruthy();
    await waitFor(async () =>
      expect((await rowFor('DNA extractions', code)).textContent).toContain('Pass'),
    );
  });

  it('edits measurements, sending only what changed', async () => {
    await signInAs('lab_technician');
    renderApp('/lab');
    const user = userEvent.setup();
    await rowsOf('DNA extractions');
    await user.click(screen.getByRole('button', { name: 'Edit the measurements of extraction 7' }));
    const form = screen.getByRole('form', { name: 'Edit measurements of extraction 7' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('Nothing has changed.')).toBeTruthy();
    await user.clear(within(form).getByLabelText('Concentration (ng/µL)'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved the measurements of extraction #7.')).toBeTruthy();
    const listed = await api.get<{ concentration_ng_ul: number | null; purity_a260_280: number }[]>(
      '/extractions',
      { sample_id: 7 },
    );
    expect(listed.data[0]).toMatchObject({ concentration_ng_ul: null, purity_a260_280: 1.92 });
  });

  it('creates a batch, checking its date', async () => {
    await signInAs('lab_technician');
    renderApp('/lab');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New batch' }));
    const form = screen.getByRole('form', { name: 'New extraction batch' });
    fireEvent.change(within(form).getByLabelText(/Extraction date/), {
      target: { value: '1999-12-31' },
    });
    await user.click(within(form).getByRole('button', { name: 'Create batch' }));
    expect(within(form).getByText('Choose the lab.')).toBeTruthy();
    expect(
      within(form).getByText('The date must be between 1 Jan 2000 and tomorrow.'),
    ).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText(/^Lab/), '2');
    fireEvent.change(within(form).getByLabelText(/Extraction date/), {
      target: { value: '2026-10-31' },
    });
    await user.type(within(form).getByLabelText('Kit'), 'DNeasy PowerSoil');
    await user.click(within(form).getByRole('button', { name: 'Create batch' }));
    expect(await screen.findByText('Created batch #1000.')).toBeTruthy();
    const row = await rowFor('Extraction batches', '#1000');
    expect(row.textContent).toContain('Kolkata Estuarine Genomics Laboratory');
    expect(row.textContent).toContain('You');
  });

  it('filters the extractions of one batch from the batch table', async () => {
    await signInAs('administrator');
    const { router } = renderApp('/lab');
    await rowsOf('Extraction batches');
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Show the extractions of batch 3' }));
    await waitFor(async () => expect(await rowsOf('DNA extractions')).toHaveLength(4));
    expect(router.state.location.search).toBe('?batch_id=3');
  });
});

describe('QC results tab', () => {
  it('lists results newest first with sample codes and names, and filters by result', async () => {
    await signInAs('viewer');
    renderApp('/lab?tab=qc');
    const rows = await rowsOf('QC results');
    expect(rows).toHaveLength(18);
    expect(rows[0].textContent).toContain('EB-20260315-0006-002');
    expect(rows[0].textContent).toContain('Lakshmi Lab'); // a viewer cannot list users
    await userEvent.setup().selectOptions(screen.getByLabelText('Result'), 'fail');
    await waitFor(async () => expect(await rowsOf('QC results')).toHaveLength(2));
  });

  it('records a result for a sample or for an analysis', async () => {
    await signInAs('lab_technician');
    renderApp('/lab?tab=qc');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Record QC result' }));
    const form = screen.getByRole('form', { name: 'Record QC result' });
    await user.type(within(form).getByLabelText('Metric'), 'high');
    await user.click(within(form).getByRole('button', { name: 'Record result' }));
    for (const text of [
      'Choose the sample.',
      'Choose the QC type.',
      'Choose the result.',
      'Enter a number.',
    ]) {
      expect(within(form).getByText(text)).toBeTruthy();
    }
    const sample = within(form).getByLabelText(/^Sample/);
    await waitFor(() => expect(within(sample).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(sample, '7');
    await user.selectOptions(within(form).getByLabelText(/QC type/), 'extraction_blank');
    await user.selectOptions(within(form).getByLabelText(/^Result/), 'warn');
    await user.clear(within(form).getByLabelText('Metric'));
    await user.type(within(form).getByLabelText('Metric'), '0.4');
    await user.click(within(form).getByRole('button', { name: 'Record result' }));
    expect(
      await screen.findByText('Recorded extraction blank (warn) for EB-20260310-0004-001.'),
    ).toBeTruthy();
    expect((await rowsOf('QC results'))[0].textContent).toContain('You');

    await user.click(screen.getByRole('button', { name: 'Record QC result' }));
    const again = screen.getByRole('form', { name: 'Record QC result' });
    await user.click(within(again).getByRole('radio', { name: /An analysis/ }));
    const analysis = within(again).getByLabelText(/^Analysis/);
    await waitFor(() => expect(within(analysis).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(analysis, '1');
    await user.selectOptions(within(again).getByLabelText(/QC type/), 'read_quality');
    await user.selectOptions(within(again).getByLabelText(/^Result/), 'pass');
    await user.click(within(again).getByRole('button', { name: 'Record result' }));
    expect(await screen.findByText('Recorded read quality (pass) for analysis 1.')).toBeTruthy();
  });
});

describe('Sequencing runs', () => {
  it('creates a run from chosen extractions, skipping booked ones, and opens it', async () => {
    await signInAs('lab_technician');
    await api.post('/sequencing-runs', {
      lab_id: 1,
      platform: 'MiSeq',
      run_date: '2026-11-01',
      extraction_ids: [1],
    }); // RUN-1000 holds extraction 1
    const { router } = renderApp('/lab?tab=runs');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New run' }));
    const form = screen.getByRole('form', { name: 'New sequencing run' });
    const booked = await rowWhere('Extractions that passed QC', 1, '#1');
    expect(booked.textContent).toContain('On RUN-1000');
    expect((within(booked).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);

    await user.click(within(form).getByRole('button', { name: 'Create run' }));
    for (const text of [
      'Choose the lab.',
      'Enter the sequencing platform.',
      'Choose at least one extraction.',
    ]) {
      expect(within(form).getByText(text)).toBeTruthy();
    }
    await user.selectOptions(within(form).getByLabelText(/^Lab/), '1');
    await user.type(within(form).getByLabelText(/Platform/), 'Illumina NovaSeq 6000');
    await user.click(within(form).getByRole('checkbox', { name: /extraction 3 / }));
    await user.click(within(form).getByRole('checkbox', { name: /extraction 2 / }));
    await user.click(within(form).getByRole('button', { name: 'Create run' }));

    await screen.findByRole('heading', { name: 'RUN-1001' });
    expect(router.state.location.pathname).toBe('/lab/runs/1001');
    const libraries = await rowsOf('Libraries');
    expect(libraries.map((r) => cells(r)[0])).toEqual(['LIB-1001', 'LIB-1002']);
    expect(libraries[0].textContent).toContain('EB-20250515-0001-002');
  });

  it('adds a library to a planned run and moves it to running and completed', async () => {
    await signInAs('lab_technician');
    await api.post('/sequencing-runs', {
      lab_id: 1,
      platform: 'MiSeq',
      run_date: '2026-11-01',
      extraction_ids: [1],
    });
    renderApp('/lab/runs/1000');
    await screen.findByRole('heading', { name: 'RUN-1000' });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Add library' });
    await user.click(within(form).getByRole('button', { name: 'Add library' }));
    expect(within(form).getByText('Choose an extraction.')).toBeTruthy();
    const select = within(form).getByLabelText(/Extraction/);
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    expect(within(select).queryByRole('option', { name: /^#1:/ })).toBeNull(); // already on this run
    await user.selectOptions(select, '5');
    await user.click(within(form).getByRole('button', { name: 'Add library' }));
    expect(await screen.findByText('Added library LIB-1001.')).toBeTruthy();
    await waitFor(async () => expect(await rowsOf('Libraries')).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add library' })).toBeNull());
    expect(button('Start run')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mark completed' }));
    expect(await screen.findByText('This run is completed; its status is final.')).toBeTruthy();
  });

  it('asks before marking a run failed', async () => {
    await signInAs('principal_investigator');
    await api.post('/sequencing-runs', {
      lab_id: 2,
      platform: 'MiSeq',
      run_date: '2026-11-01',
      extraction_ids: [13],
    });
    renderApp('/lab/runs/1000');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mark failed' }));
    await user.click(screen.getByRole('button', { name: 'Confirm: mark failed' }));
    expect(await screen.findByText('This run is failed; its status is final.')).toBeTruthy();
  });

  it('shows a lab technician only their project’s libraries, and others no controls', async () => {
    await signInAs('lab_technician');
    renderApp('/lab/runs/2');
    expect(await rowsOf('Libraries')).toHaveLength(4);
    expect(screen.getByText('Only libraries from your own projects are listed.')).toBeTruthy();
    expect(screen.getByText('This run is completed; its status is final.')).toBeTruthy();
    cleanup();
    await api.post('/auth/logout');
    await signInAs('analyst');
    renderApp('/lab/runs/2');
    await rowsOf('Libraries');
    expect(screen.queryByRole('heading', { name: 'Status' })).toBeNull();
  });

  it('treats a run of another project like a missing one', async () => {
    await signInAs('principal_investigator');
    await api.post('/sequencing-runs', {
      lab_id: 2,
      platform: 'MiSeq',
      run_date: '2026-11-01',
      extraction_ids: [13],
    });
    await api.post('/auth/logout');
    await signInAs('lab_technician'); // project 1 only
    renderApp('/lab/runs/1000');
    expect(await screen.findByText('Could not open this run')).toBeTruthy();
  });
});

describe('lab rules', () => {
  it('limits batch dates like the API', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(latestBatchDate(now)).toBe('2026-11-02');
    expect(checkBatchDate('', now)).toBe('Enter the extraction date.');
    expect(checkBatchDate('2026-02-30', now)).toBe('Enter a real date.');
    expect(checkBatchDate('2026-11-02', now)).toBeUndefined();
    expect(checkBatchDate('2026-11-03', now)).toBe(
      'The date must be between 1 Jan 2000 and tomorrow.',
    );
    expect(checkBatchDate('1999-12-31', now)).toBe(
      'The date must be between 1 Jan 2000 and tomorrow.',
    );
  });

  it('reads optional measurements', () => {
    expect(checkMeasurement('', 10)).toEqual({ value: null });
    expect(checkMeasurement('abc', 10)).toEqual({ value: null, error: 'Enter a number.' });
    expect(checkMeasurement('-1', 10).error).toBe('Must be 0 or more.');
    expect(checkMeasurement('11', 10).error).toBe('Must be at most 10.');
    expect(checkMeasurement(' 2.5 ', 10)).toEqual({ value: 2.5 });
  });

  it('says why an extraction cannot be booked', () => {
    const x = { project_id: 1, active_run_code: null } as DnaExtraction;
    expect(bookingBlock(x, () => true)).toBeNull();
    expect(bookingBlock({ ...x, active_run_code: 'RUN-1000' }, () => true)).toBe('On RUN-1000');
    expect(bookingBlock(x, () => false)).toBe('Not your project to change');
  });
});
