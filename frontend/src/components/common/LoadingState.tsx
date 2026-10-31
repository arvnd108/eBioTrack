// Owner: B (Frontend)
// Purpose: loading indicator

interface LoadingStateProps {
  /** What is loading, read out by screen readers. */
  label?: string;
  /** `block` fills a section with padding; `inline` sits in a line of text or a button row. */
  variant?: 'block' | 'inline';
}

export function LoadingState({ label = 'Loading…', variant = 'block' }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        variant === 'block'
          ? 'flex items-center justify-center gap-3 py-10 text-sm text-slate-500'
          : 'inline-flex items-center gap-2 text-sm text-slate-500'
      }
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-emerald-600"
      />
      <span>{label}</span>
    </div>
  );
}
