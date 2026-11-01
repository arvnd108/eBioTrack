// Owner: B (Frontend)
// Purpose: In-browser mock of the REST API, answering with CONTRACT section 10/11 shapes
//
// Used when VITE_USE_MOCK=true (see apiClient.ts). Each handler returns what the real server
// would: an HTTP status and a JSON body (`{ data, meta? }` or `{ error }`). Covers every GET
// endpoint in section 10 and the writes the pages use so far (auth, users, projects, sites,
// events, samples, import dry run, export). Pages that need more writes add a handler here.
//
// Rules copied from the contract so pages see realistic behaviour:
//   - lists are paginated (?page, ?limit; default 25, max 100) with meta { page, limit, total }
//   - project data the user is not a member of is hidden (404 for a single item)
//   - analytics and detections use only approved analyses and qc_flag = 'pass', and analytics
//     responses carry meta.caveat
//   - the T20 routes (users, projects, audit) and T21 routes (regions, sites, events, samples)
//     follow the real API scenario by scenario: same checks, order, status codes and messages
//
// To mock a new endpoint, add one entry to `routes` below. Paths are relative to /api and may
// use `:params`, for example '/projects/:id'.

import {
  EDNA_CAVEAT,
  type AuditAction,
  type AuditEntry,
  type Project,
  type ProjectRole,
  type ApiErrorDetail,
  type CollectionEvent,
  type CollectionEventDetail,
  type CreateEventRequest,
  type EnvironmentalMeasurement,
  type HabitatType,
  type PageMeta,
  type RoleName,
  type Sample,
  type SampleStatus,
  type Site,
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
  mockProjectMembers,
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
  mockStatusHistory,
  sampleCode,
  type StatusHistoryRow,
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

// ---------------------------------------------------------------------------
// Writable data: copies of the seeds that the T20 write routes change. resetMockState() puts
// the seeds back. Read-only slices (lab, analysis, taxa) still read the fixtures directly.
// ---------------------------------------------------------------------------

interface MemberRow {
  project_id: number;
  user_id: number;
  project_role: ProjectRole;
  joined_at: string;
}

interface MockState {
  users: User[];
  /** Passwords of users created through the mock; seeded users use DEV_PASSWORD. */
  passwords: Map<number, string>;
  projects: Omit<Project, 'your_role'>[];
  members: MemberRow[];
  projectSites: { project_id: number; site_id: number }[];
  audit: AuditEntry[];
  sites: Site[];
  events: CollectionEvent[];
  samples: Sample[];
  measurements: EnvironmentalMeasurement[];
  history: StatusHistoryRow[];
  nextUserId: number;
  nextProjectId: number;
  nextAuditId: number;
  nextSiteId: number;
  nextEventId: number;
  nextSampleId: number;
  nextMeasurementId: number;
}

function freshState(): MockState {
  return {
    users: mockUsers.map((u) => ({ ...u, roles: [...u.roles] })),
    passwords: new Map(),
    projects: mockProjects.map((p) => ({ ...p })),
    members: mockProjectMembers.map((m) => ({ ...m })),
    projectSites: Object.entries(mockProjectSites).flatMap(([projectId, siteIds]) =>
      siteIds.map((siteId) => ({ project_id: Number(projectId), site_id: siteId })),
    ),
    audit: mockAudit.map((a) => ({ ...a })),
    sites: mockSites.map((x) => ({ ...x })),
    events: mockEvents.map((x) => ({ ...x })),
    samples: mockSamples.map((x) => ({ ...x })),
    measurements: mockMeasurements.map((x) => ({ ...x })),
    history: mockStatusHistory.map((x) => ({ ...x })),
    // Application-generated IDs start at 1000 (CONTRACT D6). Like a PostgreSQL sequence, an
    // insert the database refuses (unknown region, duplicate name) still uses up its id.
    nextUserId: 1000,
    nextProjectId: 1000,
    nextAuditId: 1000,
    nextSiteId: 1000,
    nextEventId: 1000,
    nextSampleId: 1000,
    nextMeasurementId: 1000,
  };
}

let state = freshState();

/** The signed-in user; a deactivated user has no session (backend middleware/auth.js). */
function currentUser(): User | null {
  const user = state.users.find((u) => u.user_id === sessionUserId) ?? null;
  return user && user.active ? user : null;
}

const roleIn = (projectId: number, userId: number): ProjectRole | null =>
  state.members.find((m) => m.project_id === projectId && m.user_id === userId)?.project_role ??
  null;

const siteIdsOf = (projectId: number): number[] =>
  state.projectSites.filter((l) => l.project_id === projectId).map((l) => l.site_id);

/**
 * Writes an audit entry the way audit_row_change() does (database/triggers/access_triggers.sql):
 * insert -> { column: { new } }, delete -> { column: { old } }, update -> only changed columns
 * { column: { old, new } }; an update that changes nothing writes nothing.
 */
function writeAudit(
  actorId: number | null,
  entityType: string,
  entityId: number,
  action: AuditAction,
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): void {
  let details: Record<string, unknown> | null = null;
  if (action === 'insert' && after) {
    details = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, { new: v }]));
  } else if (action === 'delete' && before) {
    details = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, { old: v }]));
  } else if (action === 'update' && before && after) {
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]),
    );
    if (changed.length === 0) return;
    details = Object.fromEntries(changed.map((k) => [k, { old: before[k], new: after[k] }]));
  }
  state.audit.push({
    audit_id: state.nextAuditId++,
    actor_id: actorId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    details,
    created_at: new Date().toISOString(),
  });
}

/** Artificial latency so loading states are visible in the browser. Tests set it to 0. */
let delayMs = 200;

export function setMockDelay(ms: number): void {
  delayMs = ms;
}

/** Exports created through the mock during this page load (cleared by resetMockState). */
const created = { exports: 0 };

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
  state = freshState();
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

/** Orders like PostgreSQL: ascending puts NULLs last, descending puts them first. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Pagination per CONTRACT section 8: ?page=1&limit=25, default 25, max 100. `?sort=field` or
 * `?sort=-field` orders the rows first (ties keep their id order, as the API's ORDER BY ..., id
 * does). When `sortable` is given, any other field is the API's 422 (middleware/pagination.js).
 */
function paginate<T>(
  rows: T[],
  query: URLSearchParams,
  sortable?: readonly string[],
  /** Id column the API breaks ties on in the same direction (`ORDER BY field DESC, id DESC`). */
  tieKey?: string,
): MockResponse {
  const rawSort = query.get('sort')?.trim();
  if (rawSort) {
    const descending = rawSort.startsWith('-');
    const field = descending ? rawSort.slice(1) : rawSort;
    if (sortable && !sortable.includes(field)) {
      return fail(422, 'validation_error', `Invalid sort field: ${field}`, [
        { field: 'sort', message: `Must be one of: ${sortable.join(', ')}` },
      ]);
    }
    const value = (row: T, key: string) => (row as Record<string, unknown>)[key];
    rows = [...rows].sort(
      (a, b) =>
        (compareValues(value(a, field), value(b, field)) ||
          (tieKey ? compareValues(value(a, tieKey), value(b, tieKey)) : 0)) * (descending ? -1 : 1),
    );
  }
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
  return state.projects
    .map((p) => p.project_id)
    .filter((id) => isAdmin(user) || roleIn(id, user.user_id) !== null);
}

function projectsFor(user: User): Project[] {
  const ids = visibleProjectIds(user);
  return state.projects
    .filter((p) => ids.includes(p.project_id))
    .map((p) => ({ ...p, your_role: roleIn(p.project_id, user.user_id) }));
}

const allEvents = () => state.events;
const allSamples = () => state.samples;

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
      const site = state.sites.find((s) => s.site_id === event.site_id)!;
      return [{ assignment: a, sample, event, site }];
    });
}

/**
 * Audit entries the user may read, newest first (backend services/audit.service.js): an
 * administrator sees everything; a principal investigator sees entries about entities in a
 * project they belong to (the project and its members and sites, its events, samples,
 * extractions, libraries, the runs and analyses those libraries are in, and their QC results);
 * other roles see nothing.
 */
function auditFor(user: User): AuditEntry[] {
  let visible: AuditEntry[];
  if (isAdmin(user)) {
    visible = state.audit;
  } else if (hasAnyRole(user, ['principal_investigator'])) {
    const projects = new Set(
      state.members.filter((m) => m.user_id === user.user_id).map((m) => m.project_id),
    );
    const events = allEvents().filter((e) => projects.has(e.project_id));
    const samples = new Set(
      allSamples()
        .filter((s) => events.some((e) => e.event_id === s.event_id))
        .map((s) => s.sample_id),
    );
    const extractions = mockExtractions.filter((x) => samples.has(x.sample_id));
    const libraries = mockLibraries.filter((l) =>
      extractions.some((x) => x.extraction_id === l.extraction_id),
    );
    const runs = new Set(libraries.map((l) => l.run_id));
    const analyses = new Set(
      mockAnalyses.filter((a) => runs.has(a.run_id)).map((a) => a.analysis_id),
    );
    const scope: Record<string, Set<number>> = {
      projects,
      project_members: projects,
      project_sites: projects,
      collection_events: new Set(events.map((e) => e.event_id)),
      samples,
      dna_extractions: new Set(extractions.map((x) => x.extraction_id)),
      sequencing_libraries: new Set(libraries.map((l) => l.library_id)),
      sequencing_runs: runs,
      analysis_runs: analyses,
      quality_control_results: new Set(
        mockQcResults
          .filter(
            (q) =>
              (q.sample_id !== null && samples.has(q.sample_id)) ||
              (q.analysis_id !== null && analyses.has(q.analysis_id)),
          )
          .map((q) => q.qc_id),
      ),
    };
    visible = state.audit.filter((a) => scope[a.entity_type]?.has(a.entity_id) ?? false);
  } else {
    return [];
  }
  return [...visible].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.audit_id - a.audit_id,
  );
}

// ---------------------------------------------------------------------------
// T20 helpers: validation with the API's own messages (backend routes/*.routes.js zod schemas)
// and the edit_project gate (middleware/authorize.js)
// ---------------------------------------------------------------------------

const PROJECT_STATUSES = ['planned', 'active', 'completed', 'archived'];
const PROJECT_ROLES = ['owner', 'manager', 'contributor', 'viewer'];

const typeName = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** z.string().trim().min(1, 'must not be blank').max(n) (min only when `required`). */
function checkText(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): ApiErrorDetail[] {
  if (typeof value !== 'string') {
    return [{ field, message: `Invalid input: expected string, received ${typeName(value)}` }];
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return [{ field, message: 'must not be blank' }];
  if (trimmed.length > max) {
    return [{ field, message: `Too big: expected string to have <=${max} characters` }];
  }
  return [];
}

/** utils/schemas.js calendarDate. */
function checkDate(value: unknown, field: string): ApiErrorDetail[] {
  if (typeof value !== 'string') {
    return [{ field, message: `Invalid input: expected string, received ${typeName(value)}` }];
  }
  const details: ApiErrorDetail[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    details.push({ field, message: 'must be a date as YYYY-MM-DD' });
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    details.push({ field, message: 'must be a real calendar date' });
  }
  return details;
}

/** utils/schemas.js idNumber. */
function checkId(value: unknown, field: string): ApiErrorDetail[] {
  if (typeof value !== 'number') {
    return [{ field, message: `Invalid input: expected number, received ${typeName(value)}` }];
  }
  if (!Number.isInteger(value)) {
    return [{ field, message: 'Invalid input: expected int, received number' }];
  }
  if (value <= 0) return [{ field, message: 'Too small: expected number to be >0' }];
  return [];
}

function checkEmail(value: unknown): ApiErrorDetail[] {
  if (typeof value !== 'string') {
    return [
      { field: 'email', message: `Invalid input: expected string, received ${typeName(value)}` },
    ];
  }
  const email = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(email) && email.length <= 254
    ? []
    : [{ field: 'email', message: 'Invalid email address' }];
}

function checkPassword(value: unknown): ApiErrorDetail[] {
  if (typeof value !== 'string') {
    return [
      { field: 'password', message: `Invalid input: expected string, received ${typeName(value)}` },
    ];
  }
  if (value.length < 8) return [{ field: 'password', message: 'must be at least 8 characters' }];
  if (new TextEncoder().encode(value).length > 72) {
    return [{ field: 'password', message: 'must be at most 72 bytes' }];
  }
  return [];
}

function checkRoleIds(value: unknown, required: boolean): ApiErrorDetail[] {
  if (!Array.isArray(value)) {
    return [
      { field: 'role_ids', message: `Invalid input: expected array, received ${typeName(value)}` },
    ];
  }
  const bad = value.flatMap((id, i) => checkId(id, `role_ids[${i}]`));
  if (bad.length) return bad;
  if (required && value.length === 0) {
    return [{ field: 'role_ids', message: 'at least one role is required' }];
  }
  if (value.length > 20) {
    return [{ field: 'role_ids', message: 'Too big: expected array to have <=20 items' }];
  }
  if (new Set(value).size !== value.length) {
    return [{ field: 'role_ids', message: 'must not contain duplicates' }];
  }
  return [];
}

/** Role names for role ids, sorted by name like the API's array_agg(... ORDER BY role_name). */
function roleNames(roleIds: number[]): RoleName[] {
  return roleIds
    .map((id) => mockRoles.find((r) => r.role_id === id)!.role_name)
    .sort((a, b) => a.localeCompare(b));
}

const unknownRolesError = (ids: number[]) =>
  fail(422, 'invalid_reference', `Unknown role id(s): ${ids.join(', ')}`, [
    { field: 'role_ids', message: `unknown role id(s): ${ids.join(', ')}` },
  ]);

const ruleViolation = (message: string, field: string) =>
  fail(422, 'rule_violation', message, [{ field, message }]);

const lockOut = ruleViolation;

const atLeastOne = (message: string) =>
  fail(422, 'validation_error', message, [{ field: 'root', message }]);

/** uq_projects_title (23505) on PATCH: the API passes the database's detail through. */
const duplicateTitle = (title: string) => {
  const detail = `Key (title)=(${title}) already exists.`;
  return fail(409, 'duplicate', detail, [{ message: detail }]);
};

// ---------------------------------------------------------------------------
// T21 helpers: regions, sites, events and samples (backend routes/sites|events|samples.routes.js
// and services/*.service.js). Messages are zod's own, as the API sends them.
// ---------------------------------------------------------------------------

const REGION_TYPES = ['country', 'state', 'basin', 'reserve', 'other'];
const HABITAT_TYPES: HabitatType[] = [
  'river',
  'lake',
  'estuary',
  'marine',
  'wetland',
  'groundwater',
  'soil',
  'other',
];
const SAMPLE_STATUSES: SampleStatus[] = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];

/** CONTRACT section 3, enforced by the samples status trigger (EB001 -> 409). */
const SAMPLE_TRANSITIONS: Record<SampleStatus, SampleStatus[]> = {
  collected: ['stored', 'failed', 'discarded'],
  stored: ['extracted', 'failed', 'discarded'],
  extracted: ['sequenced', 'failed', 'discarded'],
  sequenced: ['analyzed', 'failed'],
  analyzed: [],
  failed: ['discarded'],
  discarded: [],
};

const MAX_MEASUREMENTS = 50;
const MAX_SAMPLES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const validationError = (details: ApiErrorDetail[]) =>
  fail(422, 'validation_error', details[0].message, details);

/** z.enum(values) */
function checkEnum(value: unknown, field: string, values: readonly string[]): ApiErrorDetail[] {
  if (typeof value === 'string' && values.includes(value)) return [];
  const options = values.map((v) => `"${v}"`).join('|');
  return [{ field, message: `Invalid option: expected one of ${options}` }];
}

/** utils/schemas.js idString: an id in a URL or query string. */
function checkIdString(value: string | null, field: string): ApiErrorDetail[] {
  return value === null || /^[1-9]\d{0,14}$/.test(value)
    ? []
    : [{ field, message: 'must be a positive integer' }];
}

/** z.number() with optional bounds; `min`/`max` carry the schema's own message when it has one. */
function checkNumber(
  value: unknown,
  field: string,
  bounds: {
    min?: number;
    minMessage?: string;
    positive?: string;
    max?: number;
    maxMessage?: string;
  } = {},
): ApiErrorDetail[] {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    const received = typeof value === 'number' ? 'NaN' : typeName(value);
    return [{ field, message: `Invalid input: expected number, received ${received}` }];
  }
  if (bounds.positive !== undefined && value <= 0) return [{ field, message: bounds.positive }];
  if (bounds.min !== undefined && value < bounds.min) {
    return [
      { field, message: bounds.minMessage ?? `Too small: expected number to be >=${bounds.min}` },
    ];
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return [
      { field, message: bounds.maxMessage ?? `Too big: expected number to be <=${bounds.max}` },
    ];
  }
  return [];
}

/** Optional (`.nullish()`) values are skipped when null or undefined. */
const present = (value: unknown) => value !== undefined && value !== null;

/** z.strictObject: unknown keys are one issue on the whole payload, after the field issues. */
function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): ApiErrorDetail[] {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return [];
  const list = extra.map((k) => `"${k}"`).join(', ');
  return [{ field: 'root', message: `Unrecognized key${extra.length > 1 ? 's' : ''}: ${list}` }];
}

/** z.iso.datetime({ offset: true }): seconds required, `Z` or `±HH:MM`, a real date and time. */
function isIsoDateTime(value: string): boolean {
  const m =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!m) return false;
  const day = new Date(`${m[1]}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === m[1];
}

/**
 * utils/schemas.js rangeFrom/rangeTo: an ISO timestamp, or a day meaning the start (from) or the
 * end (to) of that UTC day. Returns the bounds in ms, or the validation details.
 */
function rangeOf(
  query: URLSearchParams,
): { from: number | null; to: number | null } | ApiErrorDetail[] {
  const parse = (key: 'from' | 'to') => {
    const raw = query.get(key);
    if (raw === null) return null;
    if (isIsoDateTime(raw)) return Date.parse(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      const day = new Date(`${raw}T00:00:00Z`);
      if (day.toISOString().slice(0, 10) === raw) {
        return key === 'from' ? day.getTime() : day.getTime() + DAY_MS - 1;
      }
    }
    return undefined;
  };
  const from = parse('from');
  const to = parse('to');
  const details: ApiErrorDetail[] = [];
  if (from === undefined) details.push({ field: 'from', message: 'Invalid input' });
  if (to === undefined) details.push({ field: 'to', message: 'Invalid input' });
  return details.length ? details : { from: from ?? null, to: to ?? null };
}

/** numeric(p, s): the database rounds to `scale` decimals. */
const round = (value: number, scale: number) => Number(value.toFixed(scale));

/** The project of an event or sample, or null when it does not exist (services/projectAccess.js). */
const eventById = (id: number) => state.events.find((e) => e.event_id === id) ?? null;

/** The collector's name next to `collector_id`, as the events routes return it (CONTRACT 1.6). */
const withCollectorName = <T extends CollectionEvent>(
  event: T,
): T & { collector_name: string | null } => ({
  ...event,
  collector_name: state.users.find((u) => u.user_id === event.collector_id)?.full_name ?? null,
});
const sampleById = (id: number) => state.samples.find((s) => s.sample_id === id) ?? null;

/**
 * services/projectAccess.js assertProjectAccess: an administrator passes (an unknown project is
 * still a 404); anyone else must be a member (404 with `notFound` otherwise, so existence is not
 * leaked), and a project viewer is read-only (403 on writes).
 */
function projectAccess(
  user: User,
  projectId: number,
  { write = false, what = 'Project' }: { write?: boolean; what?: string } = {},
): MockResponse | null {
  if (isAdmin(user)) {
    return state.projects.some((p) => p.project_id === projectId) ? null : notFound(what);
  }
  const role = roleIn(projectId, user.user_id);
  if (role === null) return notFound(what);
  if (write && role === 'viewer')
    return fail(403, 'forbidden', 'You do not have permission to do this');
  return null;
}

/** The audit trigger stores timestamps as to_jsonb(timestamptz) does: `2026-03-12T09:30:00+00:00`. */
const jsonbTime = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/\.\d{3}Z$/, '+00:00')
    .replace(/\.(\d+)Z$/, '.$1+00:00');

/** register_sample(): the next code in the event, the first history row, and the audit entry. */
function registerSample(
  event: CollectionEvent,
  input: {
    sample_type_id: number;
    volume_ml?: number | null;
    depth_m?: number | null;
    storage_location?: string | null;
  },
  now: string,
  pending: Sample[],
): Sample | MockResponse {
  if (!mockSampleTypes.some((t) => t.sample_type_id === input.sample_type_id)) {
    return fail(422, 'invalid_reference', `Sample type ${input.sample_type_id} does not exist`, []);
  }
  const sequence =
    [...state.samples, ...pending].filter((s) => s.event_id === event.event_id).length + 1;
  return {
    sample_id: state.nextSampleId++,
    event_id: event.event_id,
    sample_type_id: input.sample_type_id,
    sample_code: sampleCode(event, sequence),
    volume_ml: present(input.volume_ml) ? round(input.volume_ml!, 2) : null,
    depth_m: present(input.depth_m) ? round(input.depth_m!, 2) : null,
    storage_location: present(input.storage_location) ? input.storage_location!.trim() : null,
    status: 'collected',
    created_at: now,
  };
}

/** Saves samples made by registerSample (rows, first history entries, audit). */
function commitSamples(samples: Sample[], actorId: number, now: string): void {
  for (const sample of samples) {
    state.samples.push(sample);
    state.history.push({
      sample_id: sample.sample_id,
      old_status: null,
      new_status: 'collected',
      changed_at: now,
      changed_by: actorId,
      note: null,
    });
    writeAudit(actorId, 'samples', sample.sample_id, 'insert', null, {
      ...sample,
      created_at: jsonbTime(sample.created_at),
    });
  }
}

/** Checks a site body (POST when `create`, PATCH otherwise); returns the cleaned fields. */
function checkSiteBody(
  body: Record<string, unknown>,
  create: boolean,
): Partial<Omit<Site, 'site_id'>> | ApiErrorDetail[] {
  const details: ApiErrorDetail[] = [];
  const has = (key: string) => (create ? true : body[key] !== undefined);
  if (has('region_id')) details.push(...checkId(body.region_id, 'region_id'));
  if (has('name')) details.push(...checkText(body.name, 'name', 200, true));
  if (has('latitude')) {
    const message = 'Latitude must be between -90 and 90';
    details.push(
      ...checkNumber(body.latitude, 'latitude', {
        min: -90,
        minMessage: message,
        max: 90,
        maxMessage: message,
      }),
    );
  }
  if (has('longitude')) {
    const message = 'Longitude must be between -180 and 180';
    details.push(
      ...checkNumber(body.longitude, 'longitude', {
        min: -180,
        minMessage: message,
        max: 180,
        maxMessage: message,
      }),
    );
  }
  if (has('habitat_type'))
    details.push(...checkEnum(body.habitat_type, 'habitat_type', HABITAT_TYPES));
  if (present(body.description))
    details.push(...checkText(body.description, 'description', 2000, false));
  if (!create && details.length === 0 && Object.keys(body).length === 0) {
    const message =
      'at least one of region_id, name, latitude, longitude, habitat_type, description is required';
    details.push({ field: 'root', message });
  }
  details.push(
    ...unknownKeys(body, [
      'region_id',
      'name',
      'latitude',
      'longitude',
      'habitat_type',
      'description',
    ]),
  );
  if (details.length) return details;

  const out: Partial<Omit<Site, 'site_id'>> = {};
  if (body.region_id !== undefined) out.region_id = body.region_id as number;
  if (body.name !== undefined) out.name = (body.name as string).trim();
  if (body.latitude !== undefined) out.latitude = round(body.latitude as number, 6);
  if (body.longitude !== undefined) out.longitude = round(body.longitude as number, 6);
  if (body.habitat_type !== undefined) out.habitat_type = body.habitat_type as HabitatType;
  if (body.description !== undefined) {
    out.description = body.description === null ? null : (body.description as string).trim();
  }
  return out;
}

/** The database's FK and unique checks on sampling_sites (both use up the id on insert). */
function siteConflict(site: Omit<Site, 'site_id'>, siteId: number | null): MockResponse | null {
  if (!mockRegions.some((r) => r.region_id === site.region_id)) {
    const detail = `Key (region_id)=(${site.region_id}) is not present in table "regions".`;
    return fail(422, 'invalid_reference', detail, [{ message: detail }]);
  }
  if (
    state.sites.some(
      (s) => s.site_id !== siteId && s.region_id === site.region_id && s.name === site.name,
    )
  ) {
    const detail = `Key (region_id, name)=(${site.region_id}, ${site.name}) already exists.`;
    return fail(409, 'duplicate', detail, [{ message: detail }]);
  }
  return null;
}

/** The sample fields both POST /events (per sample) and POST /samples accept. */
function checkSampleFields(body: Record<string, unknown>, prefix: string): ApiErrorDetail[] {
  const details: ApiErrorDetail[] = [];
  details.push(...checkId(body.sample_type_id, `${prefix}sample_type_id`));
  if (present(body.volume_ml)) {
    details.push(
      ...checkNumber(body.volume_ml, `${prefix}volume_ml`, {
        positive: 'must be greater than 0',
        max: 99999999.99,
      }),
    );
  }
  if (present(body.depth_m)) {
    details.push(
      ...checkNumber(body.depth_m, `${prefix}depth_m`, {
        min: 0,
        minMessage: 'must be 0 or more',
        max: 999999.99,
      }),
    );
  }
  if (present(body.storage_location)) {
    details.push(...checkText(body.storage_location, `${prefix}storage_location`, 200, true));
  }
  return details;
}

/** routes/events.routes.js createBody. */
function checkEventBody(body: Record<string, unknown>): ApiErrorDetail[] {
  const details: ApiErrorDetail[] = [];
  details.push(...checkId(body.project_id, 'project_id'));
  details.push(...checkId(body.site_id, 'site_id'));
  if (typeof body.collected_at !== 'string') {
    details.push({
      field: 'collected_at',
      message: `Invalid input: expected string, received ${typeName(body.collected_at)}`,
    });
  } else if (!isIsoDateTime(body.collected_at)) {
    details.push({ field: 'collected_at', message: 'Invalid ISO datetime' });
  } else if (Date.parse(body.collected_at) > Date.now() + DAY_MS) {
    details.push({ field: 'collected_at', message: 'must not be more than one day in the future' });
  }
  if (present(body.notes)) details.push(...checkText(body.notes, 'notes', 5000, false));

  const list = (key: 'measurements' | 'samples', max: number) => {
    const value = body[key];
    if (value === undefined) return [] as Record<string, unknown>[];
    if (!Array.isArray(value)) {
      details.push({
        field: key,
        message: `Invalid input: expected array, received ${typeName(value)}`,
      });
      return [];
    }
    if (value.length > max) {
      details.push({ field: key, message: `Too big: expected array to have <=${max} items` });
    }
    return value as Record<string, unknown>[];
  };
  const measurements = list('measurements', MAX_MEASUREMENTS);
  measurements.forEach((m, i) => {
    const at = `measurements[${i}].`;
    if (typeof m !== 'object' || m === null) {
      details.push({
        field: `measurements[${i}]`,
        message: `Invalid input: expected object, received ${typeName(m)}`,
      });
      return;
    }
    details.push(...checkText(m.parameter, `${at}parameter`, 100, true));
    details.push(...checkNumber(m.value, `${at}value`));
    details.push(...checkText(m.unit, `${at}unit`, 50, true));
  });
  const samples = list('samples', MAX_SAMPLES);
  samples.forEach((s, i) => {
    if (typeof s !== 'object' || s === null) {
      details.push({
        field: `samples[${i}]`,
        message: `Invalid input: expected object, received ${typeName(s)}`,
      });
      return;
    }
    details.push(...checkSampleFields(s, `samples[${i}].`));
  });
  // zod: unknown keys are one issue after the field issues; superRefine (each parameter at most
  // once per request) still runs after an unknown key, but not after a field issue.
  const keyIssues = unknownKeys(body, [
    'project_id',
    'site_id',
    'collected_at',
    'notes',
    'measurements',
    'samples',
  ]);
  if (details.length > 0) return [...details, ...keyIssues];
  const seen = new Set<string>();
  const repeats: ApiErrorDetail[] = [];
  measurements.forEach((m, i) => {
    const parameter = (m.parameter as string).trim();
    if (seen.has(parameter)) {
      repeats.push({
        field: `measurements[${i}].parameter`,
        message: 'appears more than once in this request',
      });
    }
    seen.add(parameter);
  });
  return [...keyIssues, ...repeats];
}

function memberView(row: MemberRow) {
  const member = state.users.find((u) => u.user_id === row.user_id)!;
  return {
    project_id: row.project_id,
    user_id: row.user_id,
    full_name: member.full_name,
    email: member.email,
    project_role: row.project_role,
    joined_at: row.joined_at,
  };
}

const ROLE_ORDER: Record<ProjectRole, number> = { owner: 1, manager: 2, contributor: 3, viewer: 4 };

/** GET /api/projects/:id body: the project plus v_project_summary fields, members and sites. */
function projectDetail(project: Project) {
  const id = project.project_id;
  const rows = state.members.filter((m) => m.project_id === id);
  const members = rows
    .map(memberView)
    .sort(
      (a, b) =>
        ROLE_ORDER[a.project_role] - ROLE_ORDER[b.project_role] ||
        a.full_name.localeCompare(b.full_name) ||
        a.user_id - b.user_id,
    );
  const owner = members.find((m) => m.project_role === 'owner') ?? null;
  const count = (role: ProjectRole) => rows.filter((m) => m.project_role === role).length;
  const siteIds = siteIdsOf(id);
  const events = allEvents().filter((e) => e.project_id === id);
  return {
    ...project,
    owner_id: owner?.user_id ?? null,
    owner_name: owner?.full_name ?? null,
    member_count: rows.length,
    manager_count: count('manager'),
    contributor_count: count('contributor'),
    viewer_count: count('viewer'),
    site_count: siteIds.length,
    event_count: events.length,
    sample_count: allSamples().filter((s) => events.some((e) => e.event_id === s.event_id)).length,
    members,
    sites: state.sites.filter((s) => siteIds.includes(s.site_id)),
  };
}

/**
 * authorize('edit_project') in the API's order: a role outside administrator/PI gets 403 first,
 * then a project the user is not a member of gets 404, a project viewer 403 (read-only), and a
 * role other than owner/manager 403. Calls `edit` with the stored (writable) project.
 */
function withProjectEdit(
  { user, params }: MockContext,
  edit: (project: Omit<Project, 'your_role'>) => MockResponse,
): MockResponse {
  if (!isAdmin(user) && !hasAnyRole(user, ['principal_investigator'])) {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
  const project = state.projects.find((p) => p.project_id === Number(params.id));
  if (!project) return notFound('Project');
  if (!isAdmin(user)) {
    const role = roleIn(project.project_id, user.user_id);
    if (role === null) return notFound('Project');
    if (role !== 'owner' && role !== 'manager') {
      return fail(403, 'forbidden', 'You do not have permission to do this');
    }
  }
  return edit(project);
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

      const user = state.users.find((u) => u.email === email);
      const expected = user ? (state.passwords.get(user.user_id) ?? DEV_PASSWORD) : null;
      if (!user || !user.active || password !== expected) {
        recordLoginFailure(email);
        return fail(401, 'invalid_credentials', 'Invalid email or password');
      }
      loginFailures.delete(email);
      storeSession(user.user_id);
      writeAudit(user.user_id, 'users', user.user_id, 'login'); // auth.service.js recordLogin
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

  // Users (administration): backend routes/users.routes.js + services/users.service.js --------
  {
    method: 'GET',
    path: '/users',
    roles: ['administrator'],
    handler: ({ query }) => {
      const active = query.get('active');
      const role = query.get('role');
      const rows = state.users.filter(
        (u) =>
          (active === null || String(u.active) === active) &&
          (!role || u.roles.includes(role as RoleName)),
      );
      return paginate(rows, query, ['user_id', 'full_name', 'email']);
    },
  },
  {
    method: 'POST',
    path: '/users',
    roles: ['administrator'],
    handler: ({ user: actor, body }) => {
      const req = (body ?? {}) as Record<string, unknown>;
      const details = [
        ...checkText(req.full_name, 'full_name', 200, true),
        ...checkEmail(req.email),
        ...checkPassword(req.password),
        ...checkRoleIds(req.role_ids, true),
      ];
      if (details.length) return fail(422, 'validation_error', details[0].message, details);
      const roleIds = req.role_ids as number[];
      const unknownRoles = roleIds.filter((id) => !mockRoles.some((r) => r.role_id === id));
      if (unknownRoles.length) return unknownRolesError(unknownRoles);
      const email = String(req.email).trim().toLowerCase();
      if (state.users.some((u) => u.email === email)) {
        const detail = `Key (email)=(${email}) already exists.`; // uq_users_email (23505)
        return fail(409, 'duplicate', detail, [{ message: detail }]);
      }
      const created: User = {
        user_id: state.nextUserId++,
        full_name: String(req.full_name).trim(),
        email,
        roles: roleNames(roleIds),
        active: true,
      };
      state.users.push(created);
      state.passwords.set(created.user_id, String(req.password));
      writeAudit(actor.user_id, 'users', created.user_id, 'insert', null, {
        user_id: created.user_id,
        full_name: created.full_name,
        email: created.email,
        active: true,
      });
      return ok(created, undefined, 201);
    },
  },
  {
    method: 'PATCH',
    path: '/users/:id',
    roles: ['administrator'],
    handler: ({ user: actor, params, body }) => {
      const req = (body ?? {}) as Record<string, unknown>;
      if (Object.keys(req).length === 0) {
        return atLeastOne('at least one of active, full_name, role_ids is required');
      }
      const details = [
        ...(req.full_name !== undefined ? checkText(req.full_name, 'full_name', 200, true) : []),
        ...(req.active !== undefined && typeof req.active !== 'boolean'
          ? [{ field: 'active', message: 'Invalid input: expected boolean, received string' }]
          : []),
        ...(req.role_ids !== undefined ? checkRoleIds(req.role_ids, true) : []),
      ];
      if (details.length) return fail(422, 'validation_error', details[0].message, details);

      const target = state.users.find((u) => u.user_id === Number(params.id));
      if (!target) return fail(404, 'not_found', 'User not found');
      const roleIds = req.role_ids as number[] | undefined;
      if (roleIds) {
        const unknownRoles = roleIds.filter((id) => !mockRoles.some((r) => r.role_id === id));
        if (unknownRoles.length) return unknownRolesError(unknownRoles);
      }
      const nextRoles = roleIds ? roleNames(roleIds) : target.roles;
      const nextActive = req.active === undefined ? target.active : (req.active as boolean);
      const wasAdmin = target.roles.includes('administrator');
      const willBeAdmin = nextRoles.includes('administrator');

      // Lock-out rules (users.service.js updateUser).
      if (target.user_id === actor.user_id) {
        if (req.active === false) {
          return lockOut('You cannot deactivate your own account', 'active');
        }
        if (roleIds && wasAdmin && !willBeAdmin) {
          return lockOut('You cannot remove your own administrator role', 'role_ids');
        }
      }
      const activeAdminsAfter = state.users.filter((u) =>
        u.user_id === target.user_id
          ? nextActive && willBeAdmin
          : u.active && u.roles.includes('administrator'),
      ).length;
      if (activeAdminsAfter === 0) {
        return lockOut(
          'The last active administrator cannot be deactivated or lose the administrator role',
          roleIds && !willBeAdmin ? 'role_ids' : 'active',
        );
      }

      const before = { full_name: target.full_name, active: target.active };
      if (req.full_name !== undefined) target.full_name = String(req.full_name).trim();
      if (req.active !== undefined) target.active = req.active as boolean;
      writeAudit(actor.user_id, 'users', target.user_id, 'update', before, {
        full_name: target.full_name,
        active: target.active,
      });
      if (roleIds) {
        for (const name of target.roles.filter((r) => !nextRoles.includes(r))) {
          writeAudit(actor.user_id, 'user_roles', target.user_id, 'delete', {
            user_id: target.user_id,
            role_id: mockRoles.find((r) => r.role_name === name)!.role_id,
          });
        }
        for (const name of nextRoles.filter((r) => !target.roles.includes(r))) {
          writeAudit(actor.user_id, 'user_roles', target.user_id, 'insert', null, {
            user_id: target.user_id,
            role_id: mockRoles.find((r) => r.role_name === name)!.role_id,
          });
        }
        target.roles = nextRoles;
      }
      return ok({ ...target, roles: [...target.roles] });
    },
  },
  { method: 'GET', path: '/roles', handler: () => ok(mockRoles) },

  // Projects: backend routes/projects.routes.js + services/projects.service.js -------------
  {
    method: 'GET',
    path: '/projects',
    handler: ({ user, query }) => {
      const status = query.get('status');
      return paginate(
        projectsFor(user).filter((p) => !status || p.status === status),
        query,
        ['project_id', 'title', 'status', 'start_date'],
      );
    },
  },
  {
    method: 'POST',
    path: '/projects',
    roles: ['principal_investigator'],
    handler: ({ user, body }) => {
      const req = (body ?? {}) as Record<string, unknown>;
      const details = [
        ...checkText(req.title, 'title', 300, true),
        ...(req.objectives != null ? checkText(req.objectives, 'objectives', 5000, false) : []),
        ...(req.start_date != null ? checkDate(req.start_date, 'start_date') : []),
      ];
      if (details.length) return fail(422, 'validation_error', details[0].message, details);
      const title = String(req.title).trim();
      // create_project_with_owner() raises its own message for a taken title (checked against
      // the real API); a PATCH hits uq_projects_title instead (duplicateTitle).
      if (state.projects.some((p) => p.title === title)) {
        return fail(409, 'duplicate', 'Project titles are unique.', [
          { message: 'Project titles are unique.' },
        ]);
      }

      const project = {
        project_id: state.nextProjectId++,
        title,
        objectives: req.objectives == null ? null : String(req.objectives).trim(),
        start_date: (req.start_date as string | null | undefined) ?? null,
        end_date: null,
        status: 'planned' as const,
        created_by: user.user_id,
      };
      // create_project_with_owner(): the project and the caller's owner membership together.
      state.projects.push(project);
      state.members.push({
        project_id: project.project_id,
        user_id: user.user_id,
        project_role: 'owner',
        joined_at: new Date().toISOString(),
      });
      writeAudit(user.user_id, 'projects', project.project_id, 'insert', null, project);
      writeAudit(user.user_id, 'project_members', project.project_id, 'insert', null, {
        project_id: project.project_id,
        user_id: user.user_id,
        project_role: 'owner',
      });
      return ok({ ...project, your_role: 'owner' }, undefined, 201);
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
      return ok(projectDetail(project));
    },
  },
  {
    method: 'PATCH',
    path: '/projects/:id',
    handler: (ctx) =>
      withProjectEdit(ctx, (project) => {
        const req = (ctx.body ?? {}) as Record<string, unknown>;
        if (Object.keys(req).length === 0) {
          return atLeastOne('at least one of title, objectives, status, end_date is required');
        }
        const details = [
          ...(req.title !== undefined ? checkText(req.title, 'title', 300, true) : []),
          ...(req.objectives != null ? checkText(req.objectives, 'objectives', 5000, false) : []),
          ...(req.status !== undefined && !PROJECT_STATUSES.includes(req.status as string)
            ? [
                {
                  field: 'status',
                  message:
                    'Invalid option: expected one of "planned"|"active"|"completed"|"archived"',
                },
              ]
            : []),
          ...(req.end_date != null ? checkDate(req.end_date, 'end_date') : []),
        ];
        if (details.length) return fail(422, 'validation_error', details[0].message, details);
        if (
          req.end_date != null &&
          project.start_date !== null &&
          String(req.end_date) < project.start_date
        ) {
          return fail(422, 'validation_error', 'end_date must not be before start_date', [
            { field: 'end_date', message: `must be on or after ${project.start_date}` },
          ]);
        }
        const title = req.title === undefined ? project.title : String(req.title).trim();
        if (title !== project.title && state.projects.some((p) => p.title === title)) {
          return duplicateTitle(title);
        }
        const before = { ...project };
        project.title = title;
        if (req.objectives !== undefined) {
          project.objectives = req.objectives === null ? null : String(req.objectives).trim();
        }
        if (req.status !== undefined) project.status = req.status as Project['status'];
        if (req.end_date !== undefined) project.end_date = (req.end_date as string | null) ?? null;
        writeAudit(ctx.user.user_id, 'projects', project.project_id, 'update', before, project);
        return ok({ ...project, your_role: roleIn(project.project_id, ctx.user.user_id) });
      }),
  },
  {
    method: 'POST',
    path: '/projects/:id/members',
    handler: (ctx) =>
      withProjectEdit(ctx, (project) => {
        const req = (ctx.body ?? {}) as Record<string, unknown>;
        const details = [
          ...checkId(req.user_id, 'user_id'),
          ...(PROJECT_ROLES.includes(req.project_role as string)
            ? []
            : [
                {
                  field: 'project_role',
                  message:
                    'Invalid option: expected one of "owner"|"manager"|"contributor"|"viewer"',
                },
              ]),
        ];
        if (details.length) return fail(422, 'validation_error', details[0].message, details);
        if (req.project_role === 'owner') {
          return ruleViolation(
            'A project has one owner, set when it is created; owner cannot be assigned here',
            'project_role',
          );
        }
        const memberId = req.user_id as number;
        const member = state.users.find((u) => u.user_id === memberId);
        if (!member) {
          return fail(422, 'invalid_reference', `User ${memberId} does not exist`, [
            { field: 'user_id', message: `User ${memberId} does not exist` },
          ]);
        }
        if (!member.active) return ruleViolation(`User ${memberId} is deactivated`, 'user_id');
        if (roleIn(project.project_id, memberId) !== null) {
          const detail = `Key (project_id, user_id)=(${project.project_id}, ${memberId}) already exists.`;
          return fail(409, 'duplicate', detail, [{ message: detail }]);
        }
        const row: MemberRow = {
          project_id: project.project_id,
          user_id: memberId,
          project_role: req.project_role as ProjectRole,
          joined_at: new Date().toISOString(),
        };
        state.members.push(row);
        writeAudit(ctx.user.user_id, 'project_members', project.project_id, 'insert', null, {
          project_id: row.project_id,
          user_id: row.user_id,
          project_role: row.project_role,
        });
        return ok(memberView(row), undefined, 201);
      }),
  },
  {
    method: 'DELETE',
    path: '/projects/:id/members/:userId',
    handler: (ctx) =>
      withProjectEdit(ctx, (project) => {
        const memberId = Number(ctx.params.userId);
        const row = state.members.find(
          (m) => m.project_id === project.project_id && m.user_id === memberId,
        );
        if (!row) return fail(404, 'not_found', 'Membership not found');
        if (row.project_role === 'owner') {
          return ruleViolation('The project owner cannot be removed', 'user_id');
        }
        state.members = state.members.filter((m) => m !== row);
        writeAudit(ctx.user.user_id, 'project_members', project.project_id, 'delete', {
          project_id: row.project_id,
          user_id: row.user_id,
          project_role: row.project_role,
        });
        return noContent();
      }),
  },
  {
    method: 'POST',
    path: '/projects/:id/sites',
    handler: (ctx) =>
      withProjectEdit(ctx, (project) => {
        const req = (ctx.body ?? {}) as Record<string, unknown>;
        const details = checkId(req.site_id, 'site_id');
        if (details.length) return fail(422, 'validation_error', details[0].message, details);
        const siteId = req.site_id as number;
        if (!state.sites.some((site) => site.site_id === siteId)) {
          return fail(422, 'invalid_reference', `Site ${siteId} does not exist`, [
            { field: 'site_id', message: `Site ${siteId} does not exist` },
          ]);
        }
        if (siteIdsOf(project.project_id).includes(siteId)) {
          const detail = `Key (project_id, site_id)=(${project.project_id}, ${siteId}) already exists.`;
          return fail(409, 'duplicate', detail, [{ message: detail }]);
        }
        const link = { project_id: project.project_id, site_id: siteId };
        state.projectSites.push(link);
        writeAudit(ctx.user.user_id, 'project_sites', project.project_id, 'insert', null, link);
        return ok(link, undefined, 201);
      }),
  },
  {
    method: 'DELETE',
    path: '/projects/:id/sites/:siteId',
    handler: (ctx) =>
      withProjectEdit(ctx, (project) => {
        const siteId = Number(ctx.params.siteId);
        const link = state.projectSites.find(
          (l) => l.project_id === project.project_id && l.site_id === siteId,
        );
        if (!link) return fail(404, 'not_found', 'Site is not linked to this project');
        if (allEvents().some((e) => e.project_id === project.project_id && e.site_id === siteId)) {
          return fail(
            409,
            'conflict',
            'Site has collection events in this project and cannot be removed',
          );
        }
        state.projectSites = state.projectSites.filter((l) => l !== link);
        writeAudit(ctx.user.user_id, 'project_sites', project.project_id, 'delete', { ...link });
        return noContent();
      }),
  },

  // Sites and regions (T21) --------------------------------------------------------------
  {
    method: 'GET',
    path: '/regions',
    handler: ({ query }) => {
      const type = query.get('region_type');
      if (type !== null) {
        const bad = checkEnum(type, 'region_type', REGION_TYPES);
        if (bad.length) return validationError(bad);
      }
      return ok(mockRegions.filter((r) => type === null || r.region_type === type));
    },
  },
  {
    method: 'GET',
    path: '/sites',
    handler: ({ query, user }) => {
      const habitat = query.get('habitat_type');
      const bad = [
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...checkIdString(query.get('region_id'), 'region_id'),
        ...(habitat === null ? [] : checkEnum(habitat, 'habitat_type', HABITAT_TYPES)),
      ];
      if (bad.length) return validationError(bad);
      const projectId = num(query, 'project_id');
      const regionId = num(query, 'region_id');
      // As the API: filtering by a project needs access to it (services/sites.service.js).
      if (projectId !== null) {
        const denied = projectAccess(user, projectId);
        if (denied) return denied;
      }
      const rows = state.sites
        .filter(
          (s) =>
            (projectId === null || siteIdsOf(projectId).includes(s.site_id)) &&
            (regionId === null || s.region_id === regionId) &&
            (!habitat || s.habitat_type === habitat),
        )
        .sort((a, b) => a.site_id - b.site_id);
      return paginate(rows, query, ['site_id', 'name'], 'site_id');
    },
  },
  {
    method: 'POST',
    path: '/sites',
    roles: ['principal_investigator', 'field_researcher'],
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const fields = checkSiteBody(input, true);
      if (Array.isArray(fields)) return validationError(fields);
      const site_id = state.nextSiteId++; // used up even when the insert fails
      const site = { description: null, ...fields } as Omit<Site, 'site_id'>;
      const conflict = siteConflict(site, null);
      if (conflict) return conflict;
      const created: Site = { site_id, ...site };
      state.sites.push(created);
      writeAudit(user.user_id, 'sampling_sites', site_id, 'insert', null, {
        ...created,
        created_by: user.user_id,
        created_at: jsonbTime(new Date().toISOString()),
      });
      return ok(created, undefined, 201);
    },
  },
  {
    method: 'GET',
    path: '/sites/:id',
    handler: ({ params }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const site = state.sites.find((s) => s.site_id === Number(params.id));
      return site ? ok(site) : notFound('Site');
    },
  },
  {
    method: 'PATCH',
    path: '/sites/:id',
    roles: ['principal_investigator', 'field_researcher'],
    handler: ({ params, body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const fields = checkSiteBody(input, false);
      const bad = [...checkIdString(params.id, 'id'), ...(Array.isArray(fields) ? fields : [])];
      if (bad.length || Array.isArray(fields)) return validationError(bad);
      const site = state.sites.find((s) => s.site_id === Number(params.id));
      if (!site) return notFound('Site');
      const next: Site = { ...site, ...fields };
      const conflict = siteConflict(next, site.site_id);
      if (conflict) return conflict;
      writeAudit(user.user_id, 'sampling_sites', site.site_id, 'update', { ...site }, { ...next });
      Object.assign(site, next);
      return ok({ ...site });
    },
  },

  // Collection events (T21) --------------------------------------------------------------
  {
    method: 'GET',
    path: '/events',
    handler: ({ user, query }) => {
      const range = rangeOf(query);
      const bad = [
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...checkIdString(query.get('site_id'), 'site_id'),
        ...(Array.isArray(range) ? range : []),
      ];
      if (bad.length === 0 && !Array.isArray(range) && range.from !== null && range.to !== null) {
        if (range.from > range.to) bad.push({ field: 'from', message: 'must not be after to' });
      }
      if (bad.length || Array.isArray(range)) return validationError(bad);
      const projectId = num(query, 'project_id');
      const siteId = num(query, 'site_id');
      if (projectId !== null) {
        const denied = projectAccess(user, projectId);
        if (denied) return denied;
      }
      const visible = visibleProjectIds(user);
      const rows = state.events
        .filter((e) => {
          const at = Date.parse(e.collected_at);
          return (
            visible.includes(e.project_id) &&
            (projectId === null || e.project_id === projectId) &&
            (siteId === null || e.site_id === siteId) &&
            (range.from === null || at >= range.from) &&
            (range.to === null || at <= range.to)
          );
        })
        // Newest first unless ?sort is given (collected_at DESC, event_id DESC).
        .sort(
          (a, b) =>
            Date.parse(b.collected_at) - Date.parse(a.collected_at) || b.event_id - a.event_id,
        );
      if (query.get('sort')) rows.sort((a, b) => a.event_id - b.event_id);
      return paginate(rows.map(withCollectorName), query, ['event_id', 'collected_at'], 'event_id');
    },
  },
  {
    method: 'GET',
    path: '/events/:id',
    handler: ({ user, params }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const event = eventById(Number(params.id));
      if (!event) return notFound('Event');
      const denied = projectAccess(user, event.project_id, { what: 'Event' });
      if (denied) return denied;
      const detail: CollectionEventDetail = {
        ...withCollectorName(event),
        samples: state.samples
          .filter((s) => s.event_id === event.event_id)
          .sort((a, b) => a.sample_id - b.sample_id),
        measurements: state.measurements
          .filter((m) => m.event_id === event.event_id)
          .sort((a, b) => a.measurement_id - b.measurement_id),
      };
      return ok(detail);
    },
  },
  {
    // One transaction: event, measurements, then register_sample() per sample
    // (services/events.service.js). Any failure keeps nothing (ids still used up).
    method: 'POST',
    path: '/events',
    roles: ['principal_investigator', 'field_researcher'],
    handler: ({ user, body }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      // authorize('create_event_sample', { source: 'body.project_id' }) runs before validation.
      if (!isAdmin(user)) {
        const raw = input.project_id;
        const projectId =
          typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
        if (projectId === null || !state.projects.some((p) => p.project_id === projectId)) {
          return notFound('Project');
        }
        const denied = projectAccess(user, projectId, { write: true });
        if (denied) return denied;
      }
      const bad = checkEventBody(input);
      if (bad.length) return validationError(bad);
      const req = input as unknown as CreateEventRequest;
      if (!state.projects.some((p) => p.project_id === req.project_id)) {
        return fail(422, 'invalid_reference', 'Project does not exist', [
          { field: 'project_id', message: 'does not exist' },
        ]);
      }
      if (!siteIdsOf(req.project_id).includes(req.site_id)) {
        return fail(422, 'invalid_reference', 'Site is not attached to this project', [
          { field: 'site_id', message: 'is not attached to this project' },
        ]);
      }
      const now = new Date().toISOString();
      const event: CollectionEvent = {
        event_id: state.nextEventId++,
        project_id: req.project_id,
        site_id: req.site_id,
        collector_id: user.user_id,
        collected_at: new Date(req.collected_at).toISOString(),
        notes: present(req.notes) ? req.notes!.trim() : null,
        created_at: now,
      };
      const measurements: EnvironmentalMeasurement[] = (req.measurements ?? []).map((m) => ({
        measurement_id: state.nextMeasurementId++,
        event_id: event.event_id,
        parameter: m.parameter.trim(),
        value: m.value,
        unit: m.unit.trim(),
      }));
      const samples: Sample[] = [];
      for (const input of req.samples ?? []) {
        const sample = registerSample(event, input, now, samples);
        if (!('sample_id' in sample)) return sample;
        samples.push(sample);
      }
      state.events.push(event);
      state.measurements.push(...measurements);
      writeAudit(user.user_id, 'collection_events', event.event_id, 'insert', null, {
        ...event,
        collected_at: jsonbTime(event.collected_at),
        created_at: jsonbTime(now),
      });
      commitSamples(samples, user.user_id, now);
      return ok({ ...withCollectorName(event), samples, measurements }, undefined, 201);
    },
  },

  // Samples (T21) ---------------------------------------------------------------------------
  { method: 'GET', path: '/sample-types', handler: () => ok(mockSampleTypes) },
  {
    method: 'GET',
    path: '/samples',
    handler: ({ user, query }) => {
      const status = query.get('status');
      const q = query.get('q');
      const bad = [
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...checkIdString(query.get('site_id'), 'site_id'),
        ...checkIdString(query.get('event_id'), 'event_id'),
        ...(status === null ? [] : checkEnum(status, 'status', SAMPLE_STATUSES)),
        ...(q === null ? [] : checkText(q, 'q', 64, false)),
      ];
      if (q !== null && q.trim() === '') {
        bad.push({ field: 'q', message: 'Too small: expected string to have >=1 characters' });
      }
      if (bad.length) return validationError(bad);
      const projectId = num(query, 'project_id');
      const siteId = num(query, 'site_id');
      const eventId = num(query, 'event_id');
      if (projectId !== null) {
        const denied = projectAccess(user, projectId);
        if (denied) return denied;
      }
      const visible = visibleProjectIds(user);
      // q is a case-insensitive prefix of the sample code.
      const prefix = q?.trim().toUpperCase();
      const rows = state.samples
        .filter((s) => {
          const event = eventById(s.event_id)!;
          return (
            visible.includes(event.project_id) &&
            (projectId === null || event.project_id === projectId) &&
            (siteId === null || event.site_id === siteId) &&
            (eventId === null || s.event_id === eventId) &&
            (!status || s.status === status) &&
            (!prefix || s.sample_code.startsWith(prefix))
          );
        })
        .sort((a, b) => a.sample_id - b.sample_id);
      return paginate(rows, query, ['sample_id', 'sample_code', 'created_at'], 'sample_id');
    },
  },
  {
    method: 'POST',
    path: '/samples',
    roles: ['principal_investigator', 'field_researcher'],
    handler: ({ user, body }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const bad = [
        ...checkId(input.event_id, 'event_id'),
        ...checkSampleFields(input, ''),
        ...unknownKeys(input, [
          'event_id',
          'sample_type_id',
          'volume_ml',
          'depth_m',
          'storage_location',
        ]),
      ];
      if (bad.length) return validationError(bad);
      const event = eventById(input.event_id as number);
      if (!event) return notFound('Event');
      const denied = projectAccess(user, event.project_id, { write: true, what: 'Event' });
      if (denied) return denied;
      const now = new Date().toISOString();
      const sample = registerSample(event, input as { sample_type_id: number }, now, []);
      if (!('sample_id' in sample)) return sample;
      commitSamples([sample], user.user_id, now);
      return ok(sample, undefined, 201);
    },
  },
  {
    method: 'GET',
    path: '/samples/:id',
    handler: ({ user, params }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const sample = sampleById(Number(params.id));
      if (!sample) return notFound('Sample');
      const event = eventById(sample.event_id)!;
      const denied = projectAccess(user, event.project_id, { what: 'Sample' });
      if (denied) return denied;
      const site = state.sites.find((s) => s.site_id === event.site_id)!;
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
          .sort((a, b) => a.attempt_number - b.attempt_number || a.extraction_id - b.extraction_id)
          .map(({ extraction_id, attempt_number, qc_status }) => ({
            extraction_id,
            attempt_number,
            qc_status,
          })),
        status_history: state.history
          .filter((h) => h.sample_id === sample.sample_id)
          .map(({ old_status, new_status, changed_at, changed_by, note }) => ({
            old_status,
            new_status,
            changed_at,
            changed_by,
            changed_by_name: state.users.find((u) => u.user_id === changed_by)?.full_name ?? null,
            note,
          })),
      });
    },
  },
  {
    // A plain UPDATE: the trigger enforces CONTRACT section 3 and writes the history row.
    // `note` is stored on the history row; none (or only spaces) stores NULL (CONTRACT 1.6).
    method: 'PATCH',
    path: '/samples/:id/status',
    roles: ['principal_investigator', 'field_researcher', 'lab_technician'],
    handler: ({ user, params, body }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const bad = [
        ...checkIdString(params.id, 'id'),
        ...checkEnum(input.new_status, 'new_status', SAMPLE_STATUSES),
        ...(present(input.note) ? checkText(input.note, 'note', 1000, false) : []),
        ...unknownKeys(input, ['new_status', 'note']),
      ];
      if (bad.length) return validationError(bad);
      const sample = sampleById(Number(params.id));
      if (!sample) return notFound('Sample');
      const denied = projectAccess(user, eventById(sample.event_id)!.project_id, {
        write: true,
        what: 'Sample',
      });
      if (denied) return denied;
      const next = input.new_status as SampleStatus;
      if (sample.status === next) {
        return fail(409, 'invalid_transition', `Sample is already ${next}`, []);
      }
      if (!SAMPLE_TRANSITIONS[sample.status].includes(next)) {
        return fail(
          409,
          'invalid_transition',
          `Invalid sample status transition: ${sample.status} -> ${next}`,
          [],
        );
      }
      const now = new Date().toISOString();
      state.history.push({
        sample_id: sample.sample_id,
        old_status: sample.status,
        new_status: next,
        changed_at: now,
        changed_by: user.user_id,
        note: present(input.note) ? (input.note as string).trim() || null : null,
      });
      writeAudit(
        user.user_id,
        'samples',
        sample.sample_id,
        'update',
        { status: sample.status },
        { status: next },
      );
      sample.status = next;
      return ok({ ...sample });
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
          ? state.sites.find((s) => s.site_id === e.site_id)!.name
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
      const siteIds = new Set(projectIds.flatMap((id) => siteIdsOf(id)));
      return ok({
        projects: projectIds.length,
        sites: siteIds.size,
        samples: allSamples().filter((s) => events.some((e) => e.event_id === s.event_id)).length,
        approved_detections: approvedDetections(user).filter((d) =>
          projectIds.includes(d.event.project_id),
        ).length,
        recent_activity: hasAnyRole(user, ['administrator', 'principal_investigator'])
          ? auditFor(user).slice(0, 5)
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
    handler: ({ user, query }) => {
      const entityType = query.get('entity_type');
      const entityId = num(query, 'entity_id');
      const actorId = num(query, 'actor_id');
      // `from` / `to` are ISO timestamps with an offset, compared as instants (timestamptz).
      const from = query.get('from') ? Date.parse(query.get('from')!) : null;
      const to = query.get('to') ? Date.parse(query.get('to')!) : null;
      if (from !== null && to !== null && from > to) {
        return fail(422, 'validation_error', 'must not be after to', [
          { field: 'from', message: 'must not be after to' },
        ]);
      }
      const rows = auditFor(user).filter((a) => {
        const at = Date.parse(a.created_at);
        return (
          (!entityType || a.entity_type === entityType) &&
          (entityId === null || a.entity_id === entityId) &&
          (actorId === null || a.actor_id === actorId) &&
          (from === null || at >= from) &&
          (to === null || at <= to)
        );
      });
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
