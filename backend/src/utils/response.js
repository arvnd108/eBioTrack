// Owner: A (Backend)
// Purpose: Standard success/paginated response helpers

/**
 * Sends a standard single-item or collection success response.
 * Envelope: { "data": <object or array> }
 *
 * @param {import('express').Response} res
 * @param {any} data
 * @param {number} [statusCode=200]
 */
export function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ data });
}

/**
 * Sends a standard paginated collection response.
 * Envelope: { "data": [...], "meta": { "page": number, "limit": number, "total": number } }
 *
 * @param {import('express').Response} res
 * @param {any[]} data
 * @param {{ page: number|string, limit: number|string, total: number|string }} meta
 * @param {number} [statusCode=200]
 */
export function sendPaginated(res, data, meta = {}, statusCode = 200) {
  return res.status(statusCode).json({
    data,
    meta: {
      page: Number(meta.page ?? 1),
      limit: Number(meta.limit ?? 25),
      total: Number(meta.total ?? 0),
    },
  });
}

/**
 * Sends a 204 No Content response.
 *
 * @param {import('express').Response} res
 */
export function sendNoContent(res) {
  return res.status(204).end();
}

/**
 * Convenient aliases matching issue specification.
 */
export const ok = (res, data, meta) =>
  meta ? sendPaginated(res, data, meta) : sendSuccess(res, data);
export const created = (res, data) => sendSuccess(res, data, 201);
export const noContent = sendNoContent;

export default {
  sendSuccess,
  sendPaginated,
  sendNoContent,
  ok,
  created,
  noContent,
};
