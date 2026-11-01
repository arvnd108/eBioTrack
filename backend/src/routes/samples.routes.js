// Owner: A (Backend)
// Purpose: Route definitions: samples, detail and status history
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/samples.controller.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { ROLES } from '../middleware/permissions.js';
import { validate } from '../middleware/validate.js';
import { idNumber, idString, pageQuery } from '../utils/schemas.js';

export const SAMPLE_STATUSES = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];

// numeric(10,2) and numeric(8,2) limits; positive volume, non-negative depth (the CHECKs and
// register_sample() are the authority).
export const volumeMl = z.number().positive('must be greater than 0').max(99999999.99);
export const depthM = z.number().min(0, 'must be 0 or more').max(999999.99);
export const storageLocation = z.string().trim().min(1, 'must not be blank').max(200);

const listQuery = z.object({
  project_id: idString.optional(),
  site_id: idString.optional(),
  event_id: idString.optional(),
  status: z.enum(SAMPLE_STATUSES).optional(),
  q: z.string().trim().min(1).max(64).optional(),
  ...pageQuery,
});
const createBody = z.strictObject({
  event_id: idNumber,
  sample_type_id: idNumber,
  volume_ml: volumeMl.nullish(),
  depth_m: depthM.nullish(),
  storage_location: storageLocation.nullish(),
});
const statusBody = z.strictObject({
  new_status: z.enum(SAMPLE_STATUSES),
  note: z.string().trim().max(1000).nullish(),
});
const idParams = z.object({ id: idString });

// Reads: any signed-in user, rows limited to their projects. Writes: global role gate here, then
// the project check in the service (the project comes from the event or the sample).
export const sampleTypesRouter = Router();
sampleTypesRouter.get('/', auth, controller.listSampleTypes);

const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['sample_id', 'sample_code', 'created_at'] }),
  controller.listSamples,
);
router.post(
  '/',
  auth,
  requireRole(ROLES.PRINCIPAL_INVESTIGATOR, ROLES.FIELD_RESEARCHER),
  validate({ body: createBody }),
  controller.createSample,
);
router.get('/:id', auth, validate({ params: idParams }), controller.getSample);
router.patch(
  '/:id/status',
  auth,
  requireRole(ROLES.PRINCIPAL_INVESTIGATOR, ROLES.FIELD_RESEARCHER, ROLES.LAB_TECHNICIAN),
  validate({ params: idParams, body: statusBody }),
  controller.changeSampleStatus,
);

export default router;
