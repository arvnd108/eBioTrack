// Owner: B (Frontend)
// Purpose: Fetch wrapper: base URL, errors, credentials
//
// Every service file calls the API through `api.get/post/patch/delete` below. It:
//   - prefixes paths with /api (the frontend never talks to the database directly),
//   - sends the session cookie (`credentials: 'include'`, cookie `ebiotrack.sid`),
//   - sends JSON bodies, or FormData as multipart (CSV import),
//   - returns the `{ data, meta }` envelope on success (CONTRACT section 8),
//   - throws an `ApiError` carrying the server's `{ error: { code, message, details } }`.
//
// Mock mode: with VITE_USE_MOCK=true (the default until the backend routes exist), requests are
// answered by src/services/mock/mockApi.ts instead of the network. Mock answers go through the
// same parsing as real responses, so pages behave the same in both modes.

import type { ApiErrorBody, ApiErrorCode, ApiErrorDetail, ApiResponse } from '../types';
import { handleMockRequest } from './mock/mockApi';

export const API_BASE = '/api';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  method?: HttpMethod;
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

/** Error thrown for any failed request. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetail[];
  /** Seconds from the `Retry-After` header (for example on 429 too_many_attempts), else null. */
  readonly retryAfter: number | null;

  constructor(status: number, error: ApiErrorBody['error'], retryAfter: number | null = null) {
    super(error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.details = error.details ?? [];
    this.retryAfter = retryAfter;
  }

  /** Message for one form field, from `details` (validation errors). */
  fieldMessage(field: string): string | undefined {
    return this.details.find((d) => d.field === field)?.message;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

let onUnauthenticated: (() => void) | null = null;

/**
 * Registers what to do when a request comes back 401 `unauthenticated` (the session expired or
 * the user was deactivated). AuthContext uses it to sign the user out and show the login page.
 * Returns a function that removes the handler.
 */
export function setUnauthenticatedHandler(handler: (() => void) | null): () => void {
  onUnauthenticated = handler;
  return () => {
    if (onUnauthenticated === handler) onUnauthenticated = null;
  };
}

// ---------------------------------------------------------------------------
// Mock mode switch
// ---------------------------------------------------------------------------

let mockMode = import.meta.env?.VITE_USE_MOCK !== 'false';

/** True when requests go to the in-browser mock API instead of the backend. */
export function isMockMode(): boolean {
  return mockMode;
}

/** Turn mock mode on or off at runtime (used by tests). */
export function setMockMode(on: boolean): void {
  mockMode = on;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Appends query parameters, skipping null, undefined, and empty strings. */
export function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  );
}

/** Parses a `Retry-After` header given in seconds; null when absent or not a number. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/**
 * Turns an HTTP status and parsed JSON body into the success envelope, or throws `ApiError`.
 * Shared by real and mock responses.
 */
export function toResult<T, M>(
  status: number,
  body: unknown,
  statusText = '',
  retryAfter: number | null = null,
): ApiResponse<T, M> {
  if (status === 204) {
    return { data: undefined as T };
  }
  if (status < 200 || status >= 300) {
    if (isErrorBody(body)) throw new ApiError(status, body.error, retryAfter);
    throw new ApiError(
      status,
      {
        code: `http_${status}`,
        message: statusText || `Request failed with status ${status}`,
      },
      retryAfter,
    );
  }
  if (!isRecord(body) || !('data' in body)) {
    throw new ApiError(status, {
      code: 'invalid_response',
      message: 'The server sent a response in an unexpected format.',
    });
  }
  return body as unknown as ApiResponse<T, M>;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export async function request<T, M = undefined>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T, M>> {
  try {
    return await send<T, M>(path, options);
  } catch (err) {
    // An expired session on any request (except the startup /auth/me check, where 401 simply
    // means "not signed in yet") signs the user out everywhere.
    if (isApiError(err) && err.code === 'unauthenticated' && path !== '/auth/me') {
      onUnauthenticated?.();
    }
    throw err;
  }
}

async function send<T, M>(path: string, options: RequestOptions): Promise<ApiResponse<T, M>> {
  const method = options.method ?? 'GET';
  const url = buildPath(path, options.query);

  if (mockMode) {
    const mock = await handleMockRequest(method, url, options.body);
    return toResult<T, M>(
      mock.status,
      mock.body,
      '',
      parseRetryAfter(mock.headers?.['Retry-After']),
    );
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    // File uploads (CSV import): the browser sets the multipart Content-Type and boundary.
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${url}`, {
      method,
      headers,
      body,
      credentials: 'include',
      signal: options.signal,
    });
  } catch (err) {
    // Let callers ignore requests they cancelled themselves.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, {
      code: 'network_error',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  }

  return toResult<T, M>(
    res.status,
    await readJson(res),
    res.statusText,
    parseRetryAfter(res.headers.get('Retry-After')),
  );
}

/** Shorthand used by the service files. */
export const api = {
  get: <T, M = undefined>(path: string, query?: Query, signal?: AbortSignal) =>
    request<T, M>(path, { query, signal }),
  post: <T, M = undefined>(path: string, body?: unknown) =>
    request<T, M>(path, { method: 'POST', body }),
  patch: <T, M = undefined>(path: string, body?: unknown) =>
    request<T, M>(path, { method: 'PATCH', body }),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
};
