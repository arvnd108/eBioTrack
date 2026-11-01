// Owner: B (Frontend)
// Purpose: error display

import { errorMessage } from '../../services/errorMessages';

interface ErrorStateProps {
  /** Anything thrown; an ApiError is described by its contract error code. */
  error: unknown;
  /** Heading, for example "Could not load samples". */
  title?: string;
  /** Shows a Retry button when given. */
  onRetry?: () => void;
}

export function ErrorState({ error, title = 'Something went wrong', onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm">
      <p className="font-medium text-red-800">{title}</p>
      <p className="mt-1 text-red-700">{errorMessage(error)}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 font-medium text-red-800 hover:bg-red-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}
