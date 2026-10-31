// Owner: A (Backend)
// Purpose: Route definitions: users (administration) and roles
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/users.controller.js';
import { auth } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { ROLES } from '../middleware/permissions.js';
import { validate } from '../middleware/validate.js';
import { atLeastOneKey, booleanString, idNumber, idString, pageQuery } from '../utils/schemas.js';

// bcrypt only uses the first 72 bytes, so longer passwords are rejected instead of truncated.
const password = z
  .string()
  .min(8, 'must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value) <= 72, 'must be at most 72 bytes');
const fullName = z.string().trim().min(1, 'must not be blank').max(200);
const roleIds = z
  .array(idNumber)
  .min(1, 'at least one role is required')
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'must not contain duplicates');

const listQuery = z.object({
  active: booleanString.optional(),
  role: z.enum(Object.values(ROLES)).optional(),
  ...pageQuery,
});
const createBody = z.strictObject({
  full_name: fullName,
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password,
  role_ids: roleIds,
});
const patchBody = z
  .strictObject({
    active: z.boolean().optional(),
    full_name: fullName.optional(),
    role_ids: roleIds.optional(),
  })
  .refine(atLeastOneKey, 'at least one of active, full_name, role_ids is required');
const idParams = z.object({ id: idString });

export const usersRouter = Router();
usersRouter.get(
  '/',
  auth,
  authorize('manage_users'),
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['user_id', 'full_name', 'email'] }),
  controller.listUsers,
);
usersRouter.post(
  '/',
  auth,
  authorize('manage_users'),
  validate({ body: createBody }),
  controller.createUser,
);
usersRouter.patch(
  '/:id',
  auth,
  authorize('manage_users'),
  validate({ params: idParams, body: patchBody }),
  controller.updateUser,
);

export const rolesRouter = Router();
rolesRouter.get('/', auth, controller.listRoles);
