// Owner: A (Backend)
// Purpose: Request body/query validation

import { AppError } from './errorHandler.js';

/** Format a Zod issue path as `a.b[0].c`; an empty path is the whole payload. */
function formatPath(path) {
  if (path.length === 0) return 'root';
  return path.reduce((out, segment) => {
    if (typeof segment === 'number') return `${out}[${segment}]`;
    return out === '' ? String(segment) : `${out}.${String(segment)}`;
  }, '');
}

/**
 * Replace a request property with parsed data. Express 5 defines `req.query` as a read-only
 * getter, so plain assignment throws; defining an own property on the request works for all targets.
 */
function setRequestProperty(req, target, value) {
  Object.defineProperty(req, target, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * Creates a validation middleware using Zod schemas for body, query, and/or params.
 *
 * @param {object} schemas
 * @param {import('zod').ZodTypeAny} [schemas.body]
 * @param {import('zod').ZodTypeAny} [schemas.query]
 * @param {import('zod').ZodTypeAny} [schemas.params]
 */
export function validate(schemas = {}) {
  const targets = ['params', 'query', 'body'];

  return async (req, _res, next) => {
    try {
      const details = [];

      for (const target of targets) {
        const schema = schemas[target];
        if (!schema) continue;

        const dataToValidate = req[target] ?? {};
        const result = await schema.safeParseAsync(dataToValidate);

        if (!result.success) {
          for (const issue of result.error.issues) {
            const field = formatPath(issue.path);
            details.push({
              field,
              message: issue.message,
            });
          }
        } else {
          // Replace with parsed/stripped/transformed data
          setRequestProperty(req, target, result.data);
        }
      }

      if (details.length > 0) {
        const message = details[0]?.message || 'Validation failed';
        return next(new AppError(422, 'validation_error', message, details));
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export default validate;
