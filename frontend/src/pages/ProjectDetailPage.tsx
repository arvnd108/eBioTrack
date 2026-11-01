// Owner: B (Frontend)
// Purpose: One project: details, members and sites (GET /api/projects/:id)
//
// Anyone in the project (or an administrator) can read it; a project the user does not belong
// to is a 404, worded the same as a project that does not exist (CONTRACT 8). Editing details,
// members and sites needs `edit_project`: an administrator, or a principal investigator who is
// the project's owner or manager. The API enforces this; the page hides what the user cannot do.

import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '../components/common/Badge';
import { Can } from '../components/common/Can';
import { ErrorState } from '../components/common/ErrorState';
import { LoadingState } from '../components/common/LoadingState';
import { useAuth } from '../hooks/useAuth';
import { useFetch } from '../hooks/useFetch';
import type { ProjectDetail } from '../types';
import { formatDate } from '../utils/format';
import { EditProjectForm } from './projects/EditProjectForm';
import { MembersSection } from './projects/MembersSection';
import { SitesSection } from './projects/SitesSection';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900">{children}</dd>
    </div>
  );
}

const backLink = (
  <Link to="/projects" className="text-sm text-emerald-700 hover:underline">
    ← All projects
  </Link>
);

export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, can, hasRole } = useAuth();
  const [editing, setEditing] = useState(false);

  const id = Number(projectId);
  const validId = /^[1-9]\d{0,14}$/.test(projectId ?? '');
  const project = useFetch<ProjectDetail>(validId ? `/projects/${id}` : null);

  if (!validId) {
    return (
      <section className="space-y-3">
        {backLink}
        <h1 className="text-2xl font-semibold">Project not found</h1>
      </section>
    );
  }
  if (!project.data) {
    if (project.error) {
      return (
        <section className="space-y-3">
          {backLink}
          <ErrorState
            error={project.error}
            title="Could not open this project"
            onRetry={project.reload}
          />
        </section>
      );
    }
    return <LoadingState label="Loading project…" />;
  }

  const p = project.data;
  const canEdit = can('edit_project', p.your_role);

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        {backLink}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{p.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <Badge value={p.status} />
              {p.your_role ? (
                <>
                  Your role: <Badge value={p.your_role} />
                </>
              ) : (
                'Administrator access'
              )}
            </p>
          </div>
          <Can action="edit_project" projectRole={p.your_role}>
            {!editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                Edit details
              </button>
            )}
          </Can>
        </div>
      </div>

      {project.error ? (
        <ErrorState
          error={project.error}
          title="Could not refresh this project"
          onRetry={project.reload}
        />
      ) : null}

      {editing ? (
        <EditProjectForm
          project={p}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            project.reload();
          }}
        />
      ) : (
        <p className="whitespace-pre-line text-slate-700">
          {p.objectives || 'No objectives recorded.'}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Owner">{p.owner_name ?? '—'}</Fact>
        <Fact label="Start date">{formatDate(p.start_date)}</Fact>
        <Fact label="End date">{formatDate(p.end_date)}</Fact>
        <Fact label="Members">{p.member_count}</Fact>
        <Fact label="Sites">{p.site_count}</Fact>
        <Fact label="Collection events">{p.event_count}</Fact>
        <Fact label="Samples">{p.sample_count}</Fact>
        <Fact label="Managers / contributors / viewers">
          {p.manager_count} / {p.contributor_count} / {p.viewer_count}
        </Fact>
      </dl>

      <MembersSection
        project={p}
        canEdit={canEdit}
        currentUserId={user?.user_id ?? 0}
        onChanged={(leftProject) => {
          // A principal investigator who leaves may no longer see the project.
          if (leftProject && !hasRole('administrator')) navigate('/projects', { replace: true });
          else project.reload();
        }}
      />
      <SitesSection project={p} canEdit={canEdit} onChanged={project.reload} />
    </section>
  );
}
