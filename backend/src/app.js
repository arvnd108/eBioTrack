// Owner: A (Backend)
// Purpose: Express app: middleware stack and route mounting
import express from 'express';
import { pool } from './db/pool.js';

export const app = express();
app.disable('x-powered-by');

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ data: { status: 'ok' } });
  } catch (err) {
    console.error(`[health] database check failed: ${err.message}`);
    res.status(503).json({ error: { code: 'unavailable', message: 'Database is not reachable' } });
  }
});
