// Owner: B (Frontend)
// Purpose: Interactive site map and filters
//
// GET /api/sites (any signed-in user; sites belong to no single project) on a Leaflet map, one
// circle per site coloured by habitat, with a popup summary (events and samples in the user's
// projects, links to them). Filters (project, region, habitat) and the selected site live in the
// URL, so other pages link here with ?site_id=. The table under the map lists the same sites for
// keyboard and screen-reader users. manage_sites (administrator, principal investigator, field
// researcher) adds New site and Edit site; the form takes coordinates from a click on the map.

import { lazy, Suspense, useState } from 'react';
import { Badge } from '../components/common/Badge';
import { Can } from '../components/common/Can';
import { DataTable, type Column } from '../components/common/DataTable';
import { ErrorState } from '../components/common/ErrorState';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { LoadingState } from '../components/common/LoadingState';
import { HABITAT_TYPES } from '../domain';
import { useAuth } from '../hooks/useAuth';
import { useFetch } from '../hooks/useFetch';
import { useProjectIndex, useRegions } from '../hooks/useLookups';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import type { HabitatType, PageMeta, Site } from '../types';
import { humanize } from '../utils/format';
import { HABITAT_COLORS } from '../components/maps/habitatColors';
import { SiteForm } from './map/SiteForm';
import { SiteSummary } from './map/SiteSummary';

const SiteMap = lazy(() => import('../components/maps/SiteMap'));

const FILTERS = ['project_id', 'region_id', 'habitat_type', 'site_id'] as const;
const LIMIT = 100;

type FormState = { mode: 'create' } | { mode: 'edit'; site: Site } | null;

export default function SamplingMapPage() {
  const { can, user } = useAuth();
  const [filters, setFilters] = useQueryFilters(FILTERS);
  const [form, setForm] = useState<FormState>(null);
  const [picked, setPicked] = useState<{ latitude: number; longitude: number } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const projects = useProjectIndex();
  const regions = useRegions();
  const habitat = HABITAT_TYPES.find((h) => h === filters.habitat_type);
  const sites = useFetch<Site[], PageMeta>('/sites', {
    project_id: idParam(filters.project_id),
    region_id: idParam(filters.region_id),
    habitat_type: habitat,
    limit: LIMIT,
    sort: 'name',
  });
  const selectedId = idParam(filters.site_id) ? Number(filters.site_id) : null;
  // Anyone signed in may add a site; correcting one needs manage_sites or being its creator.
  const canCreate = can('create_site');
  const canEditSite = (s: Site) =>
    can('manage_sites') || (!!user && s.created_by !== undefined && s.created_by === user.user_id);

  const select = (siteId: number | null) => setFilters({ site_id: siteId ? String(siteId) : '' });

  function openForm(next: FormState) {
    setSaved(null);
    setPicked(null);
    setForm(next);
  }

  const columns: Column<Site>[] = [
    { key: 'name', header: 'Site' },
    {
      key: 'habitat_type',
      header: 'Habitat',
      render: (s) => <Badge value={s.habitat_type} />,
    },
    {
      key: 'region_id',
      header: 'Region',
      render: (s) => regions.byId.get(s.region_id)?.name ?? `Region ${s.region_id}`,
    },
    {
      key: 'location',
      header: 'Latitude, longitude',
      render: (s) => `${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}`,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (s) => (
        <span className="inline-flex gap-2">
          <button
            type="button"
            onClick={() => select(s.site_id)}
            aria-label={`Show ${s.name} on the map`}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100"
          >
            Show on map
          </button>
          {canEditSite(s) && (
            <button
              type="button"
              onClick={() => openForm({ mode: 'edit', site: s })}
              aria-label={`Edit ${s.name}`}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-100"
            >
              Edit
            </button>
          )}
        </span>
      ),
    },
  ];

  const rows = sites.data ?? [];
  const anyFilter = !!(filters.project_id || filters.region_id || habitat);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sampling map</h1>
          <p className="mt-1 text-slate-600">
            Sampling sites; click a site for its events and samples.
          </p>
        </div>
        <Can action="create_site">
          {!form && (
            <button
              type="button"
              onClick={() => openForm({ mode: 'create' })}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              New site
            </button>
          )}
        </Can>
      </div>

      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3">
        <FormField label="Project">
          <select
            value={idParam(filters.project_id) ?? ''}
            onChange={(e) => setFilters({ project_id: e.target.value, site_id: '' })}
            className={fieldControlClass()}
          >
            <option value="">All sites</option>
            {projects.list.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.title}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Region">
          <select
            value={idParam(filters.region_id) ?? ''}
            onChange={(e) => setFilters({ region_id: e.target.value, site_id: '' })}
            className={fieldControlClass()}
          >
            <option value="">All regions</option>
            {regions.list.map((r) => (
              <option key={r.region_id} value={r.region_id}>
                {r.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Habitat">
          <select
            value={habitat ?? ''}
            onChange={(e) => setFilters({ habitat_type: e.target.value, site_id: '' })}
            className={fieldControlClass()}
          >
            <option value="">All habitats</option>
            {HABITAT_TYPES.map((h) => (
              <option key={h} value={h}>
                {humanize(h)}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      {saved && (
        <p role="status" className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
          {saved}
        </p>
      )}
      {form && (
        <SiteForm
          key={form.mode === 'edit' ? form.site.site_id : 'new'}
          regions={regions.list}
          linkableProjects={projects.list.filter((p) => can('edit_project', p.your_role))}
          site={form.mode === 'edit' ? form.site : undefined}
          picked={picked}
          onCancel={() => openForm(null)}
          onSaved={(site) => {
            setSaved(form.mode === 'edit' ? `Saved ${site.name}.` : `Created ${site.name}.`);
            setForm(null);
            setPicked(null);
            sites.reload();
            select(site.site_id);
          }}
        />
      )}

      {sites.error && !sites.data ? (
        <ErrorState error={sites.error} title="Could not load the sites" onRetry={sites.reload} />
      ) : (
        <>
          <Suspense fallback={<LoadingState label="Loading the map…" />}>
            <SiteMap
              sites={rows}
              selectedId={selectedId}
              onSelect={select}
              picking={!!form}
              picked={picked}
              onPick={(latitude, longitude) => setPicked({ latitude, longitude })}
              renderPopup={(site) => (
                <SiteSummary
                  site={site}
                  region={regions.byId.get(site.region_id)}
                  onEdit={canEditSite(site) ? () => openForm({ mode: 'edit', site }) : undefined}
                />
              )}
            />
          </Suspense>
          <ul
            aria-label="Habitat colours"
            className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"
          >
            {HABITAT_TYPES.map((h: HabitatType) => (
              <li key={h} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: HABITAT_COLORS[h] }}
                />
                {humanize(h)}
              </li>
            ))}
          </ul>
        </>
      )}

      {sites.meta && sites.meta.total > LIMIT && (
        <p className="text-sm text-amber-800">
          Showing the first {LIMIT} of {sites.meta.total} sites. Narrow the filters to see the rest.
        </p>
      )}
      <DataTable
        caption="Sites"
        showCaption
        columns={columns}
        rows={sites.data}
        rowKey={(s) => s.site_id}
        loading={sites.status === 'loading'}
        error={sites.error}
        onRetry={sites.reload}
        emptyTitle={anyFilter ? 'No sites match these filters' : 'No sites yet'}
        emptyDescription={
          anyFilter ? 'Try other filters.' : canCreate ? 'Add one with New site.' : undefined
        }
      />
    </section>
  );
}
