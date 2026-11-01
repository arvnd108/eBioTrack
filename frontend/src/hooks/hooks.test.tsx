// @vitest-environment jsdom
// Owner: B (Frontend)
// Purpose: useFetch and usePagination against the { data, meta } envelope

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMockMode } from '../services/apiClient';
import { resetMock, signInAs } from '../test/renderApp';
import type { PageMeta, Project } from '../types';
import { useFetch } from './useFetch';
import { DEFAULT_LIMIT, MAX_LIMIT, pageInfo, usePagination } from './usePagination';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setMockMode(true);
});

describe('usePagination', () => {
  it('builds the CONTRACT 8 query and resets to page 1 on a new sort or size', () => {
    const { result } = renderHook(() => usePagination({ initialSort: '-collected_at' }));
    expect(result.current.query).toEqual({ page: 1, limit: DEFAULT_LIMIT, sort: '-collected_at' });

    act(() => result.current.setPage(3));
    expect(result.current.query.page).toBe(3);
    act(() => result.current.setSort('sample_code'));
    expect(result.current.query).toEqual({ page: 1, limit: 25, sort: 'sample_code' });

    act(() => result.current.setPage(2));
    act(() => result.current.setLimit(500));
    expect(result.current.query).toEqual({ page: 1, limit: MAX_LIMIT, sort: 'sample_code' });

    act(() => result.current.setSort(null));
    expect(result.current.query).toEqual({ page: 1, limit: MAX_LIMIT });
    act(() => result.current.setPage(-4));
    expect(result.current.page).toBe(1);
  });

  it('pageInfo describes a page of the meta envelope', () => {
    expect(pageInfo({ page: 2, limit: 25, total: 130 })).toEqual({
      totalPages: 6,
      hasPrevious: true,
      hasNext: true,
      firstItem: 26,
      lastItem: 50,
    });
    expect(pageInfo({ page: 1, limit: 25, total: 0 })).toMatchObject({
      totalPages: 1,
      firstItem: 0,
      lastItem: 0,
      hasNext: false,
    });
  });
});

describe('useFetch', () => {
  beforeEach(resetMock);

  it('loads data and meta from a list endpoint', async () => {
    await signInAs('lab_technician');
    const { result } = renderHook(() => useFetch<Project[], PageMeta>('/projects', { page: 1 }));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data?.map((p) => p.project_id)).toEqual([1]);
    expect(result.current.meta).toEqual({ page: 1, limit: 25, total: 1 });
    expect(result.current.error).toBeNull();
  });

  it('reports errors and loads again on reload', async () => {
    const { result } = renderHook(() => useFetch<Project[]>('/projects'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatchObject({ status: 401, code: 'unauthenticated' });

    await signInAs('viewer');
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toHaveLength(1);
  });

  it('stays idle for a null path and clears old data', async () => {
    await signInAs('viewer');
    const { result, rerender } = renderHook(({ path }) => useFetch<Project[]>(path), {
      initialProps: { path: '/projects' as string | null },
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    rerender({ path: null });
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('ignores a slow answer to an older request', async () => {
    setMockMode(false);
    const answers: Record<string, (body: unknown) => void> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise<Response>((resolve) => {
            answers[url] = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }));
          }),
      ),
    );
    const { result, rerender } = renderHook(
      ({ status }) => useFetch<string[]>('/projects', { status }),
      {
        initialProps: { status: 'planned' },
      },
    );
    rerender({ status: 'active' });

    await act(async () => answers['/api/projects?status=active']({ data: ['new'] }));
    await act(async () => answers['/api/projects?status=planned']({ data: ['old'] }));
    expect(result.current.data).toEqual(['new']);
    expect(result.current.status).toBe('success');
  });

  it('does not refetch for an equal query object', async () => {
    await signInAs('viewer');
    const { result, rerender } = renderHook(
      ({ query }) => useFetch<Project[]>('/projects', query),
      {
        initialProps: { query: { status: 'active' } },
      },
    );
    await waitFor(() => expect(result.current.status).toBe('success'));
    rerender({ query: { status: 'active' } });
    expect(result.current.status).toBe('success');
  });
});
