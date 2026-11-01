// Owner: A (Backend)
// Purpose: Request handling: CSV report exports
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as service from '../services/exports.service.js';
import { sendSuccess } from '../utils/response.js';

export async function createExport(req, res) {
  return sendSuccess(res, await service.createExport(req.body, req.user), 201);
}

export async function downloadExport(req, res) {
  const file = await service.openExport(req.params.id, req.user);
  res.status(200);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'X-Row-Count': String(file.rowCount),
    'Cache-Control': 'no-store',
  });
  // Headers are out once streaming starts, so a late failure can only end the response early.
  try {
    await pipeline(Readable.from(file.chunks()), res);
  } catch (err) {
    console.error(`[exports] streaming export ${req.params.id} failed: ${err.message}`);
  }
}
