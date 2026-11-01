// Owner: B (Frontend)
// Purpose: show content only when the user's role allows an action
//
// Hides buttons and links the user could not use, with the same rules as the API
// (src/permissions.ts mirrors CONTRACT 9 and backend/src/middleware/permissions.js):
//
//   <Can action="create_project">
//     <button>New project</button>
//   </Can>
//
//   <Can action="edit_project" projectRole={project.your_role}>
//     <button>Edit</button>
//   </Can>
//
// Hiding is a convenience, not security: the API still refuses the request on its own.

import type { ReactNode } from 'react';
import { useAuth } from '../../hooks/useAuth';
import type { Action } from '../../permissions';
import type { ProjectRole } from '../../types';

interface CanProps {
  /** One action, or several where any one is enough. */
  action: Action | readonly Action[];
  /** The user's role in the target project (`your_role`); leave out where no project applies. */
  projectRole?: ProjectRole | null;
  children: ReactNode;
  /** Shown instead when not allowed (nothing by default). */
  fallback?: ReactNode;
}

export function Can({ action, projectRole, children, fallback = null }: CanProps) {
  const { canAny } = useAuth();
  const actions: readonly Action[] = typeof action === 'string' ? [action] : action;
  return <>{canAny(actions, projectRole) ? children : fallback}</>;
}
