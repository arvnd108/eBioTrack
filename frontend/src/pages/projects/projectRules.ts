// Owner: B (Frontend)
// Purpose: Project form checks, with the API's limits (backend routes/projects.routes.js)
//
// title: required, at most 300 characters after trimming; objectives: at most 5000;
// dates: real calendar dates `YYYY-MM-DD`; end_date on or after start_date (ck_projects_dates).
// The API checks all of this again; these give plain messages before anything is sent.

import { formatDate } from '../../utils/format';

export type ProjectField = 'title' | 'objectives' | 'start_date' | 'status' | 'end_date';
export type ProjectErrors = Partial<Record<ProjectField, string>>;

export const TITLE_MAX = 300;
export const OBJECTIVES_MAX = 5000;

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function checkProject(values: {
  title: string;
  objectives: string;
  start_date?: string;
  end_date?: string;
  /** The saved start date, when editing (it cannot be changed after creation). */
  savedStartDate?: string | null;
}): ProjectErrors {
  const errors: ProjectErrors = {};
  const title = values.title.trim();
  if (!title) errors.title = 'Enter a title.';
  else if (title.length > TITLE_MAX)
    errors.title = `Title must be at most ${TITLE_MAX} characters.`;

  if (values.objectives.trim().length > OBJECTIVES_MAX) {
    errors.objectives = `Objectives must be at most ${OBJECTIVES_MAX} characters.`;
  }
  if (values.start_date && !isCalendarDate(values.start_date)) {
    errors.start_date = 'Enter a real date.';
  }
  if (values.end_date) {
    const start = values.savedStartDate ?? values.start_date ?? null;
    if (!isCalendarDate(values.end_date)) errors.end_date = 'Enter a real date.';
    else if (start && values.end_date < start) {
      errors.end_date = `End date must be on or after the start date (${formatDate(start)}).`;
    }
  }
  return errors;
}

/** Message for 409 `duplicate` on a project title (the API sends the database's text). */
export const DUPLICATE_TITLE = 'A project with this title already exists. Choose another title.';
