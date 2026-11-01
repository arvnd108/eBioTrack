// Owner: A (Backend)
// Purpose: Route definitions: CSV report exports
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/exports.controller.js';
import { auth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  fromNotAfterTo,
  fromNotAfterToIssue,
  idNumber,
  idString,
  rangeFrom,
  rangeTo,
} from '../utils/schemas.js';

const SAMPLE_STATUSES = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];

// Each export type accepts only its own filter keys (strict: an unknown key is a 422).
const range = { from: rangeFrom.optional(), to: rangeTo.optional() };
const filtersFor = (shape) =>
  z.strictObject({ ...shape, ...range }).refine(fromNotAfterTo, fromNotAfterToIssue);
const body = (type, filters) =>
  z.strictObject({
    export_type: z.literal(type),
    project_id: idNumber,
    filters: filters.optional(),
  });

const createBody = z.discriminatedUnion('export_type', [
  body(
    'samples_csv',
    filtersFor({ site_id: idNumber.optional(), status: z.enum(SAMPLE_STATUSES).optional() }),
  ),
  body(
    'detections_csv',
    filtersFor({ site_id: idNumber.optional(), taxon_id: idNumber.optional() }),
  ),
  body(
    'richness_csv',
    filtersFor({
      site_id: idNumber.optional(),
      group_by: z.enum(['year', 'month', 'site']).optional(),
    }),
  ),
]);
const idParams = z.object({ id: idString });

// An export is a READ: every signed-in role may ask, project role `viewer` included, so there is
// no write gate here; project access is checked in the service. Download: the requester only.
const router = Router();
router.post('/', auth, validate({ body: createBody }), controller.createExport);
router.get('/:id/download', auth, validate({ params: idParams }), controller.downloadExport);

export default router;
