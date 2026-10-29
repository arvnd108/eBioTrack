// Owner: A (Backend)
// Purpose: express-session with the PostgreSQL store (CONTRACT D11)
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';

export const SESSION_COOKIE_NAME = 'ebiotrack.sid';

// Shared by the session middleware and by logout when it clears the cookie.
// Behind a reverse proxy the deployer must set `app.set('trust proxy', 1)`, otherwise Express
// sees plain HTTP and refuses to send a Secure cookie.
export const cookieOptions = Object.freeze({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  path: '/',
});

const PgStore = connectPgSimple(session);

export const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: false,
  cookie: { ...cookieOptions, maxAge: config.sessionMaxAgeHours * 60 * 60 * 1000 },
  // The shared pool, not a second one. The table comes from migration 095.
  store: new PgStore({
    pool,
    tableName: 'session',
    createTableIfMissing: false,
    // The prune timer would keep test processes alive.
    pruneSessionInterval: config.isTest ? false : 15 * 60,
  }),
});
