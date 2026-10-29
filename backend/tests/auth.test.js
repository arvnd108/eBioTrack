// Owner: A (Backend)
// Purpose: Login, logout and /me against the seeded test database (skipped if unreachable)
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { query } from '../src/db/query.js';
import { loginAttempts } from '../src/utils/loginAttempts.js';
import { devPassword, probeDatabase, resetAndSeedDatabase } from './helpers.js';

const available = await probeDatabase();
const PI_EMAIL = 'principal_investigator@ebiotrack.test';
let password;

const login = (email, pw = password, agent = request(app)) =>
  agent.post('/api/auth/login').send({ email, password: pw });
const sidCookie = (res) =>
  (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ebiotrack.sid='));
const cookieValue = (res) => sidCookie(res)?.split(';')[0];

describe.skipIf(!available)('auth', () => {
  beforeAll(async () => {
    await resetAndSeedDatabase();
    password = await devPassword();
  });
  afterEach(() => loginAttempts.clear());
  afterAll(async () => {
    // Leave the fixture world as seeded: nobody has signed in.
    await query('UPDATE users SET active = true, last_login_at = NULL');
    await query("DELETE FROM audit_logs WHERE action = 'login'");
    await query('DELETE FROM session');
    await closePool();
  });

  describe('POST /api/auth/login', () => {
    it('signs in with the exact user shape and a secure session cookie', async () => {
      const res = await login(PI_EMAIL);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          user_id: 2,
          full_name: expect.any(String),
          email: PI_EMAIL,
          roles: ['principal_investigator'],
          active: true,
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
      const cookie = sidCookie(res);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('accepts an upper-case email', async () => {
      const res = await login(PI_EMAIL.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.body.data.email).toBe(PI_EMAIL);
    });

    it('stamps last_login_at and writes a login audit entry', async () => {
      await login('analyst@ebiotrack.test');
      const rows = await query(
        `SELECT u.last_login_at, (SELECT count(*) FROM audit_logs
                 WHERE actor_id = 5 AND action = 'login' AND entity_type = 'users' AND entity_id = 5) AS audits
           FROM users u WHERE u.user_id = 5`,
      );
      expect(rows[0].last_login_at).not.toBeNull();
      expect(Number(rows[0].audits)).toBeGreaterThanOrEqual(1);
    });

    it('answers a wrong password and an unknown email identically', async () => {
      const wrong = await login(PI_EMAIL, 'definitely-not-it');
      const unknown = await login('nobody@ebiotrack.test', 'definitely-not-it');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.error.code).toBe('invalid_credentials');
      expect(sidCookie(wrong)).toBeUndefined();
    });

    it('rejects an inactive user with the same generic 401', async () => {
      await query('UPDATE users SET active = false WHERE user_id = 6');
      try {
        const res = await login('viewer@ebiotrack.test');
        const wrong = await login(PI_EMAIL, 'nope');
        expect(res.status).toBe(401);
        expect(res.body).toEqual(wrong.body);
      } finally {
        await query('UPDATE users SET active = true WHERE user_id = 6');
      }
    });

    it('rejects an invalid body with 422 validation_error', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_error');
      const fields = res.body.error.details.map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['email', 'password']));
    });

    it('returns 429 after five failures, even for the right password', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await login(PI_EMAIL, `wrong-${i}`)).status).toBe(401);
      }
      const blocked = await login(PI_EMAIL);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('too_many_attempts');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // Another email is not affected.
      expect((await login('analyst@ebiotrack.test')).status).toBe(200);
    });
  });

  describe('session', () => {
    it('rejects /me without a cookie', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('returns the user from /me with a cookie, then 401 after logout and clears the cookie', async () => {
      const agent = request.agent(app);
      await login(PI_EMAIL, password, agent);
      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data.user_id).toBe(2);
      expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);

      const out = await agent.post('/api/auth/logout');
      expect(out.status).toBe(204);
      expect(out.text).toBe('');
      expect(sidCookie(out)).toMatch(/ebiotrack\.sid=;/);

      const after = await agent.get('/api/auth/me');
      expect(after.status).toBe(401);
    });

    it('rejects logout without a session', async () => {
      expect((await request(app).post('/api/auth/logout')).status).toBe(401);
    });

    it('issues a new session id on every login (fixation)', async () => {
      const first = await login(PI_EMAIL);
      const second = await request(app)
        .post('/api/auth/login')
        .set('Cookie', cookieValue(first))
        .send({ email: PI_EMAIL, password });
      expect(cookieValue(second)).toBeDefined();
      expect(cookieValue(second)).not.toBe(cookieValue(first));
      // The old id no longer works.
      const old = await request(app).get('/api/auth/me').set('Cookie', cookieValue(first));
      expect(old.status).toBe(401);
    });

    it('stores only user_id in the session row', async () => {
      const res = await login('lab_technician@ebiotrack.test');
      const sid = decodeURIComponent(cookieValue(res).split('=')[1]).slice(2).split('.')[0];
      const rows = await query('SELECT sess FROM session WHERE sid = $1', [sid]);
      const keys = Object.keys(rows[0].sess).filter((k) => k !== 'cookie');
      expect(keys).toEqual(['user_id']);
      expect(rows[0].sess.user_id).toBe(4);
    });

    it('makes the next request 401 when the user is deactivated mid-session', async () => {
      const agent = request.agent(app);
      await login('field_researcher@ebiotrack.test', password, agent);
      expect((await agent.get('/api/auth/me')).status).toBe(200);
      await query('UPDATE users SET active = false WHERE user_id = 3');
      try {
        expect((await agent.get('/api/auth/me')).status).toBe(401);
      } finally {
        await query('UPDATE users SET active = true WHERE user_id = 3');
      }
    });
  });

  describe('origin check', () => {
    it('rejects a state-changing request from an unexpected origin', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ email: PI_EMAIL, password });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it('allows the configured frontend origin and requests with no Origin', async () => {
      const ok = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ email: PI_EMAIL, password });
      expect(ok.status).toBe(200);
    });
  });
});
