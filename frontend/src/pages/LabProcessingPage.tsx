// Owner: B (Frontend)
// Purpose: Extraction, QC, sequencing workflow
//
// Three tabs, kept in the URL (?tab=extractions|qc|runs) with their filters, so other pages can
// link to them (a sample's extractions: ?tab=extractions&sample_id=7):
//   - Extractions: DNA extractions (record, QC verdict, measurements) and extraction batches;
//   - QC results: list and record;
//   - Sequencing runs: list and create from selected extractions; each run opens on its own page.
// Everyone in a project can read its lab data; record_lab (administrator, or a principal
// investigator or lab technician who is not a project viewer) adds the write controls.

import { useQueryFilters } from '../hooks/useQueryFilters';
import { ExtractionsTab } from './lab/ExtractionsSection';
import { QcResultsSection } from './lab/QcResultsSection';
import { RunsSection } from './lab/RunsSection';

const TABS = [
  { id: 'extractions', label: 'Extractions' },
  { id: 'qc', label: 'QC results' },
  { id: 'runs', label: 'Sequencing runs' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export default function LabProcessingPage() {
  const [filters, setFilters] = useQueryFilters(['tab'] as const);
  const current: Tab = TABS.find((t) => t.id === filters.tab)?.id ?? 'extractions';

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Lab processing</h1>
        <p className="mt-1 text-slate-600">
          From sample to sequence: DNA extractions and their QC, quality-control results, and
          sequencing runs.
        </p>
      </div>
      <div
        role="tablist"
        aria-label="Lab sections"
        className="flex gap-1 border-b border-slate-200"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={current === t.id}
            aria-controls={`panel-${t.id}`}
            // A new tab starts without the previous tab's filters.
            onClick={() =>
              setFilters({ tab: t.id === 'extractions' ? '' : t.id }, { keepOthers: false })
            }
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              current === t.id
                ? 'border-emerald-700 text-emerald-800'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${current}`} aria-labelledby={`tab-${current}`}>
        {current === 'extractions' && <ExtractionsTab />}
        {current === 'qc' && <QcResultsSection />}
        {current === 'runs' && <RunsSection />}
      </div>
    </section>
  );
}
