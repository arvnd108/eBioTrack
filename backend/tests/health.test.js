// Owner: A (Backend)
// Purpose: Test for GET /api/health (needs the test database; skipped if unreachable)
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { probeDatabase } from './helpers.js';

const available = await probeDatabase();

describe.skipIf(!available)('GET /api/health', () => {
  afterAll(closePool);

  it('returns 200 and the data envelope', async () => {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { status: 'ok' } });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
