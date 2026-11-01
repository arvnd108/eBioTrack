// Owner: B (Frontend)
// Purpose: Choose a user or a site to link to a project
//
// Each picker shows a list when the API can give one, and otherwise an ID box:
//  - users: GET /api/users is administrator-only (CONTRACT 10), so a principal investigator types
//    the person's user ID;
//  - sites: GET /api/sites arrives with T21; while the API answers 404 the user types a site ID.
// Both forward `id` / `aria-*` from FormField to the control they render.

import type { SelectHTMLAttributes } from 'react';
import { fieldControlClass } from '../../components/common/FormField';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { useFetch } from '../../hooks/useFetch';
import type { PageMeta, Site, User } from '../../types';
import { humanize } from '../../utils/format';

type ControlProps = Pick<
  SelectHTMLAttributes<HTMLElement>,
  'id' | 'required' | 'aria-invalid' | 'aria-describedby' | 'aria-label'
>;

interface PickerProps extends ControlProps {
  /** The chosen ID as text ('' for none). */
  value: string;
  onChange: (value: string) => void;
  /** IDs already linked, left out of the list. */
  exclude: number[];
  invalid?: boolean;
}

function IdInput({
  value,
  onChange,
  invalid,
  placeholder,
  ...control
}: Omit<PickerProps, 'exclude'> & { placeholder: string }) {
  return (
    <input
      {...control}
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
      placeholder={placeholder}
      className={fieldControlClass(invalid)}
    />
  );
}

/** Whether the picker can list users; the label's hint depends on it. */
export function useCanListUsers(): boolean {
  return useAuth().can('manage_users');
}

export function UserPicker({ value, onChange, exclude, invalid, ...control }: PickerProps) {
  const canList = useCanListUsers();
  const users = useFetch<User[], PageMeta>(canList ? '/users' : null, {
    active: 'true',
    limit: 100,
    sort: 'full_name',
  });

  if (!canList || users.status === 'error') {
    return (
      <IdInput
        {...control}
        value={value}
        onChange={onChange}
        invalid={invalid}
        placeholder="User ID, for example 7"
      />
    );
  }
  if (!users.data) return <LoadingState label="Loading users…" variant="inline" />;

  const choices = users.data.filter((u) => !exclude.includes(u.user_id));
  return (
    <select
      {...control}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={fieldControlClass(invalid)}
    >
      <option value="">
        {choices.length ? 'Choose a person…' : 'Everyone active is already a member'}
      </option>
      {choices.map((u) => (
        <option key={u.user_id} value={u.user_id}>
          {u.full_name} ({u.email}, {u.roles.map(humanize).join(', ')})
        </option>
      ))}
    </select>
  );
}

/**
 * Lists sites when GET /api/sites is available; the hint says which mode is in use.
 * `enabled` is false for users who cannot link sites, so they send no request.
 */
export function useSiteList(enabled = true) {
  return useFetch<Site[], PageMeta>(enabled ? '/sites' : null, { limit: 100 });
}

export function SitePicker({
  value,
  onChange,
  exclude,
  invalid,
  sites,
  ...control
}: PickerProps & { sites: ReturnType<typeof useSiteList> }) {
  if (sites.status === 'error') {
    return (
      <IdInput
        {...control}
        value={value}
        onChange={onChange}
        invalid={invalid}
        placeholder="Site ID, for example 4"
      />
    );
  }
  if (!sites.data) return <LoadingState label="Loading sites…" variant="inline" />;

  const choices = sites.data.filter((s) => !exclude.includes(s.site_id));
  return (
    <select
      {...control}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={fieldControlClass(invalid)}
    >
      <option value="">{choices.length ? 'Choose a site…' : 'All sites are already linked'}</option>
      {choices.map((s) => (
        <option key={s.site_id} value={s.site_id}>
          {s.name} ({humanize(s.habitat_type)}, site {s.site_id})
        </option>
      ))}
    </select>
  );
}
