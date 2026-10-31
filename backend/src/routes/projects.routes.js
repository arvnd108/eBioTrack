// Owner: A (Backend)
// Purpose: Route definitions: projects and members
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/projects.controller.js';
import { auth } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import { atLeastOneKey, calendarDate, idNumber, idString, pageQuery } from '../utils/schemas.js';

const PROJECT_STATUSES = ['planned', 'active', 'completed', 'archived'];
const title = z.string().trim().min(1, 'must not be blank').max(300);
const objectives = z.string().trim().max(5000);

const listQuery = z.object({ status: z.enum(PROJECT_STATUSES).optional(), ...pageQuery });
const createBody = z.strictObject({
  title,
  objectives: objectives.nullish(),
  start_date: calendarDate.nullish(),
});
const patchBody = z
  .strictObject({
    title: title.optional(),
    objectives: objectives.nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    end_date: calendarDate.nullable().optional(),
  })
  .refine(atLeastOneKey, 'at least one of title, objectives, status, end_date is required');
// `owner` is accepted by the schema so the service can answer with a clear rule_violation.
const memberBody = z.strictObject({
  user_id: idNumber,
  project_role: z.enum(['owner', 'manager', 'contributor', 'viewer']),
});
const siteBody = z.strictObject({ site_id: idNumber });

const idParams = z.object({ id: idString });
const memberParams = z.object({ id: idString, userId: idString });
const siteParams = z.object({ id: idString, siteId: idString });

// auth first (401), then the permission gate (403/404), then validation, so a caller who may not
// touch the project learns nothing about the body rules.
const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({
    strict: true,
    allowedSortFields: ['project_id', 'title', 'status', 'start_date'],
  }),
  controller.listProjects,
);
router.post(
  '/',
  auth,
  authorize('create_project'),
  validate({ body: createBody }),
  controller.createProject,
);
router.get(
  '/:id',
  auth,
  authorize('read_project_data'),
  validate({ params: idParams }),
  controller.getProject,
);
router.patch(
  '/:id',
  auth,
  authorize('edit_project'),
  validate({ params: idParams, body: patchBody }),
  controller.updateProject,
);
router.post(
  '/:id/members',
  auth,
  authorize('edit_project'),
  validate({ params: idParams, body: memberBody }),
  controller.addMember,
);
router.delete(
  '/:id/members/:userId',
  auth,
  authorize('edit_project'),
  validate({ params: memberParams }),
  controller.removeMember,
);
router.post(
  '/:id/sites',
  auth,
  authorize('edit_project'),
  validate({ params: idParams, body: siteBody }),
  controller.addSite,
);
router.delete(
  '/:id/sites/:siteId',
  auth,
  authorize('edit_project'),
  validate({ params: siteParams }),
  controller.removeSite,
);

export default router;
