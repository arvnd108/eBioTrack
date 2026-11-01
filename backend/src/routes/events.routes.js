// Owner: A (Backend)
// Purpose: Route definitions: collection events and environmental measurements
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/events.controller.js';
import { auth } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import {
  fromNotAfterTo,
  fromNotAfterToIssue,
  idNumber,
  idString,
  pageQuery,
  rangeFrom,
  rangeTo,
} from '../utils/schemas.js';
import { depthM, storageLocation, volumeMl } from './samples.routes.js';

// Caps on one request: at most 50 measurements and 100 samples.
const MAX_MEASUREMENTS = 50;
const MAX_SAMPLES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const listQuery = z
  .object({
    project_id: idString.optional(),
    site_id: idString.optional(),
    from: rangeFrom.optional(),
    to: rangeTo.optional(),
    ...pageQuery,
  })
  .refine(fromNotAfterTo, fromNotAfterToIssue);

const measurement = z.strictObject({
  parameter: z.string().trim().min(1, 'must not be blank').max(100),
  value: z.number(),
  unit: z.string().trim().min(1, 'must not be blank').max(50),
});
const sample = z.strictObject({
  sample_type_id: idNumber,
  volume_ml: volumeMl.nullish(),
  depth_m: depthM.nullish(),
  storage_location: storageLocation.nullish(),
});
const createBody = z
  .strictObject({
    project_id: idNumber,
    site_id: idNumber,
    collected_at: z.iso
      .datetime({ offset: true })
      .refine((value) => new Date(value).getTime() <= Date.now() + DAY_MS, {
        message: 'must not be more than one day in the future',
      }),
    notes: z.string().trim().max(5000).nullish(),
    measurements: z.array(measurement).max(MAX_MEASUREMENTS).optional(),
    samples: z.array(sample).max(MAX_SAMPLES).optional(),
  })
  .superRefine((body, ctx) => {
    const seen = new Set();
    (body.measurements ?? []).forEach((m, index) => {
      if (seen.has(m.parameter)) {
        ctx.addIssue({
          code: 'custom',
          path: ['measurements', index, 'parameter'],
          message: 'appears more than once in this request',
        });
      }
      seen.add(m.parameter);
    });
  });
const idParams = z.object({ id: idString });

// POST: auth, then the matrix action (global role + membership of body.project_id; a project
// viewer is refused), then validation.
const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['event_id', 'collected_at'] }),
  controller.listEvents,
);
router.post(
  '/',
  auth,
  authorize('create_event_sample', { source: 'body.project_id' }),
  validate({ body: createBody }),
  controller.createEvent,
);
router.get('/:id', auth, validate({ params: idParams }), controller.getEvent);

export default router;
