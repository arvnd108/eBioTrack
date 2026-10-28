// Owner: A (Backend)
// Purpose: Process entry point: load config, start HTTP server
import { config, maskDatabaseUrl } from './config/env.js';
import { pool, closePool } from './db/pool.js';
import { app } from './app.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

try {
  await pool.query('SELECT 1');
} catch (err) {
  console.error(
    `Cannot reach the database at ${maskDatabaseUrl(config.databaseUrl)}: ${err.message}`,
  );
  console.error('Is it running? Try: docker compose up -d db');
  await closePool();
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`eBioTrack API listening on port ${config.port} (${config.nodeEnv})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
