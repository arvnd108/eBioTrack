// Owner: B (Frontend)
// Purpose: page controls for a paginated list (CONTRACT 8 meta: page, limit, total)

import { useEffect } from 'react';
import type { PageMeta } from '../../types';
import { pageInfo } from '../../hooks/usePagination';

interface PaginationProps {
  /** `meta` from a list response. */
  meta: PageMeta;
  onPageChange: (page: number) => void;
  /** Disables the buttons, for example while the next page loads. */
  disabled?: boolean;
}

export function Pagination({ meta, onPageChange, disabled = false }: PaginationProps) {
  const { totalPages, hasPrevious, hasNext, firstItem, lastItem } = pageInfo(meta);

  // A page past the end (rows were removed, or a filter shrank the list): go to the last page.
  useEffect(() => {
    if (meta.total > 0 && meta.page > totalPages) onPageChange(totalPages);
  }, [meta.page, meta.total, totalPages, onPageChange]);

  if (meta.total === 0) return null;

  const button =
    'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 ' +
    'hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 pt-3">
      <p className="text-sm text-slate-600">
        Showing <span className="font-medium">{firstItem}</span>–
        <span className="font-medium">{lastItem}</span> of{' '}
        <span className="font-medium">{meta.total}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={button}
          onClick={() => onPageChange(meta.page - 1)}
          disabled={disabled || !hasPrevious}
        >
          Previous
        </button>
        <span className="text-sm text-slate-600" aria-current="page">
          Page {Math.min(meta.page, totalPages)} of {totalPages}
        </span>
        <button
          type="button"
          className={button}
          onClick={() => onPageChange(meta.page + 1)}
          disabled={disabled || !hasNext}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
