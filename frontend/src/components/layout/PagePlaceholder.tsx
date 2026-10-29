// Owner: B (Frontend)
// Purpose: Temporary page body used by the T08 scaffold until each page is built

import type { ReactNode } from 'react';

interface PagePlaceholderProps {
  title: string;
  /** Workflow task that builds the real page, for example 'T26'. */
  task: string;
  description: string;
  children?: ReactNode;
}

export function PagePlaceholder({ title, task, description, children }: PagePlaceholderProps) {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-slate-600">{description}</p>
      <p className="mt-6 rounded-md border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
        This page is built in {task}.
      </p>
      {children}
    </section>
  );
}
