// Owner: C (Testing & QA)
// Purpose: Authentication through the real API: sessions, login, lockout, logout, deactivation, CSRF
//
// Expectations come from CONTRACT 8 (status codes, envelope), 10 ("Auth" and the lockout paragraph)
// and tests/fixtures/README.md (seeded users and the shared development password). Each seeded
// user logs in once per file; every failed-login test uses a user created for it, so the shared
// six are never locked. reseed() (afterAll) truncates `session`, so no cookie outlives the file.
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  COOKIE_NAME,
  ENDPOINTS,
  ROLE_NAMES,
  SEED,
  addGlobalRole,
  anonymous,
  assertNo5xx,
  backendConfig,
  committed,
  createClient,
  devPassword,
  expireSessions,
  limiter,
  login,
  loginAll,
  observedBodies,
  probePath,
  removeGlobalRole,
  restoreIfCommitted,
  serverOrigin,
  setActive,
  sql,
  startApi,
  stopApi,
} from '../setup/api.js';
import { closeTestPool } from '../setup/testDb.js';

const dbAvailable = inject('dbAvailable');

const PASSWORD = devPassword();
const LOCKOUT_EMAIL = 't33.lockout@ebiotrack.test';
const ENVELOPE_LEAK =
  /node_modules|\/Users\/|\.js:\d+|\bat \w+.*\(|SELECT |INSERT |UPDATE |pg_catalog|stack/i;

const setCookieOf = (res) => res.cookies.find((c) => c.name === COOKIE_NAME);
const expectEnvelope = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(
    Object.keys(res.body.error).filter((k) => !['code', 'message', 'details'].includes(k)),
  ).toEqual([]);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.code).toBe(code);
  expect(res.body.error.message).not.toMatch(ENVELOPE_LEAK);
};

describe.skipIf(!dbAvailable)('authentication through the API', () => {
  let users;

  beforeAll(async () => {
    await startApi();
    users = await loginAll();
  });
  afterEach(() => assertNo5xx());
  afterAll(async () => {
    assertNo5xx();
    // Secrets never leak: not one response of this file contained one.
    const bodies = observedBodies();
    expect(bodies.length).toBeGreaterThan(100);
    for (const text of bodies) {
      expect(text).not.toContain('password_hash');
      expect(text).not.toMatch(/\$2[aby]\$/);
      expect(text).not.toContain(PASSWORD);
    }
    await restoreIfCommitted();
    await stopApi();
    await closeTestPool();
  });

  describe('helper self-test', () => {
    it('GET /api/auth/me without a cookie -> 401 envelope', async () => {
      expectEnvelope(await anonymous().get('/api/auth/me'), 401, 'unauthenticated');
    });
    it('GET /api/health is public', async () => {
      const res = await anonymous().get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { status: 'ok' } });
    });
    it('login of user 1 -> 200, the CONTRACT 11 user object, no password_hash', async () => {
      const res = await login(SEED.administrator.email).then(() =>
        users.administrator.get('/api/auth/me'),
      );
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual([
        'active',
        'email',
        'full_name',
        'roles',
        'user_id',
      ]);
      expect(res.body.data).toMatchObject({
        user_id: 1,
        email: SEED.administrator.email,
        roles: ['administrator'],
        active: true,
      });
      expect(res.text).not.toContain('password_hash');
    });
    it('every seeded user signs in with the user object of CONTRACT 11 and exactly their role', () => {
      for (const role of ROLE_NAMES) {
        expect(users[role].user).toMatchObject({
          user_id: SEED[role].user_id,
          roles: [role],
          active: true,
        });
      }
    });
  });

  describe('no cookie -> 401 on every protected endpoint', () => {
    const protectedRows = ENDPOINTS.filter((e) => e.action !== 'public');

    it.each(protectedRows.map((e) => [`${e.method} ${e.path}`, e]))('%s', async (_name, e) => {
      const res = await anonymous().request(e.method, probePath(e), e.body);
      expectEnvelope(res, 401, 'unauthenticated');
    });

    it('a forged or unknown session id is the same 401', async () => {
      const forged = anonymous();
      for (const cookie of [
        `${COOKIE_NAME}=forged`,
        `${COOKIE_NAME}=s%3Aforged.badsignature`,
        `${COOKIE_NAME}=`,
      ]) {
        expectEnvelope(await forged.get('/api/auth/me', { cookie }), 401, 'unauthenticated');
      }
    });

    it('only /api/health, POST /api/auth/login and POST /api/auth/register are public: no other row of the matrix is', () => {
      expect(
        ENDPOINTS.filter((e) => e.action === 'public').map((e) => `${e.method} ${e.path}`),
      ).toEqual(['POST /api/auth/login', 'POST /api/auth/register']);
    });

    it('unknown paths and methods are a 404 JSON envelope, never an HTML error page', async () => {
      const anon = anonymous();
      for (const [method, path] of [
        ['GET', '/api/nope'],
        ['GET', '/nope'],
        ['POST', '/api/nope/deeper/still'],
        ['PUT', '/api/projects/1'],
        ['DELETE', '/api/samples/1'],
      ]) {
        const res = await anon.request(method, path, method === 'POST' ? {} : undefined);
        expect([401, 404], `${method} ${path}`).toContain(res.status);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(typeof res.body.error.code).toBe('string');
        expect(res.text).not.toMatch(/<html|<!doctype|<pre>/i);
      }
      expectEnvelope(await anon.get('/api/nope'), 404, 'not_found');
    });

    it('OPTIONS never produces an HTML page or a server error', async () => {
      for (const path of ['/api/projects', '/api/nope', '/api/auth/login']) {
        const res = await anonymous().request('OPTIONS', path);
        expect(res.status, path).toBeLessThan(500);
        expect(res.text).not.toMatch(/<html|<!doctype/i);
      }
    });
  });

  describe('login', () => {
    it('wrong password and unknown email give the same status and message (no user enumeration)', async () => {
      const wrong = await anonymous().post('/api/auth/login', {
        email: SEED.viewer.email,
        password: 'definitely-wrong',
      });
      const unknown = await anonymous().post('/api/auth/login', {
        email: 'nobody-here@ebiotrack.test',
        password: 'definitely-wrong',
      });
      expectEnvelope(wrong, 401, 'invalid_credentials');
      expectEnvelope(unknown, 401, 'invalid_credentials');
      expect(unknown.body).toEqual(wrong.body);
      expect(setCookieOf(wrong)).toBeUndefined();
      limiter().clear();
    });

    it('an inactive account answers like a wrong password', async () => {
      await sql(
        `INSERT INTO users (full_name, email, password_hash, active)
         SELECT 'T33 inactive', 't33.inactive@ebiotrack.test', password_hash, false FROM users WHERE user_id = 6`,
      );
      committed();
      const inactive = await anonymous().post('/api/auth/login', {
        email: 't33.inactive@ebiotrack.test',
        password: PASSWORD,
      });
      const wrong = await anonymous().post('/api/auth/login', {
        email: SEED.viewer.email,
        password: 'definitely-wrong',
      });
      expect(inactive.status).toBe(wrong.status);
      expect(inactive.body).toEqual(wrong.body);
      limiter().clear();
    });

    it.each([
      ['no body', undefined],
      ['empty object', {}],
      ['no password', { email: SEED.viewer.email }],
      ['no email', { password: PASSWORD }],
      ['empty password', { email: SEED.viewer.email, password: '' }],
      ['email not an email', { email: 'not-an-email', password: PASSWORD }],
      ['non-string types', { email: 5, password: ['x'] }],
      ['a password over 72 bytes', { email: SEED.viewer.email, password: 'x'.repeat(73) }],
    ])(
      'missing or malformed fields (%s) -> 422 validation_error, not a 401 and not counted as a failure',
      async (_n, body) => {
        const res = await anonymous().post('/api/auth/login', body);
        expectEnvelope(res, 422, 'validation_error');
        expect(setCookieOf(res)).toBeUndefined();
      },
    );

    it('an invalid JSON body -> 400 bad_request', async () => {
      const res = await anonymous().post('/api/auth/login', undefined, {
        raw: '{"email": ',
        headers: { 'content-type': 'application/json' },
      });
      expectEnvelope(res, 400, 'bad_request');
    });

    it('the email is case-insensitive (ck_users_email_lower): upper case and padding sign in', async () => {
      const res = await anonymous().post('/api/auth/login', {
        email: `  ${SEED.viewer.email.toUpperCase()}  `,
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.user_id).toBe(SEED.viewer.user_id);
    });

    it('success sets ebiotrack.sid with HttpOnly, SameSite=Lax, Path=/ and (NODE_ENV=test) not Secure', async () => {
      const res = await anonymous().post('/api/auth/login', {
        email: SEED.analyst.email,
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      const cookie = setCookieOf(res);
      expect(cookie, 'a Set-Cookie for ebiotrack.sid').toBeDefined();
      expect(cookie.attrs).toContain('httponly');
      expect(cookie.attrMap.samesite?.toLowerCase()).toBe('lax');
      expect(cookie.attrMap.path).toBe('/');
      expect(cookie.attrs).not.toContain('secure');
      expect(cookie.attrMap.expires ?? cookie.attrMap['max-age']).toBeDefined();
      expect(cookie.value.length).toBeGreaterThan(16);
    });

    it('every login gets a new session id (log in twice: the ids differ)', async () => {
      const first = await login(SEED.viewer.email);
      const second = await login(SEED.viewer.email);
      expect(first.sid).not.toBe(second.sid);
      // both sessions are valid at the same time (no single-session policy in the contract)
      expect((await first.get('/api/auth/me')).status).toBe(200);
      expect((await second.get('/api/auth/me')).status).toBe(200);
    });

    it('session fixation: an id sent before login is not reused, and a planted id stays useless', async () => {
      const planted = `${COOKIE_NAME}=planted-by-an-attacker`;
      const res = await anonymous().post(
        '/api/auth/login',
        { email: SEED.viewer.email, password: PASSWORD },
        { cookie: planted },
      );
      expect(res.status).toBe(200);
      const cookie = setCookieOf(res);
      expect(cookie.value).not.toBe('planted-by-an-attacker');
      expectEnvelope(
        await anonymous().get('/api/auth/me', { cookie: planted }),
        401,
        'unauthenticated',
      );
    });

    it('signing in again on top of a live cookie destroys the old session (regenerate)', async () => {
      const a = await login(SEED.analyst.email);
      const old = a.cookie;
      const res = await a.post('/api/auth/login', {
        email: SEED.analyst.email,
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expectEnvelope(
        await anonymous().get('/api/auth/me', { cookie: old }),
        401,
        'unauthenticated',
      );
      expect((await a.get('/api/auth/me')).status).toBe(200);
    });

    it('last_login_at is stamped by a successful sign-in only', async () => {
      const [{ last_login_at: before }] = await sql(
        'SELECT last_login_at FROM users WHERE user_id = 6',
      );
      expect(before, 'viewer logged in during this file already').not.toBeNull();
      await anonymous().post('/api/auth/login', {
        email: SEED.viewer.email,
        password: 'wrong-wrong',
      });
      const [{ last_login_at: afterFail }] = await sql(
        'SELECT last_login_at FROM users WHERE user_id = 6',
      );
      expect(afterFail.getTime()).toBe(before.getTime());
      await login(SEED.viewer.email);
      const [{ last_login_at: afterOk }] = await sql(
        'SELECT last_login_at FROM users WHERE user_id = 6',
      );
      expect(afterOk.getTime()).toBeGreaterThan(before.getTime());
      limiter().clear();
    });
  });

  describe('lockout (a user created for this test; the six shared users are never locked)', () => {
    const bad = () =>
      anonymous().post('/api/auth/login', { email: LOCKOUT_EMAIL, password: 'wrong-password' });
    const good = () =>
      anonymous().post('/api/auth/login', { email: LOCKOUT_EMAIL, password: PASSWORD });

    beforeAll(async () => {
      committed();
      await sql(
        `INSERT INTO users (full_name, email, password_hash, active)
         SELECT 'T33 lockout', $1, password_hash, true FROM users WHERE user_id = 6`,
        [LOCKOUT_EMAIL],
      );
    });
    afterEach(() => limiter().clear());

    it('after 5 failures the 6th attempt -> 429 too_many_attempts with a numeric Retry-After', async () => {
      for (let i = 1; i <= 5; i += 1) {
        expect((await bad()).status, `failure ${i}`).toBe(401);
      }
      const sixth = await bad();
      expectEnvelope(sixth, 429, 'too_many_attempts');
      const retry = sixth.headers.get('retry-after');
      expect(retry).toMatch(/^\d+$/);
      expect(Number(retry)).toBeGreaterThan(0);
      expect(Number(retry)).toBeLessThanOrEqual(15 * 60);
    });

    it('a correct password during lockout is still refused (429) and no session is created', async () => {
      for (let i = 0; i < 5; i += 1) await bad();
      const res = await good();
      expectEnvelope(res, 429, 'too_many_attempts');
      expect(setCookieOf(res)).toBeUndefined();
      expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    });

    it('when the window ends (limiter state cleared, no waiting) the correct password signs in again', async () => {
      for (let i = 0; i < 5; i += 1) await bad();
      expect((await good()).status).toBe(429);
      limiter().clear();
      const res = await good();
      expect(res.status).toBe(200);
      expect(setCookieOf(res)).toBeDefined();
    });

    it('a successful sign-in resets the count: 4 failures, success, 4 more failures are all still 401', async () => {
      for (let i = 0; i < 4; i += 1) expect((await bad()).status).toBe(401);
      expect((await good()).status).toBe(200);
      for (let i = 0; i < 4; i += 1) expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(401); // the 5th failure since the reset is still a 401
      expect((await bad()).status).toBe(429);
    });

    it('the lock is per email: another account from the same address signs in', async () => {
      for (let i = 0; i < 5; i += 1) await bad();
      expect((await bad()).status).toBe(429);
      expect(
        (
          await anonymous().post('/api/auth/login', {
            email: SEED.viewer.email,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
    });
  });

  describe('logout', () => {
    it('204, the old cookie is refused afterwards, and /me is 401', async () => {
      const c = await login(SEED.lab_technician.email);
      const old = c.cookie;
      const out = await c.post('/api/auth/logout');
      expect(out.status).toBe(204);
      expect(out.text).toBe('');
      expectEnvelope(
        await anonymous().get('/api/auth/me', { cookie: old }),
        401,
        'unauthenticated',
      );
      expectEnvelope(await c.get('/api/auth/me'), 401, 'unauthenticated');
    });
    it('logout without a session -> 401, a second logout with the old cookie -> 401', async () => {
      expectEnvelope(await anonymous().post('/api/auth/logout'), 401, 'unauthenticated');
      const c = await login(SEED.lab_technician.email);
      const old = c.cookie;
      await c.post('/api/auth/logout');
      expectEnvelope(
        await anonymous().post('/api/auth/logout', undefined, { cookie: old }),
        401,
        'unauthenticated',
      );
    });
    it("logging one browser out leaves the same user's other session alone", async () => {
      const one = await login(SEED.lab_technician.email);
      const two = await login(SEED.lab_technician.email);
      await one.post('/api/auth/logout');
      expect((await two.get('/api/auth/me')).status).toBe(200);
    });
  });

  describe('changes made in the database take effect on the very next request', () => {
    it('deactivation: a live cookie dies at once, login is refused, reactivation does not revive the old cookie', async () => {
      const c = await login(SEED.analyst.email);
      expect((await c.get('/api/projects')).status).toBe(200);
      await setActive(SEED.analyst.user_id, false);
      expectEnvelope(await c.get('/api/projects'), 401, 'unauthenticated');
      expect(
        (
          await anonymous().post('/api/auth/login', {
            email: SEED.analyst.email,
            password: PASSWORD,
          })
        ).status,
      ).toBe(401);
      await setActive(SEED.analyst.user_id, true);
      expectEnvelope(await c.get('/api/projects'), 401, 'unauthenticated');
      expect((await login(SEED.analyst.email)).user.user_id).toBe(SEED.analyst.user_id);
      limiter().clear();
    });

    it('removing the only role -> the next privileged request is 403; adding a second role applies the union', async () => {
      const c = await login(SEED.analyst.email);
      expect((await c.post('/api/analyses/import', {})).status).toBe(422);
      await removeGlobalRole(SEED.analyst.user_id, 'analyst');
      // still a contributor of project 1: the project role keeps import open (CONTRACT 9)
      expect((await c.post('/api/analyses/import', {})).status).toBe(422);
      expect((await c.post('/api/analyses/abc/approve')).status).toBe(403);
      expect((await c.get('/api/auth/me')).body.data.roles).toEqual([]);
      await addGlobalRole(SEED.analyst.user_id, 'principal_investigator');
      expect((await c.post('/api/analyses/abc/approve')).status).toBe(422);
      expect((await c.post('/api/analyses/import', {})).status).toBe(422);
      await addGlobalRole(SEED.analyst.user_id, 'analyst');
      await removeGlobalRole(SEED.analyst.user_id, 'principal_investigator');
      expect((await c.post('/api/analyses/abc/approve')).status).toBe(403);
      expect((await c.get('/api/auth/me')).body.data.roles).toEqual(['analyst']);
    });

    it('an expired session row (expire in the past, table `session` from migration 095) -> 401', async () => {
      const c = await login(SEED.lab_technician.email);
      expect((await c.get('/api/auth/me')).status).toBe(200);
      await expireSessions(SEED.lab_technician.user_id);
      expectEnvelope(await c.get('/api/auth/me'), 401, 'unauthenticated');
    });

    it('a deleted session row -> 401', async () => {
      const c = await login(SEED.lab_technician.email);
      committed();
      await sql(`DELETE FROM session WHERE sess ->> 'user_id' = $1`, [
        String(SEED.lab_technician.user_id),
      ]);
      expectEnvelope(await c.get('/api/auth/me'), 401, 'unauthenticated');
    });
  });

  describe('CSRF origin check on state-changing requests', () => {
    const own = () => serverOrigin();
    const probe = (c, origin) =>
      c.post('/api/projects', {}, origin === undefined ? {} : { headers: { origin } });

    it('a foreign Origin on POST/PATCH/DELETE -> 403 forbidden, before any other check', async () => {
      const pi = users.principal_investigator;
      const evil = { headers: { origin: 'https://evil.example' } };
      expectEnvelope(await pi.post('/api/projects', {}, evil), 403, 'forbidden');
      expectEnvelope(await pi.patch('/api/projects/1', {}, evil), 403, 'forbidden');
      expectEnvelope(await pi.delete('/api/projects/1/sites/1', undefined, evil), 403, 'forbidden');
      // even an unauthenticated caller meets the origin check first
      expectEnvelope(
        await anonymous().post(
          '/api/auth/login',
          { email: SEED.viewer.email, password: PASSWORD },
          evil,
        ),
        403,
        'forbidden',
      );
    });
    it('Origin: null and a malformed Origin are refused too', async () => {
      expectEnvelope(await probe(users.principal_investigator, 'null'), 403, 'forbidden');
      expectEnvelope(await probe(users.principal_investigator, 'not a url'), 403, 'forbidden');
    });
    it("the server's own origin passes the check (the request goes on to validation: 422)", async () => {
      expect((await probe(users.principal_investigator, own())).status).toBe(422);
    });
    it('an origin listed in ALLOWED_ORIGINS passes the check', async () => {
      const listed = backendConfig().allowedOrigins;
      expect(listed.length, 'the backend lists at least the dev frontend origin').toBeGreaterThan(
        0,
      );
      for (const origin of listed) {
        expect((await probe(users.principal_investigator, origin)).status, origin).toBe(422);
      }
    });
    it('a host that merely contains the allowed host is not allowed', async () => {
      const own = new URL(serverOrigin());
      expectEnvelope(
        await probe(
          users.principal_investigator,
          `${own.protocol}//${own.hostname}.evil.example:${own.port}`,
        ),
        403,
        'forbidden',
      );
      // CONTRACT GAP: the check compares the Origin's host only, not its scheme, so
      // https://<own host> passes; the contract says "this server's own host", which allows it.
    });
    it('no Origin header passes (documented: curl and server-side clients are not cross-site browsers)', async () => {
      expect((await probe(users.principal_investigator)).status).toBe(422);
    });
    it('GET with a foreign Origin is not blocked', async () => {
      const res = await users.principal_investigator.get('/api/projects', {
        headers: { origin: 'https://evil.example' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('error envelope', () => {
    it('401, 403, 404, 400, 422 and 429 all use { error: { code, message, details? } }', async () => {
      const viewer = users.viewer;
      expectEnvelope(await anonymous().get('/api/auth/me'), 401, 'unauthenticated');
      expectEnvelope(await viewer.get('/api/users'), 403, 'forbidden');
      expectEnvelope(await viewer.get('/api/projects/999999'), 404, 'not_found');
      expectEnvelope(await viewer.get('/api/no-such-route'), 404, 'not_found');
      expectEnvelope(
        await users.principal_investigator.post('/api/projects', undefined, {
          raw: '{',
          headers: { 'content-type': 'application/json' },
        }),
        400,
        'bad_request',
      );
      const invalid = await users.principal_investigator.post('/api/projects', {});
      expectEnvelope(invalid, 422, 'validation_error');
      expect(Array.isArray(invalid.body.error.details)).toBe(true);
      expect(Object.keys(invalid.body.error.details[0]).sort()).toEqual(['field', 'message']);
    });

    it('404 and 403 messages never echo SQL, stack traces or file paths', async () => {
      const probes = [
        await users.viewer.get('/api/projects/1%27%20OR%201=1--'),
        await users.viewer.get('/api/samples/99999999999999999999'),
        await users.viewer.get('/api/users'),
        await users.viewer.get('/api/does/not/exist'),
        await users.analyst.get('/api/projects/2'),
      ];
      for (const res of probes) {
        expect(res.status).toBeLessThan(500);
        expect(res.body.error.message).not.toMatch(ENVELOPE_LEAK);
        expect(JSON.stringify(res.body)).not.toMatch(/ebiotrack_test|postgres|ECONN/i);
      }
    });
  });

  it('createClient keeps cookies per client: two clients never share a session', async () => {
    const a = createClient(users.administrator.cookie);
    const b = createClient();
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
  });
});
