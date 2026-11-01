// Owner: B (Frontend)
// Purpose: In-browser mock of the REST API, answering with CONTRACT section 10/11 shapes
//
// Used when VITE_USE_MOCK=true (see apiClient.ts). Each handler returns what the real server
// would: an HTTP status and a JSON body (`{ data, meta? }` or `{ error }`). Covers every GET
// endpoint in section 10, plus the section 11 write examples (login/logout, create event,
// import dry run, export). Pages that need more writes add a handler here.
//
// Rules copied from the contract so pages see realistic behaviour:
//   - lists are paginated (?page, ?limit; default 25, max 100) with meta { page, limit, total }
//   - project data the user is not a member of is hidden (404 for a single item)
//   - analytics and detections use only approved analyses and qc_flag = 'pass', and analytics
//     responses carry meta.caveat
//
// To mock a new endpoint, add one entry to `routes` below. Paths are relative to /api and may
// use `:params`, for example '/projects/:id'.

import {
  EDNA_CAVEAT,
  type ApiErrorDetail,
  type CollectionEvent,
  type CollectionEventDetail,
  type CreateEventRequest,
  type PageMeta,
  type RoleName,
  type Sample,
  type User,
} from '../../types';
import type { HttpMethod } from '../apiClient';
import {
  hasAnyRole,
  mockAnalyses,
  mockAssignments,
  mockAudit,
  mockBatches,
  mockEvents,
  mockExtractions,
  mockLabs,
  mockLibraries,
  mockMarkers,
  mockMeasurements,
  mockMemberships,
  mockProjectSites,
  mockProjects,
  mockQcResults,
  mockRegions,
  mockRoles,
  mockRuns,
  mockSamples,
  mockSampleTypes,
  mockSites,
  mockTaxa,
  mockUsers,
  DEV_PASSWORD,
  sampleCode,
  statusHistoryFor,
} from './fixtures';

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface MockContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Signed-in user; always set unless the route has `auth: false`. */
  user: User;
}

interface MockRoute {
  method: HttpMethod;
  path: string;
  /** Default true: return 401 when nobody is signed in. */
  auth?: boolean;
  /** Global roles allowed (administrators always pass). Others get 403. */
  roles?: RoleName[];
  handler: (ctx: MockContext) => MockResponse;
}

// ---------------------------------------------------------------------------
// Session (kept in sessionStorage so a page refresh keeps you signed in)
// ---------------------------------------------------------------------------

const SESSION_KEY = 'ebiotrack.mock.user_id';
let sessionUserId: number | null = readStoredSession();

function readStoredSession(): number | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function storeSession(userId: number | null): void {
  sessionUserId = userId;
  try {
    if (userId === null) globalThis.sessionStorage?.removeItem(SESSION_KEY);
    else globalThis.sessionStorage?.setItem(SESSION_KEY, String(userId));
  } catch {
    // Storage can be unavailable (private mode, tests); the in-memory session still works.
  }
}

function currentUser(): User | null {
  return mockUsers.find((u) => u.user_id === sessionUserId) ?? null;
}

/** Artificial latency so loading states are visible in the browser. Tests set it to 0. */
let delayMs = 200;

export function setMockDelay(ms: number): void {
  delayMs = ms;
}

/** Records created through the mock during this page load (cleared by resetMockState). */
const created = { events: [] as CollectionEvent[], samples: [] as Sample[], exports: 0 };

/**
 * Failed sign-ins per email, mirroring backend/src/utils/loginAttempts.js: 5 failures within
 * 15 minutes lock that email out (429 too_many_attempts with Retry-After) until the window ends.
 * A successful sign-in clears the count.
 */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function loginRetryAfterSeconds(email: string): number {
  const entry = loginFailures.get(email);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    loginFailures.delete(email);
    return 0;
  }
  if (entry.count < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

function recordLoginFailure(email: string): void {
  const entry = loginFailures.get(email);
  if (entry && entry.resetAt > Date.now()) entry.count += 1;
  else loginFailures.set(email, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
}

/** Sign out and drop records created through the mock (used by tests). */
export function resetMockState(): void {
  storeSession(null);
  loginFailures.clear();
  created.events = [];
  created.samples = [];
  created.exports = 0;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const ok = (data: unknown, meta?: unknown, status = 200): MockResponse => ({
  status,
  body: meta === undefined ? { data } : { data, meta },
});

const noContent = (): MockResponse => ({ status: 204 });

function fail(
  status: number,
  code: string,
  message: string,
  details?: ApiErrorDetail[],
): MockResponse {
  return { status, body: { error: details ? { code, message, details } : { code, message } } };
}

const notFound = (what: string) => fail(404, 'not_found', `${what} not found`);

/** Same check as the backend's `z.email()` for the cases a form can produce. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates a login body exactly like backend/src/routes/auth.routes.js (zod), with the same
 * field names and messages, so the login page sees identical 422 responses in both modes.
 */
function validateLoginBody(body: unknown): { email: string; password: string } | ApiErrorDetail[] {
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  const details: ApiErrorDetail[] = [];
  const missing = (value: unknown) =>
    `Invalid input: expected string, received ${value === null ? 'null' : typeof value}`;

  let cleanEmail = '';
  if (typeof email !== 'string') {
    details.push({ field: 'email', message: missing(email) });
  } else {
    cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(cleanEmail) || cleanEmail.length > 254) {
      details.push({ field: 'email', message: 'Invalid email address' });
    }
  }

  if (typeof password !== 'string') {
    details.push({ field: 'password', message: missing(password) });
  } else if (password.length === 0) {
    details.push({
      field: 'password',
      message: 'Too small: expected string to have >=1 characters',
    });
  } else if (new TextEncoder().encode(password).length > 72) {
    details.push({ field: 'password', message: 'must be at most 72 bytes' });
  }

  return details.length ? details : { email: cleanEmail, password: password as string };
}

/** Pagination per CONTRACT section 8: ?page=1&limit=25, default 25, max 100. */
function paginate<T>(rows: T[], query: URLSearchParams): MockResponse {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 25));
  const meta: PageMeta = { page, limit, total: rows.length };
  return ok(rows.slice((page - 1) * limit, page * limit), meta);
}

/** Reads an optional numeric filter (`?site_id=3`); null when absent. */
function num(query: URLSearchParams, key: string): number | null {
  const v = query.get(key);
  return v === null || v === '' ? null : Number(v);
}

/** `from`/`to` date filters on an ISO timestamp (dates compare as strings). */
function inRange(iso: string, query: URLSearchParams): boolean {
  const from = query.get('from');
  const to = query.get('to');
  return (!from || iso.slice(0, 10) >= from) && (!to || iso.slice(0, 10) <= to);
}

// ---------------------------------------------------------------------------
// Data access with the contract's visibility rules
// ---------------------------------------------------------------------------

const isAdmin = (user: User) => hasAnyRole(user, ['administrator']);

function visibleProjectIds(user: User): number[] {
  return mockProjects
    .map((p) => p.project_id)
    .filter((id) => isAdmin(user) || mockMemberships[id]?.[user.user_id] !== undefined);
}

function projectsFor(user: User) {
  const ids = visibleProjectIds(user);
  return mockProjects
    .filter((p) => ids.includes(p.project_id))
    .map((p) => ({ ...p, your_role: mockMemberships[p.project_id]?.[user.user_id] ?? null }));
}

const allEvents = () => [...mockEvents, ...created.events];
const allSamples = () => [...mockSamples, ...created.samples];

function eventsFor(user: User, query?: URLSearchParams): CollectionEvent[] {
  const ids = visibleProjectIds(user);
  const projectId = query ? num(query, 'project_id') : null;
  const siteId = query ? num(query, 'site_id') : null;
  return allEvents().filter(
    (e) =>
      ids.includes(e.project_id) &&
      (projectId === null || e.project_id === projectId) &&
      (siteId === null || e.site_id === siteId) &&
      (!query || inRange(e.collected_at, query)),
  );
}

function eventOf(sample: Sample): CollectionEvent {
  return allEvents().find((e) => e.event_id === sample.event_id)!;
}

/** Approved analyses + passing rows, joined to their library, sample, event, and site. */
function approvedDetections(user: User) {
  const events = eventsFor(user);
  return mockAssignments
    .filter((a) => a.qc_flag === 'pass')
    .filter((a) => mockAnalyses.find((x) => x.analysis_id === a.analysis_id)?.status === 'approved')
    .flatMap((a) => {
      const library = mockLibraries.find((l) => l.library_id === a.library_id)!;
      const extraction = mockExtractions.find((x) => x.extraction_id === library.extraction_id)!;
      const sample = allSamples().find((s) => s.sample_id === extraction.sample_id)!;
      const event = events.find((e) => e.event_id === sample.event_id);
      if (!event) return [];
      const site = mockSites.find((s) => s.site_id === event.site_id)!;
      return [{ assignment: a, sample, event, site }];
    });
}

// ---------------------------------------------------------------------------
// Routes (CONTRACT section 10, in the same order)
// ---------------------------------------------------------------------------

const routes: MockRoute[] = [
  // Auth --------------------------------------------------------------------
  {
    method: 'POST',
    path: '/auth/login',
    auth: false,
    // Mirrors backend/src/controllers/auth.controller.js: validation (422), lockout (429 with
    // Retry-After), wrong email or password (401, same message for both), then a new session.
    handler: ({ body }) => {
      const parsed = validateLoginBody(body);
      if (Array.isArray(parsed)) {
        return fail(422, 'validation_error', parsed[0].message, parsed);
      }
      const { email, password } = parsed;

      const retryAfter = loginRetryAfterSeconds(email);
      if (retryAfter > 0) {
        return {
          ...fail(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again later.'),
          headers: { 'Retry-After': String(retryAfter) },
        };
      }

      const user = mockUsers.find((u) => u.email === email);
      if (!user || !user.active || password !== DEV_PASSWORD) {
        recordLoginFailure(email);
        return fail(401, 'invalid_credentials', 'Invalid email or password');
      }
      loginFailures.delete(email);
      storeSession(user.user_id);
      return ok(user);
    },
  },
  {
    method: 'POST',
    path: '/auth/logout',
    handler: () => {
      storeSession(null);
      return noContent();
    },
  },
  { method: 'GET', path: '/auth/me', handler: ({ user }) => ok(user) },

  // Users (administration) ------------------------------------------------------
  {
    method: 'GET',
    path: '/users',
    roles: ['administrator'],
    handler: ({ query }) => {
      const active = query.get('active');
      const role = query.get('role');
      const rows = mockUsers.filter(
        (u) =>
          (active === null || String(u.active) === active) &&
          (!role || u.roles.includes(role as RoleName)),
      );
      return paginate(rows, query);
    },
  },
  { method: 'GET', path: '/roles', handler: () => ok(mockRoles) },

  // Projects ---------------------------------------------------------------------
  {
    method: 'GET',
    path: '/projects',
    handler: ({ user, query }) => {
      const status = query.get('status');
      return paginate(
        projectsFor(user).filter((p) => !status || p.status === status),
        query,
      );
    },
  },
  {
    method: 'GET',
    path: '/projects/:id',
    handler: ({ user, params }) => {
      const id = Number(params.id);
      const project = projectsFor(user).find((p) => p.project_id === id);
      // Projects the user is not a member of return 404 (CONTRACT section 8).
      if (!project) return notFound('Project');
      const members = Object.entries(mockMemberships[id] ?? {}).map(([userId, role]) => {
        const member = mockUsers.find((u) => u.user_id === Number(userId))!;
        return {
          project_id: id,
          user_id: member.user_id,
          full_name: member.full_name,
          email: member.email,
          project_role: role,
          joined_at: project.start_date
            ? `${project.start_date}T09:30:00Z`
            : '2025-01-01T00:00:00Z',
        };
      });
      const sites = mockSites.filter((s) => mockProjectSites[id]?.includes(s.site_id));
      return ok({ ...project, members, sites });
    },
  },

  // Sites and regions ------------------------------------------------------------------
  { method: 'GET', path: '/regions', handler: () => ok(mockRegions) },
  {
    method: 'GET',
    path: '/sites',
    handler: ({ query }) => {
      const projectId = num(query, 'project_id');
      const regionId = num(query, 'region_id');
      const habitat = query.get('habitat_type');
      const rows = mockSites.filter(
        (s) =>
          (projectId === null || mockProjectSites[projectId]?.includes(s.site_id)) &&
          (regionId === null || s.region_id === regionId) &&
          (!habitat || s.habitat_type === habitat),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/sites/:id',
    handler: ({ params }) => {
      const site = mockSites.find((s) => s.site_id === Number(params.id));
      return site ? ok(site) : notFound('Site');
    },
  },

  // Collection events ------------------------------------------------------------------
  {
    method: 'GET',
    path: '/events',
    handler: ({ user, query }) => paginate(eventsFor(user, query), query),
  },
  {
    method: 'GET',
    path: '/events/:id',
    handler: ({ user, params }) => {
      const event = eventsFor(user).find((e) => e.event_id === Number(params.id));
      if (!event) return notFound('Collection event');
      const detail: CollectionEventDetail = {
        ...event,
        samples: allSamples().filter((s) => s.event_id === event.event_id),
        measurements: mockMeasurements.filter((m) => m.event_id === event.event_id),
      };
      return ok(detail);
    },
  },
  {
    // Section 11 example: event with samples and measurements, created in one transaction.
    method: 'POST',
    path: '/events',
    roles: ['principal_investigator', 'field_researcher'],
    handler: ({ user, body }) => {
      const req = (body ?? {}) as Partial<CreateEventRequest>;
      const details: ApiErrorDetail[] = [];
      if (!req.project_id) details.push({ field: 'project_id', message: 'Project is required' });
      if (!req.site_id) details.push({ field: 'site_id', message: 'Site is required' });
      if (!req.collected_at) {
        details.push({ field: 'collected_at', message: 'Collection time is required' });
      }
      if (details.length) {
        return fail(422, 'validation_error', 'Check the highlighted fields', details);
      }
      if (!visibleProjectIds(user).includes(req.project_id!)) return notFound('Project');
      if (!mockProjectSites[req.project_id!]?.includes(req.site_id!)) {
        return fail(422, 'invalid_reference', 'That site is not attached to this project');
      }
      const event_id = 1000 + created.events.length;
      const now = new Date().toISOString();
      const event: CollectionEvent = {
        event_id,
        project_id: req.project_id!,
        site_id: req.site_id!,
        collector_id: user.user_id,
        collected_at: req.collected_at!,
        notes: req.notes ?? null,
        created_at: now,
      };
      const samples: Sample[] = (req.samples ?? []).map((s, i) => ({
        sample_id: 1000 + created.samples.length + i,
        event_id,
        sample_type_id: s.sample_type_id,
        sample_code: sampleCode(event, i + 1),
        volume_ml: s.volume_ml ?? null,
        depth_m: s.depth_m ?? null,
        storage_location: s.storage_location ?? null,
        status: 'collected',
        created_at: now,
      }));
      const measurements = (req.measurements ?? []).map((m, i) => ({
        measurement_id: 1000 + i,
        event_id,
        ...m,
      }));
      created.events.push(event);
      created.samples.push(...samples);
      return ok({ ...event, samples, measurements }, undefined, 201);
    },
  },

  // Samples ------------------------------------------------------------------------------
  { method: 'GET', path: '/sample-types', handler: () => ok(mockSampleTypes) },
  {
    method: 'GET',
    path: '/samples',
    handler: ({ user, query }) => {
      const events = eventsFor(user, query);
      const eventId = num(query, 'event_id');
      const status = query.get('status');
      const q = query.get('q')?.toLowerCase();
      const rows = allSamples().filter(
        (s) =>
          events.some((e) => e.event_id === s.event_id) &&
          (eventId === null || s.event_id === eventId) &&
          (!status || s.status === status) &&
          (!q || s.sample_code.toLowerCase().includes(q)),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/samples/:id',
    handler: ({ user, params }) => {
      const sample = allSamples().find((s) => s.sample_id === Number(params.id));
      if (!sample || !eventsFor(user).some((e) => e.event_id === sample.event_id)) {
        return notFound('Sample');
      }
      const event = eventOf(sample);
      const site = mockSites.find((s) => s.site_id === event.site_id)!;
      return ok({
        sample_id: sample.sample_id,
        sample_code: sample.sample_code,
        status: sample.status,
        sample_type: mockSampleTypes.find((t) => t.sample_type_id === sample.sample_type_id)!
          .type_name,
        volume_ml: sample.volume_ml,
        depth_m: sample.depth_m,
        event: {
          event_id: event.event_id,
          collected_at: event.collected_at,
          project_id: event.project_id,
        },
        site: { site_id: site.site_id, name: site.name },
        extractions: mockExtractions
          .filter((x) => x.sample_id === sample.sample_id)
          .map(({ extraction_id, attempt_number, qc_status }) => ({
            extraction_id,
            attempt_number,
            qc_status,
          })),
        status_history: statusHistoryFor(sample),
      });
    },
  },

  // Laboratory ---------------------------------------------------------------------------------
  { method: 'GET', path: '/labs', handler: () => ok(mockLabs) },
  { method: 'GET', path: '/markers', handler: () => ok(mockMarkers) },
  {
    method: 'GET',
    path: '/extraction-batches',
    handler: ({ query }) => {
      const labId = num(query, 'lab_id');
      return paginate(
        mockBatches.filter((b) => labId === null || b.lab_id === labId),
        query,
      );
    },
  },
  {
    method: 'GET',
    path: '/extractions',
    handler: ({ query }) => {
      const sampleId = num(query, 'sample_id');
      const batchId = num(query, 'batch_id');
      const qc = query.get('qc_status');
      const rows = mockExtractions.filter(
        (x) =>
          (sampleId === null || x.sample_id === sampleId) &&
          (batchId === null || x.batch_id === batchId) &&
          (!qc || x.qc_status === qc),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/qc-results',
    handler: ({ query }) => {
      const sampleId = num(query, 'sample_id');
      const analysisId = num(query, 'analysis_id');
      const result = query.get('result');
      const rows = mockQcResults.filter(
        (r) =>
          (sampleId === null || r.sample_id === sampleId) &&
          (analysisId === null || r.analysis_id === analysisId) &&
          (!result || r.result === result),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/sequencing-runs',
    handler: ({ query }) => {
      const labId = num(query, 'lab_id');
      const status = query.get('status');
      const rows = mockRuns.filter(
        (r) => (labId === null || r.lab_id === labId) && (!status || r.status === status),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/sequencing-runs/:id',
    handler: ({ params }) => {
      const run = mockRuns.find((r) => r.run_id === Number(params.id));
      if (!run) return notFound('Sequencing run');
      const libraries = mockLibraries
        .filter((l) => l.run_id === run.run_id)
        .map((l) => {
          const extraction = mockExtractions.find((x) => x.extraction_id === l.extraction_id)!;
          const sample = allSamples().find((s) => s.sample_id === extraction.sample_id)!;
          return { ...l, sample_id: sample.sample_id, sample_code: sample.sample_code };
        });
      return ok({ ...run, libraries });
    },
  },

  // Analyses and detections ------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/analyses',
    handler: ({ query }) => {
      const runId = num(query, 'run_id');
      const markerId = num(query, 'marker_id');
      const status = query.get('status');
      const rows = mockAnalyses.filter(
        (a) =>
          (runId === null || a.run_id === runId) &&
          (markerId === null || a.marker_id === markerId) &&
          (!status || a.status === status),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/analyses/:id',
    handler: ({ params }) => {
      const analysis = mockAnalyses.find((a) => a.analysis_id === Number(params.id));
      if (!analysis) return notFound('Analysis');
      const counts = { pass: 0, warn: 0, fail: 0 };
      for (const a of mockAssignments) {
        if (a.analysis_id === analysis.analysis_id) counts[a.qc_flag] += 1;
      }
      return ok({ ...analysis, assignment_counts: counts });
    },
  },
  {
    // Section 11 example. Body is multipart (analysis_id, file); ?dry_run=true validates only.
    method: 'POST',
    path: '/analyses/import',
    roles: ['principal_investigator', 'analyst'],
    handler: ({ query, body }) => {
      const analysisId =
        body instanceof FormData
          ? Number(body.get('analysis_id'))
          : Number((body as { analysis_id?: unknown } | undefined)?.analysis_id);
      if (!mockAnalyses.some((a) => a.analysis_id === analysisId)) {
        return fail(422, 'validation_error', 'Choose an analysis to import into', [
          { field: 'analysis_id', message: 'Unknown analysis' },
        ]);
      }
      if (query.get('dry_run') === 'true') {
        return ok({
          valid_rows: 38,
          errors: [{ row: 12, field: 'confidence', message: 'must be between 0 and 1' }],
        });
      }
      return ok({ inserted: 38 }, undefined, 201);
    },
  },

  // Taxa -----------------------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/taxa',
    handler: ({ query }) => {
      const q = query.get('q')?.toLowerCase();
      const rank = query.get('rank');
      const parentId = num(query, 'parent_taxon_id');
      const rows = mockTaxa.filter(
        (t) =>
          (!q || t.scientific_name.toLowerCase().includes(q)) &&
          (!rank || t.rank === rank) &&
          (parentId === null || t.parent_taxon_id === parentId),
      );
      return paginate(rows, query);
    },
  },
  {
    method: 'GET',
    path: '/taxa/:id',
    handler: ({ params }) => {
      const taxon = mockTaxa.find((t) => t.taxon_id === Number(params.id));
      if (!taxon) return notFound('Taxon');
      const lineage = [];
      for (let t = taxon; t; t = mockTaxa.find((x) => x.taxon_id === t.parent_taxon_id)!) {
        lineage.unshift({ taxon_id: t.taxon_id, scientific_name: t.scientific_name, rank: t.rank });
        if (t.parent_taxon_id === null) break;
      }
      return ok({ ...taxon, lineage });
    },
  },
  {
    method: 'GET',
    path: '/taxa/:id/detections',
    handler: ({ user, params, query }) => {
      const taxonId = Number(params.id);
      if (!mockTaxa.some((t) => t.taxon_id === taxonId)) return notFound('Taxon');
      const projectId = num(query, 'project_id');
      const siteId = num(query, 'site_id');
      const rows = approvedDetections(user)
        .filter(
          ({ assignment, event, site }) =>
            assignment.taxon_id === taxonId &&
            (projectId === null || event.project_id === projectId) &&
            (siteId === null || site.site_id === siteId) &&
            inRange(event.collected_at, query),
        )
        .map(({ assignment, sample, event, site }) => ({
          site_id: site.site_id,
          site_name: site.name,
          sample_code: sample.sample_code,
          collected_at: event.collected_at,
          analysis_id: assignment.analysis_id,
          read_count: assignment.read_count,
          confidence: assignment.confidence,
          qc_flag: assignment.qc_flag,
        }));
      return paginate(rows, query);
    },
  },

  // Analytics, dashboard, exports, audit ----------------------------------------------------------------
  {
    method: 'GET',
    path: '/analytics/richness',
    handler: ({ user, query }) => {
      const projectId = num(query, 'project_id');
      const siteId = num(query, 'site_id');
      const groupBy = query.get('group_by') ?? 'year';
      if (!['year', 'month', 'site'].includes(groupBy)) {
        return fail(422, 'validation_error', 'group_by must be year, month, or site', [
          { field: 'group_by', message: 'must be year, month, or site' },
        ]);
      }
      const keyOf = (e: CollectionEvent) =>
        groupBy === 'site'
          ? mockSites.find((s) => s.site_id === e.site_id)!.name
          : e.collected_at.slice(0, groupBy === 'year' ? 4 : 7);
      const events = eventsFor(user, query).filter(
        (e) =>
          (projectId === null || e.project_id === projectId) &&
          (siteId === null || e.site_id === siteId),
      );
      const detections = approvedDetections(user);
      const groups = new Map<
        string,
        { group: string; site_id: number; taxa: Set<number>; samples: Set<number> }
      >();
      for (const e of events) {
        const key = `${keyOf(e)}|${e.site_id}`;
        const g = groups.get(key) ?? {
          group: keyOf(e),
          site_id: e.site_id,
          taxa: new Set(),
          samples: new Set(),
        };
        allSamples()
          .filter(
            (s) => s.event_id === e.event_id && s.status !== 'failed' && s.status !== 'discarded',
          )
          .forEach((s) => g.samples.add(s.sample_id));
        detections
          .filter((d) => d.event.event_id === e.event_id)
          .forEach((d) => g.taxa.add(d.assignment.taxon_id));
        groups.set(key, g);
      }
      const rows = [...groups.values()]
        .sort((a, b) => a.group.localeCompare(b.group) || a.site_id - b.site_id)
        .map((g) => ({
          group: g.group,
          site_id: g.site_id,
          observed_taxa: g.taxa.size,
          sample_count: g.samples.size,
        }));
      return ok(rows, { caveat: EDNA_CAVEAT });
    },
  },
  {
    method: 'GET',
    path: '/analytics/detection-frequency',
    handler: ({ user, query }) => {
      const taxonId = num(query, 'taxon_id');
      const projectId = num(query, 'project_id');
      const events = eventsFor(user).filter(
        (e) => projectId === null || e.project_id === projectId,
      );
      const detections = approvedDetections(user);
      const siteIds = [...new Set(events.map((e) => e.site_id))].sort((a, b) => a - b);
      const rows = siteIds.map((site_id) => {
        const siteEvents = events.filter((e) => e.site_id === site_id).map((e) => e.event_id);
        const samplesTotal = allSamples().filter(
          (s) => siteEvents.includes(s.event_id) && s.status === 'analyzed',
        ).length;
        const detected = new Set(
          detections
            .filter(
              (d) =>
                d.site.site_id === site_id &&
                siteEvents.includes(d.event.event_id) &&
                (taxonId === null || d.assignment.taxon_id === taxonId),
            )
            .map((d) => d.sample.sample_id),
        );
        return { site_id, detections: detected.size, samples_total: samplesTotal };
      });
      return ok(rows, { caveat: EDNA_CAVEAT });
    },
  },
  {
    method: 'GET',
    path: '/dashboard/summary',
    handler: ({ user, query }) => {
      const projectId = num(query, 'project_id');
      const projectIds = visibleProjectIds(user).filter(
        (id) => projectId === null || id === projectId,
      );
      const events = eventsFor(user).filter((e) => projectIds.includes(e.project_id));
      const siteIds = new Set(projectIds.flatMap((id) => mockProjectSites[id] ?? []));
      return ok({
        projects: projectIds.length,
        sites: siteIds.size,
        samples: allSamples().filter((s) => events.some((e) => e.event_id === s.event_id)).length,
        approved_detections: approvedDetections(user).filter((d) =>
          projectIds.includes(d.event.project_id),
        ).length,
        recent_activity: hasAnyRole(user, ['administrator', 'principal_investigator'])
          ? mockAudit.slice(0, 5)
          : [],
      });
    },
  },
  {
    method: 'POST',
    path: '/exports',
    handler: ({ user, body }) => {
      const req = (body ?? {}) as { export_type?: string; project_id?: number };
      if (!req.export_type || !req.project_id) {
        return fail(422, 'validation_error', 'Choose an export type and a project', [
          ...(req.export_type ? [] : [{ field: 'export_type', message: 'required' }]),
          ...(req.project_id ? [] : [{ field: 'project_id', message: 'required' }]),
        ]);
      }
      if (!visibleProjectIds(user).includes(req.project_id)) return notFound('Project');
      created.exports += 1;
      return ok({ export_id: 1000 + created.exports, row_count: 16 }, undefined, 201);
    },
  },
  {
    method: 'GET',
    path: '/audit',
    roles: ['principal_investigator'],
    handler: ({ query }) => {
      const entityType = query.get('entity_type');
      const entityId = num(query, 'entity_id');
      const actorId = num(query, 'actor_id');
      const rows = mockAudit.filter(
        (a) =>
          (!entityType || a.entity_type === entityType) &&
          (entityId === null || a.entity_id === entityId) &&
          (actorId === null || a.actor_id === actorId) &&
          inRange(a.created_at, query),
      );
      return paginate(rows, query);
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

/** Copies JSON bodies so handlers never share objects with the caller; FormData passes through. */
function copyBody(body: unknown): unknown {
  if (body === undefined || body instanceof FormData) return body;
  return JSON.parse(JSON.stringify(body)) as unknown;
}

/** Answers one request. `url` is relative to /api and may include a query string. */
export async function handleMockRequest(
  method: HttpMethod,
  url: string,
  body?: unknown,
): Promise<MockResponse> {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

  const [path, search = ''] = url.split('?');
  // Prefer literal segments over :params (so /analyses/import never matches /analyses/:id).
  const candidates = routes
    .filter((r) => r.method === method)
    .map((route) => ({ route, params: matchPath(route.path, path) }))
    .filter((c): c is { route: MockRoute; params: Record<string, string> } => c.params !== null)
    .sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);

  const match = candidates[0];
  if (!match) {
    return fail(
      404,
      'not_found',
      `The mock API has no handler for ${method} /api${path}. Add one in src/services/mock/mockApi.ts.`,
    );
  }

  const { route, params } = match;
  const user = currentUser();
  if (route.auth !== false && !user) {
    return fail(401, 'unauthenticated', 'Authentication required');
  }
  if (route.roles && user && !isAdmin(user) && !hasAnyRole(user, route.roles)) {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
  return route.handler({
    params,
    query: new URLSearchParams(search),
    body: copyBody(body),
    user: user as User,
  });
}
