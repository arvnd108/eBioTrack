// Owner: B (Frontend)
// Purpose: Unit tests for the API client (real and mock mode)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  buildPath,
  parseRetryAfter,
  setMockMode,
  setUnauthenticatedHandler,
} from './apiClient';
import { resetMockState, setMockDelay } from './mock/mockApi';
import { DEV_PASSWORD } from './mock/fixtures';
import type { PageMeta, Project, User } from '../types';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseRetryAfter', () => {
  it('reads seconds and ignores anything else', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('0.5')).toBe(1);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
  });
});

describe('buildPath', () => {
  it('adds query parameters and skips empty values', () => {
    expect(buildPath('/samples', { site_id: 3, status: 'stored', q: '', from: null })).toBe(
      '/samples?site_id=3&status=stored',
    );
  });

  it('returns the path unchanged without a query', () => {
    expect(buildPath('/projects')).toBe('/projects');
    expect(buildPath('/projects', { status: undefined })).toBe('/projects');
  });
});

describe('real mode', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    setMockMode(false);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('calls /api with the session cookie and returns the envelope', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ site_id: 1 }], meta: { page: 1, limit: 25, total: 1 } }),
    );

    const res = await api.get<unknown[], PageMeta>('/sites', { project_id: 1 });

    expect(res.data).toEqual([{ site_id: 1 }]);
    expect(res.meta?.total).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sites?project_id=1');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('sends JSON bodies', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: { project_id: 9 } }));

    await api.post('/projects', { title: 'New' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"New"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends FormData as multipart without a JSON content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { valid_rows: 1, errors: [] } }));
    const form = new FormData();
    form.append('analysis_id', '4');

    await api.post('/analyses/import?dry_run=true', form);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/analyses/import?dry_run=true');
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns undefined data for 204 No Content', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.post('/auth/logout')).resolves.toEqual({ data: undefined });
  });

  it('throws ApiError with the server error code, message, and details', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: 'validation_error',
          message: 'Latitude must be between -90 and 90',
          details: [{ field: 'latitude', message: 'out of range' }],
        },
      }),
    );

    const err = await api.post('/sites', { latitude: 99 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(422);
    expect(apiErr.code).toBe('validation_error');
    expect(apiErr.message).toBe('Latitude must be between -90 and 90');
    expect(apiErr.fieldMessage('latitude')).toBe('out of range');
  });

  it('throws a generic ApiError when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });

  it('reads Retry-After into the error (429 too_many_attempts)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'too_many_attempts',
            message: 'Too many failed sign-in attempts. Try again later.',
          },
        }),
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    );
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({
      status: 429,
      code: 'too_many_attempts',
      retryAfter: 120,
    });
  });

  it('calls the unauthenticated handler on a 401 except for the startup /auth/me check', async () => {
    const handler = vi.fn();
    const remove = setUnauthenticatedHandler(handler);
    const unauthenticated = () =>
      jsonResponse(401, { error: { code: 'unauthenticated', message: 'Authentication required' } });

    fetchMock.mockResolvedValueOnce(unauthenticated());
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(unauthenticated());
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);

    // A wrong password is a 401 too, but not an expired session.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        error: { code: 'invalid_credentials', message: 'Invalid email or password' },
      }),
    );
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(handler).toHaveBeenCalledTimes(1);

    remove();
  });

  it('throws network_error when the server cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('rejects a success response without a data envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { projects: [] }));
    await expect(api.get('/projects')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('mock mode', () => {
  beforeEach(() => {
    setMockMode(true);
    setMockDelay(0);
    resetMockState();
  });

  it('returns 401 before sign-in', async () => {
    await expect(api.get('/auth/me')).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('signs in a fixture user and keeps the session', async () => {
    const login = await api.post<User>('/auth/login', {
      email: 'principal_investigator@ebiotrack.test',
      password: DEV_PASSWORD,
    });
    expect(login.data).toMatchObject({ user_id: 2, roles: ['principal_investigator'] });

    const me = await api.get<User>('/auth/me');
    expect(me.data.user_id).toBe(2);

    await api.post('/auth/logout');
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects unknown users and empty fields', async () => {
    await expect(
      api.post('/auth/login', { email: 'nobody@ebiotrack.test', password: 'x' }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });

    const err = (await api
      .post('/auth/login', { email: '', password: '' })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('validation_error');
    expect(err.fieldMessage('email')).toBeDefined();
    expect(err.fieldMessage('password')).toBeDefined();
  });

  it('lists only the projects a user belongs to, with pagination meta', async () => {
    await api.post('/auth/login', {
      email: 'lab_technician@ebiotrack.test',
      password: DEV_PASSWORD,
    });

    const res = await api.get<Project[], PageMeta>('/projects');

    expect(res.data.map((p) => p.project_id)).toEqual([1]);
    expect(res.data[0].your_role).toBe('contributor');
    expect(res.meta).toEqual({ page: 1, limit: 25, total: 1 });
    await expect(api.get('/projects/2')).rejects.toMatchObject({ status: 404 });
  });

  it('filters sites by project', async () => {
    await api.post('/auth/login', { email: 'viewer@ebiotrack.test', password: DEV_PASSWORD });
    const res = await api.get<{ site_id: number }[]>('/sites', { project_id: 2 });
    expect(res.data.map((s) => s.site_id)).toEqual([4, 5]);
  });

  it('answers 404 for endpoints that have no mock yet', async () => {
    await api.post('/auth/login', { email: 'viewer@ebiotrack.test', password: DEV_PASSWORD });
    await expect(api.get('/no-such-endpoint')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});
