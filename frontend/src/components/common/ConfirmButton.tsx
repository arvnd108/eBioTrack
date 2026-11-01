// Owner: B (Frontend)
// Purpose: a button that asks for a second click before a destructive action
//
// First click turns it into "Confirm …?" with a Cancel next to it; no browser dialogs.
//
//   <ConfirmButton label="Remove" confirmLabel="Remove member?" onConfirm={() => remove(id)} />

import { useState } from 'react';

interface ConfirmButtonProps {
  label: string;
  /** Text of the confirming button, for example "Remove member?". */
  confirmLabel: string;
  onConfirm: () => void | Promise<unknown>;
  disabled?: boolean;
  /** Accessible name for the first button when `label` alone is ambiguous in a table row. */
  ariaLabel?: string;
}

const base =
  'rounded-md px-2.5 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  ariaLabel,
}: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        className={`${base} border border-red-200 text-red-700 hover:bg-red-50`}
        onClick={() => setAsking(true)}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={`${base} bg-red-700 text-white hover:bg-red-800`}
        onClick={async () => {
          setAsking(false);
          await onConfirm();
        }}
        disabled={disabled}
        autoFocus
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className={`${base} text-slate-600 hover:bg-slate-100`}
        onClick={() => setAsking(false)}
      >
        Cancel
      </button>
    </span>
  );
}
