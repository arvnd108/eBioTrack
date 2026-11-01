// Owner: B (Frontend)
// Purpose: API calls for sites
//
// CONTRACT 10, Sites and regions (backend T21). T26 adds the rest.

import type { PageMeta, Site } from '../types';
import { api } from './apiClient';

/** Up to 100 sites by name (CONTRACT 8 maximum page size), for pickers. */
export async function listSites(): Promise<{ sites: Site[]; total: number }> {
  const res = await api.get<Site[], PageMeta>('/sites', { limit: 100, sort: 'name' });
  return { sites: res.data, total: res.meta?.total ?? res.data.length };
}
