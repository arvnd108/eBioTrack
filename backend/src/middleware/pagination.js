// Owner: A (Backend)
// Purpose: Page and limit parsing

import { AppError } from './errorHandler.js';

/**
 * Creates pagination middleware with configurable defaults and maximum limits.
 * Attaches { page, limit, offset, sort } to req.pagination.
 *
 * Defaults: page = 1, limit = 25, maxLimit = 100.
 *
 * @param {object} [options={}]
 * @param {number} [options.defaultPage=1]
 * @param {number} [options.defaultLimit=25]
 * @param {number} [options.maxLimit=100]
 * @param {string[]} [options.allowedSortFields] Optional allowlist of sortable column names
 * @param {boolean} [options.strict=false] If true, throws 422 for non-integer or negative inputs
 */
export function pagination(options = {}) {
  const defaultPage = options.defaultPage ?? 1;
  const defaultLimit = options.defaultLimit ?? 25;
  const maxLimit = options.maxLimit ?? 100;
  const allowedSortFields = options.allowedSortFields ?? options.sortableFields ?? null;
  const strict = Boolean(options.strict);

  return (req, _res, next) => {
    let page = defaultPage;
    let limit = defaultLimit;

    if (req.query?.page !== undefined) {
      const parsed = Number(req.query.page);
      if (!Number.isInteger(parsed) || parsed < 1) {
        if (strict) {
          return next(
            new AppError(422, 'validation_error', 'Page must be a positive integer', [
              { field: 'page', message: 'must be an integer >= 1' },
            ]),
          );
        }
        page = defaultPage;
      } else {
        page = parsed;
      }
    }

    if (req.query?.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        if (strict) {
          return next(
            new AppError(422, 'validation_error', 'Limit must be a positive integer', [
              { field: 'limit', message: 'must be an integer >= 1' },
            ]),
          );
        }
        limit = defaultLimit;
      } else {
        limit = Math.min(parsed, maxLimit);
      }
    }

    const offset = (page - 1) * limit;

    let sort = null;
    if (typeof req.query?.sort === 'string' && req.query.sort.trim().length > 0) {
      const raw = req.query.sort.trim();
      const desc = raw.startsWith('-');
      const field = desc ? raw.slice(1) : raw;

      if (Array.isArray(allowedSortFields) && allowedSortFields.length > 0) {
        if (!allowedSortFields.includes(field)) {
          return next(
            new AppError(422, 'validation_error', `Invalid sort field: ${field}`, [
              { field: 'sort', message: `Must be one of: ${allowedSortFields.join(', ')}` },
            ]),
          );
        }
      }

      sort = {
        field,
        direction: desc ? 'DESC' : 'ASC',
      };
    }

    req.pagination = {
      page,
      limit,
      offset,
      sort,
    };

    next();
  };
}

export default pagination;
