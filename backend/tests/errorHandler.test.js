// Owner: A (Backend)
// Purpose: Unit and integration tests for error handler and SQLSTATE translation
import { describe, expect, it } from 'vitest';
import express from 'express';
import {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  errorHandler,
  notFoundHandler,
} from '../src/middleware/errorHandler.js';
import { app } from '../src/app.js';

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

describe('errorHandler middleware', () => {
  it('formats custom AppError correctly', () => {
    const res = createMockRes();
    const err = new AppError(422, 'validation_error', 'Invalid email', [
      { field: 'email', message: 'invalid email format' },
    ]);

    errorHandler(err, {}, res, () => {});

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: 'validation_error',
        message: 'Invalid email',
        details: [{ field: 'email', message: 'invalid email format' }],
      },
    });
  });

  it('formats convenience helper errors correctly', () => {
    const helpers = [
      { fn: () => badRequest('Invalid payload'), status: 400, code: 'bad_request' },
      { fn: () => unauthorized(), status: 401, code: 'unauthorized' },
      { fn: () => forbidden(), status: 403, code: 'forbidden' },
      { fn: () => notFound(), status: 404, code: 'not_found' },
      { fn: () => conflict('Already exists'), status: 409, code: 'conflict' },
      { fn: () => unprocessable('Invalid input'), status: 422, code: 'validation_error' },
    ];

    for (const { fn, status, code } of helpers) {
      const res = createMockRes();
      errorHandler(fn(), {}, res, () => {});
      expect(res.statusCode).toBe(status);
      expect(res.body.error.code).toBe(code);
    }
  });

  it('translates database SQLSTATE codes per CONTRACT Section 7', () => {
    const testCases = [
      {
        err: { code: 'EB001', message: 'Illegal status transition from collected to analyzed' },
        expectedStatus: 409,
        expectedCode: 'invalid_transition',
      },
      {
        err: { code: 'EB002', message: 'Control blank exceeded threshold', detail: 'QC failed' },
        expectedStatus: 422,
        expectedCode: 'rule_violation',
      },
      {
        err: { code: 'EB003', message: 'Analysis already approved' },
        expectedStatus: 409,
        expectedCode: 'conflict',
      },
      {
        err: {
          code: '23505',
          detail: 'Key (sample_code)=(SMP-001) already exists.',
          message: 'duplicate key value',
        },
        expectedStatus: 409,
        expectedCode: 'duplicate',
      },
      {
        err: {
          code: '23503',
          detail: 'Key (site_id)=(999) is not present in table "sampling_sites".',
          message: 'foreign key violation',
        },
        expectedStatus: 422,
        expectedCode: 'invalid_reference',
      },
      {
        err: {
          code: '23514',
          message:
            'new row for relation "samples" violates check constraint "ck_samples_volume_ml"',
        },
        expectedStatus: 422,
        expectedCode: 'validation_error',
      },
    ];

    for (const tc of testCases) {
      const res = createMockRes();
      errorHandler(tc.err, {}, res, () => {});
      expect(res.statusCode).toBe(tc.expectedStatus);
      expect(res.body.error.code).toBe(tc.expectedCode);
    }
  });

  it('handles unexpected errors as 500 internal_error without leaking details', () => {
    const res = createMockRes();
    const secretError = new Error('Secret DB password exposed in stack');

    errorHandler(secretError, {}, res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    });
  });

  it('handles notFoundHandler catch-all', () => {
    const res = createMockRes();
    const req = { method: 'GET', originalUrl: '/api/unknown-endpoint' };

    notFoundHandler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'not_found',
        message: 'Route not found: GET /api/unknown-endpoint',
      },
    });
  });

  describe('Integration with Express app', () => {
    it('returns 400 bad_request on malformed JSON payload', async () => {
      const testApp = express();
      testApp.use(express.json());
      testApp.use(errorHandler);

      const server = testApp.listen(0);
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ "invalid_json": ',
        });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data).toEqual({
          error: {
            code: 'bad_request',
            message: 'Malformed JSON payload in request body',
          },
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('returns 404 not_found on app for unknown routes', async () => {
      const server = app.listen(0);
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/api/non-existent-route`);

        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error.code).toBe('not_found');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
