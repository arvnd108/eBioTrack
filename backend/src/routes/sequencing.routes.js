// Owner: A (Backend)
// Purpose: Route definitions: sequencing libraries and runs
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/sequencing.controller.js';
import { auth } from '../middleware/auth.js';
import { requireAction } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import { calendarDate, idNumber, idString, pageQuery } from '../utils/schemas.js';

const RUN_STATUSES = ['planned', 'running', 'completed', 'failed'];
const MAX_EXTRACTIONS_PER_RUN = 500;

const listQuery = z.object({
  lab_id: idString.optional(),
  status: z.enum(RUN_STATUSES).optional(),
  ...pageQuery,
});
const createBody = z.strictObject({
  lab_id: idNumber,
  platform: z.string().trim().min(1, 'must not be blank').max(100),
  run_date: calendarDate,
  extraction_ids: z
    .array(idNumber)
    .min(1, 'at least one extraction is required')
    .max(MAX_EXTRACTIONS_PER_RUN)
    .refine((ids) => new Set(ids).size === ids.length, 'extraction_ids must be distinct'),
});
const libraryBody = z.strictObject({ extraction_id: idNumber });
const statusBody = z.strictObject({ status: z.enum(RUN_STATUSES) });
const idParams = z.object({ id: idString });

const recordLab = requireAction('record_lab');

const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['run_id', 'created_at'] }),
  controller.listRuns,
);
router.get('/:id', auth, validate({ params: idParams }), controller.getRun);
router.post('/', auth, recordLab, validate({ body: createBody }), controller.createRun);
router.post(
  '/:id/libraries',
  auth,
  recordLab,
  validate({ params: idParams, body: libraryBody }),
  controller.addLibrary,
);
router.patch(
  '/:id',
  auth,
  recordLab,
  validate({ params: idParams, body: statusBody }),
  controller.updateRunStatus,
);

export default router;
