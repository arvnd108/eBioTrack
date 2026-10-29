// Owner: A (Backend)
// Purpose: Session check; attaches the current user
import { promisify } from 'node:util';
import { findUserById } from '../services/auth.service.js';
import { AppError } from './errorHandler.js';
import { SESSION_COOKIE_NAME, cookieOptions } from './session.js';

const unauthenticated = () => new AppError(401, 'unauthenticated', 'Authentication required');

/**
 * Require a signed-in, active user and attach it as `req.user`:
 * { user_id, full_name, email, roles: string[], active }.
 * The user is re-read from the database on every request, so deactivation and role changes take
 * effect immediately.
 */
export async function auth(req, res, next) {
  try {
    const userId = req.session?.user_id;
    if (!Number.isInteger(userId)) throw unauthenticated();

    const user = await findUserById(userId);
    if (!user || !user.active) {
      await promisify(req.session.destroy.bind(req.session))();
      res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
      throw unauthenticated();
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}
