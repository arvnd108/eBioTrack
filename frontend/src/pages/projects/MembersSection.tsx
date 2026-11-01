// Owner: B (Frontend)
// Purpose: Project members: list, add and remove (owner/manager PI or administrator)
//
// API rules (backend services/projects.service.js), checked again by the server:
//  - a project has one owner, set at creation: it cannot be added or removed here;
//  - only active users can be added; adding an existing member is 409 `duplicate`;
//  - a manager may remove themselves (and then may lose access to the project).

import { useState, type FormEvent } from 'react';
import { Badge } from '../../components/common/Badge';
import { ConfirmButton } from '../../components/common/ConfirmButton';
import { DataTable, type Column } from '../../components/common/DataTable';
import { ErrorState } from '../../components/common/ErrorState';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { addMember, removeMember } from '../../services/projectsService';
import type { ProjectDetail, ProjectMember, ProjectRole } from '../../types';
import { formatDateTime } from '../../utils/format';
import { UserPicker, useCanListUsers } from './Pickers';

const ADDABLE_ROLES: Exclude<ProjectRole, 'owner'>[] = ['manager', 'contributor', 'viewer'];
const FIELDS = ['user_id', 'project_role'] as const;

interface MembersSectionProps {
  project: ProjectDetail;
  canEdit: boolean;
  currentUserId: number;
  /** Called after a change; `leftProject` when the user removed themselves. */
  onChanged: (leftProject?: boolean) => void;
}

export function MembersSection({
  project,
  canEdit,
  currentUserId,
  onChanged,
}: MembersSectionProps) {
  const canList = useCanListUsers();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Exclude<ProjectRole, 'owner'>>('contributor');
  const [userError, setUserError] = useState<string | null>(null);
  const add = useSubmit(addMember);
  const remove = useSubmit(async (projectId: number, memberId: number) => {
    await removeMember(projectId, memberId);
    return true; // removeMember resolves to nothing; true marks success for run()
  });

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = Number(userId);
    if (!userId || !Number.isSafeInteger(id) || id <= 0) {
      setUserError(canList ? 'Choose a person.' : 'Enter the person’s user ID.');
      return;
    }
    setUserError(null);
    if (await add.run(project.project_id, { user_id: id, project_role: role })) {
      setUserId('');
      onChanged();
    }
  }

  async function handleRemove(member: ProjectMember) {
    if (await remove.run(project.project_id, member.user_id)) {
      onChanged(member.user_id === currentUserId);
    }
  }

  const server = add.error
    ? formErrors(add.error, FIELDS, {
        duplicate: { field: 'user_id', message: 'This person is already a member of the project.' },
      })
    : { fieldErrors: {}, formError: null };

  const columns: Column<ProjectMember>[] = [
    { key: 'full_name', header: 'Name' },
    { key: 'email', header: 'Email' },
    {
      key: 'project_role',
      header: 'Project role',
      render: (m) => <Badge value={m.project_role} />,
    },
    { key: 'joined_at', header: 'Joined', render: (m) => formatDateTime(m.joined_at) },
  ];
  if (canEdit) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (m) =>
        m.project_role === 'owner' ? (
          <span className="text-xs text-slate-500">Owner</span>
        ) : (
          <ConfirmButton
            label="Remove"
            ariaLabel={`Remove ${m.full_name}`}
            confirmLabel={m.user_id === currentUserId ? 'Leave project?' : 'Remove member?'}
            onConfirm={() => handleRemove(m)}
            disabled={remove.submitting}
          />
        ),
    });
  }

  return (
    <section aria-labelledby="members-heading" className="space-y-3">
      <h2 id="members-heading" className="text-lg font-semibold">
        Members <span className="text-sm font-normal text-slate-500">({project.member_count})</span>
      </h2>
      {remove.error ? (
        <ErrorState error={remove.error} title="Could not remove the member" />
      ) : null}
      <DataTable
        caption="Members"
        columns={columns}
        rows={project.members}
        rowKey={(m) => m.user_id}
        emptyTitle="No members"
      />
      {canEdit && (
        <form
          onSubmit={handleAdd}
          noValidate
          aria-label="Add member"
          className="grid items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_12rem_auto]"
        >
          <FormField
            label="Person"
            error={userError ?? server.fieldErrors.user_id}
            hint={
              canList ? undefined : 'Only administrators can browse users; ask one for the user ID.'
            }
            required
          >
            <UserPicker
              value={userId}
              onChange={setUserId}
              exclude={project.members.map((m) => m.user_id)}
              invalid={!!(userError ?? server.fieldErrors.user_id)}
            />
          </FormField>
          <FormField label="Project role" error={server.fieldErrors.project_role}>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Exclude<ProjectRole, 'owner'>)}
              className={fieldControlClass(!!server.fieldErrors.project_role)}
            >
              {ADDABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </FormField>
          <button
            type="submit"
            disabled={add.submitting}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {add.submitting ? 'Adding…' : 'Add member'}
          </button>
          {server.formError && (
            <p role="alert" className="text-sm text-red-700 sm:col-span-3">
              {server.formError}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
