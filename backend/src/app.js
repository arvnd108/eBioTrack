// Owner: A (Backend)
// Purpose: Express app: middleware stack and route mounting
import express from 'express';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { originCheck } from './middleware/originCheck.js';
import { sessionMiddleware } from './middleware/session.js';
import analysesRoutes from './routes/analyses.routes.js';
import { analyticsRouter, dashboardRouter } from './routes/analytics.routes.js';
import auditRoutes from './routes/audit.routes.js';
import authRoutes from './routes/auth.routes.js';
import eventsRoutes from './routes/events.routes.js';
import exportsRoutes from './routes/exports.routes.js';
import extractionsRoutes, {
  batchesRouter,
  labsRouter,
  markersRouter,
  qcRouter,
} from './routes/extractions.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import samplesRoutes, { sampleTypesRouter } from './routes/samples.routes.js';
import sequencingRoutes from './routes/sequencing.routes.js';
import sitesRoutes, { regionsRouter } from './routes/sites.routes.js';
import taxaRoutes from './routes/taxa.routes.js';
import { rolesRouter, usersRouter } from './routes/users.routes.js';

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

// Sessions and the CSRF origin check apply to everything under /api except health.
app.use('/api', sessionMiddleware, originCheck);

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/projects', projectsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/regions', regionsRouter);
app.use('/api/sites', sitesRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/sample-types', sampleTypesRouter);
app.use('/api/samples', samplesRoutes);
app.use('/api/labs', labsRouter);
app.use('/api/markers', markersRouter);
app.use('/api/extraction-batches', batchesRouter);
app.use('/api/extractions', extractionsRoutes);
app.use('/api/qc-results', qcRouter);
app.use('/api/sequencing-runs', sequencingRoutes);
app.use('/api/analyses', analysesRoutes);
app.use('/api/taxa', taxaRoutes);
app.use('/api/analytics', analyticsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/exports', exportsRoutes);

// Catch-all 404 handler for unmatched routes
app.use(notFoundHandler);

// Centralized error handler
app.use(errorHandler);

export default app;
