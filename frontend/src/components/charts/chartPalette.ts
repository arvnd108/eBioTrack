// Owner: B (Frontend)
// Purpose: Chart colours and shared Recharts styling
//
// Categorical slots in a fixed order (validated for colour-vision deficiency on a white surface:
// worst adjacent ΔE 9.1; three slots are below 3:1 contrast, so every chart ships with a table
// of its numbers). Colour follows the entity, never its rank: a site keeps its slot whatever
// the filter shows. More than eight series do not get generated colours; the chart falls back
// to its table.

export const SERIES_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
] as const;

export const MAX_SERIES = SERIES_COLORS.length;

/** Recessive axes and grid, text in the page's ink colours. */
export const AXIS_TICK = { fill: '#475569', fontSize: 12 } as const;
export const GRID_STROKE = '#e2e8f0';
