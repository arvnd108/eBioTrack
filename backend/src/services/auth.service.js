// Owner: A (Backend)
// Purpose: Business logic and calls to SQL objects: login, logout, current session
import { randomBytes } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db/query.js';
import { AppError } from '../middleware/errorHandler.js';
import { hashPassword, verifyPassword } from '../utils/passwordHash.js';

// Explicit column lists on purpose: password_hash must never ride along by accident.
const userWithRoles = (extraColumns = '') => `
  SELECT ${extraColumns}u.user_id, u.full_name, u.email, u.active,
         COALESCE(array_agg(r.role_name ORDER BY r.role_name) FILTER (WHERE r.role_name IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.user_id
    LEFT JOIN roles r ON r.role_id = ur.role_id`;
// Selecting the hash with GROUP BY u.user_id is valid because user_id is the primary key.

// A valid hash of a random value, computed once at startup. Comparing against it when the email
// is unknown makes that path cost as much as a real password check.
const dummyHash = hashPassword(randomBytes(24).toString('hex'));

const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'Invalid email or password');

/** @returns {{user_id: number, full_name: string, email: string, roles: string[], active: boolean}} */
const toUser = (row) => ({
  user_id: row.user_id,
  full_name: row.full_name,
  email: row.email,
  roles: row.roles,
  active: row.active,
});

/**
 * Load a user and roles in one query. Returns null when there is no such user.
 * @param {number} userId
 */
export async function findUserById(userId) {
  const row = await queryOne(`${userWithRoles()} WHERE u.user_id = $1 GROUP BY u.user_id`, [
    userId,
  ]);
  return row ? toUser(row) : null;
}

/**
 * Check an email and password. Unknown email, wrong password and inactive user all throw the same
 * 401, after the same bcrypt work.
 * @param {string} email already lower-cased
 * @param {string} password
 */
export async function authenticate(email, password) {
  const row = await queryOne(
    `${userWithRoles('u.password_hash, ')}
      WHERE u.email = $1 GROUP BY u.user_id`,
    [email],
  );
  const matches = await verifyPassword(password, row ? row.password_hash : await dummyHash);
  if (!row || !matches || !row.active) throw invalidCredentials();
  return toUser(row);
}

/** Stamp last_login_at and write the audit entry for a successful sign-in. */
export async function recordLogin(userId) {
  await withTransaction(
    async (client) => {
      await query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [userId], client);
      await query(
        `INSERT INTO audit_logs (actor_id, entity_type, entity_id, action)
         VALUES ($1, 'users', $1, 'login')`,
        [userId],
        client,
      );
    },
    { actorId: userId },
  );
}
