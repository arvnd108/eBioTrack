// Owner: B (Frontend)
// Purpose: One colour per habitat type for the map markers and their legend

import type { HabitatType } from '../../types';

export const HABITAT_COLORS: Record<HabitatType, string> = {
  river: '#0284c7',
  lake: '#2563eb',
  estuary: '#0d9488',
  marine: '#1e3a8a',
  wetland: '#65a30d',
  groundwater: '#7c3aed',
  soil: '#a16207',
  other: '#64748b',
};
