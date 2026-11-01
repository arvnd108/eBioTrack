// Owner: B (Frontend)
// Purpose: Hook: list filters kept in the URL (?status=stored&site_id=2)
//
// Filters live in the query string so a link can open a list already filtered (the map's
// "Samples at this site", an event's "All samples") and the browser's Back button restores them.
//
//   const [filters, setFilters] = useQueryFilters(['status', 'site_id'] as const);
//   setFilters({ status: 'stored', site_id: '' });   // '' removes a filter
//
// Change several filters in ONE call: two calls in the same click would each start from the old
// URL, and the second would undo the first.

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useQueryFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  // A stable key for the current values, so `filters` only changes when a value does.
  const signature = JSON.stringify(keys.map((k) => [k, params.get(k) ?? '']));
  const filters = useMemo(
    () => Object.fromEntries(JSON.parse(signature) as [K, string][]) as Record<K, string>,
    [signature],
  );

  const setFilters = useCallback(
    (changes: Partial<Record<K, string>>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes) as [K, string | undefined][]) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return [filters, setFilters] as const;
}

/** A filter id from the URL, or undefined when it is not a positive integer (?site_id=abc). */
export const idParam = (value: string) => (/^[1-9]\d{0,14}$/.test(value) ? value : undefined);
