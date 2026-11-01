// Owner: B (Frontend)
// Purpose: Hook: where the signed-in user may record lab work (record_lab, CONTRACT 9)
//
// record_lab is project-scoped: an administrator anywhere; a principal investigator or lab
// technician in a project where they are not a viewer. Lab rows carry their project_id
// (CONTRACT 1.7), so a page asks per row:
//   const lab = useLabAccess();
//   lab.canWrite(extraction.project_id)   // this row's buttons
//   lab.writableProjects                  // projects to offer in a form
//   lab.any                               // show "New ..." buttons at all
// Batches carry no project, so creating one needs only the global role (lab.canCreateBatch).

import { useCallback, useMemo } from 'react';
import { useAuth } from './useAuth';
import { useProjectIndex } from './useLookups';

export function useLabAccess() {
  const { can } = useAuth();
  const projects = useProjectIndex();
  const writableProjects = useMemo(
    () => projects.list.filter((p) => can('record_lab', p.your_role)),
    [projects.list, can],
  );
  const canWrite = useCallback(
    (projectId: number) => {
      const project = projects.byId.get(projectId);
      return project ? can('record_lab', project.your_role) : false;
    },
    [projects.byId, can],
  );
  return {
    projects,
    writableProjects,
    canWrite,
    any: writableProjects.length > 0,
    canCreateBatch: can('record_lab'),
  };
}
