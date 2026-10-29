// Owner: A (Backend)
// Purpose: Read and validate environment variables
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const DEFAULT_SECRET = 'change_me';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export class EnvError extends Error {
  constructor(problems) {
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Copy .env.example to .env and fix the values above.',
    );
    this.name = 'EnvError';
    this.problems = problems;
    this.stack = `${this.name}: ${this.message}`;
  }
}

const databaseUrl = z.string().refine((value) => {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'must be a postgres:// connection URL');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: databaseUrl.optional(),
  TEST_DATABASE_URL: databaseUrl.optional(),
  SESSION_SECRET: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  SESSION_MAX_AGE_HOURS: z.coerce.number().positive().max(720).default(8),
  // "true" or "false"; unset means secure cookies in production only.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // Comma-separated browser origins allowed to make state-changing requests (CSRF origin check).
  ALLOWED_ORIGINS: z.string().optional(),
});

const DEV_FRONTEND_ORIGIN = 'http://localhost:5173';

/**
 * Replace the password in a connection URL so it is safe to log.
 * @param {string} url
 * @returns {string}
 */
export function maskDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid url>';
  }
}

/**
 * Validate a raw environment object and return the frozen config.
 * Pure (does not read process.env), so it can be unit tested.
 * In NODE_ENV=test the database URL is always TEST_DATABASE_URL, never DATABASE_URL.
 * @param {Record<string, string | undefined>} source
 * @returns {Readonly<{nodeEnv: string, port: number, databaseUrl: string, testDatabaseUrl: string | null, sessionSecret: string, dbPoolMax: number | null, sessionMaxAgeHours: number, cookieSecure: boolean, allowedOrigins: string[], isProduction: boolean, isTest: boolean}>}
 */
export function loadConfig(source) {
  // Treat empty strings (e.g. `PORT=` in .env) as unset.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  const problems = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path.join('.');
      problems.push(`${name}: ${cleaned[name] === undefined ? 'is required' : issue.message}`);
    }
  }

  // Cross-field rules use the raw values so every problem is reported in a single message.
  const nodeEnv = cleaned.NODE_ENV ?? 'development';
  if (nodeEnv === 'production' && cleaned.SESSION_SECRET === DEFAULT_SECRET) {
    problems.push(`SESSION_SECRET: must not be "${DEFAULT_SECRET}" in production`);
  }
  if (nodeEnv === 'test') {
    if (!cleaned.TEST_DATABASE_URL) {
      problems.push('TEST_DATABASE_URL: is required when NODE_ENV=test');
    } else if (cleaned.DATABASE_URL === cleaned.TEST_DATABASE_URL) {
      problems.push(
        'TEST_DATABASE_URL: must differ from DATABASE_URL so tests cannot touch the dev database',
      );
    }
  } else if (!cleaned.DATABASE_URL) {
    problems.push('DATABASE_URL: is required');
  }
  if (problems.length > 0) throw new EnvError([...new Set(problems)]);

  const env = parsed.data;
  const isTest = env.NODE_ENV === 'test';
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: isTest ? env.TEST_DATABASE_URL : env.DATABASE_URL,
    testDatabaseUrl: env.TEST_DATABASE_URL ?? null,
    sessionSecret: env.SESSION_SECRET,
    dbPoolMax: env.DB_POOL_MAX ?? null,
    sessionMaxAgeHours: env.SESSION_MAX_AGE_HOURS,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    // Outside production the Vite dev server origin is allowed by default.
    allowedOrigins: (
      env.ALLOWED_ORIGINS ?? (env.NODE_ENV === 'production' ? '' : DEV_FRONTEND_ORIGIN)
    )
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    isProduction: env.NODE_ENV === 'production',
    isTest,
  });
}

// Values already in the process environment win over .env.
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

export const config = loadConfig(process.env);
