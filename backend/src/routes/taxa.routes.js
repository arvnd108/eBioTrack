// Owner: A (Backend)
// Purpose: Route definitions: taxa and detection history
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/taxa.controller.js';
import { auth } from '../middleware/auth.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import { TAXON_RANKS } from '../utils/csv.js';
import {
  fromNotAfterTo,
  fromNotAfterToIssue,
  idString,
  pageQuery,
  rangeFrom,
  rangeTo,
} from '../utils/schemas.js';

const listQuery = z.object({
  q: z.string().trim().min(1, 'must not be blank').max(200).optional(),
  rank: z.enum(TAXON_RANKS).optional(),
  parent_taxon_id: idString.optional(),
  ...pageQuery,
});
const detectionsQuery = z
  .object({
    project_id: idString.optional(),
    site_id: idString.optional(),
    from: rangeFrom.optional(),
    to: rangeTo.optional(),
    ...pageQuery,
  })
  .refine(fromNotAfterTo, fromNotAfterToIssue);
const idParams = z.object({ id: idString });

// Reads only. Taxa are reference data (any signed-in user); detections are scoped to the caller's
// projects in the service.
const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['scientific_name', 'taxon_id'] }),
  controller.listTaxa,
);
router.get('/:id', auth, validate({ params: idParams }), controller.getTaxon);
router.get(
  '/:id/detections',
  auth,
  validate({ params: idParams, query: detectionsQuery }),
  pagination({ strict: true, allowedSortFields: ['collected_at'] }),
  controller.listDetections,
);

export default router;
