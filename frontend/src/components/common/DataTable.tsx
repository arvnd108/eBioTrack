// Owner: B (Frontend)
// Purpose: sortable, paginated table
//
// One table for every list page, with the loading, empty and error states built in:
//
//   <DataTable
//     caption="Samples"
//     columns={[
//       { key: 'sample_code', header: 'Code', sortField: 'sample_code' },
//       { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
//     ]}
//     rows={samples.data}
//     rowKey={(s) => s.sample_id}
//     loading={samples.status === 'loading'}
//     error={samples.error}
//     onRetry={samples.reload}
//     sort={pager.sort}
//     onSortChange={pager.setSort}
//     pagination={samples.meta && { meta: samples.meta, onPageChange: pager.setPage }}
//   />
//
// Sorting is done by the API (CONTRACT 8 `?sort=field` / `?sort=-field`): clicking a sortable
// header cycles ascending -> descending -> the API's default order and reports it through
// `onSortChange`. Columns without `sortField` are not sortable.

import type { ReactNode } from 'react';
import type { PageMeta } from '../../types';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';
import { Pagination } from './Pagination';

export interface Column<T> {
  /** Unique column id; also the row property shown when there is no `render`. */
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  /** API field name for `?sort=`; leave out for a column that cannot be sorted. */
  sortField?: string;
  align?: 'left' | 'right' | 'center';
}

interface DataTableProps<T> {
  /** Accessible name of the table, for example "Samples". */
  caption: string;
  /** Show the caption above the table instead of only to screen readers. */
  showCaption?: boolean;
  columns: Column<T>[];
  rows: T[] | null | undefined;
  rowKey: (row: T) => string | number;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  /** Current sort (`field` or `-field`), null for the API's default order. */
  sort?: string | null;
  onSortChange?: (sort: string | null) => void;
  pagination?: { meta: PageMeta; onPageChange: (page: number) => void } | null;
}

const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

function cellValue<T>(row: T, column: Column<T>): ReactNode {
  if (column.render) return column.render(row);
  const value = (row as Record<string, unknown>)[column.key];
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/** Next sort after a click on `field`: ascending, then descending, then default order. */
export function nextSort(current: string | null | undefined, field: string): string | null {
  if (current === field) return `-${field}`;
  if (current === `-${field}`) return null;
  return field;
}

export function DataTable<T>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'No records found',
  emptyDescription,
  emptyAction,
  sort = null,
  onSortChange,
  pagination,
}: DataTableProps<T>) {
  const hasRows = !!rows && rows.length > 0;

  // Nothing to show yet: a full-size state instead of an empty table.
  if (!hasRows) {
    if (error)
      return (
        <ErrorState
          error={error}
          title={`Could not load ${caption.toLowerCase()}`}
          onRetry={onRetry}
        />
      );
    if (loading) return <LoadingState label={`Loading ${caption.toLowerCase()}…`} />;
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <div>
      {/* Rows are already on screen: report a failed refresh above them and keep them. */}
      {error ? (
        <div className="mb-3">
          <ErrorState
            error={error}
            title={`Could not refresh ${caption.toLowerCase()}`}
            onRetry={onRetry}
          />
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table
          className="min-w-full divide-y divide-slate-200 text-sm"
          aria-busy={loading || undefined}
        >
          <caption
            className={showCaption ? 'px-4 py-2 text-left font-medium text-slate-700' : 'sr-only'}
          >
            {caption}
          </caption>
          <thead className="bg-slate-50">
            <tr>
              {columns.map((column) => {
                const align = alignClass[column.align ?? 'left'];
                const sortable = !!column.sortField && !!onSortChange;
                const direction =
                  sort === column.sortField
                    ? 'ascending'
                    : sort === `-${column.sortField}`
                      ? 'descending'
                      : undefined;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sortable ? (direction ?? 'none') : undefined}
                    className={`px-4 py-2 font-medium text-slate-600 ${align}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(nextSort(sort, column.sortField!))}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        {column.header}
                        <span aria-hidden="true" className="text-xs text-slate-400">
                          {direction === 'ascending' ? '▲' : direction === 'descending' ? '▼' : '↕'}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className={`divide-y divide-slate-100 ${loading ? 'opacity-60' : ''}`}>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="hover:bg-slate-50">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 py-2 text-slate-800 ${alignClass[column.align ?? 'left']}`}
                  >
                    {cellValue(row, column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <LoadingState label={`Updating ${caption.toLowerCase()}…`} variant="inline" />}
      {pagination && (
        <Pagination
          meta={pagination.meta}
          onPageChange={pagination.onPageChange}
          disabled={loading}
        />
      )}
    </div>
  );
}
