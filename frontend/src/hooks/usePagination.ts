// Owner: B (Frontend)
// Purpose: Hook: pagination state
//
// Keeps page, limit and sort for a list endpoint and turns them into the CONTRACT 8 query
// parameters (`?page=1&limit=25&sort=-collected_at`). Pair it with useFetch and DataTable:
//
//   const pager = usePagination({ initialSort: '-collected_at' });
//   const samples = useFetch<Sample[], PageMeta>('/samples', { ...filters, ...pager.query });
//   <DataTable ... sort={pager.sort} onSortChange={pager.setSort}
//              pagination={samples.meta && { meta: samples.meta, onPageChange: pager.setPage }} />
//
// When the filters change, call `pager.resetPage()` so the user starts again on page 1.

import { useCallback, useMemo, useState } from 'react';
import type { PageMeta } from '../types';

/** CONTRACT 8: default 25, maximum 100. */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export interface PaginationOptions {
  initialPage?: number;
  initialLimit?: number;
  /** `field` for ascending, `-field` for descending; null for the API's default order. */
  initialSort?: string | null;
}

export interface PaginationQuery {
  page: number;
  limit: number;
  sort?: string;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Derived numbers for showing a page of `meta`: total pages, item range, previous/next. */
export function pageInfo(meta: PageMeta) {
  const totalPages = Math.max(1, Math.ceil(meta.total / Math.max(1, meta.limit)));
  const page = Math.min(Math.max(1, meta.page), totalPages);
  const firstItem = meta.total === 0 ? 0 : (page - 1) * meta.limit + 1;
  const lastItem = Math.min(meta.total, page * meta.limit);
  return {
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    firstItem,
    lastItem,
  };
}

export function usePagination({
  initialPage = 1,
  initialLimit = DEFAULT_LIMIT,
  initialSort = null,
}: PaginationOptions = {}) {
  const [page, setPageState] = useState(Math.max(1, Math.floor(initialPage)));
  const [limit, setLimitState] = useState(clampLimit(initialLimit));
  const [sort, setSortState] = useState<string | null>(initialSort);

  const setPage = useCallback((next: number) => {
    setPageState(Number.isFinite(next) ? Math.max(1, Math.floor(next)) : 1);
  }, []);

  /** A new page size starts again on page 1. */
  const setLimit = useCallback((next: number) => {
    setLimitState(clampLimit(next));
    setPageState(1);
  }, []);

  /** A new sort order starts again on page 1. */
  const setSort = useCallback((next: string | null) => {
    setSortState(next);
    setPageState(1);
  }, []);

  const resetPage = useCallback(() => setPageState(1), []);

  const query = useMemo<PaginationQuery>(
    () => (sort ? { page, limit, sort } : { page, limit }),
    [page, limit, sort],
  );

  return { page, limit, sort, query, setPage, setLimit, setSort, resetPage };
}
