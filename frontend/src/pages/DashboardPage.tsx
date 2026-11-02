// Owner: B (Frontend)
// Purpose: Projects, sites, samples, recent activity
//
// The landing page. GET /api/dashboard/summary counts the projects, sites, samples and approved
// detections the user can see (one project with ?project_id, kept in the URL) and, for roles
// that may read the audit log (administrator; principal investigator for their projects), the
// five newest audit entries. Each count links to the page with the details. "Waiting for you"
// lists the work the user's role can do next, with counts from the list endpoints (meta.total of
// a one-row page). Empty data (no project yet, a project with no samples) says what to do next.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CaveatBanner } from '../components/common/CaveatBanner';
import { ErrorState } from '../components/common/ErrorState';
import { FormField, fieldControlClass } from '../components/common/FormField';
import { LoadingState } from '../components/common/LoadingState';
import { useAuth } from '../hooks/useAuth';
import { useFetch } from '../hooks/useFetch';
import { useProjectIndex, useUserNames } from '../hooks/useLookups';
import { idParam, useQueryFilters } from '../hooks/useQueryFilters';
import type { DashboardSummary, PageMeta } from '../types';
import { formatDateTime, humanize } from '../utils/format';
import {
  activityLink,
  describeAction,
  describeDetail,
  withoutDuplicateDecisions,
} from './dashboard/activity';

function Tile({
  label,
  value,
  to,
  note,
}: {
  label: string;
  value: number;
  to: string;
  note: string;
}) {
  return (
    <Link
      to={to}
      className="group block rounded-lg border border-slate-200 bg-white p-4 hover:border-emerald-600 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-200"
    >
      <span className="block text-sm font-medium text-slate-600">{label}</span>
      <span className="mt-1 block text-3xl font-semibold tabular-nums text-slate-900">
        {value.toLocaleString()}
      </span>
      <span className="mt-1 block text-xs text-slate-500 group-hover:text-emerald-800">{note}</span>
    </Link>
  );
}

/** The total of a list endpoint, read from a one-row page; null until known (or when skipped). */
function useTotal(path: string | null, query: Record<string, string | number | undefined> = {}) {
  const res = useFetch<unknown[], PageMeta>(path, { ...query, limit: 1 });
  return { total: res.meta?.total ?? null, error: res.error };
}

function WaitingItem({
  count,
  to,
  children,
}: {
  count: number | null;
  to: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-slate-50"
      >
        <span className="text-sm text-slate-800">{children}</span>
        <span
          className={`min-w-8 rounded-full px-2 py-0.5 text-center text-sm font-semibold tabular-nums ${
            count ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {count === null ? '…' : count}
        </span>
      </Link>
    </li>
  );
}

export default function DashboardPage() {
  const { user, can } = useAuth();
  const names = useUserNames();
  const projects = useProjectIndex();
  const [filters, setFilters] = useQueryFilters(['project_id'] as const);
  const projectId = idParam(filters.project_id);
  const project = projectId ? (projects.byId.get(Number(projectId)) ?? null) : null;
  const summary = useFetch<DashboardSummary>('/dashboard/summary', { project_id: projectId });
  const role = project?.your_role;

  // Work waiting for this role. Analyses and extractions are counted in all the user's projects
  // (those lists take no project filter); samples in the chosen project.
  const canDecide = can('decide_analysis');
  const canAnalyse = can('create_analysis');
  const canLab = can('record_lab');
  const canStore = can('change_sample_status');
  const showWaiting = canDecide || canAnalyse || canLab || canStore;
  const toApprove = useTotal(canDecide ? '/analyses' : null, { status: 'imported' });
  const drafts = useTotal(canAnalyse ? '/analyses' : null, { status: 'draft' });
  const pendingQc = useTotal(canLab ? '/extractions' : null, { qc_status: 'pending' });
  const collected = useTotal(canStore ? '/samples' : null, {
    status: 'collected',
    project_id: projectId,
  });

  const first = user?.full_name.split(' ')[0] ?? '';
  const scoped = (path: string) => (projectId ? `${path}?project_id=${projectId}` : path);
  const data = summary.data;
  const canAudit = can('read_audit_log');
  const canRecord = can('create_event_sample', projectId ? role : undefined);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-slate-600">
            {first ? `Welcome back, ${first}. ` : ''}
            {project
              ? `${project.title}: ${humanize(project.status)}${role ? `, you are ${role === 'owner' ? 'its owner' : `a ${role}`}` : ''}.`
              : 'Your projects at a glance.'}
          </p>
        </div>
        <div className="w-72">
          <FormField label="Project">
            <select
              value={projectId ?? ''}
              onChange={(e) => setFilters({ project_id: e.target.value })}
              className={fieldControlClass()}
            >
              <option value="">All my projects</option>
              {projects.list.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.title}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </div>

      {summary.error && !data ? (
        <ErrorState
          error={summary.error}
          title="Could not load the dashboard"
          onRetry={summary.reload}
        />
      ) : !data ? (
        <LoadingState label="Loading the dashboard…" />
      ) : data.projects === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
          <h2 className="text-lg font-semibold text-slate-900">You are not in a project yet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-600">
            Everything in eBioTrack belongs to a project: sites, collection events, samples and
            their results.{' '}
            {can('create_project')
              ? 'Create your first project to start.'
              : 'Ask a principal investigator to add you to their project.'}
          </p>
          {can('create_project') && (
            <Link
              to="/projects"
              className="mt-4 inline-block rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Go to projects
            </Link>
          )}
        </div>
      ) : (
        <>
          {summary.error ? (
            <ErrorState
              error={summary.error}
              title="Could not refresh the dashboard"
              onRetry={summary.reload}
            />
          ) : null}
          <div
            role="group"
            aria-label="At a glance"
            className={`grid gap-4 sm:grid-cols-2 xl:grid-cols-4 ${summary.status === 'loading' ? 'opacity-60' : ''}`}
            aria-busy={summary.status === 'loading' || undefined}
          >
            <Tile
              label={data.projects === 1 ? 'Project' : 'Projects'}
              value={data.projects}
              to={projectId ? `/projects/${projectId}` : '/projects'}
              note={projectId ? 'Open the project' : 'All the projects you are in'}
            />
            <Tile
              label="Sites"
              value={data.sites}
              to={scoped('/map')}
              note="See them on the sampling map"
            />
            <Tile
              label="Samples"
              value={data.samples}
              to={scoped('/samples')}
              note="Every sample, in any status"
            />
            <Tile
              label="Approved detections"
              value={data.approved_detections}
              to={scoped('/analytics')}
              note="Approved analyses, QC flag pass"
            />
          </div>

          {data.samples === 0 ? (
            <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              No samples yet{project ? ` in ${project.title}` : ''}.{' '}
              {canRecord ? (
                <>
                  <Link to="/events" className="text-emerald-700 underline">
                    Record a collection event
                  </Link>{' '}
                  to register the first ones.
                </>
              ) : (
                'They appear here once a collection event is recorded.'
              )}
            </p>
          ) : data.approved_detections === 0 ? (
            <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              No approved detections yet. They are counted once an analysis of these samples is
              approved.
            </p>
          ) : null}

          <CaveatBanner
            notes={[
              'Approved detections are rows of approved analyses with QC flag pass; warn and fail rows are never counted.',
            ]}
            approvedOnly={false}
          />

          {(showWaiting || canAudit) && (
            <div className="grid gap-6 lg:grid-cols-2">
              {showWaiting && (
                <section aria-labelledby="waiting-heading" className="space-y-2">
                  <h2 id="waiting-heading" className="text-lg font-semibold">
                    Waiting for you
                  </h2>
                  <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                    {canDecide && (
                      <WaitingItem count={toApprove.total} to="/analyses/import?status=imported">
                        Analyses waiting for approval
                        <span className="block text-xs text-slate-500">In all your projects</span>
                      </WaitingItem>
                    )}
                    {canAnalyse && (
                      <WaitingItem count={drafts.total} to="/analyses/import?status=draft">
                        Draft analyses waiting for their CSV
                        <span className="block text-xs text-slate-500">In all your projects</span>
                      </WaitingItem>
                    )}
                    {canLab && (
                      <WaitingItem count={pendingQc.total} to="/lab?qc_status=pending">
                        Extractions waiting for a QC verdict
                        <span className="block text-xs text-slate-500">In all your projects</span>
                      </WaitingItem>
                    )}
                    {canStore && (
                      <WaitingItem
                        count={collected.total}
                        to={`/samples?status=collected${projectId ? `&project_id=${projectId}` : ''}`}
                      >
                        Samples collected but not yet stored
                        <span className="block text-xs text-slate-500">
                          {project ? `In ${project.title}` : 'In all your projects'}
                        </span>
                      </WaitingItem>
                    )}
                  </ul>
                </section>
              )}

              {canAudit && (
                <section aria-labelledby="activity-heading" className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 id="activity-heading" className="text-lg font-semibold">
                      Recent activity
                    </h2>
                    <Link
                      to="/admin?tab=audit"
                      className="text-sm text-emerald-700 hover:underline"
                    >
                      Full audit log
                    </Link>
                  </div>
                  {data.recent_activity.length === 0 ? (
                    <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
                      No activity {project ? `in ${project.title}` : 'in your projects'} yet.
                    </p>
                  ) : (
                    <ol
                      aria-label="Recent activity"
                      className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white"
                    >
                      {withoutDuplicateDecisions(data.recent_activity).map((entry) => {
                        const link = activityLink(entry, {
                          canOpenAnalyses: canAnalyse,
                          canManageUsers: can('manage_users'),
                        });
                        const detail = describeDetail(entry, (id) => names(id));
                        const what = (
                          <>
                            <span className="font-medium">
                              {names(entry.actor_id, entry.actor_name)}
                            </span>{' '}
                            {describeAction(entry)}
                          </>
                        );
                        return (
                          <li key={entry.audit_id} className="px-3 py-2 text-sm">
                            <p className="text-slate-800">
                              {link ? (
                                <Link to={link} className="hover:text-emerald-800 hover:underline">
                                  {what}
                                </Link>
                              ) : (
                                what
                              )}
                            </p>
                            {detail && (
                              <p className="truncate text-xs text-slate-600" title={detail}>
                                {detail}
                              </p>
                            )}
                            <p className="text-xs text-slate-500">
                              {formatDateTime(entry.created_at)}
                            </p>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
              )}
            </div>
          )}

          <nav aria-label="Go to" className="flex flex-wrap gap-2 text-sm">
            {[
              ['/projects', 'Projects'],
              [scoped('/map'), 'Sampling map'],
              [scoped('/events'), 'Collection events'],
              [scoped('/samples'), 'Samples'],
              ['/lab', 'Lab processing'],
              ['/species', 'Species explorer'],
              [scoped('/analytics'), 'Biodiversity analytics'],
            ].map(([to, label]) => (
              <Link
                key={label}
                to={to}
                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:border-emerald-600 hover:text-emerald-800"
              >
                {label}
              </Link>
            ))}
          </nav>
        </>
      )}
    </section>
  );
}
