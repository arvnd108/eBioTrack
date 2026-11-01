// Owner: B (Frontend)
// Purpose: A sample's status history as a timeline, oldest first (GET /api/samples/:id)

import { Badge } from '../../components/common/Badge';
import type { SampleStatusChange } from '../../types';
import { formatDateTime, humanize } from '../../utils/format';

interface StatusTimelineProps {
  history: SampleStatusChange[];
  /** User id and the name the API sent -> display name (see useUserNames). */
  nameOf: (id: number | null, name?: string | null) => string;
}

export function StatusTimeline({ history, nameOf }: StatusTimelineProps) {
  if (history.length === 0) {
    return <p className="text-sm text-slate-600">No status changes recorded.</p>;
  }
  return (
    <ol aria-label="Status history" className="relative space-y-4 border-l border-slate-200 pl-6">
      {history.map((change, index) => (
        <li key={`${change.changed_at}-${index}`} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full border-2 border-white bg-emerald-600 ring-1 ring-slate-300"
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge value={change.new_status} />
            <span className="text-slate-600">
              {change.old_status ? `from ${humanize(change.old_status)}` : 'registered'}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-700">
            <time dateTime={change.changed_at}>{formatDateTime(change.changed_at)}</time>
            {' · '}
            {nameOf(change.changed_by, change.changed_by_name)}
          </p>
          {change.note && <p className="mt-0.5 text-sm text-slate-500">{change.note}</p>}
        </li>
      ))}
    </ol>
  );
}
