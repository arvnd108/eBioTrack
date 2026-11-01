// Owner: B (Frontend)
// Purpose: Taxon search, lineage, detection history
//
// Every role reads the shared taxonomy (GET /api/taxa: names that start with the search, or have
// a word that starts with it, optionally of one rank) and, for a chosen taxon, its approved
// detections in their own projects (TaxonPanel). Everything is in the URL (?q&rank&taxon_id and
// the project, site and date filters), so a link opens the same view. Detection is not
// abundance and non-detection is not absence: the caveat banner says so on the taxon panel.

import { useState, type FormEvent } from 'react';
import { Badge } from '../components/common/Badge';
import { DataTable, type Column } from '../components/common/DataTable';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { TAXON_RANKS } from '../domain';
import { useFetch } from '../hooks/useFetch';
import { usePagination } from '../hooks/usePagination';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import { TAXON_QUERY_MAX } from '../services/taxaService';
import type { PageMeta, Taxon } from '../types';
import { humanize } from '../utils/format';
import { SCOPE_KEYS, type Scope } from './analytics/ScopeFilters';
import { TaxonName, TaxonPanel } from './species/TaxonPanel';

const KEYS = ['q', 'rank', 'taxon_id', ...SCOPE_KEYS] as const;

export default function SpeciesExplorerPage() {
  const [filters, setFilters] = useQueryFilters(KEYS);
  const [text, setText] = useState(filters.q);
  const [problem, setProblem] = useState<string | null>(null);
  const pager = usePagination({ initialSort: 'scientific_name' });
  const rank = TAXON_RANKS.find((r) => r === filters.rank);
  const q = filters.q.trim();
  const taxa = useFetch<Taxon[], PageMeta>('/taxa', {
    q: q && q.length <= TAXON_QUERY_MAX ? q : undefined,
    rank,
    ...pager.query,
  });
  const selected = idParam(filters.taxon_id);
  const scope: Scope = {
    project_id: filters.project_id,
    site_id: filters.site_id,
    from: filters.from,
    to: filters.to,
  };

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (value.length > TAXON_QUERY_MAX) {
      setProblem(`At most ${TAXON_QUERY_MAX} characters.`);
      return;
    }
    setProblem(null);
    setFilters({ q: value });
    pager.resetPage();
  }

  const columns: Column<Taxon>[] = [
    {
      key: 'scientific_name',
      header: 'Name',
      sortField: 'scientific_name',
      render: (t) => (
        <button
          type="button"
          onClick={() => setFilters({ taxon_id: String(t.taxon_id) })}
          aria-current={String(t.taxon_id) === selected ? 'true' : undefined}
          className={`text-left hover:underline ${String(t.taxon_id) === selected ? 'font-semibold text-slate-900' : 'text-emerald-700'}`}
        >
          <TaxonName taxon={t} />
        </button>
      ),
    },
    { key: 'rank', header: 'Rank', render: (t) => humanize(t.rank) },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Species explorer</h1>
        <p className="mt-1 max-w-3xl text-slate-600">
          Search the reference taxonomy, follow a taxon&rsquo;s lineage, and see where and when it
          was detected in approved analyses of your projects.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="space-y-3">
          <form onSubmit={search} role="search" aria-label="Search taxa" className="space-y-2">
            <FormField
              label="Scientific name"
              error={problem}
              hint="A name, or the start of any word in it (rohita finds Labeo rohita)."
            >
              <input
                type="search"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setProblem(null);
                }}
                className={fieldControlClass(!!problem)}
              />
            </FormField>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <FormField label="Rank">
                  <select
                    value={rank ?? ''}
                    onChange={(e) => {
                      setFilters({ rank: e.target.value });
                      pager.resetPage();
                    }}
                    className={fieldControlClass()}
                  >
                    <option value="">Any rank</option>
                    {TAXON_RANKS.map((r) => (
                      <option key={r} value={r}>
                        {humanize(r)}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
              <button
                type="submit"
                className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
              >
                Search
              </button>
            </div>
          </form>
          <DataTable
            caption="Taxa"
            columns={columns}
            rows={taxa.data}
            rowKey={(t) => t.taxon_id}
            loading={taxa.status === 'loading'}
            error={taxa.error}
            onRetry={taxa.reload}
            sort={pager.sort}
            onSortChange={pager.setSort}
            pagination={taxa.meta ? { meta: taxa.meta, onPageChange: pager.setPage } : null}
            emptyTitle={q || rank ? 'No taxa match' : 'No taxa yet'}
            emptyDescription={
              q || rank ? 'Try the start of the genus or species name, or any rank.' : undefined
            }
          />
        </div>

        {selected ? (
          <TaxonPanel
            key={selected}
            taxonId={Number(selected)}
            scope={scope}
            onScopeChange={(changes) => setFilters(changes)}
            onOpen={(id) => setFilters({ taxon_id: String(id) })}
          />
        ) : (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
            <Badge value="species" tone="purple" />
            <p>Choose a taxon to see its lineage, where it was detected and how often.</p>
          </div>
        )}
      </div>
    </section>
  );
}
