// Owner: A (Backend)
// Purpose: Route definitions: richness, detection frequency and the dashboard summary
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/analytics.controller.js';
import { auth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  fromNotAfterTo,
  fromNotAfterToIssue,
  idString,
  rangeFrom,
  rangeTo,
} from '../utils/schemas.js';

const richnessQuery = z
  .strictObject({
    project_id: idString.optional(),
    site_id: idString.optional(),
    group_by: z.enum(['year', 'month', 'site']).default('year'),
    from: rangeFrom.optional(),
    to: rangeTo.optional(),
  })
  .refine(fromNotAfterTo, fromNotAfterToIssue);
const frequencyQuery = z.strictObject({
  taxon_id: idString,
  project_id: idString.optional(),
});
const dashboardQuery = z.strictObject({ project_id: idString.optional() });

// Reads for every signed-in role (CONTRACT 9: approved detections, analytics are readable by all);
// the data is scoped to the caller's projects in the service. Not paginated: one row per group.
export const analyticsRouter = Router();
analyticsRouter.get('/richness', auth, validate({ query: richnessQuery }), controller.richness);
analyticsRouter.get(
  '/detection-frequency',
  auth,
  validate({ query: frequencyQuery }),
  controller.detectionFrequency,
);

export const dashboardRouter = Router();
dashboardRouter.get(
  '/summary',
  auth,
  validate({ query: dashboardQuery }),
  controller.dashboardSummary,
);

export default analyticsRouter;
