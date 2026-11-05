// Owner: C (Testing & QA)
// Purpose: In-process API server and cookie client for the authorization suites (T33)
//
// The backend app runs inside the test process (no supertest, no extra dependency):
//   const api = await startApi();                    // http.createServer(app).listen(0)
//   const pi = await api.login(SEED.principal_investigator.email);
//   const res = await pi.get('/api/projects');       // { status, headers, body, text }
//   await stopApi();                                 // closes the server, the backend pool, the limiter
//
// `fetch` keeps no cookies, so a client stores the Set-Cookie of its login response and sends it
// back. Every response status and body is recorded: assertNo5xx() fails a run that crashed the
// server, and observedBodies() feeds the "no secrets in any response" scan.
//
// Data the API cannot create (a second role, a deactivated user, an expired session) is changed
// with committed SQL through sql(); call restoreIfCommitted() afterwards. reseed() truncates the
// `session` table, so every cached cookie is dead after it: log in again.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { getPool, getTestDatabaseUrl, assertSafeTarget, reseed } from './testDb.js';

export { committed, restoreIfCommitted } from './transactions.js';

/** The six seeded users (tests/fixtures/README.md, CONTRACT 6). Emails are typed, not read from the DB. */
export const SEED = Object.freeze({
  administrator: { user_id: 1, email: 'administrator@ebiotrack.test' },
  principal_investigator: { user_id: 2, email: 'principal_investigator@ebiotrack.test' },
  field_researcher: { user_id: 3, email: 'field_researcher@ebiotrack.test' },
  lab_technician: { user_id: 4, email: 'lab_technician@ebiotrack.test' },
  analyst: { user_id: 5, email: 'analyst@ebiotrack.test' },
  viewer: { user_id: 6, email: 'viewer@ebiotrack.test' },
});
export const ROLE_NAMES = Object.freeze(Object.keys(SEED));
export const COOKIE_NAME = 'ebiotrack.sid';

/** The shared development password, read from the fixtures README where the project documents it. */
export function devPassword() {
  const readme = readFileSync(new URL('../fixtures/README.md', import.meta.url), 'utf8');
  const match = /shares? one password: `([^`]+)`/i.exec(readme);
  if (!match) throw new Error('dev password not found in tests/fixtures/README.md');
  return match[1];
}

/** Every response of the process: statuses for the 5xx guard, bodies for the secret scan. */
const observed = [];
export const statuses = [];

let checked = 0;

/** Fail when any response observed since the last call was a server error. */
export function assertNo5xx() {
  const fresh = observed.slice(checked);
  checked = observed.length;
  const bad = fresh.filter((o) => o.status >= 500);
  if (bad.length) {
    throw new Error(
      `Server errors observed: ${bad
        .slice(0, 5)
        .map((o) => `${o.method} ${o.path} -> ${o.status}`)
        .join('; ')}`,
    );
  }
}

/** Raw bodies of every response observed in this file. */
export const observedBodies = () => observed.map((o) => o.text);

let server = null;
let baseUrl = null;
let backend = null;

/**
 * Start the backend app on an ephemeral port. Refuses to run unless the app is bound to the test
 * database.
 */
export async function startApi() {
  if (server) return api;
  const url = getTestDatabaseUrl();
  assertSafeTarget(url);
  let config;
  try {
    ({ config } = await import('../../backend/src/config/env.js'));
  } catch (err) {
    throw new Error(
      `the backend environment is incomplete (needs SESSION_SECRET and TEST_DATABASE_URL, as CI sets them): ${err.message}`,
      { cause: err },
    );
  }
  if (!config.isTest) throw new Error('NODE_ENV must be "test" for the authorization suites');
  assertSafeTarget(config.databaseUrl);
  if (config.databaseUrl !== url) {
    throw new Error('the backend would use a different database than TEST_DATABASE_URL');
  }
  const [{ app }, attempts] = await Promise.all([
    import('../../backend/src/app.js'),
    import('../../backend/src/utils/loginAttempts.js'),
  ]);
  backend = { loginAttempts: attempts.loginAttempts, attemptKey: attempts.attemptKey, config };
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return api;
}

/** Close the server, the backend pool and forget the limiter. Safe to call twice. */
export async function stopApi() {
  const s = server;
  server = null;
  if (s) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
  if (backend) {
    backend.loginAttempts.clear();
    const { closePool } = await import('../../backend/src/db/pool.js');
    await closePool();
    backend = null;
  }
}

/** The backend limiter (module state of this process), for explicit resets instead of waiting. */
export function limiter() {
  if (!backend) throw new Error('startApi() first');
  return backend.loginAttempts;
}
export const limiterKey = (email) => backend.attemptKey(socketAddress(), email);
// The client address Express reports for a loopback fetch.
function socketAddress() {
  return '::ffff:127.0.0.1';
}
export const serverOrigin = () => baseUrl;
export const backendConfig = () => backend.config;

function parseSetCookie(headers) {
  const list = headers.getSetCookie?.() ?? [];
  return list.map((raw) => {
    const [pair, ...attrs] = raw.split(';').map((p) => p.trim());
    const i = pair.indexOf('=');
    return {
      raw,
      name: pair.slice(0, i),
      value: decodeURIComponent(pair.slice(i + 1)),
      attrs: attrs.map((a) => a.toLowerCase()),
      attrMap: Object.fromEntries(
        attrs.map((a) => {
          const j = a.indexOf('=');
          return j === -1 ? [a.toLowerCase(), true] : [a.slice(0, j).toLowerCase(), a.slice(j + 1)];
        }),
      ),
    };
  });
}

/**
 * A client with its own cookie jar. Methods return { status, headers, body, text, cookies }.
 * @param {string | null} [initialCookie] raw "ebiotrack.sid=..." value to start with
 */
export function createClient(initialCookie = null) {
  let cookie = initialCookie;

  async function request(method, path, body, opts = {}) {
    if (!baseUrl) throw new Error('startApi() first');
    const headers = { ...(opts.headers ?? {}) };
    const jar = opts.cookie === undefined ? cookie : opts.cookie;
    if (jar) headers.cookie = jar;
    let payload;
    if (opts.raw !== undefined) {
      payload = opts.raw;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      redirect: 'manual',
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      /* non-JSON bodies (CSV, HTML) stay text */
    }
    statuses.push(res.status);
    observed.push({ method, path, status: res.status, text });
    const cookies = parseSetCookie(res.headers);
    for (const c of cookies) {
      if (c.name !== COOKIE_NAME || opts.keepJar) continue;
      const expired = c.value === '' || c.attrMap.expires?.includes('1970');
      cookie = expired ? null : `${c.name}=${encodeURIComponent(c.value)}`;
    }
    return { status: res.status, headers: res.headers, body: parsed, text, cookies };
  }

  const client = {
    request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    patch: (path, body, opts) => request('PATCH', path, body, opts),
    put: (path, body, opts) => request('PUT', path, body, opts),
    delete: (path, body, opts) => request('DELETE', path, body, opts),
    /** The raw cookie header value this client sends, or null. */
    get cookie() {
      return cookie;
    },
    /** The session id inside the cookie (never print it). */
    get sid() {
      return cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
    },
    forget() {
      cookie = null;
    },
  };
  return client;
}

/** A client without a cookie. */
export const anonymous = () => createClient();

/**
 * Sign in and return a client holding the session cookie. Login costs a bcrypt check (~250 ms), so
 * do it once per user per file.
 * @param {string} email
 * @param {string} [password] defaults to the shared dev password
 */
export async function login(email, password = devPassword()) {
  const c = createClient();
  const res = await c.post('/api/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`sign-in as ${email} failed with ${res.status}`);
  c.user = res.body.data;
  return c;
}

/** Sign in all six seeded users: { administrator: client, ... }. */
export async function loginAll() {
  const out = {};
  for (const role of ROLE_NAMES) out[role] = await login(SEED[role].email);
  return out;
}

// ---- committed SQL setup ----------------------------------------------------------------------

/** Parameterised SQL on the test database (values never built into the text). */
export async function sql(text, params = []) {
  return (await getPool().query(text, params)).rows;
}

/** Give a user an extra global role (by role name). Committed: restore with reseed(). */
export async function addGlobalRole(userId, roleName) {
  const { committed } = await import('./transactions.js');
  committed();
  await sql(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, role_id FROM roles WHERE role_name = $2
     ON CONFLICT DO NOTHING`,
    [userId, roleName],
  );
}

/** Remove one global role from a user. */
export async function removeGlobalRole(userId, roleName) {
  const { committed } = await import('./transactions.js');
  committed();
  await sql(
    `DELETE FROM user_roles WHERE user_id = $1
        AND role_id = (SELECT role_id FROM roles WHERE role_name = $2)`,
    [userId, roleName],
  );
}

/** Set a user's project role (insert or change). */
export async function setProjectRole(projectId, userId, projectRole) {
  const { committed } = await import('./transactions.js');
  committed();
  await sql(
    `INSERT INTO project_members (project_id, user_id, project_role)
     VALUES ($1, $2, $3::project_role)
     ON CONFLICT (project_id, user_id) DO UPDATE SET project_role = EXCLUDED.project_role`,
    [projectId, userId, projectRole],
  );
}

/** Activate or deactivate a user. */
export async function setActive(userId, active) {
  const { committed } = await import('./transactions.js');
  committed();
  await sql('UPDATE users SET active = $2 WHERE user_id = $1', [userId, active]);
}

/** Make the user's stored sessions expire in the past. */
export async function expireSessions(userId) {
  const { committed } = await import('./transactions.js');
  committed();
  await sql(
    `UPDATE session SET expire = now() - interval '1 minute' WHERE (sess ->> 'user_id')::int = $1`,
    [userId],
  );
}

/** Wipe the session table and reseed: the fixture world, no live cookies. */
export async function resetWorld() {
  await reseed();
}

const api = {
  login,
  loginAll,
  anonymous,
  createClient,
};
export default api;

// ---- the permission matrix as data (typed from CONTRACT 9 and 10) ------------------------------

const { administrator: ADMIN, principal_investigator: PI } = Object.fromEntries(
  ROLE_NAMES.map((r) => [r, r]),
);
const [FR, LT, AN] = ['field_researcher', 'lab_technician', 'analyst'];
const ALL = ROLE_NAMES;

/** CONTRACT 9, action -> global roles that may do it ("own" included: membership is separate). */
export const MATRIX = Object.freeze({
  manage_users: [ADMIN],
  read_audit_log: [ADMIN, PI],
  // Project roles also decide (CONTRACT 9, as amended): every probe targets project 1 where the
  // PI is the owner, users 3-5 are contributors and user 6 is a viewer, so a contributor may do
  // every write except edit_project (owner/manager) and decide_analysis (owner/manager), and the
  // project viewer is read-only. Any signed-in user may create a project.
  create_project: ALL,
  edit_project: [ADMIN, PI],
  manage_sites: [ADMIN, PI, FR, LT, AN],
  create_event_sample: [ADMIN, PI, FR, LT, AN],
  change_sample_status: [ADMIN, PI, FR, LT, AN],
  record_lab: [ADMIN, PI, FR, LT, AN],
  create_analysis: [ADMIN, PI, FR, LT, AN],
  decide_analysis: [ADMIN, PI],
  read_data: ALL,
});

/**
 * CONTRACT 10, one row per endpoint: method, path as written in the contract, the CONTRACT 9
 * action, and the probe (concrete path, body, statuses an ALLOWED caller gets). `skip` rows are
 * public or session-ending and covered in session-auth.test.js.
 */
export const ENDPOINTS = [
  // Auth
  {
    method: 'POST',
    path: '/api/auth/login',
    action: 'public',
    skip: 'public; session-auth.test.js',
  },
  {
    method: 'POST',
    path: '/api/auth/register',
    action: 'public',
    skip: 'public; auth.test.js (backend)',
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    action: 'read_data',
    skip: 'ends the session; session-auth.test.js',
  },
  { method: 'GET', path: '/api/auth/me', action: 'read_data', ok: [200] },
  // Users (administration)
  { method: 'GET', path: '/api/users', action: 'manage_users', ok: [200] },
  { method: 'POST', path: '/api/users', action: 'manage_users', body: {}, ok: [422] },
  {
    method: 'PATCH',
    path: '/api/users/:id',
    action: 'manage_users',
    probe: '/api/users/6',
    body: {},
    ok: [422],
  },
  { method: 'GET', path: '/api/roles', action: 'read_data', ok: [200] },
  // Projects
  { method: 'GET', path: '/api/projects', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/projects', action: 'create_project', body: {}, ok: [422] },
  {
    method: 'GET',
    path: '/api/projects/:id',
    action: 'read_data',
    probe: '/api/projects/1',
    ok: [200],
  },
  {
    method: 'PATCH',
    path: '/api/projects/:id',
    action: 'edit_project',
    probe: '/api/projects/1',
    body: {},
    ok: [422],
  },
  {
    method: 'POST',
    path: '/api/projects/:id/members',
    action: 'edit_project',
    probe: '/api/projects/1/members',
    body: {},
    ok: [422],
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id/members/:userId',
    action: 'edit_project',
    probe: '/api/projects/1/members/abc',
    ok: [422],
  },
  {
    method: 'POST',
    path: '/api/projects/:id/sites',
    action: 'edit_project',
    probe: '/api/projects/1/sites',
    body: {},
    ok: [422],
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id/sites/:siteId',
    action: 'edit_project',
    probe: '/api/projects/1/sites/abc',
    ok: [422],
  },
  // Sites and regions
  { method: 'GET', path: '/api/regions', action: 'read_data', ok: [200] },
  { method: 'GET', path: '/api/sites', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/sites', action: 'manage_sites', body: {}, ok: [422] },
  { method: 'GET', path: '/api/sites/:id', action: 'read_data', probe: '/api/sites/1', ok: [200] },
  {
    method: 'PATCH',
    path: '/api/sites/:id',
    action: 'manage_sites',
    probe: '/api/sites/1',
    body: {},
    ok: [422],
  },
  // Collection events (the gate reads the project from body.project_id)
  { method: 'GET', path: '/api/events', action: 'read_data', ok: [200] },
  {
    method: 'POST',
    path: '/api/events',
    action: 'create_event_sample',
    body: { project_id: 1 },
    ok: [422],
  },
  {
    method: 'GET',
    path: '/api/events/:id',
    action: 'read_data',
    probe: '/api/events/1',
    ok: [200],
  },
  // Samples
  { method: 'GET', path: '/api/sample-types', action: 'read_data', ok: [200] },
  { method: 'GET', path: '/api/samples', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/samples', action: 'create_event_sample', body: {}, ok: [422] },
  {
    method: 'GET',
    path: '/api/samples/:id',
    action: 'read_data',
    probe: '/api/samples/1',
    ok: [200],
  },
  {
    method: 'PATCH',
    path: '/api/samples/:id/status',
    action: 'change_sample_status',
    probe: '/api/samples/1/status',
    body: {},
    ok: [422],
  },
  // Laboratory
  { method: 'GET', path: '/api/labs', action: 'read_data', ok: [200] },
  { method: 'GET', path: '/api/markers', action: 'read_data', ok: [200] },
  { method: 'GET', path: '/api/extraction-batches', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/extraction-batches', action: 'record_lab', body: {}, ok: [422] },
  { method: 'GET', path: '/api/extractions', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/extractions', action: 'record_lab', body: {}, ok: [422] },
  {
    method: 'PATCH',
    path: '/api/extractions/:id',
    action: 'record_lab',
    probe: '/api/extractions/1',
    body: {},
    ok: [422],
  },
  { method: 'POST', path: '/api/qc-results', action: 'record_lab', body: {}, ok: [422] },
  { method: 'GET', path: '/api/qc-results', action: 'read_data', ok: [200] },
  { method: 'GET', path: '/api/sequencing-runs', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/sequencing-runs', action: 'record_lab', body: {}, ok: [422] },
  {
    method: 'GET',
    path: '/api/sequencing-runs/:id',
    action: 'read_data',
    probe: '/api/sequencing-runs/1',
    ok: [200],
  },
  {
    method: 'POST',
    path: '/api/sequencing-runs/:id/libraries',
    action: 'record_lab',
    probe: '/api/sequencing-runs/1/libraries',
    body: {},
    ok: [422],
  },
  {
    method: 'PATCH',
    path: '/api/sequencing-runs/:id',
    action: 'record_lab',
    probe: '/api/sequencing-runs/1',
    body: {},
    ok: [422],
  },
  // Analyses and detections (approve probes a non-numeric id so a passing gate cannot approve anything)
  { method: 'GET', path: '/api/analyses', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/analyses', action: 'create_analysis', body: {}, ok: [422] },
  {
    method: 'GET',
    path: '/api/analyses/:id',
    action: 'read_data',
    probe: '/api/analyses/1',
    ok: [200],
  },
  { method: 'POST', path: '/api/analyses/import', action: 'create_analysis', body: {}, ok: [422] },
  {
    method: 'POST',
    path: '/api/analyses/:id/approve',
    action: 'decide_analysis',
    probe: '/api/analyses/abc/approve',
    ok: [422],
  },
  {
    method: 'POST',
    path: '/api/analyses/:id/reject',
    action: 'decide_analysis',
    probe: '/api/analyses/abc/reject',
    body: {},
    ok: [422],
  },
  // Taxa
  { method: 'GET', path: '/api/taxa', action: 'read_data', ok: [200] },
  { method: 'GET', path: '/api/taxa/:id', action: 'read_data', probe: '/api/taxa/1', ok: [200] },
  {
    method: 'GET',
    path: '/api/taxa/:id/detections',
    action: 'read_data',
    probe: '/api/taxa/1/detections',
    ok: [200],
  },
  // Analytics, dashboard, exports, audit
  { method: 'GET', path: '/api/analytics/richness', action: 'read_data', ok: [200] },
  {
    method: 'GET',
    path: '/api/analytics/detection-frequency',
    action: 'read_data',
    probe: '/api/analytics/detection-frequency?taxon_id=1',
    ok: [200],
  },
  { method: 'GET', path: '/api/dashboard/summary', action: 'read_data', ok: [200] },
  { method: 'POST', path: '/api/exports', action: 'read_data', body: {}, ok: [422] },
  {
    method: 'GET',
    path: '/api/exports/:id/download',
    action: 'read_data',
    probe: '/api/exports/999999/download',
    ok: [404],
    notFound: 'Export not found',
  },
  { method: 'GET', path: '/api/audit', action: 'read_audit_log', ok: [200] },
];

export const mayCall = (role, action) => action === 'public' || MATRIX[action].includes(role);
export const probePath = (e) => e.probe ?? e.path;

/** Mounted routes (method + full path) read from backend/src/app.js and routes/*.js. */
export function mountedRoutes() {
  const backendSrc = fileURLToPath(new URL('../../backend/src/', import.meta.url));
  const app = readFileSync(`${backendSrc}app.js`, 'utf8');

  // import X, { a, b as c } from './routes/file.js'  ->  local name -> { file, exported }
  const locals = new Map();
  for (const m of app.matchAll(/import\s+([^;]+?)\s+from\s+'\.\/routes\/([\w.-]+)'/g)) {
    const [, clause, file] = m;
    const def = /^(\w+)\s*(?:,|$)/.exec(clause.trim());
    if (def) locals.set(def[1], { file, exported: 'default' });
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of named?.[1].split(',') ?? []) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) locals.set(alias ?? orig, { file, exported: orig });
    }
  }
  const mounts = [...app.matchAll(/app\.use\(\s*'(\/api\/[\w/-]+)'\s*,\s*(\w+)\s*\)/g)].map(
    (m) => ({
      mount: m[1],
      local: m[2],
    }),
  );
  if (mounts.length < 15) {
    throw new Error(`route walker: expected the app.js mounts, found ${mounts.length}`);
  }

  const routes = [];
  for (const { mount, local } of mounts) {
    const target = locals.get(local);
    if (!target) throw new Error(`route walker: no import found for mounted router "${local}"`);
    const text = readFileSync(`${backendSrc}routes/${target.file}`, 'utf8');
    let variable = target.exported;
    if (variable === 'default') {
      const d = /export default (\w+);/.exec(text);
      if (!d) throw new Error(`route walker: no default export in ${target.file}`);
      variable = d[1];
    }
    const found = [
      ...text.matchAll(
        new RegExp(`\\b${variable}\\s*\\.\\s*(get|post|put|patch|delete)\\(\\s*'([^']*)'`, 'g'),
      ),
    ];
    if (found.length === 0)
      throw new Error(`route walker: no routes for ${variable} in ${target.file}`);
    for (const f of found) {
      routes.push({ method: f[1].toUpperCase(), path: f[2] === '/' ? mount : `${mount}${f[2]}` });
    }
  }
  for (const m of app.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes;
}

/** Method + path rows of CONTRACT section 10. */
export function contractEndpoints() {
  const text = readFileSync(new URL('../../planning/CONTRACT.md', import.meta.url), 'utf8');
  const start = text.indexOf('## 10. Endpoints');
  const end = text.indexOf('## 11.', start);
  if (start === -1 || end === -1) throw new Error('CONTRACT section 10 not found');
  return [
    ...text.slice(start, end).matchAll(/^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`([^`]+)`/gm),
  ].map((m) => ({ method: m[1], path: m[2] }));
}

export const endpointKey = (e) => `${e.method} ${e.path}`;
