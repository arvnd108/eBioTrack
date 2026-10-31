// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Shared components: loading, empty and error states, sorting, pagination, a11y wiring

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { ApiError } from '../../services/apiClient';
import { EDNA_CAVEAT } from '../../types';
import { resetMock, signInAs } from '../../test/renderApp';
import { Can } from './Can';
import { CaveatBanner } from './CaveatBanner';
import { DataTable, nextSort, type Column } from './DataTable';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { FormField, fieldControlClass } from './FormField';
import { LoadingState } from './LoadingState';

afterEach(cleanup);

interface Row {
  id: number;
  code: string;
  note: string | null;
}
const columns: Column<Row>[] = [
  { key: 'code', header: 'Code', sortField: 'code' },
  { key: 'note', header: 'Note' },
];
const rows: Row[] = [
  { id: 1, code: 'EB-1', note: 'first' },
  { id: 2, code: 'EB-2', note: null },
];
const table = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) =>
  render(
    <DataTable<Row>
      caption="Samples"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      {...props}
    />,
  );

describe('DataTable', () => {
  it('shows a loading state before the first rows arrive', () => {
    table({ rows: undefined, loading: true });
    expect(screen.getByRole('status').textContent).toContain('Loading samples…');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an empty state, with an optional action', () => {
    table({ rows: [], emptyTitle: 'No samples yet', emptyAction: <button>New sample</button> });
    expect(screen.getByText('No samples yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New sample' })).toBeTruthy();
  });

  it('shows an error with Retry when the first load fails', async () => {
    const onRetry = vi.fn();
    table({
      rows: undefined,
      error: new ApiError(500, { code: 'http_500', message: 'x' }),
      onRetry,
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not load samples');
    expect(alert.textContent).toContain('The server ran into a problem');
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the rows visible while refreshing, and on a failed refresh', () => {
    const { rerender } = table({ loading: true });
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');

    rerender(
      <DataTable<Row>
        caption="Samples"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        error={new ApiError(0, { code: 'network_error', message: 'x' })}
      />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('alert').textContent).toContain('Could not refresh samples');
  });

  it('renders cells, a dash for empty values, and a caption for screen readers', () => {
    table();
    expect(screen.getByRole('table', { name: 'Samples' })).toBeTruthy();
    const [, first, second] = screen.getAllByRole('row');
    expect(
      within(first)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['EB-1', 'first']);
    expect(
      within(second)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['EB-2', '—']);
  });

  it('sorts through the API: ascending, descending, then default order', async () => {
    const onSortChange = vi.fn();
    const { rerender } = table({ sort: null, onSortChange });
    const header = screen.getByRole('columnheader', { name: /Code/ });
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(screen.getByRole('columnheader', { name: 'Note' }).getAttribute('aria-sort')).toBeNull();

    await userEvent.setup().click(within(header).getByRole('button'));
    expect(onSortChange).toHaveBeenLastCalledWith('code');

    rerender(
      <DataTable<Row>
        caption="Samples"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort="-code"
        onSortChange={onSortChange}
      />,
    );
    expect(screen.getByRole('columnheader', { name: /Code/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(nextSort(null, 'code')).toBe('code');
    expect(nextSort('code', 'code')).toBe('-code');
    expect(nextSort('-code', 'code')).toBeNull();
    expect(nextSort('-other', 'code')).toBe('code');
  });

  it('pages with the meta envelope and goes back when the page no longer exists', async () => {
    const onPageChange = vi.fn();
    const { rerender } = table({
      pagination: { meta: { page: 2, limit: 2, total: 5 }, onPageChange },
    });
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 3–4 of 5');
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    rerender(
      <DataTable<Row>
        caption="Samples"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        pagination={{ meta: { page: 4, limit: 2, total: 5 }, onPageChange }}
      />,
    );
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });
});

describe('FormField', () => {
  it('connects the label, hint and error to the control', () => {
    const { rerender } = render(
      <FormField label="Email" hint="Your work address" required>
        <input className={fieldControlClass()} />
      </FormField>,
    );
    const input = screen.getByLabelText(/Email/);
    expect(input.hasAttribute('required')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Your work address',
    );

    rerender(
      <FormField label="Email" hint="Your work address" error="Enter your email address." required>
        <input className={fieldControlClass(true)} />
      </FormField>,
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Enter your email address.',
    );
    expect(screen.queryByText('Your work address')).toBeNull();
    expect(fieldControlClass(true)).toContain('border-red-400');
  });
});

describe('LoadingState, EmptyState and ErrorState', () => {
  it('announce themselves', () => {
    render(<LoadingState label="Loading runs…" />);
    expect(screen.getByRole('status').textContent).toBe('Loading runs…');
    cleanup();
    render(<EmptyState title="No runs" description="Create a run to see it here." />);
    expect(screen.getByText('Create a run to see it here.')).toBeTruthy();
  });

  it.each([
    [new ApiError(0, { code: 'network_error', message: '' }), 'Could not reach the server'],
    [new ApiError(403, { code: 'forbidden', message: '' }), 'You do not have permission'],
    [new ApiError(404, { code: 'not_found', message: 'Project not found' }), 'Project not found'],
    [
      new ApiError(409, { code: 'invalid_transition', message: 'Run RUN-001 cannot move' }),
      'Run RUN-001 cannot move',
    ],
    [
      new ApiError(503, { code: 'http_503', message: 'Service Unavailable' }),
      'The server ran into a problem',
    ],
    [
      new ApiError(429, { code: 'too_many_attempts', message: '' }, 90),
      'Try again in about 2 minutes',
    ],
    [new Error('boom'), 'Something went wrong'],
  ])('describes %s in plain words', (error, text) => {
    render(<ErrorState error={error} />);
    expect(screen.getByRole('alert').textContent).toContain(text);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('CaveatBanner', () => {
  it('uses the caveat from the API, with the fixed contract text as fallback', () => {
    render(<CaveatBanner notes={['Sampling effort differs: 2–3 samples per site.']} />);
    const note = screen.getByRole('note', { name: 'How to read these results' });
    expect(note.textContent).toContain(EDNA_CAVEAT);
    expect(note.textContent).toContain('Only approved analyses and detections with QC flag "pass"');
    expect(note.textContent).toContain('Sampling effort differs');
    cleanup();

    render(<CaveatBanner caveat="Server caveat text." approvedOnly={false} />);
    expect(screen.getByRole('note').textContent).toBe('Server caveat text.');
  });
});

describe('Can', () => {
  beforeEach(resetMock);

  it('shows content only to roles allowed to perform the action', async () => {
    await signInAs('lab_technician');
    render(
      <AuthProvider>
        <Can action="record_lab">
          <button>New extraction</button>
        </Can>
        <Can action="record_lab" projectRole="viewer" fallback={<span>Read only</span>}>
          <button>Edit in viewer project</button>
        </Can>
        <Can action={['manage_users', 'decide_analysis']}>
          <button>Approve</button>
        </Can>
      </AuthProvider>,
    );
    expect(await screen.findByRole('button', { name: 'New extraction' })).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit in viewer project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
