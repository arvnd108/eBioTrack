// Owner: B (Frontend)
// Purpose: Hook: state for one write action (a form submit or a button)
//
//   const save = useSubmit(updateProject);
//   <button disabled={save.submitting} onClick={() => save.run(id, body)}>Save</button>
//   {save.error ? <ErrorState error={save.error} /> : null}
//
// `run` resolves to the action's result, or `undefined` when it failed (the error is in `error`),
// so the caller never needs its own try/catch. A second click while one is running is ignored.

import { useCallback, useRef, useState } from 'react';

export function useSubmit<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);

  const run = useCallback(
    async (...args: Args): Promise<Result | undefined> => {
      if (running.current) return undefined;
      running.current = true;
      setSubmitting(true);
      setError(null);
      try {
        return await action(...args);
      } catch (err) {
        setError(err);
        return undefined;
      } finally {
        running.current = false;
        setSubmitting(false);
      }
    },
    [action],
  );

  const reset = useCallback(() => setError(null), []);

  return { run, submitting, error, reset };
}
