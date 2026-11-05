// Owner: B (Frontend)
// Purpose: API calls for sites
//
// CONTRACT 10, Sites and regions (backend T21). Reads are open to every signed-in user; creating
// and editing need `manage_sites` (administrator, principal investigator, field researcher).

import type { PageMeta, Region, RegionType, Site } from '../types';
import { api } from './apiClient';

export type SiteFields = Omit<Site, 'site_id'>;

/** Up to 100 sites by name (CONTRACT 8 maximum page size), for pickers. */
export async function listSites(): Promise<{ sites: Site[]; total: number }> {
  const res = await api.get<Site[], PageMeta>('/sites', { limit: 100, sort: 'name' });
  return { sites: res.data, total: res.meta?.total ?? res.data.length };
}

/** Any signed-in user may add a region (name and type), so a site can be placed anywhere. */
export async function createRegion(body: {
  name: string;
  region_type: RegionType;
}): Promise<Region> {
  return (await api.post<Region>('/regions', body)).data;
}

export async function createSite(body: SiteFields): Promise<Site> {
  return (await api.post<Site>('/sites', body)).data;
}

/** Sends only the fields that changed. */
export async function updateSite(siteId: number, changes: Partial<SiteFields>): Promise<Site> {
  return (await api.patch<Site>(`/sites/${siteId}`, changes)).data;
}
