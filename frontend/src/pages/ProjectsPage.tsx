// Owner: B (Frontend)
// Purpose: Create, edit, manage collaborators
//
// The project list (GET /api/projects: only projects the user belongs to; every project for an
// administrator), with a status filter, API sorting and pagination, and the New project form for
// roles with `create_project` (administrator, principal investigator). Each title opens the
// project's page (ProjectDetailPage), where members, sites and details are managed.

import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../components/common/Badge';
import { Can } from '../components/common/Can';
import { DataTable, type Column } from '../components/common/DataTable';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { useFetch } from '../hooks/useFetch';
import { usePagination } from '../hooks/usePagination';
import type { PageMeta, Project, ProjectStatus } from '../types';
import { formatDate } from '../utils/format';
import { CreateProjectForm } from './projects/CreateProjectForm';

const STATUSES: ProjectStatus[] = ['planned', 'active', 'completed', 'archived'];

const columns: Column<Project>[] = [
  {
    key: 'title',
    header: 'Title',
    sortField: 'title',
    render: (p) => (
      <Link
        to={`/projects/${p.project_id}`}
        className="font-medium text-emerald-700 hover:underline"
      >
        {p.title}
      </Link>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortField: 'status',
    render: (p) => <Badge value={p.status} />,
  },
  {
    key: 'start_date',
    header: 'Start',
    sortField: 'start_date',
    render: (p) => formatDate(p.start_date),
  },
  { key: 'end_date', header: 'End', render: (p) => formatDate(p.end_date) },
  {
    key: 'your_role',
    header: 'Your role',
    // Administrators see every project without being a member.
    render: (p) =>
      p.your_role ? (
        <Badge value={p.your_role} />
      ) : (
        <span className="text-slate-500">Administrator access</span>
      ),
  },
];

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ProjectStatus | ''>('');
  const [creating, setCreating] = useState(false);
  const pager = usePagination({ initialSort: 'title' });
  const projects = useFetch<Project[], PageMeta>('/projects', {
    status: status || undefined,
    ...pager.query,
  });
  const { resetPage } = pager;

  const changeStatus = useCallback(
    (value: string) => {
      setStatus(value as ProjectStatus | '');
      resetPage();
    },
    [resetPage],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
          <p className="mt-1 text-slate-600">
            Projects you belong to, with their members and sites.
          </p>
        </div>
        <Can action="create_project">
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              New project
            </button>
          )}
        </Can>
      </div>

      {creating && (
        <CreateProjectForm
          onCancel={() => setCreating(false)}
          onCreated={(project) => navigate(`/projects/${project.project_id}`)}
        />
      )}

      <div className="max-w-xs">
        <FormField label="Status">
          <select
            value={status}
            onChange={(e) => changeStatus(e.target.value)}
            className={fieldControlClass()}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <DataTable
        caption="Projects"
        columns={columns}
        rows={projects.data}
        rowKey={(p) => p.project_id}
        loading={projects.status === 'loading'}
        error={projects.error}
        onRetry={projects.reload}
        sort={pager.sort}
        onSortChange={pager.setSort}
        pagination={projects.meta ? { meta: projects.meta, onPageChange: pager.setPage } : null}
        emptyTitle={status ? `No ${status} projects` : 'No projects yet'}
        emptyDescription={
          status
            ? 'Try another status.'
            : 'You are not a member of any project. A principal investigator can add you to one.'
        }
      />
    </section>
  );
}
