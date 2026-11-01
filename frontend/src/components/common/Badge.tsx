// Owner: B (Frontend)
// Purpose: small coloured label for statuses and roles

import { humanize } from '../../utils/format';

type Tone = 'grey' | 'green' | 'blue' | 'amber' | 'red' | 'purple';

const TONES: Record<Tone, string> = {
  grey: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-800',
  blue: 'bg-sky-100 text-sky-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  purple: 'bg-violet-100 text-violet-800',
};

/** Colours for the enum values pages show most (unknown values are grey). */
const VALUE_TONES: Record<string, Tone> = {
  // project_status
  planned: 'blue',
  active: 'green',
  completed: 'purple',
  archived: 'grey',
  // project_role
  owner: 'purple',
  manager: 'blue',
  contributor: 'green',
  viewer: 'grey',
  // audit_action
  insert: 'green',
  update: 'blue',
  delete: 'red',
  approve: 'green',
  reject: 'red',
  login: 'grey',
  export: 'amber',
};

interface BadgeProps {
  /** An enum value such as `active` or `principal_investigator`; shown humanized. */
  value: string;
  /** Text to show instead of the humanized value. */
  label?: string;
  tone?: Tone;
}

export function Badge({ value, label, tone }: BadgeProps) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone ?? VALUE_TONES[value] ?? 'grey']}`}
    >
      {label ?? humanize(value)}
    </span>
  );
}
