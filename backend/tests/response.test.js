// Owner: A (Backend)
// Purpose: Unit tests for response envelope helpers
import { describe, expect, it } from 'vitest';
import {
  sendSuccess,
  sendPaginated,
  sendNoContent,
  ok,
  created,
  noContent,
} from '../src/utils/response.js';

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res;
}

describe('response helpers', () => {
  describe('sendSuccess', () => {
    it('sends data wrapped in data envelope with 200 by default', () => {
      const res = createMockRes();
      sendSuccess(res, { id: 1, name: 'Project A' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        data: { id: 1, name: 'Project A' },
      });
    });

    it('supports custom status code such as 201 created', () => {
      const res = createMockRes();
      sendSuccess(res, { id: 2 }, 201);
      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({
        data: { id: 2 },
      });
    });

    it('handles array data correctly', () => {
      const res = createMockRes();
      sendSuccess(res, [1, 2, 3]);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        data: [1, 2, 3],
      });
    });
  });

  describe('sendPaginated', () => {
    it('sends paginated data with meta envelope and numeric conversions', () => {
      const res = createMockRes();
      sendPaginated(res, [{ id: 1 }, { id: 2 }], { page: '2', limit: '25', total: '50' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        data: [{ id: 1 }, { id: 2 }],
        meta: {
          page: 2,
          limit: 25,
          total: 50,
        },
      });
    });

    it('falls back to default meta values when omitted', () => {
      const res = createMockRes();
      sendPaginated(res, []);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        data: [],
        meta: {
          page: 1,
          limit: 25,
          total: 0,
        },
      });
    });
  });

  describe('sendNoContent', () => {
    it('ends response with 204 status and empty body', () => {
      const res = createMockRes();
      sendNoContent(res);
      expect(res.statusCode).toBe(204);
      expect(res.ended).toBe(true);
      expect(res.body).toBeNull();
    });
  });

  describe('convenience aliases ok, created, noContent', () => {
    it('ok sends data envelope when meta is omitted', () => {
      const res = createMockRes();
      ok(res, { hello: 'world' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ data: { hello: 'world' } });
    });

    it('ok sends paginated envelope when meta is provided', () => {
      const res = createMockRes();
      ok(res, [1, 2], { page: 1, limit: 10, total: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        data: [1, 2],
        meta: { page: 1, limit: 10, total: 2 },
      });
    });

    it('created sends 201 status with data', () => {
      const res = createMockRes();
      created(res, { created: true });
      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({ data: { created: true } });
    });

    it('noContent sends 204 status', () => {
      const res = createMockRes();
      noContent(res);
      expect(res.statusCode).toBe(204);
      expect(res.ended).toBe(true);
    });
  });
});
