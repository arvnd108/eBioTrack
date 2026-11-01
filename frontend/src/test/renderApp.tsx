// Owner: B (Frontend)
// Purpose: Test helper: mount the real routes and auth in memory, in mock mode

import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import { api, setMockMode } from '../services/apiClient';
import { DEV_PASSWORD } from '../services/mock/fixtures';
import { resetMockState, setMockDelay } from '../services/mock/mockApi';
import { routes } from '../routes';

/** Fresh mock state with no delay; call in beforeEach. */
export function resetMock(): void {
  setMockMode(true);
  setMockDelay(0);
  resetMockState();
}

/** Starts a mock session for a seeded user, as if they had signed in earlier. */
export async function signInAs(role: string): Promise<void> {
  await api.post('/auth/login', { email: `${role}@ebiotrack.test`, password: DEV_PASSWORD });
}

/** Renders the whole app at `path` and returns the memory router (for its location). */
export function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { router, ...view };
}
