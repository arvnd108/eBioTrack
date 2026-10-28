// Owner: A (Backend)
// Purpose: Unit tests for pagination middleware
import { describe, expect, it } from 'vitest';
import { pagination } from '../src/middleware/pagination.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('pagination middleware', () => {
  it('applies default pagination values when query is empty', () => {
    const middleware = pagination();
    const req = { query: {} };
    let nextCalled = false;

    middleware(req, {}, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.pagination).toEqual({
      page: 1,
      limit: 25,
      offset: 0,
      sort: null,
    });
  });

  it('correctly calculates offset for custom page and limit', () => {
    const middleware = pagination();
    const req = { query: { page: '3', limit: '10' } };
    let nextCalled = false;

    middleware(req, {}, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.pagination).toEqual({
      page: 3,
      limit: 10,
      offset: 20,
      sort: null,
    });
  });

  it('caps limit at 100 by default', () => {
    const middleware = pagination();
    const req = { query: { page: '1', limit: '500' } };

    middleware(req, {}, () => {});

    expect(req.pagination.limit).toBe(100);
    expect(req.pagination.offset).toBe(0);
  });

  it('handles invalid/negative non-numeric inputs by falling back safely', () => {
    const middleware = pagination();
    const req = { query: { page: '-5', limit: 'abc' } };

    middleware(req, {}, () => {});

    expect(req.pagination).toEqual({
      page: 1,
      limit: 25,
      offset: 0,
      sort: null,
    });
  });

  it('supports custom options like custom defaultLimit and maxLimit', () => {
    const middleware = pagination({ defaultLimit: 50, maxLimit: 200 });
    const req = { query: { limit: '150' } };

    middleware(req, {}, () => {});

    expect(req.pagination.limit).toBe(150);
  });

  it('parses valid sort field with ascending and descending prefixes', () => {
    const middleware = pagination({ allowedSortFields: ['created_at', 'site_name'] });

    const reqAsc = { query: { sort: 'site_name' } };
    middleware(reqAsc, {}, () => {});
    expect(reqAsc.pagination.sort).toEqual({ field: 'site_name', direction: 'ASC' });

    const reqDesc = { query: { sort: '-created_at' } };
    middleware(reqDesc, {}, () => {});
    expect(reqDesc.pagination.sort).toEqual({ field: 'created_at', direction: 'DESC' });
  });

  it('rejects unallowed sort fields when allowlist is configured', () => {
    const middleware = pagination({ allowedSortFields: ['created_at'] });
    const req = { query: { sort: 'malicious_column' } };
    let capturedError = null;

    middleware(req, {}, (err) => {
      capturedError = err;
    });

    expect(capturedError).toBeInstanceOf(AppError);
    expect(capturedError.statusCode).toBe(422);
    expect(capturedError.code).toBe('validation_error');
    expect(capturedError.details[0].field).toBe('sort');
  });

  it('rejects invalid inputs when strict option is enabled', () => {
    const middleware = pagination({ strict: true });
    const req = { query: { page: 'invalid' } };
    let errorPassed = null;

    middleware(req, {}, (err) => {
      errorPassed = err;
    });

    expect(errorPassed).toBeInstanceOf(AppError);
    expect(errorPassed.statusCode).toBe(422);
    expect(errorPassed.code).toBe('validation_error');
    expect(errorPassed.details[0].field).toBe('page');
  });
});
