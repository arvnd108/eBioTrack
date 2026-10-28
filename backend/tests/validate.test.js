// Owner: A (Backend)
// Purpose: Unit tests for request validation middleware
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validate } from '../src/middleware/validate.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('validate middleware', () => {
  it('calls next without error when validation succeeds and replaces data', async () => {
    const schema = {
      body: z.object({
        name: z.string().trim(),
        count: z.coerce.number(),
      }),
    };

    const middleware = validate(schema);
    const req = {
      body: {
        name: '  Project eBioTrack  ',
        count: '42',
      },
    };
    let nextCalled = false;

    await middleware(req, {}, (err) => {
      if (!err) nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.body).toEqual({
      name: 'Project eBioTrack',
      count: 42,
    });
  });

  it('rejects invalid payload with 422 AppError and structured field details', async () => {
    const schema = {
      body: z.object({
        latitude: z.number().min(-90).max(90),
        site_name: z.string().min(1, 'Site name is required'),
      }),
    };

    const middleware = validate(schema);
    const req = {
      body: {
        latitude: 120, // out of range
        site_name: '',
      },
    };
    let capturedError = null;

    await middleware(req, {}, (err) => {
      capturedError = err;
    });

    expect(capturedError).toBeInstanceOf(AppError);
    expect(capturedError.statusCode).toBe(422);
    expect(capturedError.code).toBe('validation_error');
    expect(capturedError.details).toHaveLength(2);
    expect(capturedError.details[0].field).toBe('latitude');
    expect(capturedError.details[1].field).toBe('site_name');
  });

  it('correctly handles nested field paths', async () => {
    const schema = {
      body: z.object({
        metadata: z.object({
          depth_m: z.number().nonnegative(),
        }),
      }),
    };

    const middleware = validate(schema);
    const req = {
      body: {
        metadata: {
          depth_m: -10,
        },
      },
    };
    let capturedError = null;

    await middleware(req, {}, (err) => {
      capturedError = err;
    });

    expect(capturedError).toBeInstanceOf(AppError);
    expect(capturedError.details[0].field).toBe('metadata.depth_m');
  });

  it('validates query and params targets', async () => {
    const schema = {
      params: z.object({
        id: z.coerce.number().positive(),
      }),
      query: z.object({
        status: z.enum(['draft', 'approved']),
      }),
    };

    const middleware = validate(schema);
    const req = {
      params: { id: '10' },
      query: { status: 'invalid_status' },
    };
    let capturedError = null;

    await middleware(req, {}, (err) => {
      capturedError = err;
    });

    expect(capturedError).toBeInstanceOf(AppError);
    expect(capturedError.details[0].field).toBe('status');
  });
});
