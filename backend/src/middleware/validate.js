// Owner: A (Backend)
// Purpose: Request body/query validation

import { AppError } from './errorHandler.js';

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
            const field = issue.path.length > 0 ? issue.path.join('.') : target;
            details.push({
              field,
              message: issue.message,
            });
          }
        } else {
          // Replace with parsed/stripped/transformed data
          req[target] = result.data;
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
