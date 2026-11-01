// Owner: B (Frontend)
// Purpose: Edit project form (PATCH /api/projects/:id; owner/manager PI or administrator)
//
// The API accepts title, objectives, status and end_date. The start date is set at creation and
// cannot be changed, so it is shown but not editable. Only changed fields are sent.

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { updateProject } from '../../services/projectsService';
import type { ProjectDetail, ProjectStatus, UpdateProjectRequest } from '../../types';
import { formatDate } from '../../utils/format';
import {
  DUPLICATE_TITLE,
  OBJECTIVES_MAX,
  TITLE_MAX,
  checkProject,
  type ProjectErrors,
} from './projectRules';

const STATUSES: ProjectStatus[] = ['planned', 'active', 'completed', 'archived'];
const FIELDS = ['title', 'objectives', 'status', 'end_date'] as const;

interface EditProjectFormProps {
  project: ProjectDetail;
  onSaved: () => void;
  onCancel: () => void;
}

export function EditProjectForm({ project, onSaved, onCancel }: EditProjectFormProps) {
  const [title, setTitle] = useState(project.title);
  const [objectives, setObjectives] = useState(project.objectives ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [endDate, setEndDate] = useState(project.end_date ?? '');
  const [errors, setErrors] = useState<ProjectErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const save = useSubmit(updateProject);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNote(null);
    const found = checkProject({
      title,
      objectives,
      end_date: endDate,
      savedStartDate: project.start_date,
    });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const changes: UpdateProjectRequest = {};
    if (title.trim() !== project.title) changes.title = title.trim();
    if ((objectives.trim() || null) !== project.objectives)
      changes.objectives = objectives.trim() || null;
    if (status !== project.status) changes.status = status;
    if ((endDate || null) !== project.end_date) changes.end_date = endDate || null;
    if (Object.keys(changes).length === 0) {
      setNote('Nothing has changed.');
      return;
    }
    if (await save.run(project.project_id, changes)) onSaved();
  }

  const server = save.error
    ? formErrors(save.error, FIELDS, { duplicate: { field: 'title', message: DUPLICATE_TITLE } })
    : { fieldErrors: {}, formError: null };
  const fieldError = (field: (typeof FIELDS)[number]) => errors[field] ?? server.fieldErrors[field];

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Edit project"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">Edit project</h2>
      <FormField label="Title" error={fieldError('title')} required>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX + 50}
          className={fieldControlClass(!!fieldError('title'))}
        />
      </FormField>
      <FormField label="Objectives" error={fieldError('objectives')}>
        <textarea
          value={objectives}
          onChange={(e) => setObjectives(e.target.value)}
          rows={3}
          maxLength={OBJECTIVES_MAX + 50}
          className={fieldControlClass(!!fieldError('objectives'))}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Status" error={fieldError('status')}>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            className={fieldControlClass(!!fieldError('status'))}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="End date"
          error={fieldError('end_date')}
          hint={`Start date: ${formatDate(project.start_date)} (set at creation). Leave empty if open-ended.`}
        >
          <input
            type="date"
            value={endDate}
            min={project.start_date ?? undefined}
            onChange={(e) => setEndDate(e.target.value)}
            className={fieldControlClass(!!fieldError('end_date'))}
          />
        </FormField>
      </div>
      {note && (
        <p role="status" className="text-sm text-slate-600">
          {note}
        </p>
      )}
      {server.formError && (
        <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700">
          {server.formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.submitting}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {save.submitting ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
