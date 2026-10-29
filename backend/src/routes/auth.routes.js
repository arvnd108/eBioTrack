// Owner: A (Backend)
// Purpose: Route definitions: login, logout, current session
import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/auth.controller.js';
import { auth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// bcrypt only uses the first 72 bytes, so longer passwords are rejected instead of truncated.
const loginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 72, 'must be at most 72 bytes'),
});

const router = Router();

router.post('/login', validate({ body: loginBody }), controller.login);
router.post('/logout', auth, controller.logout);
router.get('/me', auth, controller.me);

export default router;
