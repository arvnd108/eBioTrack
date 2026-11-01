// Owner: B (Frontend)
// Purpose: eDNA caveat: detection is not abundance; non-detection is not absence
//
// The ONE caveat component every analytics and species page reuses (issue #45 "Watch out for").
// CONTRACT 10: every analytics response carries `meta.caveat` with the fixed text, and analytics
// and detections count only approved analyses with `qc_flag = 'pass'`. Pass the response's
// `meta.caveat` so the wording always comes from the API, plus page-specific notes:
//
//   <CaveatBanner
//     caveat={richness.meta?.caveat}
//     notes={[`Sampling effort differs: ${minSamples}–${maxSamples} samples per site.`]}
//   />

import type { ReactNode } from 'react';
import { EDNA_CAVEAT } from '../../types';

interface CaveatBannerProps {
  /** `meta.caveat` from the analytics response; falls back to the contract's fixed text. */
  caveat?: string | null;
  /** Extra points for this page: sampling effort, QC flags shown, uncertainty, and so on. */
  notes?: ReactNode[];
  /**
   * Adds the line saying only approved, QC-passed detections are counted (true for every
   * analytics endpoint). Set false on a view that also shows unapproved or flagged rows.
   */
  approvedOnly?: boolean;
}

export function CaveatBanner({ caveat, notes = [], approvedOnly = true }: CaveatBannerProps) {
  const points: ReactNode[] = [
    ...(approvedOnly
      ? ['Only approved analyses and detections with QC flag "pass" are counted.']
      : []),
    ...notes,
  ];

  return (
    <aside
      role="note"
      aria-label="How to read these results"
      className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <p className="font-medium">{caveat || EDNA_CAVEAT}</p>
      {points.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {points.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}
