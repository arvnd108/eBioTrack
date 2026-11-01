// Owner: B (Frontend)
// Purpose: Detection frequency by site (Recharts)
//
// For one taxon, the share of each site's analysed samples in which it was detected (approved,
// QC pass), as horizontal bars from 0 to 100 %. One series, so no legend; the counts behind each
// bar ("3 of 4 samples") are in the tooltip and in the table the page shows next to it.

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DetectionFrequencyRow } from '../../types';
import { AXIS_TICK, GRID_STROKE, SERIES_COLORS } from './chartPalette';

interface DetectionFrequencyChartProps {
  rows: readonly DetectionFrequencyRow[];
  siteName: (siteId: number) => string;
}

/** Detected share in percent, or null when the site has no analysed sample yet. */
export const detectionRate = (row: DetectionFrequencyRow): number | null =>
  row.samples_total === 0 ? null : Math.round((row.detections / row.samples_total) * 100);

export function DetectionFrequencyChart({ rows, siteName }: DetectionFrequencyChartProps) {
  const data = rows.map((r) => ({
    label: siteName(r.site_id),
    rate: detectionRate(r) ?? 0,
    detections: r.detections,
    total: r.samples_total,
  }));
  const height = Math.max(120, 44 * data.length + 40);
  return (
    <div aria-hidden="true" className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: GRID_STROKE }}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={140}
          />
          <Tooltip
            cursor={{ fill: '#f1f5f9' }}
            formatter={(_value, _name, item) => [
              `${String(item.payload.detections)} of ${String(item.payload.total)} analysed samples`,
              'Detected in',
            ]}
          />
          <Bar
            dataKey="rate"
            name="Detected in"
            fill={SERIES_COLORS[0]}
            radius={[0, 4, 4, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
