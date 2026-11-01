// Owner: A (Backend)
// Purpose: Route definitions: analysis runs, CSV import, transactional approval
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import * as controller from '../controllers/analyses.controller.js';
import { auth } from '../middleware/auth.js';
import { requireRole } from '../middleware/authorize.js';
import { AppError, unprocessable } from '../middleware/errorHandler.js';
import { pagination } from '../middleware/pagination.js';
import { ROLES } from '../middleware/permissions.js';
import { validate } from '../middleware/validate.js';
import { booleanString, idNumber, idString, pageQuery } from '../utils/schemas.js';

const STATUSES = ['draft', 'imported', 'approved', 'rejected', 'superseded'];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const listQuery = z.object({
  run_id: idString.optional(),
  status: z.enum(STATUSES).optional(),
  marker_id: idString.optional(),
  ...pageQuery,
});
const text = (max) => z.string().trim().min(1, 'must not be blank').max(max);
const createBody = z.strictObject({
  run_id: idNumber,
  marker_id: idNumber,
  pipeline_name: text(200),
  pipeline_version: text(100),
  reference_db: text(200),
  reference_db_version: text(100).nullish(),
  parameters: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= 10000, 'must be 10 000 characters or less')
    .optional(),
  supersedes_analysis_id: idNumber.nullish(),
});
const rejectBody = z.strictObject({ reason: text(1000) });
const idParams = z.object({ id: idString });
const importQuery = z.object({ dry_run: booleanString.default(false) });
const importBody = z.strictObject({ analysis_id: idString });

// Memory storage only (nothing is written to disk); one file, the field names below, 10 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 },
}).single('file');

/** multer errors become the standard 422 envelope; a missing file is a 422 too. */
function receiveFile(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'maximum size is 10 MB'
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'the file must be sent in the field "file"'
            : 'the upload could not be read';
      const field = err.code === 'LIMIT_FIELD_COUNT' ? 'form' : 'file';
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          new AppError(413, 'payload_too_large', 'The upload is too large', [{ field, message }]),
        );
      }
      return next(unprocessable('The upload was rejected', [{ field, message }]));
    }
    if (!req.file) {
      return next(
        unprocessable('The upload was rejected', [{ field: 'file', message: 'is required' }]),
      );
    }
    req.body = { ...req.body };
    return next();
  });
}

// Gates: global roles here (create_analysis: PI and analyst; decide_analysis: PI; administrator
// always), then the project check in the service because the project comes from the analysis's run.
const createRole = requireRole(ROLES.PRINCIPAL_INVESTIGATOR, ROLES.ANALYST);
const decideRole = requireRole(ROLES.PRINCIPAL_INVESTIGATOR);

const router = Router();
router.get(
  '/',
  auth,
  validate({ query: listQuery }),
  pagination({ strict: true, allowedSortFields: ['analysis_id', 'created_at'] }),
  controller.listAnalyses,
);
router.post('/', auth, createRole, validate({ body: createBody }), controller.createAnalysis);
router.post(
  '/import',
  auth,
  createRole,
  receiveFile,
  validate({ query: importQuery, body: importBody }),
  controller.importDetections,
);
router.get('/:id', auth, validate({ params: idParams }), controller.getAnalysis);
router.post(
  '/:id/approve',
  auth,
  decideRole,
  validate({ params: idParams }),
  controller.approveAnalysis,
);
router.post(
  '/:id/reject',
  auth,
  decideRole,
  validate({ params: idParams, body: rejectBody }),
  controller.rejectAnalysis,
);

export default router;
