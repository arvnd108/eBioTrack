// Owner: B (Frontend)
// Purpose: empty result display (no rows, nothing found for the filters)

import type { ReactNode } from 'react';

interface EmptyStateProps {
  title?: string;
  /** One line on why it is empty or what to do next. */
  description?: ReactNode;
  /** Optional action, for example a "New project" button the user is allowed to use. */
  action?: ReactNode;
}

export function EmptyState({
  title = 'Nothing to show yet',
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
