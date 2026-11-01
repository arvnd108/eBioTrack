// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: Sign-in, protected routes and role-aware navigation, through the real routes (mock mode)

import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMockMode } from './services/apiClient';
import { DEV_PASSWORD } from './services/mock/fixtures';
import { resetMockState } from './services/mock/mockApi';
import { renderApp, resetMock, signInAs } from './test/renderApp';

beforeEach(resetMock);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setMockMode(true);
});

const sidebarLinks = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((link) => link.textContent);

async function fillAndSubmit(email: string, password: string) {
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText(/Email/), email);
  if (password) await user.type(screen.getByLabelText(/Password/), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

describe('protected routes', () => {
  it('send a signed-out user to /login, then back to the page they wanted', async () => {
    const { router } = renderApp('/samples?status=stored');
    await screen.findByRole('heading', { name: 'eBioTrack' });
    expect(router.state.location.pathname).toBe('/login');

    await fillAndSubmit('lab_technician@ebiotrack.test', DEV_PASSWORD);

    await screen.findByRole('heading', { name: 'Samples' });
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/samples?status=stored',
    );
  });

  it('show the page straight away when a session already exists', async () => {
    await signInAs('viewer');
    const { router } = renderApp('/species');
    await screen.findByRole('heading', { name: 'Species explorer' });
    expect(router.state.location.pathname).toBe('/species');
  });

  it('start fresh at the dashboard after an explicit sign-out', async () => {
    await signInAs('viewer');
    const { router } = renderApp('/samples');
    await screen.findByRole('heading', { name: 'Samples' });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });
    expect(router.state.location.state).toBeNull();

    await fillAndSubmit('viewer@ebiotrack.test', DEV_PASSWORD);
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(router.state.location.pathname).toBe('/');
  });

  it('send the user to login with a notice when the session expires, then back', async () => {
    await signInAs('analyst');
    const { router } = renderApp('/lab');
    await screen.findByRole('heading', { name: 'Lab processing' });

    // The server forgets the session; the next request gets 401 unauthenticated.
    resetMockState();
    const { api } = await import('./services/apiClient');
    await act(async () => {
      await api.get('/projects').catch(() => undefined);
    });

    await screen.findByText('Your session has ended. Please sign in again.');
    expect(router.state.location.pathname).toBe('/login');

    await fillAndSubmit('analyst@ebiotrack.test', DEV_PASSWORD);
    await screen.findByRole('heading', { name: 'Lab processing' });
  });

  it('show an error with Retry when the session check cannot reach the server', async () => {
    setMockMode(false);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    renderApp('/projects');
    await screen.findByText('Could not check your session');
    expect(
      screen.getByText('Could not reach the server. Check your connection and try again.'),
    ).toBeTruthy();

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            user_id: 6,
            full_name: 'Vikram Viewer',
            email: 'viewer@ebiotrack.test',
            roles: ['viewer'],
            active: true,
          },
        }),
        { status: 200 },
      ),
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'Projects' });
  });
});

describe('role-aware navigation (CONTRACT 9)', () => {
  const ALL_PAGES = [
    'Dashboard',
    'Projects',
    'Sampling map',
    'Collection events',
    'Samples',
    'Lab processing',
    'Analysis import',
    'Species explorer',
    'Biodiversity analytics',
    'ML insights',
    'Administration',
  ];
  const without = (...hidden: string[]) => ALL_PAGES.filter((page) => !hidden.includes(page));

  it.each([
    ['administrator', ALL_PAGES],
    ['principal_investigator', ALL_PAGES],
    ['analyst', without('Administration')],
    ['field_researcher', without('Analysis import', 'Administration')],
    ['lab_technician', without('Analysis import', 'Administration')],
    ['viewer', without('Analysis import', 'Administration')],
  ])('%s sees the pages their role can use', async (role, expected) => {
    await signInAs(role);
    renderApp('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(sidebarLinks()).toEqual(expected);
  });

  it.each([
    ['viewer', '/admin'],
    ['lab_technician', '/analyses/import'],
  ])('%s opening %s by URL gets "Not permitted"', async (role, path) => {
    await signInAs(role);
    renderApp(path);
    await screen.findByRole('heading', { name: 'Not permitted' });
  });

  it('shows the signed-in user and their role in the navbar', async () => {
    await signInAs('principal_investigator');
    renderApp('/');
    const banner = await screen.findByRole('banner');
    await within(banner).findByText('Pranav Investigator');
    expect(within(banner).getByText('principal investigator')).toBeTruthy();
  });
});

describe('login page', () => {
  it('checks the fields before sending anything', async () => {
    renderApp('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    const user = await fillAndSubmit('', '');

    expect(screen.getByText('Enter your email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(screen.getByLabelText(/Email/).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText(/Email/));

    await user.type(screen.getByLabelText(/Email/), 'not-an-email');
    expect(screen.getByText('Enter a valid email address, like name@example.org.')).toBeTruthy();
    await user.clear(screen.getByLabelText(/Email/));
    await user.type(screen.getByLabelText(/Email/), 'viewer@ebiotrack.test');
    expect(screen.queryByText(/valid email address/)).toBeNull();
  });

  it('says "Invalid email or password" for a wrong password and clears it', async () => {
    renderApp('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    await fillAndSubmit('viewer@ebiotrack.test', 'wrong-password');

    expect((await screen.findByRole('alert')).textContent).toBe('Invalid email or password.');
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe(
      'viewer@ebiotrack.test',
    );
  });

  it('tells the user how long to wait after too many failed attempts', async () => {
    renderApp('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    const user = userEvent.setup();
    for (let i = 0; i < 6; i += 1) {
      await user.clear(screen.getByLabelText(/Email/));
      await user.type(screen.getByLabelText(/Email/), 'field_researcher@ebiotrack.test');
      await user.type(screen.getByLabelText(/Password/), 'wrong');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('alert');
    }
    expect(screen.getByRole('alert').textContent).toBe(
      'Too many failed sign-in attempts. Try again in about 15 minutes.',
    );
  });

  it('fills a seeded user from the mock-mode list', async () => {
    const { router } = renderApp('/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'analyst@ebiotrack.test' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(router.state.location.pathname).toBe('/');
  });

  it('never redirects outside the app after signing in', async () => {
    const { router } = renderApp('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    await act(() => router.navigate('/login', { state: { from: '//evil.example/steal' } }));
    await fillAndSubmit('viewer@ebiotrack.test', DEV_PASSWORD);
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(router.state.location.pathname).toBe('/');
  });

  it('sends a user who is already signed in on to the app', async () => {
    await signInAs('viewer');
    const { router } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(router.state.location.pathname).toBe('/');
  });

  it('hides the seeded-user list outside mock mode', async () => {
    setMockMode(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'unauthenticated', message: 'Authentication required' },
          }),
          { status: 401 },
        ),
      ),
    );
    renderApp('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByText(/Mock mode/)).toBeNull();
  });
});
