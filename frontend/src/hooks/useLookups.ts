// Owner: B (Frontend)
// Purpose: Hooks for the small lists that pages use to show names instead of ids
//
// Each reads one list once (up to 100 rows, the API's page maximum) and offers a lookup:
//   const projects = useProjectIndex();  projects.byId.get(1)?.title
//   const names = useUserNames();       names(3) -> "Farah Field" (administrator) or "User 3"
// GET /api/users is administrator-only (CONTRACT 10), so other roles see "User <id>", and
// "You" for themselves.

import { useCallback, useMemo } from 'react';
import type { PageMeta, Project, Region, SampleType, Site, User } from '../types';
import { useAuth } from './useAuth';
import { useFetch } from './useFetch';

function indexBy<T, K>(rows: T[] | undefined, key: (row: T) => K): Map<K, T> {
  return new Map((rows ?? []).map((row) => [key(row), row]));
}

/** Projects the user can see (administrators: all), by title. */
export function useProjectIndex() {
  const res = useFetch<Project[], PageMeta>('/projects', { limit: 100, sort: 'title' });
  const byId = useMemo(() => indexBy(res.data, (p) => p.project_id), [res.data]);
  return { ...res, list: res.data ?? [], byId };
}

/** Sites by name; `projectId` narrows to one project's sites; `enabled` false sends nothing. */
export function useSiteIndex(projectId?: number | null, enabled = true) {
  const res = useFetch<Site[], PageMeta>(enabled ? '/sites' : null, {
    limit: 100,
    sort: 'name',
    project_id: projectId ?? undefined,
  });
  const byId = useMemo(() => indexBy(res.data, (s) => s.site_id), [res.data]);
  return { ...res, list: res.data ?? [], byId };
}

export function useRegions() {
  const res = useFetch<Region[]>('/regions');
  const byId = useMemo(() => indexBy(res.data, (r) => r.region_id), [res.data]);
  return { ...res, list: res.data ?? [], byId };
}

export function useSampleTypes() {
  const res = useFetch<SampleType[]>('/sample-types');
  const byId = useMemo(() => indexBy(res.data, (t) => t.sample_type_id), [res.data]);
  return { ...res, list: res.data ?? [], byId };
}

/** A function from user id to a display name (see the header comment). */
export function useUserNames(): (id: number | null) => string {
  const { user, can } = useAuth();
  const isAdmin = can('manage_users');
  const users = useFetch<User[], PageMeta>(isAdmin ? '/users' : null, {
    limit: 100,
    sort: 'full_name',
  });
  const names = useMemo(
    () => new Map((users.data ?? []).map((u) => [u.user_id, u.full_name])),
    [users.data],
  );
  const me = user?.user_id;
  return useCallback(
    (id: number | null) => {
      if (id === null) return 'System';
      const name = names.get(id);
      if (name) return name;
      return id === me ? 'You' : `User ${id}`;
    },
    [names, me],
  );
}
