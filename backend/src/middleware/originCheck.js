// Owner: A (Backend)
// Purpose: CSRF defence for state-changing requests: reject unexpected browser origins
//
// What protects against CSRF here:
//  - The session cookie is SameSite=Lax, so browsers do not send it on cross-site POST, PATCH or
//    DELETE requests.
//  - The API only reads JSON bodies, which a plain cross-site HTML form cannot send.
//  - This check adds a third layer: a state-changing request that carries an Origin header must
//    come from this server's own host or from ALLOWED_ORIGINS.
// What is not covered: requests with no Origin header (curl, server-side clients) are allowed,
// because they are not browser cross-site requests and cannot ride on a victim's cookie. GET
// requests are never state-changing in this API, so they are not checked. No CSRF token is used.
import { config } from '../config/env.js';
import { AppError } from './errorHandler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function originCheck(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();

  let allowed = config.allowedOrigins.includes(origin);
  if (!allowed) {
    try {
      allowed = new URL(origin).host === req.get('host');
    } catch {
      allowed = false;
    }
  }
  if (allowed) return next();
  return next(new AppError(403, 'forbidden', 'Request origin is not allowed'));
}
