// Owner: A (Backend)
// Purpose: Tests validate() and body-parser error mapping through a real Express app
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { validate } from '../src/middleware/validate.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.get(
    '/items/:id',
    validate({
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({ status: z.enum(['draft', 'approved']).default('draft') }),
    }),
    (req, res) => res.json({ params: req.params, query: req.query }),
  );
  app.post(
    '/items',
    validate({
      body: z.object({ lat: z.number().min(-90), tags: z.array(z.object({ name: z.string() })) }),
    }),
    (req, res) => res.json({ body: req.body }),
  );
  app.post('/any', validate({ body: z.string() }), (req, res) => res.json({ body: req.body }));
  app.use(errorHandler);

  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('validate() on a real Express app', () => {
  it('passes a valid query and applies defaults and coercion', async () => {
    const res = await fetch(`${base}/items/7?status=approved`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ params: { id: 7 }, query: { status: 'approved' } });

    const defaulted = await fetch(`${base}/items/7`);
    expect((await defaulted.json()).query).toEqual({ status: 'draft' });
  });

  it('rejects an invalid query with 422 and field details', async () => {
    const res = await fetch(`${base}/items/7?status=bogus`);
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe('validation_error');
    expect(error.details[0].field).toBe('status');
  });

  it('rejects invalid params with 422', async () => {
    const res = await fetch(`${base}/items/abc`);
    expect(res.status).toBe(422);
    expect((await res.json()).error.details[0].field).toBe('id');
  });

  it('formats array paths with brackets', async () => {
    const res = await post('/items', { lat: 1, tags: [{ name: 'ok' }, { name: 5 }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error.details[0].field).toBe('tags[1].name');
  });

  it('uses "root" when the whole payload is invalid', async () => {
    const res = await post('/any', {});
    expect(res.status).toBe(422);
    expect((await res.json()).error.details[0].field).toBe('root');
  });
});

describe('body-parser error mapping', () => {
  it('maps an oversized body to 413 payload_too_large', async () => {
    const res = await post('/items', { lat: 1, tags: [], pad: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
  });

  it('still maps malformed JSON to 400 bad_request', async () => {
    const res = await post('/items', '{bad');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });
});
