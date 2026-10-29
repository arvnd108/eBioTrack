// Owner: A (Backend)
// Purpose: In-memory limiter for repeated failed sign-ins
//
// Single-process measure suitable for this project's scale: the counters live in this process's
// memory, so they reset on restart and are not shared between several server instances. A real
// multi-instance deployment would move them to the database or a shared cache.

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;

/**
 * Failed-attempt counter keyed by client IP plus email.
 * @param {{ maxFailures?: number, windowMs?: number, now?: () => number }} [options]
 */
export function createLoginAttempts({
  maxFailures = MAX_FAILURES,
  windowMs = WINDOW_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const entries = new Map();

  const live = (key) => {
    const entry = entries.get(key);
    if (entry && entry.resetAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    /** Seconds until the key may try again, or 0 when it is allowed. */
    retryAfterSeconds(key) {
      const entry = live(key);
      if (!entry || entry.count < maxFailures) return 0;
      return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000));
    },
    recordFailure(key) {
      const entry = live(key);
      if (entry) entry.count += 1;
      else entries.set(key, { count: 1, resetAt: now() + windowMs });
      // Opportunistic cleanup keeps the map from growing with one-off keys.
      if (entries.size > 10_000) {
        for (const k of entries.keys()) live(k);
      }
    },
    reset(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

/** The limiter the login route uses. */
export const loginAttempts = createLoginAttempts();

/** @returns {string} */
export const attemptKey = (ip, email) => `${ip ?? 'unknown'}|${email}`;
