// Owner: B (Frontend)
// Purpose: "Download CSV" for one export request, with the caveat shown beside the result
//
// POST /api/exports records who asked for what, then GET /api/exports/:id/download returns the
// CSV (regenerated now, approved and QC-passed detections only). An export is always for one
// project, so the button is disabled with a reason until a project is chosen. The file itself
// has no caveat line (it would break spreadsheet readers); the caveat travels with the download
// and is shown here next to it.

import { useState } from 'react';
import { useSubmit } from '../../hooks/useSubmit';
import { exportCsv } from '../../services/analyticsService';
import { errorMessage } from '../../services/errorMessages';
import type { CreateExportRequest } from '../../types';

interface ExportButtonProps {
  label?: string;
  /** The export to ask for, or null while it cannot be made (then `disabledReason` is shown). */
  request: CreateExportRequest | null;
  disabledReason?: string;
}

export function ExportButton({
  label = 'Download CSV',
  request,
  disabledReason = 'Choose a project to download.',
}: ExportButtonProps) {
  const save = useSubmit(exportCsv);
  const [done, setDone] = useState<{
    filename: string;
    rowCount: number;
    caveat: string | null;
  } | null>(null);

  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!request || save.submitting}
          onClick={async () => {
            if (!request) return;
            setDone(null);
            const result = await save.run(request);
            if (result) setDone(result);
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
        >
          {save.submitting ? 'Preparing…' : label}
        </button>
        {!request && <span className="text-slate-500">{disabledReason}</span>}
      </div>
      {done && (
        <p role="status" className="text-slate-600">
          Downloaded {done.filename} ({done.rowCount} row{done.rowCount === 1 ? '' : 's'}).
          {done.caveat ? ` ${done.caveat}` : ''}
        </p>
      )}
      {save.error ? (
        <p role="alert" className="text-red-700">
          Could not export: {errorMessage(save.error)}
        </p>
      ) : null}
    </div>
  );
}
