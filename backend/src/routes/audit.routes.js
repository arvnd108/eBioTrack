// Owner: A (Backend)
// Purpose: Route definitions: authorized audit history
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/audit.controller.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import { idString, pageQuery } from '../utils/schemas.js';

const timestamp = z.iso.datetime({ offset: true });
// A table name only: letters, digits and underscore. It is bound as a parameter, never interpolated.
const entityType = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a table name');

const listQuery = z
  .object({
    entity_type: entityType.optional(),
    entity_id: idString.optional(),
    actor_id: idString.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
    ...pageQuery,
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
    path: ['from'],
    message: 'must not be after to',
  });

const router = Router();
// The administrator passes requireRole always; a principal_investigator sees own-project entries only
// (scoped in the service, since the audit log has no project column).
router.get(
  '/',
  auth,
  requireRole('principal_investigator'),
  validate({ query: listQuery }),
  pagination({ strict: true }),
  controller.listAudit,
);

export default router;
