// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Analysis import, Species explorer and Biodiversity analytics, through the real routes
// (mock mode, which follows the real API scenario by scenario)

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../services/apiClient';
import { renderApp, resetMock, signInAs } from '../test/renderApp';
import type { AnalysisRun } from '../types';
import { checkLocally } from './analyses/ImportStep';
import { formatBytes, parseParameters, templateCsv } from './analyses/analysisRules';
import { detectionRate } from '../components/charts/DetectionFrequencyChart';
import { effortNote } from './BiodiversityAnalyticsPage';
import { scopeQuery } from './analytics/ScopeFilters';

const HEADER = 'library_code,scientific_name,taxon_rank,read_count,confidence,qc_flag';
// tests/fixtures/detections_valid.csv (CONTRACT 12); the invalid fixture differs only in row 8,
// whose library belongs to run 2. Copied here because tests cannot read outside frontend/.
const VALID_ROWS = [
  'LIB-0001,Labeo rohita,species,14250,0.9712,pass',
  'LIB-0001,Labeo calbasu,species,1450,0.9731,pass',
  'LIB-0002,Labeo rohita,species,12980,0.9654,pass',
  'LIB-0003,Labeo rohita,species,9840,0.9588,pass',
  'LIB-0003,Cirrhinus mrigala,species,5210,0.9120,pass',
  'LIB-0004,Cirrhinus mrigala,species,4390,0.8940,pass',
  'LIB-0005,Cyprinus carpio,species,3060,0.9015,pass',
  'LIB-0005,Labeo,genus,720,0.7410,warn',
  'LIB-0006,Gambusia affinis,species,0,0.0000,fail',
  'LIB-0007,Labeo rohita,species,20310,1.0000,pass',
  'LIB-0007,Cirrhinus mrigala,species,88,0.5120,warn',
  'LIB-0007,Cyprinus carpio,species,1975,0.8830,pass',
  'LIB-0008,Labeo calbasu,species,2210,0.9390,pass',
  'LIB-0008,Cirrhinus mrigala,species,35,0.4010,fail',
];
const VALID = [HEADER, ...VALID_ROWS, ''].join('\n');
const INVALID = [
  HEADER,
  ...VALID_ROWS.map((row, i) => (i === 6 ? row.replace('LIB-0005', 'LIB-0009') : row)),
  '',
].join('\n');
const csv = (text: string, name = 'detections.csv') => new File([text], name, { type: 'text/csv' });

const saved: { name: string; text: string }[] = [];
beforeEach(() => {
  resetMock();
  saved.length = 0;
  // jsdom has no object URLs; record what the page hands to the browser instead.
  let blob: Blob | null = null;
  URL.createObjectURL = vi.fn((b: Blob) => {
    blob = b;
    return 'blob:test';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const name = this.download;
    void blob?.text().then((text) => saved.push({ name, text }));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const table = (name: string) => screen.getByRole('table', { name });
const rowsOf = async (name: string) => {
  await waitFor(() => expect(within(table(name)).getAllByRole('row').length).toBeGreaterThan(1));
  return within(table(name)).getAllByRole('row').slice(1);
};
const cells = (row: HTMLElement) =>
  [...(row as HTMLTableRowElement).cells].map((c) => c.textContent);
const panel = () => screen.getByRole('heading', { name: /^Analysis #\d+/ }).closest('section')!;
/** The status badge next to the panel's heading. */
const panelStatus = () =>
  screen.getByRole('heading', { name: /^Analysis #\d+/ }).nextElementSibling?.textContent;

/** A draft analysis of run 1 created by `role` through the API. */
async function draft(role = 'analyst', body: Record<string, unknown> = {}) {
  await signInAs(role);
  const res = await api.post<AnalysisRun>('/analyses', {
    run_id: 1,
    marker_id: 2,
    pipeline_name: 'QIIME 2',
    pipeline_version: '2024.5',
    reference_db: 'BOLD Systems',
    ...body,
  });
  return res.data.analysis_id;
}
async function importFile(id: number, text: string) {
  const form = new FormData();
  form.append('analysis_id', String(id));
  form.append('file', csv(text));
  await api.post('/analyses/import', form);
}

describe('Analysis import: who sees what', () => {
  it.each(['viewer', 'field_researcher', 'lab_technician'])('is not open to a %s', async (role) => {
    await signInAs(role);
    renderApp('/analyses/import');
    expect(await screen.findByRole('heading', { name: 'Not permitted' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Analysis import' })).toBeNull();
  });

  it('lists every analysis with the names of the run, marker and people', async () => {
    await signInAs('analyst');
    renderApp('/analyses/import');
    const rows = await rowsOf('Analyses');
    expect(rows.map((r) => cells(r)[0])).toEqual(['#4', '#3', '#2', '#1']);
    expect(cells(rows[1])).toEqual([
      '#3',
      'ImportedNeeds approval',
      'RUN-002',
      'COI',
      'OBITools3 3.1.0BOLD Systems 2026-01',
      'You',
      '—',
      expect.stringMatching(/2026/),
    ]);
    expect(cells(rows[3])[6]).toBe('Pranav Investigator');
    expect(screen.getByRole('button', { name: 'New analysis' })).toBeTruthy();
  });

  it('filters by status and keeps the filter in the URL', async () => {
    await signInAs('principal_investigator');
    const { router } = renderApp('/analyses/import?status=approved');
    const rows = await rowsOf('Analyses');
    expect(rows.map((r) => cells(r)[0])).toEqual(['#2', '#1']);
    await userEvent.setup().selectOptions(screen.getByLabelText('Status'), 'draft');
    await waitFor(() => expect(router.state.location.search).toBe('?status=draft'));
    await waitFor(async () =>
      expect((await rowsOf('Analyses')).map((r) => cells(r)[0])).toEqual(['#4']),
    );
  });

  it('gives an analyst the import step but no approve or reject', async () => {
    await signInAs('analyst');
    renderApp('/analyses/import?analysis_id=4');
    await screen.findByRole('heading', { name: 'Import detections' });
    expect(screen.queryByRole('form', { name: 'Reject analysis' })).toBeNull();
    // Imported: waiting for a principal investigator, nothing to press.
    await signInAs('analyst');
    cleanup();
    renderApp('/analyses/import?analysis_id=3');
    expect(
      await screen.findByText(/Waiting for approval by a principal investigator/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve analysis' })).toBeNull();
  });

  it('hides the write steps from an analyst who is only a viewer of the run’s project', async () => {
    await signInAs('administrator');
    await api.delete('/projects/1/members/5');
    await api.post('/projects/1/members', { user_id: 5, project_role: 'viewer' });
    await signInAs('analyst');
    renderApp('/analyses/import?analysis_id=4');
    expect(await screen.findByText(/This draft waits for its detections CSV/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Import detections' })).toBeNull();
    cleanup();
    renderApp('/analyses/import?analysis_id=2');
    await screen.findByText(/Approved results are never edited/);
    expect(screen.queryByRole('button', { name: 'Start a correction' })).toBeNull();
    // The new-analysis form says so as soon as the run is chosen, and will not submit.
    await userEvent.setup().click(screen.getByRole('button', { name: 'New analysis' }));
    const form = screen.getByRole('form', { name: 'New analysis' });
    await waitFor(() =>
      expect(
        within(form)
          .getByLabelText(/^Sequencing run/)
          .querySelectorAll('option').length,
      ).toBe(3),
    );
    await userEvent.setup().selectOptions(within(form).getByLabelText(/^Sequencing run/), '1');
    expect(await within(form).findByText(/You cannot add analyses to RUN-001/)).toBeTruthy();
    expect(
      (within(form).getByRole('button', { name: 'Create analysis' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('Creating an analysis', () => {
  it('checks the form before sending and opens the new draft', async () => {
    await signInAs('analyst');
    renderApp('/analyses/import');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New analysis' }));
    const form = screen.getByRole('form', { name: 'New analysis' });
    await user.click(within(form).getByRole('button', { name: 'Create analysis' }));
    for (const message of [
      'Choose the sequencing run.',
      'Choose the marker.',
      'Enter the pipeline name.',
      'Enter the pipeline version.',
      'Enter the reference database.',
    ]) {
      expect(within(form).getByText(message)).toBeTruthy();
    }
    await waitFor(() =>
      expect(
        within(form)
          .getByLabelText(/^Sequencing run/)
          .querySelectorAll('option').length,
      ).toBe(3),
    );
    await user.selectOptions(within(form).getByLabelText(/^Sequencing run/), '1');
    expect(within(form).queryByText('Choose the sequencing run.')).toBeNull();
    expect(await within(form).findByText(/RUN-001 has 8 libraries you can see/)).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText(/^Marker/), '2');
    await user.type(within(form).getByRole('combobox', { name: /^Pipeline/ }), 'QIIME 2');
    await user.type(within(form).getByLabelText(/^Pipeline version/), '2024.5');
    await user.type(
      within(form).getByRole('combobox', { name: /^Reference database/ }),
      'MitoFish',
    );
    await user.type(within(form).getByLabelText(/^Parameters/), '[[1]');
    await user.click(within(form).getByRole('button', { name: 'Create analysis' }));
    expect(within(form).getByText(/Enter a JSON object in curly braces/)).toBeTruthy();
    await user.clear(within(form).getByLabelText(/^Parameters/));
    await user.type(within(form).getByLabelText(/^Parameters/), '{{"min_length": 100}');
    await user.click(within(form).getByRole('button', { name: 'Create analysis' }));

    expect(await screen.findByRole('heading', { name: 'Analysis #1000' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New analysis' })).toBeNull();
    expect(panelStatus()).toBe('Draft');
    expect(within(panel()).getByText('QIIME 2 2024.5')).toBeTruthy();
    expect(within(panel()).getByText('Not imported yet')).toBeTruthy();
    const created = (await api.get<AnalysisRun>('/analyses/1000')).data;
    expect(created).toMatchObject({
      run_id: 1,
      marker_id: 2,
      reference_db: 'MitoFish',
      reference_db_version: null,
      parameters: { min_length: 100 },
      supersedes_analysis_id: null,
    });
    await waitFor(async () => expect(cells((await rowsOf('Analyses'))[0])[0]).toBe('#1000'));
  });

  it('starts a correction from an approved analysis with its settings copied', async () => {
    await signInAs('analyst');
    renderApp('/analyses/import?analysis_id=2');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start a correction' }));
    const form = screen.getByRole('form', { name: 'New correction' });
    expect(within(form).getByRole('heading', { name: 'Correct analysis #2' })).toBeTruthy();
    expect((within(form).getByLabelText(/^Pipeline version/) as HTMLInputElement).value).toBe(
      '3.0.1',
    );
    await waitFor(() =>
      expect((within(form).getByLabelText(/^Corrects analysis/) as HTMLSelectElement).value).toBe(
        '2',
      ),
    );
    await user.clear(within(form).getByLabelText(/^Reference database version/));
    await user.type(within(form).getByLabelText(/^Reference database version/), '2026-06');
    await user.click(within(form).getByRole('button', { name: 'Create correction' }));
    expect(await screen.findByRole('heading', { name: 'Analysis #1000' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '#2' })).toBeTruthy();

    // #2 now names its correction instead of offering another one.
    await user.click(within(panel()).getByRole('button', { name: '#2' }));
    expect(await screen.findByText(/Correction/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '#1000' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start a correction' })).toBeNull();
  });

  it('explains a second correction of the same analysis', async () => {
    await draft('analyst', { run_id: 2, marker_id: 1, supersedes_analysis_id: 1 });
    renderApp('/analyses/import');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New analysis' }));
    const form = screen.getByRole('form', { name: 'New analysis' });
    await waitFor(() =>
      expect(
        within(form)
          .getByLabelText(/^Corrects analysis/)
          .querySelectorAll('option').length,
      ).toBe(3),
    );
    await user.selectOptions(within(form).getByLabelText(/^Sequencing run/), '1');
    await user.selectOptions(within(form).getByLabelText(/^Marker/), '1');
    await user.type(within(form).getByRole('combobox', { name: /^Pipeline/ }), 'x');
    await user.type(within(form).getByLabelText(/^Pipeline version/), '1');
    await user.type(within(form).getByRole('combobox', { name: /^Reference database/ }), 'y');
    await user.selectOptions(within(form).getByLabelText(/^Corrects analysis/), '1');
    await user.click(within(form).getByRole('button', { name: 'Create analysis' }));
    expect(await within(form).findByText(/already has a correction/)).toBeTruthy();
  });
});

describe('Importing detections', () => {
  it('previews row errors, then imports a clean file', async () => {
    const id = await draft();
    renderApp(`/analyses/import?analysis_id=${id}`);
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Detections CSV');
    const importButton = () =>
      within(panel()).getByRole('button', { name: /^Import/ }) as HTMLButtonElement;
    expect(importButton().disabled).toBe(true);

    await user.upload(input, csv(INVALID, 'bad.csv'));
    expect(await screen.findByText(/The format looks right/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check file' }));
    const errors = await rowsOf('Problems found by the dry run');
    expect(errors.map(cells)).toEqual([
      [
        '8',
        'library_code',
        `library LIB-0009 belongs to another sequencing run (analysis ${id} uses run 1)`,
      ],
    ]);
    expect(screen.getByText(/1 problem to fix \(13 valid rows\)/)).toBeTruthy();
    expect(importButton().disabled).toBe(true);

    await user.upload(input, csv(VALID, 'good.csv'));
    // A new file needs its own check before it can be imported.
    expect(screen.queryByRole('table', { name: 'Problems found by the dry run' })).toBeNull();
    expect(importButton().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Check file' }));
    expect(await screen.findByText(/All 14 rows are valid/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Import 14 detections' }));

    expect(await screen.findByText(/Imported 14 detections/)).toBeTruthy();
    await waitFor(() => expect(panelStatus()).toBe('Imported'));
    expect(within(panel()).getByText('10 pass')).toBeTruthy();
    expect(within(panel()).getByText('You')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Import detections' })).toBeNull();
  });

  it('ignores a dry run that answers after another file was chosen', async () => {
    const id = await draft();
    const realPost = api.post.bind(api);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(api, 'post').mockImplementationOnce(async (...args: Parameters<typeof api.post>) => {
      await held; // the first dry run answers only after the second file was chosen
      return realPost(...args);
    });
    renderApp(`/analyses/import?analysis_id=${id}`);
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Detections CSV');
    await user.upload(input, csv(VALID, 'first.csv'));
    await user.click(await screen.findByRole('button', { name: 'Check file' }));
    await user.upload(input, csv(VALID, 'second.csv'));
    release();
    await waitFor(() => expect(screen.queryByText(/Checking/)).toBeNull());
    expect(screen.queryByText(/All 14 rows are valid/)).toBeNull();
    expect(
      (within(panel()).getByRole('button', { name: /^Import/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Check file' }));
    expect(await screen.findByText(/All 14 rows are valid/)).toBeTruthy();
  });

  it('shows problems found before uploading and blocks a file the API would refuse', async () => {
    const id = await draft();
    renderApp(`/analyses/import?analysis_id=${id}`);
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Detections CSV');
    await user.upload(input, csv('library_code,scientific_name\nLIB-0001,Labeo rohita\n'));
    const local = await rowsOf('Problems found before uploading');
    expect(local.map((r) => cells(r)[1])).toEqual([
      'taxon_rank',
      'read_count',
      'confidence',
      'qc_flag',
    ]);
    // The server check is still offered and gives the authoritative list.
    expect((screen.getByRole('button', { name: 'Check file' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await user.upload(input, csv(''));
    expect(await screen.findByText(/This file cannot be imported: the file is empty/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check file' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('lists only the first 100 problems and says how many there are', async () => {
    const id = await draft();
    renderApp(`/analyses/import?analysis_id=${id}`);
    const user = userEvent.setup();
    const rows = Array.from({ length: 120 }, (_, i) => `LIB-0001,Nope ${i},species,1,0.5,pass`);
    await user.upload(
      await screen.findByLabelText('Detections CSV'),
      csv(`${HEADER}\n${rows.join('\n')}\n`),
    );
    await user.click(screen.getByRole('button', { name: 'Check file' }));
    expect(await rowsOf('Problems found by the dry run')).toHaveLength(100);
    expect(screen.getByText(/120 problems to fix \(0 valid rows\)/)).toBeTruthy();
    expect(
      screen.getByText(
        'Showing the first 100 of 120 problems. Fix these and check again to see the rest.',
      ),
    ).toBeTruthy();
  });

  it('offers a template with the run’s own library codes', async () => {
    const id = await draft();
    renderApp(`/analyses/import?analysis_id=${id}`);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Download a template' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe('detections-template.csv');
    expect(saved[0].text.split('\r\n')[1]).toMatch(/^LIB-0001,/);
    expect(saved[0].text.split('\r\n')[2]).toMatch(/^LIB-0002,/);
  });
});

describe('Approving and rejecting', () => {
  it('lets a principal investigator approve an analyst’s import', async () => {
    await signInAs('principal_investigator');
    renderApp('/analyses/import?analysis_id=3');
    const user = userEvent.setup();
    expect(
      await screen.findByText(/Approving makes the 12 detections with QC flag pass count/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve analysis' }));
    expect(await screen.findByText('Analysis #3 is approved.')).toBeTruthy();
    await waitFor(() => expect(panelStatus()).toBe('Approved'));
    expect(within(panel()).getByText(/^You, /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve analysis' })).toBeNull();
    await waitFor(async () =>
      expect(cells((await rowsOf('Analyses')).find((r) => cells(r)[0] === '#3')!)[6]).toBe('You'),
    );
  });

  it('does not offer the approval to the person who imported it', async () => {
    const id = await draft('principal_investigator');
    await importFile(id, VALID);
    renderApp(`/analyses/import?analysis_id=${id}`);
    expect(
      await screen.findByText(
        /You imported this analysis, so another principal investigator must approve it/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve analysis' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Reject analysis' })).toBeTruthy();
  });

  it('needs a reason to reject, and shows it to the analyst', async () => {
    await signInAs('principal_investigator');
    renderApp('/analyses/import?analysis_id=3');
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Reject analysis' });
    await user.click(within(form).getByRole('button', { name: 'Reject analysis' }));
    expect(within(form).getByText('Say why the analysis is rejected.')).toBeTruthy();
    await user.type(within(form).getByLabelText(/^Reason/), '  Wrong reference database  ');
    expect(within(form).queryByText('Say why the analysis is rejected.')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Reject analysis' }));
    expect(await screen.findByText('Analysis #3 was rejected.')).toBeTruthy();
    await waitFor(() => expect(within(panel()).getByText(/^Rejected by You/)).toBeTruthy());

    cleanup();
    await signInAs('analyst');
    renderApp('/analyses/import?analysis_id=3');
    expect(await screen.findByText(/^Rejected by Pranav Investigator/)).toBeTruthy();
    expect(screen.getByText('Wrong reference database')).toBeTruthy();
    const row = (await rowsOf('Analyses')).find((r) => cells(r)[0] === '#3')!;
    expect(cells(row)[6]).toBe('Pranav Investigator');
  });

  it('lets a principal investigator reject a draft that never got its file', async () => {
    await signInAs('principal_investigator');
    renderApp('/analyses/import?analysis_id=4');
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Reject analysis' });
    expect(screen.getByRole('heading', { name: 'Import detections' })).toBeTruthy();
    await user.type(within(form).getByLabelText(/^Reason/), 'Duplicate of #3');
    await user.click(within(form).getByRole('button', { name: 'Reject analysis' }));
    expect(await screen.findByText('Analysis #4 was rejected.')).toBeTruthy();
  });

  it('shows where an analysis is when someone else decided it first', async () => {
    await signInAs('principal_investigator');
    renderApp('/analyses/import?analysis_id=3');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Approve analysis' });
    await signInAs('administrator');
    await api.post('/analyses/3/approve');
    await signInAs('principal_investigator');
    await user.click(screen.getByRole('button', { name: 'Approve analysis' }));
    expect(
      await screen.findByText(
        'Analysis 3 is already approved. It changed since you opened it; this is where it is now.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(panelStatus()).toBe('Approved'));
  });

  it('marks the corrected analysis superseded when the correction is approved', async () => {
    const id = await draft('analyst', { run_id: 1, marker_id: 1, supersedes_analysis_id: 1 });
    await importFile(id, VALID);
    await signInAs('principal_investigator');
    renderApp(`/analyses/import?analysis_id=${id}`);
    const user = userEvent.setup();
    expect(await screen.findByText(/Analysis #1 becomes superseded at the same time/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve analysis' }));
    await screen.findByText(`Analysis #${id} is approved.`);
    await user.click(within(panel()).getByRole('button', { name: '#1' }));
    expect(
      await screen.findByText(/Its detections no longer count in analytics or exports/),
    ).toBeTruthy();
    expect(panelStatus()).toBe('Superseded');
    expect(within(panel()).getByRole('button', { name: `#${id}` })).toBeTruthy();
  });
});

describe('Species explorer', () => {
  it('shows the caveat before any taxon is chosen', async () => {
    await signInAs('viewer');
    renderApp('/species');
    await screen.findByText(
      'Choose a taxon to see its lineage, where it was detected and how often.',
    );
    expect(screen.getByRole('note').textContent).toContain(
      'Detection does not indicate abundance; non-detection does not indicate absence.',
    );
  });

  it('finds a species by a word of its name and shows lineage, frequency and detections', async () => {
    await signInAs('viewer');
    renderApp('/species');
    const user = userEvent.setup();
    expect(await rowsOf('Taxa')).toHaveLength(15);
    await user.type(screen.getByLabelText('Scientific name'), 'rohita');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(async () => expect(await rowsOf('Taxa')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Labeo rohita' }));

    expect(await screen.findByRole('heading', { name: 'Labeo rohita' })).toBeTruthy();
    const lineage = screen.getByRole('navigation', { name: 'Lineage' });
    expect(lineage.textContent).toBe(
      'Animalia›Chordata›Actinopterygii›Cypriniformes›Cyprinidae›Labeo›Labeo rohita',
    );
    expect(screen.getByText('External ID 84645')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain(
      'Detection does not indicate abundance; non-detection does not indicate absence.',
    );
    // The viewer is in project 1 only: three sites, every analysed sample has it.
    const frequency = await rowsOf('Detection frequency by site');
    expect(frequency.map(cells)).toEqual([
      ['Dakpathar Barrage', '4', '4', '100%'],
      ['Okhla Barrage', '4', '4', '100%'],
      ['Sangam Prayagraj', '4', '4', '100%'],
    ]);
    const detections = await rowsOf('Detections of Labeo rohita');
    expect(detections).toHaveLength(12);
    expect(cells(detections[0]).slice(1, 4)).toEqual([
      'EB-20260315-0006-001',
      'Sangam Prayagraj',
      '#2',
    ]);
    expect(within(detections[0]).getByRole('link').getAttribute('href')).toBe('/samples/11');
  });

  it('orders detections oldest first on request and narrows them by date', async () => {
    await signInAs('viewer');
    const { router } = renderApp('/species?taxon_id=7');
    const user = userEvent.setup();
    await rowsOf('Detections of Labeo rohita');
    await user.click(screen.getByRole('button', { name: /Collected/ }));
    await waitFor(async () =>
      expect(cells((await rowsOf('Detections of Labeo rohita'))[0])[1]).toBe(
        'EB-20250515-0001-001',
      ),
    );
    await user.type(screen.getByLabelText('From'), '2026-01-01');
    await waitFor(async () => expect(await rowsOf('Detections of Labeo rohita')).toHaveLength(6));
    expect(router.state.location.search).toContain('from=2026-01-01');
    await user.type(screen.getByLabelText('To'), '2025-12-31');
    expect(await screen.findByText('The start date is after the end date.')).toBeTruthy();
  });

  it('moves along the lineage and says when nothing was identified only to a genus', async () => {
    await signInAs('analyst');
    renderApp('/species?taxon_id=8');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Labeo calbasu' });
    await user.click(
      within(screen.getByRole('navigation', { name: 'Lineage' })).getByRole('button', {
        name: 'Labeo',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Labeo' })).toBeTruthy();
    expect(await screen.findByText('No approved detections')).toBeTruthy();
    expect(screen.getByText(/Nothing was identified only to this genus/)).toBeTruthy();
    await user.click(
      within(screen.getByRole('group', { name: 'Lower taxa' })).getByRole('button', {
        name: 'Labeo bata',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Labeo bata' })).toBeTruthy();
    expect(
      await screen.findByText(/Non-detection does not mean the species is absent/),
    ).toBeTruthy();
  });

  it('downloads the detections of one project with the caveat beside it', async () => {
    await signInAs('viewer');
    renderApp('/species?taxon_id=11');
    const user = userEvent.setup();
    await rowsOf('Detections of Cirrhinus mrigala');
    const download = () =>
      screen.getByRole('button', { name: 'Download CSV' }) as HTMLButtonElement;
    expect(download().disabled).toBe(true);
    expect(screen.getByText('Choose a project to download.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText('Project').querySelectorAll('option').length).toBe(2),
    );
    await user.selectOptions(screen.getByLabelText('Project'), '1');
    await waitFor(() => expect(download().disabled).toBe(false));
    await user.click(download());
    expect(
      await screen.findByText(
        'Downloaded ebiotrack-detections_csv-1000.csv (5 rows). Detection does not indicate abundance; non-detection does not indicate absence.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(saved).toHaveLength(1));
    const lines = saved[0].text.trim().split('\r\n');
    expect(lines).toHaveLength(6);
    expect(lines.slice(1).every((l) => l.includes(',Cirrhinus mrigala,species,'))).toBe(true);
  });
});

describe('Biodiversity analytics', () => {
  it('shows richness with its sampling effort and the caveat', async () => {
    await signInAs('viewer');
    renderApp('/analytics');
    const rows = await rowsOf('Observed species richness');
    expect(rows.map(cells)).toEqual([
      ['2025', 'Dakpathar Barrage', '2', '3'],
      ['2025', 'Okhla Barrage', '2', '2'],
      ['2025', 'Sangam Prayagraj', '2', '2'],
      ['2026', 'Dakpathar Barrage', '2', '2'],
      ['2026', 'Okhla Barrage', '1', '2'],
      ['2026', 'Sangam Prayagraj', '2', '2'],
    ]);
    const note = screen.getByRole('note').textContent;
    expect(note).toContain('Detection does not indicate abundance');
    expect(note).toContain('Sampling effort differs: 2 to 3 samples per site and year.');
  });

  it('groups by site and counts an approved import at once', async () => {
    const id = await draft();
    await importFile(id, VALID);
    await signInAs('principal_investigator');
    await api.post(`/analyses/${id}/approve`);
    renderApp('/analytics?group_by=site&project_id=1');
    const rows = await rowsOf('Observed species richness');
    // The new import adds Cyprinus carpio at Dakpathar (library 7) and Sangam (library 5).
    expect(rows.map(cells)).toEqual([
      ['Dakpathar Barrage', '3', '5'],
      ['Okhla Barrage', '2', '4'],
      ['Sangam Prayagraj', '3', '4'],
    ]);
  });

  it('shows the detection frequency of a chosen species', async () => {
    await signInAs('analyst');
    const { router } = renderApp('/analytics');
    const user = userEvent.setup();
    expect(
      await screen.findByText('Choose a species to see its detection frequency.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText('Species').querySelectorAll('option').length).toBe(7),
    );
    await user.selectOptions(screen.getByLabelText('Species'), '11');
    expect(router.state.location.search).toContain('taxon_id=11');
    const rows = await rowsOf('Detection frequency of Cirrhinus mrigala by site');
    expect(rows.map(cells)).toEqual([
      ['Dakpathar Barrage', '0', '4', '0%'],
      ['Okhla Barrage', '2', '4', '50%'],
      ['Sangam Prayagraj', '3', '4', '75%'],
    ]);
    expect(
      screen.getByText(/not detected at a site does not mean it is absent there/),
    ).toBeTruthy();
  });

  it('downloads the richness table of one project', async () => {
    await signInAs('viewer');
    renderApp('/analytics?project_id=1&group_by=month');
    const user = userEvent.setup();
    await rowsOf('Observed species richness');
    await user.click(screen.getByRole('button', { name: 'Download richness CSV' }));
    expect(
      await screen.findByText(/^Downloaded ebiotrack-richness_csv-1000.csv \(6 rows\)/),
    ).toBeTruthy();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].text.split('\r\n').slice(0, 2)).toEqual([
      'group,site_id,observed_taxa,sample_count',
      '2025-05,1,2,3',
    ]);
  });

  it('needs a project to download, and clears the site when the project changes', async () => {
    await signInAs('principal_investigator');
    const { router } = renderApp('/analytics?project_id=1&site_id=2');
    const user = userEvent.setup();
    await rowsOf('Observed species richness');
    expect(
      (screen.getByRole('button', { name: 'Download richness CSV' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await waitFor(() =>
      expect(screen.getByLabelText('Project').querySelectorAll('option').length).toBe(3),
    );
    await user.selectOptions(screen.getByLabelText('Project'), '');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(
      (screen.getByRole('button', { name: 'Download richness CSV' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Choose a project to download.')).toBeTruthy();
  });

  it('reports a project the user cannot see', async () => {
    await signInAs('lab_technician');
    renderApp('/analytics?project_id=2');
    expect(await screen.findByText('Could not load richness')).toBeTruthy();
    expect(screen.getByText('Project not found')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('parses the parameters box', () => {
    expect(parseParameters('  ')).toEqual({ value: undefined });
    expect(parseParameters('{"a": 1}')).toEqual({ value: { a: 1 } });
    expect(parseParameters('nope')).toEqual({ error: expect.stringMatching(/valid JSON/) });
    expect(parseParameters('null')).toEqual({ error: expect.stringMatching(/JSON object/) });
    expect(parseParameters('[]')).toEqual({ error: expect.stringMatching(/JSON object/) });
    expect(parseParameters(JSON.stringify({ x: 'y'.repeat(9992) }))).toEqual({
      value: { x: 'y'.repeat(9992) },
    });
    expect(parseParameters(JSON.stringify({ x: 'y'.repeat(9993) }))).toEqual({
      error: 'At most 10 000 characters.',
    });
  });

  it('checks a file locally like the API', async () => {
    expect(await checkLocally(csv(''))).toMatchObject({ fileProblem: 'the file is empty' });
    expect(await checkLocally(new File([new Uint8Array([0x6c, 0xff])], 'x.csv'))).toMatchObject({
      fileProblem: 'the file must be UTF-8 text',
    });
    expect(
      await checkLocally(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.csv')),
    ).toMatchObject({ fileProblem: 'the file is larger than 10 MB' });
    expect(await checkLocally(csv(`${HEADER}\n"LIB-0001,x\n`))).toMatchObject({
      fileProblem: 'row 2: a quoted field is not closed',
    });
    expect(await checkLocally(csv(VALID))).toEqual({
      fileProblem: null,
      localErrors: [],
      dataRows: 14,
    });
    const bad = await checkLocally(
      csv(`${HEADER}\nLIB-0001,X,species,1,2,pass\nLIB-0001,Y,species,1,0.5,pass\n`),
    );
    expect(bad).toEqual({
      fileProblem: null,
      localErrors: [{ row: 2, field: 'confidence', message: 'must be a number between 0 and 1' }],
      dataRows: 2,
    });
  });

  it('formats sizes, builds a template and words the sampling effort', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1023)).toBe('1023 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(templateCsv([]).split('\r\n')[1]).toMatch(/^LIB-0001,/);
    expect(templateCsv(['LIB-0009']).split('\r\n')[2]).toMatch(/^LIB-0009,/);
    const row = (sample_count: number) => ({
      group: 'g',
      site_id: 1,
      observed_taxa: 1,
      sample_count,
    });
    expect(effortNote([], 'year')).toBeNull();
    expect(effortNote([row(2), row(2)], 'site')).toBe(
      'Sampling effort is even: 2 samples per site.',
    );
    expect(effortNote([row(1)], 'month')).toBe(
      'Sampling effort is even: 1 sample per site and month.',
    );
    expect(effortNote([row(1), row(4)], 'year')).toMatch(
      /^Sampling effort differs: 1 to 4 samples per site and year\./,
    );
  });

  it('rounds the detection share and leaves unanalysed sites without one', () => {
    expect(detectionRate({ site_id: 1, detections: 2, samples_total: 3 })).toBe(67);
    expect(detectionRate({ site_id: 1, detections: 1, samples_total: 3 })).toBe(33);
    expect(detectionRate({ site_id: 1, detections: 0, samples_total: 0 })).toBeNull();
  });

  it('turns the date filters into a query', () => {
    expect(
      scopeQuery({ project_id: '1', site_id: 'x', from: '2026-02-30', to: '2026-03-01' }),
    ).toEqual({
      project_id: '1',
      site_id: undefined,
      from: undefined,
      to: '2026-03-01',
      invalid: null,
    });
    expect(
      scopeQuery({ project_id: '', site_id: '', from: '2026-03-02', to: '2026-03-01' }).invalid,
    ).toBe('The start date is after the end date.');
    expect(
      scopeQuery({ project_id: '', site_id: '', from: '2026-03-01', to: '2026-03-01' }).invalid,
    ).toBeNull();
  });
});
