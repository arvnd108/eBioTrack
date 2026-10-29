// Owner: A (Backend)
// Purpose: Request handling: login, logout, current session
import { promisify } from 'node:util';
import { SESSION_COOKIE_NAME, cookieOptions } from '../middleware/session.js';
import { AppError } from '../middleware/errorHandler.js';
import * as authService from '../services/auth.service.js';
import { attemptKey, loginAttempts } from '../utils/loginAttempts.js';
import { sendNoContent, sendSuccess } from '../utils/response.js';

export async function login(req, res) {
  const { email, password } = req.body;
  const key = attemptKey(req.ip, email);

  const retryAfter = loginAttempts.retryAfterSeconds(key);
  if (retryAfter > 0) {
    res.set('Retry-After', String(retryAfter));
    throw new AppError(
      429,
      'too_many_attempts',
      'Too many failed sign-in attempts. Try again later.',
    );
  }

  let user;
  try {
    user = await authService.authenticate(email, password);
  } catch (err) {
    if (err.code === 'invalid_credentials') loginAttempts.recordFailure(key);
    throw err;
  }
  loginAttempts.reset(key);

  // New session ID on every login, so an ID planted before sign-in is useless (session fixation).
  await promisify(req.session.regenerate.bind(req.session))();
  req.session.user_id = user.user_id;
  await promisify(req.session.save.bind(req.session))();

  await authService.recordLogin(user.user_id);
  return sendSuccess(res, user);
}

export async function logout(req, res) {
  await promisify(req.session.destroy.bind(req.session))();
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
  return sendNoContent(res);
}

export function me(req, res) {
  return sendSuccess(res, req.user);
}
