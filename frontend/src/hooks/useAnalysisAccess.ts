// Owner: B (Frontend)
// Purpose: Hook: who may create, import into and decide which analyses (CONTRACT 9)
//
// An analysis belongs to the projects of its sequencing run's samples (a run can span projects).
// create_analysis (create, import) is an administrator anywhere, or a principal investigator or
// analyst who is a non-viewer member of one of those projects; decide_analysis (approve, reject)
// the same for principal investigators. The run's libraries carry their project_id
// (GET /api/sequencing-runs/:id, CONTRACT 1.7), so a page asks with those ids:
//   const access = useAnalysisAccess();
//   access.canCreateIn(projectIds)   // import into this analysis, start a correction
//   access.canDecideIn(projectIds)   // approve or reject it

import { useCallback } from 'react';
import type { Action } from '../permissions';
import { useAuth } from './useAuth';
import { useProjectIndex } from './useLookups';

export function useAnalysisAccess() {
  const { user, can } = useAuth();
  const projects = useProjectIndex();
  const isAdmin = !!user?.roles.includes('administrator');
  const allowedIn = useCallback(
    (action: Action, projectIds: readonly number[]) =>
      isAdmin ||
      projectIds.some((id) => {
        const project = projects.byId.get(id);
        return project ? can(action, project.your_role) : false;
      }),
    [isAdmin, projects.byId, can],
  );
  return {
    projects,
    userId: user?.user_id ?? null,
    /** The global role allows creating analyses at all ("New analysis" button). */
    canCreate: can('create_analysis'),
    canCreateIn: useCallback(
      (ids: readonly number[]) => allowedIn('create_analysis', ids),
      [allowedIn],
    ),
    canDecideIn: useCallback(
      (ids: readonly number[]) => allowedIn('decide_analysis', ids),
      [allowedIn],
    ),
  };
}
