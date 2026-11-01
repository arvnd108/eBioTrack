// Owner: B (Frontend)
// Purpose: API calls for taxa
//
// Taxa are shared reference data that every signed-in role reads (GET /api/taxa, /api/taxa/:id
// with its lineage). Their detections (GET /api/taxa/:id/detections) are approved, QC-passed
// detections in the caller's projects only. Pages read these with useFetch; this file holds the
// query shapes so the pages and tests agree on them.

import type { TaxonRank } from '../types';

export interface TaxaQuery {
  /** Names that start with it, or have a word that starts with it (case-insensitive). */
  q?: string;
  rank?: TaxonRank;
  parent_taxon_id?: number;
}

export interface DetectionsQuery {
  project_id?: number;
  site_id?: number;
  /** Inclusive; a date means the whole UTC day. */
  from?: string;
  to?: string;
  /** Newest first by default; `collected_at` for oldest first. */
  sort?: 'collected_at' | '-collected_at';
}

/** At most 200 characters, never blank (the API's rule for `q`). */
export const TAXON_QUERY_MAX = 200;
