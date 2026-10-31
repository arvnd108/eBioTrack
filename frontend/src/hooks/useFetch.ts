// Owner: B (Frontend)
// Purpose: Hook: data fetching with loading/error state
//
// Loads one GET endpoint and exposes the CONTRACT 8 envelope as `data` and `meta`:
//
//   const projects = useFetch<Project[], PageMeta>('/projects', { status: 'active', page: 1 });
//   if (projects.status === 'loading' && !projects.data) return <LoadingState />;
//   if (projects.error) return <ErrorState error={projects.error} onRetry={projects.reload} />;
//
// - Refetches whenever the path or a query value changes, and on `reload()`.
// - While a new request is in flight the previous `data` stays visible (no flicker in tables);
//   `status` is 'loading' until it arrives.
// - Only the latest request can update the state, and older ones are aborted, so a slow
//   answer to an old filter never overwrites a newer one.
// - Pass `null` as the path to skip fetching (for example until a project is chosen).

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildPath, request, type Query } from '../services/apiClient';

export type FetchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface FetchState<T, M> {
  data: T | undefined;
  meta: M | undefined;
  /** The error from the latest request, or null. */
  error: unknown;
  status: FetchStatus;
  /** Runs the same request again (Retry buttons). */
  reload: () => void;
}

export function useFetch<T, M = undefined>(path: string | null, query?: Query): FetchState<T, M> {
  // Compare requests by their final URL, so a new but equal query object does not refetch.
  const key = path === null ? null : buildPath(path, query);

  const [data, setData] = useState<T | undefined>(undefined);
  const [meta, setMeta] = useState<M | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<FetchStatus>(key === null ? 'idle' : 'loading');
  const [reloadCount, setReloadCount] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (key === null) {
      latest.current += 1; // drop any answer still on its way
      setData(undefined);
      setMeta(undefined);
      setError(null);
      setStatus('idle');
      return undefined;
    }
    const id = ++latest.current;
    const controller = new AbortController();
    setStatus('loading');
    setError(null);

    request<T, M>(key, { signal: controller.signal })
      .then((res) => {
        if (id !== latest.current) return;
        setData(res.data);
        setMeta(res.meta);
        setStatus('success');
      })
      .catch((err: unknown) => {
        if (id !== latest.current) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err);
        setStatus('error');
      });

    return () => controller.abort();
  }, [key, reloadCount]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);

  return { data, meta, error, status, reload };
}
