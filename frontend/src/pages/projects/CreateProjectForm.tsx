// Owner: B (Frontend)
// Purpose: New project form (POST /api/projects; the creator becomes the owner)

import { useState, type FormEvent } from 'react';
import { FormField, fieldControlClass } from '../../components/common/FormField';
import { useSubmit } from '../../hooks/useSubmit';
import { formErrors } from '../../services/errorMessages';
import { createProject } from '../../services/projectsService';
import type { Project } from '../../types';
import {
  DUPLICATE_TITLE,
  OBJECTIVES_MAX,
  TITLE_MAX,
  checkProject,
  type ProjectErrors,
} from './projectRules';

interface CreateProjectFormProps {
  onCreated: (project: Project) => void;
  onCancel: () => void;
}

const FIELDS = ['title', 'objectives', 'start_date'] as const;

export function CreateProjectForm({ onCreated, onCancel }: CreateProjectFormProps) {
  const [title, setTitle] = useState('');
  const [objectives, setObjectives] = useState('');
  const [startDate, setStartDate] = useState('');
  const [errors, setErrors] = useState<ProjectErrors>({});
  const save = useSubmit(createProject);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = checkProject({ title, objectives, start_date: startDate });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const created = await save.run({
      title: title.trim(),
      objectives: objectives.trim() || null,
      start_date: startDate || null,
    });
    if (created) return onCreated(created);
  }

  // Server answers that the checks above cannot know (duplicate title, permissions).
  const server = save.error
    ? formErrors(save.error, FIELDS, { duplicate: { field: 'title', message: DUPLICATE_TITLE } })
    : { fieldErrors: {}, formError: null };
  const fieldError = (field: (typeof FIELDS)[number]) => errors[field] ?? server.fieldErrors[field];

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="New project"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">New project</h2>
      <p className="text-sm text-slate-600">You will be the project's owner.</p>
      <FormField
        label="Title"
        error={fieldError('title')}
        required
        hint={`Up to ${TITLE_MAX} characters.`}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX + 50}
          className={fieldControlClass(!!fieldError('title'))}
        />
      </FormField>
      <FormField label="Objectives" error={fieldError('objectives')} hint="Optional.">
        <textarea
          value={objectives}
          onChange={(e) => setObjectives(e.target.value)}
          rows={3}
          maxLength={OBJECTIVES_MAX + 50}
          className={fieldControlClass(!!fieldError('objectives'))}
        />
      </FormField>
      <FormField
        label="Start date"
        error={fieldError('start_date')}
        hint="Optional. Cannot be changed later."
      >
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className={fieldControlClass(!!fieldError('start_date'))}
        />
      </FormField>
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
          {save.submitting ? 'Creating…' : 'Create project'}
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
