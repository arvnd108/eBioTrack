// Owner: B (Frontend)
// Purpose: Richness by site/period (Recharts)
//
// Observed species per group (year, month or site) as bars, one colour per site with a legend;
// grouped by site there is one bar per site in one colour. The numbers are also in the table the
// page shows next to it (the chart is `aria-hidden` and its tooltip only repeats them).

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RichnessRow } from '../../types';
import { AXIS_TICK, GRID_STROKE, MAX_SERIES, SERIES_COLORS } from './chartPalette';

interface RichnessChartProps {
  rows: readonly RichnessRow[];
  /** Grouped by site: one bar per site instead of one series per site. */
  bySite: boolean;
  /** Sites in a fixed order (by id) with their names; a site keeps its colour across filters. */
  sites: readonly { site_id: number; name: string }[];
}

export function RichnessChart({ rows, bySite, sites }: RichnessChartProps) {
  const slot = new Map(sites.map((s, i) => [s.site_id, i]));
  const name = (id: number) => sites.find((s) => s.site_id === id)?.name ?? `Site ${id}`;

  if (bySite) {
    const data = rows.map((r) => ({
      label: r.group,
      species: r.observed_taxa,
      samples: r.sample_count,
    }));
    return (
      <div aria-hidden="true" className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
            barCategoryGap="30%"
          >
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: GRID_STROKE }}
              interval={0}
            />
            <YAxis
              allowDecimals={false}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={32}
            />
            <Tooltip
              cursor={{ fill: '#f1f5f9' }}
              formatter={(value, _name, item) => [
                `${String(value)} species (${String(item.payload.samples)} samples)`,
                'Observed',
              ]}
            />
            <Bar
              dataKey="species"
              name="Observed species"
              fill={SERIES_COLORS[0]}
              radius={[4, 4, 0, 0]}
              maxBarSize={56}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const siteIds = [...new Set(rows.map((r) => r.site_id))].sort(
    (a, b) => (slot.get(a) ?? a) - (slot.get(b) ?? b),
  );
  const groups = [...new Set(rows.map((r) => r.group))];
  const data = groups.map((group) => {
    const point: Record<string, string | number | null> = { label: group };
    for (const id of siteIds) {
      const row = rows.find((r) => r.group === group && r.site_id === id);
      point[`s${id}`] = row ? row.observed_taxa : null;
    }
    return point;
  });
  const colorOf = (id: number) => SERIES_COLORS[(slot.get(id) ?? 0) % MAX_SERIES];

  return (
    <div aria-hidden="true" className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
          barGap={4}
          barCategoryGap="20%"
        >
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: GRID_STROKE }}
          />
          <YAxis
            allowDecimals={false}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            cursor={{ fill: '#f1f5f9' }}
            formatter={(value) => [`${String(value)} species`]}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            iconType="circle"
            formatter={(value: string) => <span style={{ color: '#334155' }}>{value}</span>}
          />
          {siteIds.map((id) => (
            <Bar
              key={id}
              dataKey={`s${id}`}
              name={name(id)}
              fill={colorOf(id)}
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** True when the chart can colour every site (otherwise the page shows only the table). */
export function richnessChartFits(rows: readonly RichnessRow[], bySite: boolean): boolean {
  return bySite || new Set(rows.map((r) => r.site_id)).size <= MAX_SERIES;
}
