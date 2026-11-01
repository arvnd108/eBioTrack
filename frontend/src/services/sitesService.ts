// Owner: B (Frontend)
// Purpose: API calls for sites
//
// CONTRACT 10, Sites and regions. GET /api/sites arrives with T21; until then the real API answers
// 404 and the Projects page lets the user type a site ID instead. T26 adds the rest.

import type { PageMeta, Site } from '../types';
import { api } from './apiClient';

/** Up to 100 sites (CONTRACT 8 maximum page size), for pickers. */
export async function listSites(): Promise<{ sites: Site[]; total: number }> {
  const res = await api.get<Site[], PageMeta>('/sites', { limit: 100 });
  return { sites: res.data, total: res.meta?.total ?? res.data.length };
}
