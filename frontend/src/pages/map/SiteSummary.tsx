// Owner: B (Frontend)
// Purpose: What the map shows about one site: details, how many events and samples the user's
//          projects have there, and links to them
//
// The counts come from the lists themselves (GET /api/events and /api/samples with site_id and
// limit=1, reading meta.total), so they cover only the user's projects, as the API does.

import { Link } from 'react-router-dom';
import { Badge } from '../../components/common/Badge';
import { useFetch } from '../../hooks/useFetch';
import type { PageMeta, Region, Site } from '../../types';

interface SiteSummaryProps {
  site: Site;
  region?: Region;
  onEdit?: () => void;
}

function Count({ path, siteId }: { path: '/events' | '/samples'; siteId: number }) {
  const res = useFetch<unknown[], PageMeta>(path, { site_id: siteId, limit: 1 });
  if (res.error) return <>?</>;
  return <>{res.meta ? res.meta.total : '…'}</>;
}

export function SiteSummary({ site, region, onEdit }: SiteSummaryProps) {
  return (
    <div className="min-w-56 space-y-2 text-sm">
      <div>
        <p className="text-base font-semibold text-slate-900">{site.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-slate-600">
          <Badge value={site.habitat_type} />
          {region ? region.name : `Region ${site.region_id}`}
        </p>
      </div>
      <p className="font-mono text-xs text-slate-600">
        {site.latitude.toFixed(5)}, {site.longitude.toFixed(5)}
      </p>
      {site.description && <p className="text-slate-700">{site.description}</p>}
      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-xs text-slate-500">Events</dt>
          <dd className="font-semibold">
            <Count path="/events" siteId={site.site_id} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Samples</dt>
          <dd className="font-semibold">
            <Count path="/samples" siteId={site.site_id} />
          </dd>
        </div>
      </dl>
      <p className="text-xs text-slate-500">Counts cover the projects you belong to.</p>
      <div className="flex flex-wrap gap-3">
        <Link to={`/events?site_id=${site.site_id}`} className="text-emerald-700 hover:underline">
          Events here
        </Link>
        <Link to={`/samples?site_id=${site.site_id}`} className="text-emerald-700 hover:underline">
          Samples here
        </Link>
        {onEdit && (
          <button type="button" onClick={onEdit} className="text-emerald-700 hover:underline">
            Edit site
          </button>
        )}
      </div>
    </div>
  );
}
