// Owner: A (Backend)
// Purpose: Password hashing and verification
import bcrypt from 'bcrypt';

/** bcrypt work factor (CONTRACT D12). Only tests lower it, through the `cost` option. */
export const BCRYPT_COST = 12;

/**
 * Hash a password with bcrypt.
 * @param {string} plain
 * @param {{ cost?: number }} [options] cost is overridable for tests only
 * @returns {Promise<string>}
 */
export async function hashPassword(plain, { cost = BCRYPT_COST } = {}) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  return bcrypt.hash(plain, cost);
}

/**
 * Compare a password with a stored bcrypt hash. Any problem (bad input, malformed hash) is a
 * non-match, never an exception, so callers cannot be tricked into a pass-through.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
