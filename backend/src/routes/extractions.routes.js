// Owner: A (Backend)
// Purpose: Route definitions: labs, markers, extraction batches, extractions and QC results
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/extractions.controller.js';
import { auth } from '../middleware/auth.js';
import { requireAction } from '../middleware/authorize.js';
import { pagination } from '../middleware/pagination.js';
import { validate } from '../middleware/validate.js';
import { atLeastOneKey, calendarDate, idNumber, idString, pageQuery } from '../utils/schemas.js';

const QC_STATUSES = ['pending', 'pass', 'fail'];
const QC_TYPES = [
  'extraction_blank',
  'negative_control',
  'positive_control',
  'concentration',
  'contamination_check',
  'read_quality',
];
const QC_RESULTS = ['pass', 'warn', 'fail'];

// Bounds from the column types: numeric(10,3) and numeric(5,2); both CHECKs are >= 0.
const concentration = z.number().min(0, 'must be 0 or more').max(9999999.999);
const purity = z.number().min(0, 'must be 0 or more').max(999.99);

// Batch dates: 2000-01-01 up to tomorrow (UTC), so a lab in an earlier time zone can still enter
// "today"; anything further ahead is a typo.
const EARLIEST_BATCH_DATE = '2000-01-01';
const batchDate = calendarDate.refine(
  (value) =>
    value >= EARLIEST_BATCH_DATE &&
    value <= new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  'must be between 2000-01-01 and tomorrow',
);

const batchListQuery = z.object({ lab_id: idString.optional(), ...pageQuery });
const batchBody = z.strictObject({
  lab_id: idNumber,
  extraction_date: batchDate,
  kit_name: z.string().trim().min(1, 'must not be blank').max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});
const extractionListQuery = z.object({
  sample_id: idString.optional(),
  batch_id: idString.optional(),
  qc_status: z.enum(QC_STATUSES).optional(),
  ...pageQuery,
});
const extractionBody = z.strictObject({
  sample_id: idNumber,
  batch_id: idNumber,
  concentration_ng_ul: concentration.nullish(),
  purity_a260_280: purity.nullish(),
});
const extractionPatch = z
  .strictObject({
    qc_status: z.enum(['pass', 'fail']).optional(),
    concentration_ng_ul: concentration.nullable().optional(),
    purity_a260_280: purity.nullable().optional(),
  })
  .refine(
    atLeastOneKey,
    'at least one of qc_status, concentration_ng_ul, purity_a260_280 is required',
  );
const qcListQuery = z.object({
  sample_id: idString.optional(),
  analysis_id: idString.optional(),
  result: z.enum(QC_RESULTS).optional(),
  ...pageQuery,
});
const qcBody = z
  .strictObject({
    sample_id: idNumber.nullish(),
    analysis_id: idNumber.nullish(),
    qc_type: z.enum(QC_TYPES),
    result: z.enum(QC_RESULTS),
    metric_value: z.number().nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine((body) => body.sample_id != null || body.analysis_id != null, {
    path: ['sample_id'],
    message: 'sample_id or analysis_id is required',
  });
const idParams = z.object({ id: idString });

// Reads: any signed-in user (rows limited to their projects where they have one). Writes: the
// record_lab role gate (PI, lab technician; administrator always), then the project check in the
// service, because the project comes from the sample, extraction or analysis.
const recordLab = requireAction('record_lab');

export const labsRouter = Router();
labsRouter.get('/', auth, controller.listLabs);

export const markersRouter = Router();
markersRouter.get('/', auth, controller.listMarkers);

export const batchesRouter = Router();
batchesRouter.get(
  '/',
  auth,
  validate({ query: batchListQuery }),
  pagination({ strict: true, allowedSortFields: ['batch_id', 'extraction_date'] }),
  controller.listBatches,
);
batchesRouter.post('/', auth, recordLab, validate({ body: batchBody }), controller.createBatch);

export const qcRouter = Router();
qcRouter.get(
  '/',
  auth,
  validate({ query: qcListQuery }),
  pagination({ strict: true, allowedSortFields: ['qc_id', 'recorded_at'] }),
  controller.listQcResults,
);
qcRouter.post('/', auth, recordLab, validate({ body: qcBody }), controller.createQcResult);

const router = Router();
router.get(
  '/',
  auth,
  validate({ query: extractionListQuery }),
  pagination({ strict: true, allowedSortFields: ['extraction_id', 'created_at'] }),
  controller.listExtractions,
);
router.post('/', auth, recordLab, validate({ body: extractionBody }), controller.createExtraction);
router.patch(
  '/:id',
  auth,
  recordLab,
  validate({ params: idParams, body: extractionPatch }),
  controller.updateExtraction,
);

export default router;
