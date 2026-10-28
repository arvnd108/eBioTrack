// Owner: A (Backend)
// Purpose: Express app: middleware stack and route mounting
import express from 'express';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const app = express();
app.disable('x-powered-by');

// Parse JSON request bodies
app.use(express.json());

// System health check
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ data: { status: 'ok' } });
  } catch (err) {
    console.error(`[health] database check failed: ${err.message}`);
    res.status(503).json({ error: { code: 'unavailable', message: 'Database is not reachable' } });
  }
});

// Catch-all 404 handler for unmatched routes
app.use(notFoundHandler);

// Centralized error handler
app.use(errorHandler);

export default app;
