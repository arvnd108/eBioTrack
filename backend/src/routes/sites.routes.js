// Owner: A (Backend)
// Purpose: Route definitions: regions and sampling sites
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/sites.controller.js';
import { auth } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import { atLeastOneKey, idNumber, idString, pageQuery } from '../utils/schemas.js';

const REGION_TYPES = ['country', 'state', 'basin', 'reserve', 'other'];
const HABITAT_TYPES = [
  'river',
  'lake',
  'estuary',
  'marine',
  'wetland',
  'groundwater',
  'soil',
  'other',
];

const name = z.string().trim().min(1, 'must not be blank').max(200);
const description = z.string().trim().max(2000);
const latitude = z
  .number()
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');
const longitude = z
  .number()
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');

const regionQuery = z.object({ region_type: z.enum(REGION_TYPES).optional() });
const listQuery = z.object({
  project_id: idString.optional(),
  region_id: idString.optional(),
  habitat_type: z.enum(HABITAT_TYPES).optional(),
  ...pageQuery,
});
const createBody = z.strictObject({
  region_id: idNumber,
  name,
  latitude,
  longitude,
  habitat_type: z.enum(HABITAT_TYPES),
  description: description.nullish(),
});
const patchBody = z
  .strictObject({
    region_id: idNumber.optional(),
    name: name.optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    habitat_type: z.enum(HABITAT_TYPES).optional(),
    description: description.nullable().optional(),
  })
  .refine(
    atLeastOneKey,
    'at least one of region_id, name, latitude, longitude, habitat_type, description is required',
  );
const idParams = z.object({ id: idString });

// Reads: any signed-in user. Writes: the manage_sites role gate (sites belong to no single
// project, so a field researcher's "own" limit cannot be enforced here).
export const regionsRouter = Router();
regionsRouter.get('/', auth, validate({ query: regionQuery }), controller.listRegions);

const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['site_id', 'name'] }),
  controller.listSites,
);
router.post(
  '/',
  auth,
  authorize('manage_sites'),
  validate({ body: createBody }),
  controller.createSite,
);
router.get('/:id', auth, validate({ params: idParams }), controller.getSite);
router.patch(
  '/:id',
  auth,
  authorize('manage_sites'),
  validate({ params: idParams, body: patchBody }),
  controller.updateSite,
);

export default router;
