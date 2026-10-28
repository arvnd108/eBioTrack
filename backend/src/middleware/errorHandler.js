// Owner: A (Backend)
// Purpose: Consistent error response format

/**
 * Standard application error with status code, API error code, and optional details.
 */
export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status code
   * @param {string} code API error code (e.g. 'validation_error', 'not_found')
   * @param {string} message Human-readable error message
   * @param {Array<{ field?: string, message: string }>} [details=[]]
   */
  constructor(statusCode, code, message, details = []) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// Convenience factory helpers
export const badRequest = (message = 'Bad request', details = []) =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required', details = []) =>
  new AppError(401, 'unauthorized', message, details);

export const forbidden = (message = 'Access denied', details = []) =>
  new AppError(403, 'forbidden', message, details);

export const notFound = (message = 'Resource not found', details = []) =>
  new AppError(404, 'not_found', message, details);

export const conflict = (message = 'Resource conflict', code = 'conflict', details = []) =>
  new AppError(409, code, message, details);

export const unprocessable = (
  message = 'Validation failed',
  details = [],
  code = 'validation_error',
) => new AppError(422, code, message, details);

/**
 * Map PostgreSQL SQLSTATE and known error codes to HTTP status and API error codes
 * per CONTRACT Section 7 and 8.
 */
function mapDatabaseError(err) {
  switch (err.code) {
    case 'EB001':
      return {
        statusCode: 409,
        code: 'invalid_transition',
        message: err.message || 'Invalid state transition',
        details: err.detail ? [{ message: err.detail }] : [],
      };
    case 'EB002':
      return {
        statusCode: 422,
        code: 'rule_violation',
        message: err.message || 'Business rule violation',
        details: err.detail ? [{ message: err.detail }] : [],
      };
    case 'EB003':
      return {
        statusCode: 409,
        code: 'conflict',
        message: err.message || 'Resource conflict or concurrent modification',
        details: err.detail ? [{ message: err.detail }] : [],
      };
    case '23505': // unique_violation
      return {
        statusCode: 409,
        code: 'duplicate',
        message: err.detail || err.message || 'Unique constraint violation',
        details: err.detail ? [{ message: err.detail }] : [],
      };
    case '23503': // foreign_key_violation
      return {
        statusCode: 422,
        code: 'invalid_reference',
        message: err.detail || err.message || 'Referenced record does not exist',
        details: err.detail ? [{ message: err.detail }] : [],
      };
    case '23514': // check_violation
      return {
        statusCode: 422,
        code: 'validation_error',
        message: err.message || 'Check constraint violation',
        details: err.detail ? [{ message: err.detail }] : [],
      };
    default:
      return null;
  }
}

const BODY_PARSER_CODES = {
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

/** Errors raised by express.json() (http-errors with `type`), other than JSON syntax errors. */
function isBodyParserError(err) {
  const status = err?.status ?? err?.statusCode;
  return (
    typeof err?.type === 'string' &&
    err.expose === true &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  );
}

/**
 * Express error-handling middleware.
 * Formats all errors into { error: { code, message, details? } }
 */
export function errorHandler(err, _req, res, _next) {
  let statusCode = 500;
  let code = 'internal_error';
  let message = 'Internal server error';
  let details = [];

  // 1. JSON parsing syntax error from express.json()
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    statusCode = 400;
    code = 'bad_request';
    message = 'Malformed JSON payload in request body';
  }
  // 2. Other body-parser errors (too large, unsupported charset/encoding): client errors
  else if (isBodyParserError(err)) {
    statusCode = err.status ?? err.statusCode;
    code = BODY_PARSER_CODES[statusCode] ?? 'bad_request';
    message = err.message;
  }
  // 3. Custom AppError instances
  else if (err instanceof AppError) {
    statusCode = err.statusCode || 500;
    code = err.code || 'internal_error';
    message = err.message || 'An error occurred';
    details = err.details || [];
  }
  // 4. PostgreSQL and custom contract SQLSTATE codes
  else if (err && err.code) {
    const dbMapped = mapDatabaseError(err);
    if (dbMapped) {
      statusCode = dbMapped.statusCode;
      code = dbMapped.code;
      message = dbMapped.message;
      details = dbMapped.details;
    } else {
      // Unmapped database or unexpected error with code
      if (process.env.NODE_ENV !== 'test') {
        console.error(`[error] Unhandled error (${err.code}):`, err);
      }
    }
  }
  // 5. Fallback for unhandled errors
  else {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[error] Unhandled internal error:', err);
    }
  }

  const responseBody = {
    error: {
      code,
      message,
    },
  };

  if (Array.isArray(details) && details.length > 0) {
    responseBody.error.details = details;
  }

  res.status(statusCode).json(responseBody);
}

/**
 * Catch-all 404 handler for unmatched routes.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}

export default {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  errorHandler,
  notFoundHandler,
};
