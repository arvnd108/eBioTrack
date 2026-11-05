// Owner: B (Frontend)
// Purpose: In-browser mock of the REST API, answering with CONTRACT section 10/11 shapes
//
// Used when VITE_USE_MOCK=true (see apiClient.ts). Each handler returns what the real server
// would: an HTTP status and a JSON body (`{ data, meta? }` or `{ error }`; an export download is
// CSV text with its headers). Covers every endpoint in section 10 except the optional ML route.
//
// Rules copied from the contract so pages see realistic behaviour:
//   - lists are paginated (?page, ?limit; default 25, max 100) with meta { page, limit, total }
//   - project data the user is not a member of is hidden (404 for a single item)
//   - analytics and detections use only approved analyses and qc_flag = 'pass', and analytics
//     responses carry meta.caveat
//   - the T20 routes (users, projects, audit), T21 routes (regions, sites, events, samples), T22
//     routes (lab) and T23 routes (analyses, CSV import, taxa, analytics, dashboard, exports)
//     follow the real API scenario by scenario: same checks, order, status codes and messages
//
// To mock a new endpoint, add one entry to `routes` below. Paths are relative to /api and may
// use `:params`, for example '/projects/:id'.

import {
  EDNA_CAVEAT,
  type AnalysisRejection,
  type AnalysisRun,
  type AnalysisRunRow,
  type ExportType,
  type RichnessRow,
  type Taxon,
  type AuditAction,
  type AuditEntry,
  type AuditRow,
  type Project,
  type ProjectRole,
  type ApiErrorDetail,
  type CollectionEvent,
  type CollectionEventDetail,
  type CreateEventRequest,
  type DnaExtraction,
  type ExtractionBatch,
  type QcResult,
  type QcStatus,
  type QcType,
  type QualityControlResult,
  type RunStatus,
  type SequencingLibrary,
  type SequencingRun,
  type SequencingRunDetail,
  type EnvironmentalMeasurement,
  type HabitatType,
  type PageMeta,
  type RoleName,
  type Sample,
  type SampleStatus,
  type Site,
  type User,
} from '../../types';
import {
  checkDetectionCsv,
  csvLine,
  MAX_IMPORT_BYTES,
  TAXON_RANKS,
  type CsvRowError,
  type DetectionCsvRow,
} from '../../utils/detectionCsv';
import type { HttpMethod } from '../apiClient';
import { PERMISSIONS, can, type Action } from '../../permissions';
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
  type StoredBatch,
  type StoredExtraction,
  type StoredQcResult,
  type MockAssignment,
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
  /** A multipart body (CSV import), read before the handler runs; null for any other body. */
  upload: MockUpload | null;
}

interface MockUpload {
  /** Text fields; a repeated name keeps its last value. */
  fields: Record<string, string>;
  /** The part named `file`; `text` is null when its bytes are not UTF-8. */
  file: { name: string; size: number; text: string | null } | null;
}

/** multer + TextDecoder('utf-8', { fatal: true }) in the API, done ahead because files read async. */
async function readUpload(body: unknown): Promise<MockUpload | null> {
  if (!(body instanceof FormData)) return null;
  const fields: Record<string, string> = {};
  let file: MockUpload['file'] = null;
  for (const [name, value] of body.entries()) {
    if (typeof value === 'string') {
      fields[name] = value;
    } else if (name === 'file') {
      const bytes = new Uint8Array(await value.arrayBuffer());
      let text: string | null;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
      file = { name: value.name, size: bytes.byteLength, text };
    }
  }
  return { fields, file };
}

interface MockRoute {
  method: HttpMethod;
  path: string;
  /** Default true: return 401 when nobody is signed in. */
  auth?: boolean;
  /** Global roles allowed (administrators always pass). Others get 403. */
  roles?: RoleName[];
  /** Matrix action (src/permissions.ts): a global role OR a granting project role anywhere passes; handlers then check the project. */
  action?: Action;
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
  audit: AuditRow[];
  sites: Site[];
  events: CollectionEvent[];
  samples: Sample[];
  measurements: EnvironmentalMeasurement[];
  history: StatusHistoryRow[];
  batches: StoredBatch[];
  extractions: StoredExtraction[];
  qcResults: StoredQcResult[];
  runs: SequencingRun[];
  libraries: SequencingLibrary[];
  analyses: AnalysisRunRow[];
  assignments: MockAssignment[];
  exports: StoredExport[];
  nextUserId: number;
  nextProjectId: number;
  nextAuditId: number;
  nextSiteId: number;
  nextEventId: number;
  nextSampleId: number;
  nextMeasurementId: number;
  nextBatchId: number;
  nextExtractionId: number;
  nextQcId: number;
  nextRunId: number;
  nextLibraryId: number;
  nextAnalysisId: number;
  nextAssignmentId: number;
  nextExportId: number;
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
    batches: mockBatches.map((x) => ({ ...x })),
    extractions: mockExtractions.map((x) => ({ ...x })),
    qcResults: mockQcResults.map((x) => ({ ...x })),
    runs: mockRuns.map((x) => ({ ...x })),
    libraries: mockLibraries.map((x) => ({ ...x })),
    analyses: mockAnalyses.map((x) => ({ ...x, parameters: { ...x.parameters } })),
    assignments: mockAssignments.map((x) => ({ ...x })),
    exports: [],
    // Application-generated IDs start at 1000 (CONTRACT D6). Like a PostgreSQL sequence, an
    // insert the database refuses (unknown region, duplicate name) still uses up its id.
    nextUserId: 1000,
    nextProjectId: 1000,
    nextAuditId: 1000,
    nextSiteId: 1000,
    nextEventId: 1000,
    nextSampleId: 1000,
    nextMeasurementId: 1000,
    nextBatchId: 1000,
    nextExtractionId: 1000,
    nextQcId: 1000,
    nextRunId: 1000,
    nextLibraryId: 1000,
    nextAnalysisId: 1000,
    nextAssignmentId: 1000,
    nextExportId: 1000,
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

/**
 * v_approved_detections: passing rows of approved analyses joined to their library, sample,
 * event and site, in every project (exports scope them to one project themselves).
 */
function detectionRows() {
  return passingAssignments().map((a) => {
    const library = state.libraries.find((l) => l.library_id === a.library_id)!;
    const extraction = state.extractions.find((x) => x.extraction_id === library.extraction_id)!;
    const sample = allSamples().find((s) => s.sample_id === extraction.sample_id)!;
    const event = allEvents().find((e) => e.event_id === sample.event_id)!;
    const site = state.sites.find((s) => s.site_id === event.site_id)!;
    return { assignment: a, sample, event, site };
  });
}

/** The approved detections in the user's projects. */
function approvedDetections(user: User) {
  const visible = visibleProjectIds(user);
  return detectionRows().filter((d) => visible.includes(d.event.project_id));
}

/**
 * Audit entries the user may read, newest first (backend services/audit.service.js): an
 * administrator sees everything; a principal investigator sees entries about entities in a
 * project they belong to, and anyone else the same for the projects they own (the project and its members and sites, its events, samples,
 * extractions, libraries, the runs and analyses those libraries are in, their QC results, and the
 * project's exports); other roles see nothing. `projectId` narrows to one project (the dashboard),
 * for the administrator too.
 */
function auditFor(user: User, projectId: number | null = null): AuditEntry[] {
  let visible: AuditRow[];
  if (isAdmin(user) && projectId === null) {
    visible = state.audit;
  } else {
    // administrator: any project; principal investigator: projects they belong to; anyone else:
    // only the projects they own (backend services/audit.service.js)
    const isPi = hasAnyRole(user, ['principal_investigator']);
    const projects = new Set(
      state.projects
        .map((p) => p.project_id)
        .filter(
          (id) =>
            (isAdmin(user) ||
              (isPi ? roleIn(id, user.user_id) !== null : roleIn(id, user.user_id) === 'owner')) &&
            (projectId === null || id === projectId),
        ),
    );
    const events = allEvents().filter((e) => projects.has(e.project_id));
    const samples = new Set(
      allSamples()
        .filter((s) => events.some((e) => e.event_id === s.event_id))
        .map((s) => s.sample_id),
    );
    const extractions = state.extractions.filter((x) => samples.has(x.sample_id));
    const libraries = state.libraries.filter((l) =>
      extractions.some((x) => x.extraction_id === l.extraction_id),
    );
    const runs = new Set(libraries.map((l) => l.run_id));
    const analyses = new Set(
      state.analyses.filter((a) => runs.has(a.run_id)).map((a) => a.analysis_id),
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
        state.qcResults
          .filter(
            (q) =>
              (q.sample_id !== null && samples.has(q.sample_id)) ||
              (q.analysis_id !== null && analyses.has(q.analysis_id)),
          )
          .map((q) => q.qc_id),
      ),
      data_exports: new Set(
        state.exports.filter((x) => projects.has(x.project_id)).map((x) => x.export_id),
      ),
    };
    visible = state.audit.filter((a) => scope[a.entity_type]?.has(a.entity_id) ?? false);
  }
  // CONTRACT 1.9: every entry names its actor (null for a system action).
  return [...visible]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.audit_id - a.audit_id)
    .map((a) => ({ ...a, actor_name: userName(a.actor_id) }));
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
/** The matrix action of the route being served: write checks inside its handler use it. */
let activeAction: Action | undefined;

/** The project roles this user holds in any project. */
const heldProjectRoles = (user: User): ProjectRole[] =>
  state.members.filter((m) => m.user_id === user.user_id).map((m) => m.project_role);

function projectAccess(
  user: User,
  projectId: number,
  {
    write = false,
    what = 'Project',
    action,
  }: { write?: boolean; what?: string; action?: Action } = {},
): MockResponse | null {
  if (isAdmin(user)) {
    return state.projects.some((p) => p.project_id === projectId) ? null : notFound(what);
  }
  const role = roleIn(projectId, user.user_id);
  if (role === null) return notFound(what);
  const act = action ?? (write ? activeAction : undefined);
  if ((write || (act && !PERMISSIONS[act].read)) && role === 'viewer') {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
  if (act && !can(user, act, role)) {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
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

// ---------------------------------------------------------------------------
// T22 helpers: laboratory and sequencing (backend routes/extractions|sequencing.routes.js,
// services/extractions|sequencing.service.js, database/procedures/lab_procedures.sql and
// triggers/lab_triggers.sql). Messages are the API's own.
// ---------------------------------------------------------------------------

const QC_STATUSES = ['pending', 'pass', 'fail'];
const QC_TYPES = [
  'extraction_blank',
  'negative_control',
  'positive_control',
  'concentration',
  'contamination_check',
  'read_quality',
];
const QC_RESULTS = ['pass', 'warn', 'fail'];
const RUN_STATUSES: RunStatus[] = ['planned', 'running', 'completed', 'failed'];
const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  planned: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};
const MAX_EXTRACTIONS_PER_RUN = 500;
const EARLIEST_BATCH_DATE = '2000-01-01';

/** RUN-001 / LIB-0001: zero-padded to at least `width` digits (fn_lab_code). */
const labCode = (prefix: string, id: number, width: number) =>
  `${prefix}${String(id).padStart(width, '0')}`;

const userName = (id: number | null) =>
  id === null ? null : (state.users.find((u) => u.user_id === id)?.full_name ?? null);
const codeOfSample = (id: number | null) =>
  id === null ? null : (sampleById(id)?.sample_code ?? null);

/** The planned or running run an extraction is booked on (the booking rule allows one). */
function activeRunOf(extractionId: number): SequencingRun | null {
  const runIds = state.libraries
    .filter((l) => l.extraction_id === extractionId)
    .map((l) => l.run_id)
    .sort((a, b) => a - b);
  return (
    runIds
      .map((id) => state.runs.find((r) => r.run_id === id)!)
      .find((r) => r.status === 'planned' || r.status === 'running') ?? null
  );
}

// Rows as the API returns them (CONTRACT 1.7 names and codes).
const batchView = (b: StoredBatch): ExtractionBatch => ({
  ...b,
  operator_name: userName(b.operator_id),
});
function extractionView(x: StoredExtraction): DnaExtraction {
  const run = activeRunOf(x.extraction_id);
  return {
    ...x,
    sample_code: codeOfSample(x.sample_id)!,
    project_id: projectOfSample(x.sample_id)!,
    active_run_id: run?.run_id ?? null,
    active_run_code: run?.run_code ?? null,
  };
}
const qcView = (q: StoredQcResult): QualityControlResult => ({
  ...q,
  sample_code: codeOfSample(q.sample_id),
  recorded_by_name: userName(q.recorded_by),
});

const projectOfSample = (sampleId: number) => {
  const sample = sampleById(sampleId);
  return sample ? eventById(sample.event_id)!.project_id : null;
};
const extractionById = (id: number) =>
  state.extractions.find((x) => x.extraction_id === id) ?? null;

/** projectAccess.js projectIdsOfRun: the projects of a run's libraries; null when no such run. */
function projectsOfRun(runId: number): number[] | null {
  if (!state.runs.some((r) => r.run_id === runId)) return null;
  const ids = state.libraries
    .filter((l) => l.run_id === runId)
    .map((l) => projectOfSample(extractionById(l.extraction_id)!.sample_id)!);
  return [...new Set(ids)];
}

/** projectAccess.js assertAnyProjectAccess: a membership in one of them (non-viewer to write). */
function anyProjectAccess(
  user: User,
  projectIds: number[],
  { write = false, what }: { write?: boolean; what: string },
): MockResponse | null {
  if (isAdmin(user)) return null;
  const roles = projectIds.map((id) => roleIn(id, user.user_id)).filter((r) => r !== null);
  if (roles.length === 0) return notFound(what);
  if (write && roles.every((r) => r === 'viewer')) {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
  if (write && activeAction && !roles.some((r) => can(user, activeAction as Action, r))) {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
  return null;
}

/** Visible library rows of a run for this user (all for an administrator). */
function runDetail(run: SequencingRun, user: User): SequencingRunDetail {
  const visible = visibleProjectIds(user);
  const libraries = state.libraries
    .filter((l) => l.run_id === run.run_id)
    .sort((a, b) => a.library_id - b.library_id)
    .flatMap((l) => {
      const extraction = extractionById(l.extraction_id)!;
      const projectId = projectOfSample(extraction.sample_id)!;
      if (!visible.includes(projectId)) return [];
      return [
        {
          ...l,
          sample_id: extraction.sample_id,
          sample_code: codeOfSample(extraction.sample_id)!,
          project_id: projectId,
        },
      ];
    });
  return { ...run, libraries };
}

/** fn_lab_check_bookable: QC must have passed, and no other planned or running run may hold it. */
function bookingProblem(x: StoredExtraction): MockResponse | null {
  if (x.qc_status !== 'pass') {
    return fail(
      422,
      'rule_violation',
      `Extraction ${x.extraction_id} has not passed QC (qc_status ${x.qc_status})`,
      [{ message: 'Only extractions with qc_status pass can be sequenced.' }],
    );
  }
  const run = activeRunOf(x.extraction_id);
  if (run) {
    return fail(
      422,
      'rule_violation',
      `Extraction ${x.extraction_id} is already booked on run ${run.run_code} (${run.status})`,
      [{ message: 'An extraction can be in only one planned or running run at a time.' }],
    );
  }
  return null;
}

/** A database foreign-key refusal, worded as the API passes it through. */
const missingKey = (column: string, value: unknown, table: string) => {
  const detail = `Key (${column})=(${String(value)}) is not present in table "${table}".`;
  return fail(422, 'invalid_reference', detail, [{ message: detail }]);
};

/** A new library row and its audit entry. */
function addLibraryRow(runId: number, extractionId: number, actorId: number, now: string) {
  const id = state.nextLibraryId++;
  const library: SequencingLibrary = {
    library_id: id,
    library_code: labCode('LIB-', id, 4),
    extraction_id: extractionId,
    run_id: runId,
    created_at: now,
  };
  state.libraries.push(library);
  writeAudit(actorId, 'sequencing_libraries', id, 'insert', null, {
    ...library,
    created_at: jsonbTime(now),
  });
  return library;
}

// ---------------------------------------------------------------------------
// T23 helpers: analyses, CSV import, analytics and exports (backend services/analyses.service.js,
// taxa.service.js, analytics.service.js, exports.service.js and the analysis procedures)
// ---------------------------------------------------------------------------

const ANALYSIS_STATUSES = ['draft', 'imported', 'approved', 'rejected', 'superseded'];
const ANALYSIS_FIELDS = [
  'run_id',
  'marker_id',
  'pipeline_name',
  'pipeline_version',
  'reference_db',
  'reference_db_version',
  'parameters',
  'supersedes_analysis_id',
];
/** Most row errors listed in one import response; the total is always reported. */
const MAX_REPORTED_ERRORS = 100;
type GroupBy = 'year' | 'month' | 'site';
const GROUP_BYS: GroupBy[] = ['year', 'month', 'site'];
const RICHNESS_KEYS = ['project_id', 'site_id', 'group_by', 'from', 'to'];

/** Text order of the database (collation C.UTF-8: by code point, not by locale). */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const fromAfterTo = () =>
  fail(422, 'validation_error', 'must not be after to', [
    { field: 'from', message: 'must not be after to' },
  ]);

/** z.record(z.string(), z.unknown()) with the 10 000-character refine. */
function checkParameters(value: unknown): ApiErrorDetail[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [
      {
        field: 'parameters',
        message: `Invalid input: expected record, received ${typeName(value)}`,
      },
    ];
  }
  return JSON.stringify(value).length > 10000
    ? [{ field: 'parameters', message: 'must be 10 000 characters or less' }]
    : [];
}

/** Administrator, PI and analyst may read draft, imported and rejected analyses (CONTRACT 9); so may
 * a project owner, manager or contributor, in that project. */
const canSeeUnapproved = (user: User, projectIds: number[] = []) =>
  hasAnyRole(user, ['administrator', 'principal_investigator', 'analyst']) ||
  projectIds.some((id) => can(user, 'read_unapproved_detections', roleIn(id, user.user_id)));

/** An analysis is visible through any visible project of its run, and its status (above). */
function analysisVisible(user: User, analysis: AnalysisRunRow): boolean {
  if (
    !canSeeUnapproved(user, projectsOfRun(analysis.run_id) ?? []) &&
    !['approved', 'superseded'].includes(analysis.status)
  ) {
    return false;
  }
  if (isAdmin(user)) return true;
  const visible = visibleProjectIds(user);
  return (projectsOfRun(analysis.run_id) ?? []).some((id) => visible.includes(id));
}

/** analyses.service.js authorizeAnalysis: the analysis, or the shared 404 (403 for a viewer write). */
function authorizeAnalysis(
  user: User,
  analysisId: number,
  { write = false }: { write?: boolean } = {},
): AnalysisRunRow | MockResponse {
  const analysis = state.analyses.find((a) => a.analysis_id === analysisId);
  if (!analysis) return notFound('Analysis');
  const denied = anyProjectAccess(user, projectsOfRun(analysis.run_id) ?? [], {
    write,
    what: 'Analysis',
  });
  if (denied) return denied;
  if (
    !canSeeUnapproved(user, projectsOfRun(analysis.run_id) ?? []) &&
    !['approved', 'superseded'].includes(analysis.status)
  ) {
    return notFound('Analysis');
  }
  return analysis;
}

/** The row with the names its ids point to and, while rejected, the latest rejection (1.8). */
function analysisView(a: AnalysisRunRow): AnalysisRun {
  let rejection: AnalysisRejection | null = null;
  if (a.status === 'rejected') {
    const entry = state.audit
      .filter(
        (x) =>
          x.entity_type === 'analysis_runs' &&
          x.entity_id === a.analysis_id &&
          x.action === 'reject',
      )
      .sort(
        (x, y) => Date.parse(y.created_at) - Date.parse(x.created_at) || y.audit_id - x.audit_id,
      )[0];
    if (entry) {
      rejection = {
        reason: String(entry.details?.reason ?? ''),
        rejected_by: entry.actor_id,
        rejected_by_name: userName(entry.actor_id),
        rejected_at: new Date(entry.created_at).toISOString(),
      };
    }
  }
  return {
    ...a,
    parameters: { ...a.parameters },
    run_code: state.runs.find((r) => r.run_id === a.run_id)!.run_code,
    marker_name: mockMarkers.find((m) => m.marker_id === a.marker_id)!.marker_name,
    imported_by_name: userName(a.imported_by),
    approved_by_name: userName(a.approved_by),
    rejection,
  };
}

/** import_detections() refuses any analysis that is not a draft (asked before the file is read). */
function importBlocked(analysis: AnalysisRunRow): MockResponse | null {
  const id = analysis.analysis_id;
  if (analysis.status === 'imported' || analysis.status === 'approved') {
    return fail(409, 'conflict', `Analysis ${id} is already ${analysis.status}`, [
      { message: 'Detections can only be imported into a draft analysis.' },
    ]);
  }
  if (analysis.status !== 'draft') {
    return fail(
      409,
      'invalid_transition',
      `Analysis ${id} is ${analysis.status}; detections can only be imported into a draft analysis`,
      [],
    );
  }
  return null;
}

/**
 * analyses.service.js resolveRows: names to ids, plus the errors a format check cannot see: an
 * unknown taxon (never created, D16), an unknown library or one of another run, a repeated
 * library + taxon. Per row the taxon is checked before the library; a repeat only when both exist.
 */
function resolveImportRows(rows: DetectionCsvRow[], analysis: AnalysisRunRow) {
  const errors: CsvRowError[] = [];
  const resolved: (Omit<DetectionCsvRow, 'row' | 'scientific_name' | 'taxon_rank'> & {
    library_id: number;
    taxon_id: number;
  })[] = [];
  const firstRow = new Map<string, number>();
  for (const row of rows) {
    const before = errors.length;
    const taxon = mockTaxa.find(
      (t) => t.scientific_name === row.scientific_name && t.rank === row.taxon_rank,
    );
    if (!taxon) {
      errors.push({
        row: row.row,
        field: 'scientific_name',
        message: `no taxon "${row.scientific_name}" with rank ${row.taxon_rank} (taxa are never created by an import)`,
      });
    }
    const library = state.libraries.find((l) => l.library_code === row.library_code);
    if (!library) {
      errors.push({
        row: row.row,
        field: 'library_code',
        message: `library ${row.library_code} does not exist`,
      });
    } else if (library.run_id !== analysis.run_id) {
      errors.push({
        row: row.row,
        field: 'library_code',
        message: `library ${row.library_code} belongs to another sequencing run (analysis ${analysis.analysis_id} uses run ${analysis.run_id})`,
      });
    }
    if (errors.length === before) {
      const key = `${row.library_code}\u0000${taxon!.taxon_id}`;
      if (firstRow.has(key)) {
        errors.push({
          row: row.row,
          field: 'library_code',
          message: `library ${row.library_code} with this taxon already appears in row ${firstRow.get(key)}`,
        });
      } else {
        firstRow.set(key, row.row);
        resolved.push({
          library_code: row.library_code,
          library_id: library!.library_id,
          taxon_id: taxon!.taxon_id,
          read_count: row.read_count,
          confidence: row.confidence,
          qc_flag: row.qc_flag,
        });
      }
    }
  }
  return { resolved, errors };
}

/** An audit row a procedure writes itself (approve, reject): its own details, not a column diff. */
function pushAudit(
  actorId: number,
  entityType: string,
  entityId: number,
  action: AuditAction,
  details: Record<string, unknown>,
): void {
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

/** analytics.service.js scopeProjects: the project asked for (checked), else all the caller's. */
function scopeProjects(user: User, projectId: number | null): number[] | MockResponse {
  if (projectId !== null) {
    const denied = projectAccess(user, projectId);
    return denied ?? [projectId];
  }
  return visibleProjectIds(user);
}

/** Passing rows of approved analyses: the only rows analytics, detections and exports count. */
const passingAssignments = () =>
  state.assignments.filter(
    (a) =>
      a.qc_flag === 'pass' &&
      state.analyses.find((x) => x.analysis_id === a.analysis_id)?.status === 'approved',
  );

const librariesOfSample = (sampleId: number) => {
  const extractions = state.extractions
    .filter((x) => x.sample_id === sampleId)
    .map((x) => x.extraction_id);
  return state.libraries.filter((l) => extractions.includes(l.extraction_id));
};

/**
 * analytics.service.js queryRichness: one row per (group, site) that has samples in the scope.
 * observed_taxa = distinct SPECIES with an approved, passing detection; sample_count = all samples
 * of the group at the site (sampling effort), with or without a detection, in any status.
 */
function richnessRows({
  projectIds,
  siteId,
  groupBy,
  from,
  to,
}: {
  projectIds: number[];
  siteId: number | null;
  groupBy: GroupBy;
  from: number | null;
  to: number | null;
}): RichnessRow[] {
  const groupOf = (e: CollectionEvent) =>
    groupBy === 'site'
      ? state.sites.find((s) => s.site_id === e.site_id)!.name
      : new Date(e.collected_at).toISOString().slice(0, groupBy === 'year' ? 4 : 7);
  const species = new Set(mockTaxa.filter((t) => t.rank === 'species').map((t) => t.taxon_id));
  const passing = passingAssignments().filter((a) => species.has(a.taxon_id));
  const groups = new Map<
    string,
    { group: string; site_id: number; samples: Set<number>; taxa: Set<number> }
  >();
  for (const e of state.events) {
    const at = Date.parse(e.collected_at);
    if (
      !projectIds.includes(e.project_id) ||
      (siteId !== null && e.site_id !== siteId) ||
      (from !== null && at < from) ||
      (to !== null && at > to)
    ) {
      continue;
    }
    const samples = state.samples.filter((s) => s.event_id === e.event_id);
    if (samples.length === 0) continue;
    const group = groupOf(e);
    const key = `${group}\u0000${e.site_id}`;
    const row = groups.get(key) ?? {
      group,
      site_id: e.site_id,
      samples: new Set(),
      taxa: new Set(),
    };
    for (const s of samples) {
      row.samples.add(s.sample_id);
      const libraries = librariesOfSample(s.sample_id).map((l) => l.library_id);
      for (const a of passing) if (libraries.includes(a.library_id)) row.taxa.add(a.taxon_id);
    }
    groups.set(key, row);
  }
  return [...groups.values()]
    .sort((a, b) => compareText(a.group, b.group) || a.site_id - b.site_id)
    .map((g) => ({
      group: g.group,
      site_id: g.site_id,
      observed_taxa: g.taxa.size,
      sample_count: g.samples.size,
    }));
}

interface StoredExport {
  export_id: number;
  requested_by: number;
  project_id: number;
  export_type: ExportType;
  /** As stored: a `from`/`to` date is kept as the instant it means (start or end of the day). */
  filters: Record<string, unknown>;
  row_count: number;
  created_at: string;
}

const SAMPLE_STATUS_VALUES = [
  'collected',
  'stored',
  'extracted',
  'sequenced',
  'analyzed',
  'failed',
  'discarded',
];
const EXPORT_FILTERS: Record<ExportType, string[]> = {
  samples_csv: ['site_id', 'status', 'from', 'to'],
  detections_csv: ['site_id', 'taxon_id', 'from', 'to'],
  richness_csv: ['site_id', 'group_by', 'from', 'to'],
};

/** exports.routes.js: a discriminated union on export_type, each with its own strict filters. */
function checkExportBody(
  input: Record<string, unknown>,
):
  | { export_type: ExportType; project_id: number; filters: Record<string, unknown> }
  | ApiErrorDetail[] {
  const type = input.export_type;
  if (typeof type !== 'string' || !(type in EXPORT_FILTERS)) {
    const message =
      "Invalid discriminator value. Expected 'samples_csv' | 'detections_csv' | 'richness_csv'";
    return [{ field: 'export_type', message }];
  }
  const exportType = type as ExportType;
  const details: ApiErrorDetail[] = [...checkId(input.project_id, 'project_id')];
  const stored: Record<string, unknown> = {};
  if (input.filters !== undefined) {
    const filters = input.filters;
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      details.push({
        field: 'filters',
        message: `Invalid input: expected object, received ${typeName(filters)}`,
      });
    } else {
      const f = filters as Record<string, unknown>;
      const own: ApiErrorDetail[] = [];
      for (const key of EXPORT_FILTERS[exportType]) {
        const value = f[key];
        if (value === undefined) continue;
        const field = `filters.${key}`;
        if (key === 'site_id' || key === 'taxon_id') {
          own.push(...checkId(value, field));
          stored[key] = value;
        } else if (key === 'status') {
          own.push(...checkEnum(value, field, SAMPLE_STATUS_VALUES));
          stored[key] = value;
        } else if (key === 'group_by') {
          own.push(...checkEnum(value, field, GROUP_BYS));
          stored[key] = value;
        } else {
          const bound =
            typeof value === 'string' ? rangeOf(new URLSearchParams({ [key]: value })) : null;
          if (bound === null || Array.isArray(bound)) {
            own.push({ field, message: 'Invalid input' });
          } else {
            const at = key === 'from' ? bound.from! : bound.to!;
            stored[key] = /^\d{4}-\d{2}-\d{2}$/.test(value as string)
              ? new Date(at).toISOString()
              : value;
          }
        }
      }
      const extra = Object.keys(f).filter((k) => !EXPORT_FILTERS[exportType].includes(k));
      if (extra.length > 0) {
        own.push({
          field: 'filters',
          message: `Unrecognized key${extra.length > 1 ? 's' : ''}: ${extra.map((k) => `"${k}"`).join(', ')}`,
        });
      }
      const fieldIssues = own.filter((d) => d.field !== 'filters');
      if (
        fieldIssues.length === 0 &&
        stored.from !== undefined &&
        stored.to !== undefined &&
        Date.parse(stored.from as string) > Date.parse(stored.to as string)
      ) {
        own.push({ field: 'filters.from', message: 'must not be after to' });
      }
      details.push(...own);
    }
  }
  details.push(...unknownKeys(input, ['export_type', 'project_id', 'filters']));
  if (details.length) return details;
  return { export_type: exportType, project_id: input.project_id as number, filters: stored };
}

const EXPORT_COLUMNS: Record<ExportType, string[]> = {
  samples_csv: [
    'sample_id',
    'sample_code',
    'status',
    'sample_type',
    'event_id',
    'site_id',
    'site_name',
    'project_id',
    'project_title',
    'collected_at',
    'volume_ml',
    'depth_m',
    'storage_location',
  ],
  detections_csv: [
    'sample_code',
    'site_name',
    'collected_at',
    'scientific_name',
    'rank',
    'read_count',
    'confidence',
    'qc_flag',
    'analysis_id',
    'marker_name',
    'pipeline_name',
    'pipeline_version',
    'reference_db',
    'reference_db_version',
  ],
  richness_csv: ['group', 'site_id', 'observed_taxa', 'sample_count'],
};

/** exports.service.js: the data rows of an export, regenerated from its type, project and filters. */
function exportRows(
  type: ExportType,
  projectId: number,
  filters: Record<string, unknown>,
): unknown[][] {
  const from = filters.from === undefined ? null : Date.parse(filters.from as string);
  const to = filters.to === undefined ? null : Date.parse(filters.to as string);
  const siteId = (filters.site_id as number | undefined) ?? null;
  const inWindow = (iso: string) =>
    (from === null || Date.parse(iso) >= from) && (to === null || Date.parse(iso) <= to);
  const iso = (value: string) => new Date(value).toISOString();
  if (type === 'richness_csv') {
    return richnessRows({
      projectIds: [projectId],
      siteId,
      groupBy: (filters.group_by as GroupBy | undefined) ?? 'year',
      from,
      to,
    }).map((r) => [r.group, r.site_id, r.observed_taxa, r.sample_count]);
  }
  if (type === 'samples_csv') {
    return state.samples
      .filter((s) => {
        const e = eventById(s.event_id)!;
        return (
          e.project_id === projectId &&
          (siteId === null || e.site_id === siteId) &&
          inWindow(e.collected_at) &&
          (filters.status === undefined || s.status === filters.status)
        );
      })
      .sort((a, b) => a.sample_id - b.sample_id)
      .map((s) => {
        const e = eventById(s.event_id)!;
        return [
          s.sample_id,
          s.sample_code,
          s.status,
          mockSampleTypes.find((t) => t.sample_type_id === s.sample_type_id)!.type_name,
          e.event_id,
          e.site_id,
          state.sites.find((x) => x.site_id === e.site_id)!.name,
          e.project_id,
          state.projects.find((p) => p.project_id === e.project_id)!.title,
          iso(e.collected_at),
          s.volume_ml,
          s.depth_m,
          s.storage_location,
        ];
      });
  }
  const taxonId = (filters.taxon_id as number | undefined) ?? null;
  return detectionRows()
    .filter(
      (d) =>
        d.event.project_id === projectId &&
        (siteId === null || d.site.site_id === siteId) &&
        inWindow(d.event.collected_at) &&
        (taxonId === null || d.assignment.taxon_id === taxonId),
    )
    .sort((a, b) => a.assignment.assignment_id - b.assignment.assignment_id)
    .map(({ assignment, sample, event, site }) => {
      const analysis = state.analyses.find((a) => a.analysis_id === assignment.analysis_id)!;
      const taxon = mockTaxa.find((t) => t.taxon_id === assignment.taxon_id)!;
      return [
        sample.sample_code,
        site.name,
        iso(event.collected_at),
        taxon.scientific_name,
        taxon.rank,
        assignment.read_count,
        assignment.confidence,
        assignment.qc_flag,
        analysis.analysis_id,
        mockMarkers.find((m) => m.marker_id === analysis.marker_id)!.marker_name,
        analysis.pipeline_name,
        analysis.pipeline_version,
        analysis.reference_db,
        analysis.reference_db_version,
      ];
    });
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
 * authorize('edit_project') in the API's order: a project the user is not a member of gets 404,
 * a project viewer 403 (read-only), and a project role other than owner/manager 403 (the global
 * role does not matter). Calls `edit` with the stored (writable) project.
 */
function withProjectEdit(
  { user, params }: MockContext,
  edit: (project: Omit<Project, 'your_role'>) => MockResponse,
): MockResponse {
  const project = state.projects.find((p) => p.project_id === Number(params.id));
  if (!project) return notFound('Project');
  if (!isAdmin(user)) {
    const role = roleIn(project.project_id, user.user_id);
    if (role === null) return notFound('Project');
    if (role === 'viewer' || !can(user, 'edit_project', role)) {
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
    // Mirrors backend routes/auth.routes.js registerBody + auth.service.js register: only
    // full_name, email and password are required; the new account is a viewer, signed in at once.
    method: 'POST',
    path: '/auth/register',
    auth: false,
    handler: ({ body }) => {
      const req = (body ?? {}) as Record<string, unknown>;
      const optional = (value: unknown, field: string, max: number) =>
        value === undefined || value === null ? [] : checkText(value, field, max, false);
      const details = [
        ...checkText(req.full_name, 'full_name', 200, true),
        ...checkEmail(req.email),
        ...checkPassword(req.password),
        ...optional(req.organization, 'organization', 200),
        ...optional(req.job_title, 'job_title', 200),
        ...optional(req.phone, 'phone', 40),
      ];
      if (details.length) return fail(422, 'validation_error', details[0].message, details);
      const email = String(req.email).trim().toLowerCase();
      if (state.users.some((u) => u.email === email)) {
        return fail(409, 'email_taken', 'An account with this email already exists', [
          { field: 'email', message: 'already registered' },
        ]);
      }
      const created: User = {
        user_id: state.nextUserId++,
        full_name: String(req.full_name).trim(),
        email,
        roles: ['viewer'],
        active: true,
      };
      state.users.push(created);
      state.passwords.set(created.user_id, String(req.password));
      storeSession(created.user_id);
      writeAudit(created.user_id, 'users', created.user_id, 'login');
      return ok(created, undefined, 201);
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
    action: 'create_site',
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const fields = checkSiteBody(input, true);
      if (Array.isArray(fields)) return validationError(fields);
      const site_id = state.nextSiteId++; // used up even when the insert fails
      const site = { description: null, ...fields } as Omit<Site, 'site_id'>;
      const conflict = siteConflict(site, null);
      if (conflict) return conflict;
      const created: Site = { site_id, ...site, created_by: user.user_id };
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
    handler: ({ params, body, user }) => {
      // The creator may always correct their site; everyone else needs manage_sites.
      const existing = state.sites.find((s) => s.site_id === Number(params.id));
      if (
        !(existing && existing.created_by === user.user_id) &&
        !can(user, 'manage_sites', undefined, heldProjectRoles(user))
      ) {
        return fail(403, 'forbidden', 'You do not have permission to do this');
      }
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
    action: 'create_event_sample',
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
    action: 'create_event_sample',
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
        extractions: state.extractions
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
    action: 'change_sample_status',
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

  // Laboratory (T22) ----------------------------------------------------------------------------
  { method: 'GET', path: '/labs', handler: () => ok(mockLabs) },
  { method: 'GET', path: '/markers', handler: () => ok(mockMarkers) },
  {
    method: 'GET',
    path: '/extraction-batches',
    handler: ({ query }) => {
      const bad = checkIdString(query.get('lab_id'), 'lab_id');
      if (bad.length) return validationError(bad);
      const labId = num(query, 'lab_id');
      const rows = state.batches
        .filter((b) => labId === null || b.lab_id === labId)
        .sort((a, b) => a.batch_id - b.batch_id)
        .map(batchView);
      return paginate(rows, query, ['batch_id', 'extraction_date'], 'batch_id');
    },
  },
  {
    method: 'POST',
    path: '/extraction-batches',
    action: 'record_lab',
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const details = [...checkId(input.lab_id, 'lab_id')];
      if (typeof input.extraction_date !== 'string') {
        details.push({
          field: 'extraction_date',
          message: `Invalid input: expected string, received ${typeName(input.extraction_date)}`,
        });
      } else {
        const dateIssues = checkDate(input.extraction_date, 'extraction_date');
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        if (dateIssues.length) details.push(...dateIssues);
        else if (input.extraction_date < EARLIEST_BATCH_DATE || input.extraction_date > tomorrow) {
          details.push({
            field: 'extraction_date',
            message: 'must be between 2000-01-01 and tomorrow',
          });
        }
      }
      if (present(input.kit_name))
        details.push(...checkText(input.kit_name, 'kit_name', 200, true));
      if (present(input.notes)) details.push(...checkText(input.notes, 'notes', 2000, false));
      details.push(...unknownKeys(input, ['lab_id', 'extraction_date', 'kit_name', 'notes']));
      if (details.length) return validationError(details);

      const batch_id = state.nextBatchId++; // used up even when the insert fails
      if (!mockLabs.some((l) => l.lab_id === input.lab_id)) {
        return missingKey('lab_id', input.lab_id, 'laboratories');
      }
      const batch: StoredBatch = {
        batch_id,
        lab_id: input.lab_id as number,
        operator_id: user.user_id,
        extraction_date: input.extraction_date as string,
        kit_name: present(input.kit_name) ? (input.kit_name as string).trim() : null,
        notes: present(input.notes) ? (input.notes as string).trim() : null,
        created_at: new Date().toISOString(),
      };
      state.batches.push(batch);
      return ok(batchView(batch), undefined, 201);
    },
  },
  {
    method: 'GET',
    path: '/extractions',
    handler: ({ query, user }) => {
      const qc = query.get('qc_status');
      const bad = [
        ...checkIdString(query.get('sample_id'), 'sample_id'),
        ...checkIdString(query.get('batch_id'), 'batch_id'),
        ...(qc === null ? [] : checkEnum(qc, 'qc_status', QC_STATUSES)),
      ];
      if (bad.length) return validationError(bad);
      const sampleId = num(query, 'sample_id');
      const batchId = num(query, 'batch_id');
      if (sampleId !== null) {
        const projectId = projectOfSample(sampleId);
        if (projectId === null) return notFound('Sample');
        const denied = projectAccess(user, projectId, { what: 'Sample' });
        if (denied) return denied;
      }
      const visible = visibleProjectIds(user);
      const rows = state.extractions
        .filter(
          (x) =>
            visible.includes(projectOfSample(x.sample_id)!) &&
            (sampleId === null || x.sample_id === sampleId) &&
            (batchId === null || x.batch_id === batchId) &&
            (!qc || x.qc_status === qc),
        )
        .sort((a, b) => a.extraction_id - b.extraction_id)
        .map(extractionView);
      return paginate(rows, query, ['extraction_id', 'created_at'], 'extraction_id');
    },
  },
  {
    // services/extractions.service.js createExtraction: the attempt number is the sample's next
    // one; a failed or discarded sample cannot be extracted; a stored sample becomes extracted.
    method: 'POST',
    path: '/extractions',
    action: 'record_lab',
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const details = [
        ...checkId(input.sample_id, 'sample_id'),
        ...checkId(input.batch_id, 'batch_id'),
        ...(present(input.concentration_ng_ul)
          ? checkNumber(input.concentration_ng_ul, 'concentration_ng_ul', {
              min: 0,
              minMessage: 'must be 0 or more',
              max: 9999999.999,
            })
          : []),
        ...(present(input.purity_a260_280)
          ? checkNumber(input.purity_a260_280, 'purity_a260_280', {
              min: 0,
              minMessage: 'must be 0 or more',
              max: 999.99,
            })
          : []),
        ...unknownKeys(input, ['sample_id', 'batch_id', 'concentration_ng_ul', 'purity_a260_280']),
      ];
      if (details.length) return validationError(details);
      const sample = sampleById(input.sample_id as number);
      if (!sample) return notFound('Sample');
      const denied = projectAccess(user, eventById(sample.event_id)!.project_id, {
        write: true,
        what: 'Sample',
      });
      if (denied) return denied;
      if (sample.status === 'failed' || sample.status === 'discarded') {
        return fail(422, 'rule_violation', `Sample is ${sample.status}; it cannot be extracted`, [
          { field: 'sample_id', message: `sample is ${sample.status}` },
        ]);
      }
      const extraction_id = state.nextExtractionId++; // used up even when the insert fails
      if (!state.batches.some((b) => b.batch_id === input.batch_id)) {
        return missingKey('batch_id', input.batch_id, 'extraction_batches');
      }
      const now = new Date().toISOString();
      const extraction: StoredExtraction = {
        extraction_id,
        sample_id: sample.sample_id,
        batch_id: input.batch_id as number,
        attempt_number:
          Math.max(
            0,
            ...state.extractions
              .filter((x) => x.sample_id === sample.sample_id)
              .map((x) => x.attempt_number),
          ) + 1,
        concentration_ng_ul: present(input.concentration_ng_ul)
          ? round(input.concentration_ng_ul as number, 3)
          : null,
        purity_a260_280: present(input.purity_a260_280)
          ? round(input.purity_a260_280 as number, 2)
          : null,
        qc_status: 'pending',
        created_at: now,
      };
      state.extractions.push(extraction);
      writeAudit(user.user_id, 'dna_extractions', extraction_id, 'insert', null, {
        ...extraction,
        created_at: jsonbTime(now),
      });
      // trg_dna_extractions_sample_status: stored -> extracted, with a history row.
      if (sample.status === 'stored') {
        state.history.push({
          sample_id: sample.sample_id,
          old_status: 'stored',
          new_status: 'extracted',
          changed_at: now,
          changed_by: user.user_id,
          note: null,
        });
        writeAudit(
          user.user_id,
          'samples',
          sample.sample_id,
          'update',
          { status: 'stored' },
          {
            status: 'extracted',
          },
        );
        sample.status = 'extracted';
      }
      return ok(extractionView(extraction), undefined, 201);
    },
  },
  {
    // The QC verdict is final (pending -> pass | fail, trg_dna_extractions_qc_status);
    // measurements stay editable.
    method: 'PATCH',
    path: '/extractions/:id',
    action: 'record_lab',
    handler: ({ params, body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const fieldIssues = [
        ...(input.qc_status === undefined
          ? []
          : checkEnum(input.qc_status, 'qc_status', ['pass', 'fail'])),
        ...(input.concentration_ng_ul === undefined || input.concentration_ng_ul === null
          ? []
          : checkNumber(input.concentration_ng_ul, 'concentration_ng_ul', {
              min: 0,
              minMessage: 'must be 0 or more',
              max: 9999999.999,
            })),
        ...(input.purity_a260_280 === undefined || input.purity_a260_280 === null
          ? []
          : checkNumber(input.purity_a260_280, 'purity_a260_280', {
              min: 0,
              minMessage: 'must be 0 or more',
              max: 999.99,
            })),
      ];
      const keyIssues = unknownKeys(input, ['qc_status', 'concentration_ng_ul', 'purity_a260_280']);
      const empty =
        fieldIssues.length === 0 && Object.keys(input).length === 0
          ? [
              {
                field: 'root',
                message:
                  'at least one of qc_status, concentration_ng_ul, purity_a260_280 is required',
              },
            ]
          : [];
      const bad = [...checkIdString(params.id, 'id'), ...fieldIssues, ...keyIssues, ...empty];
      if (bad.length) return validationError(bad);
      const extraction = extractionById(Number(params.id));
      if (!extraction) return notFound('Extraction');
      const denied = projectAccess(user, projectOfSample(extraction.sample_id)!, {
        write: true,
        what: 'Extraction',
      });
      if (denied) return denied;
      const next = { ...extraction };
      if (input.qc_status !== undefined) next.qc_status = input.qc_status as QcStatus;
      if (input.concentration_ng_ul !== undefined) {
        next.concentration_ng_ul =
          input.concentration_ng_ul === null ? null : round(input.concentration_ng_ul as number, 3);
      }
      if (input.purity_a260_280 !== undefined) {
        next.purity_a260_280 =
          input.purity_a260_280 === null ? null : round(input.purity_a260_280 as number, 2);
      }
      if (next.qc_status !== extraction.qc_status && extraction.qc_status !== 'pending') {
        return fail(
          409,
          'invalid_transition',
          `Extraction ${extraction.extraction_id} cannot move from QC status ${extraction.qc_status} to ${next.qc_status}`,
          [
            {
              message:
                'Allowed: pending -> pass or fail. A QC verdict is final; record a new extraction attempt instead.',
            },
          ],
        );
      }
      writeAudit(
        user.user_id,
        'dna_extractions',
        extraction.extraction_id,
        'update',
        { ...extraction },
        {
          ...next,
        },
      );
      Object.assign(extraction, next);
      return ok(extractionView(extraction));
    },
  },
  {
    method: 'GET',
    path: '/qc-results',
    handler: ({ query, user }) => {
      const result = query.get('result');
      const bad = [
        ...checkIdString(query.get('sample_id'), 'sample_id'),
        ...checkIdString(query.get('analysis_id'), 'analysis_id'),
        ...(result === null ? [] : checkEnum(result, 'result', QC_RESULTS)),
      ];
      if (bad.length) return validationError(bad);
      const sampleId = num(query, 'sample_id');
      const analysisId = num(query, 'analysis_id');
      if (sampleId !== null) {
        const projectId = projectOfSample(sampleId);
        if (projectId === null) return notFound('Sample');
        const denied = projectAccess(user, projectId, { what: 'Sample' });
        if (denied) return denied;
      }
      if (analysisId !== null) {
        const analysis = state.analyses.find((a) => a.analysis_id === analysisId);
        if (!analysis) return notFound('Analysis');
        const denied = anyProjectAccess(user, projectsOfRun(analysis.run_id) ?? [], {
          what: 'Analysis',
        });
        if (denied) return denied;
      }
      const visible = visibleProjectIds(user);
      const seen = (q: StoredQcResult) => {
        if (isAdmin(user)) return true;
        if (q.sample_id !== null) return visible.includes(projectOfSample(q.sample_id)!);
        const analysis = state.analyses.find((a) => a.analysis_id === q.analysis_id)!;
        return (projectsOfRun(analysis.run_id) ?? []).some((id) => visible.includes(id));
      };
      const rows = state.qcResults
        .filter(
          (q) =>
            seen(q) &&
            (sampleId === null || q.sample_id === sampleId) &&
            (analysisId === null || q.analysis_id === analysisId) &&
            (!result || q.result === result),
        )
        // Newest first unless ?sort is given (recorded_at DESC, qc_id DESC).
        .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at) || b.qc_id - a.qc_id);
      if (query.get('sort')) rows.sort((a, b) => a.qc_id - b.qc_id);
      return paginate(rows.map(qcView), query, ['qc_id', 'recorded_at'], 'qc_id');
    },
  },
  {
    method: 'POST',
    path: '/qc-results',
    action: 'record_lab',
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const fieldIssues = [
        ...(present(input.sample_id) ? checkId(input.sample_id, 'sample_id') : []),
        ...(present(input.analysis_id) ? checkId(input.analysis_id, 'analysis_id') : []),
        ...checkEnum(input.qc_type, 'qc_type', QC_TYPES),
        ...checkEnum(input.result, 'result', QC_RESULTS),
        ...(present(input.metric_value) ? checkNumber(input.metric_value, 'metric_value') : []),
        ...(present(input.notes) ? checkText(input.notes, 'notes', 2000, false) : []),
      ];
      const keyIssues = unknownKeys(input, [
        'sample_id',
        'analysis_id',
        'qc_type',
        'result',
        'metric_value',
        'notes',
      ]);
      // The refine runs only on a body whose fields are valid.
      const parent =
        fieldIssues.length === 0 && !present(input.sample_id) && !present(input.analysis_id)
          ? [{ field: 'sample_id', message: 'sample_id or analysis_id is required' }]
          : [];
      const bad = [...fieldIssues, ...keyIssues, ...parent];
      if (bad.length) return validationError(bad);
      if (present(input.sample_id)) {
        const projectId = projectOfSample(input.sample_id as number);
        if (projectId === null) return notFound('Sample');
        const denied = projectAccess(user, projectId, { write: true, what: 'Sample' });
        if (denied) return denied;
      }
      if (present(input.analysis_id)) {
        const analysis = state.analyses.find((a) => a.analysis_id === input.analysis_id);
        if (!analysis) return notFound('Analysis');
        const denied = anyProjectAccess(user, projectsOfRun(analysis.run_id) ?? [], {
          write: true,
          what: 'Analysis',
        });
        if (denied) return denied;
      }
      const now = new Date().toISOString();
      const row: StoredQcResult = {
        qc_id: state.nextQcId++,
        sample_id: present(input.sample_id) ? (input.sample_id as number) : null,
        analysis_id: present(input.analysis_id) ? (input.analysis_id as number) : null,
        qc_type: input.qc_type as QcType,
        result: input.result as QcResult,
        metric_value: present(input.metric_value) ? (input.metric_value as number) : null,
        notes: present(input.notes) ? (input.notes as string).trim() : null,
        recorded_by: user.user_id,
        recorded_at: now,
      };
      state.qcResults.push(row);
      writeAudit(user.user_id, 'quality_control_results', row.qc_id, 'insert', null, {
        ...row,
        recorded_at: jsonbTime(now),
      });
      return ok(qcView(row), undefined, 201);
    },
  },
  {
    method: 'GET',
    path: '/sequencing-runs',
    handler: ({ query, user }) => {
      const status = query.get('status');
      const bad = [
        ...checkIdString(query.get('lab_id'), 'lab_id'),
        ...(status === null ? [] : checkEnum(status, 'status', RUN_STATUSES)),
      ];
      if (bad.length) return validationError(bad);
      const labId = num(query, 'lab_id');
      const visible = visibleProjectIds(user);
      const rows = state.runs
        .filter(
          (r) =>
            (isAdmin(user) || (projectsOfRun(r.run_id) ?? []).some((id) => visible.includes(id))) &&
            (labId === null || r.lab_id === labId) &&
            (!status || r.status === status),
        )
        .sort((a, b) => a.run_id - b.run_id);
      return paginate(rows, query, ['run_id', 'created_at'], 'run_id');
    },
  },
  {
    method: 'GET',
    path: '/sequencing-runs/:id',
    handler: ({ params, user }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const projects = projectsOfRun(Number(params.id));
      if (projects === null) return notFound('Sequencing run');
      const denied = anyProjectAccess(user, projects, { what: 'Sequencing run' });
      if (denied) return denied;
      return ok(
        runDetail(
          state.runs.find((r) => r.run_id === Number(params.id))!,
          user,
        ),
      );
    },
  },
  {
    // services/sequencing.service.js createRun + create_sequencing_run(): every extraction must be
    // writable for the caller, then each (in id order) must have passed QC and be free; the run
    // gets RUN-<id> and one LIB-<id> per extraction. All or nothing.
    method: 'POST',
    path: '/sequencing-runs',
    action: 'record_lab',
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const details = [
        ...checkId(input.lab_id, 'lab_id'),
        ...checkText(input.platform, 'platform', 100, true),
        ...(typeof input.run_date === 'string'
          ? checkDate(input.run_date, 'run_date')
          : [
              {
                field: 'run_date',
                message: `Invalid input: expected string, received ${typeName(input.run_date)}`,
              },
            ]),
      ];
      const ids = input.extraction_ids;
      if (!Array.isArray(ids)) {
        details.push({
          field: 'extraction_ids',
          message: `Invalid input: expected array, received ${typeName(ids)}`,
        });
      } else {
        const itemIssues = ids.flatMap((id, i) => checkId(id, `extraction_ids[${i}]`));
        details.push(...itemIssues);
        if (ids.length === 0) {
          details.push({ field: 'extraction_ids', message: 'at least one extraction is required' });
        } else if (ids.length > MAX_EXTRACTIONS_PER_RUN) {
          details.push({
            field: 'extraction_ids',
            message: `Too big: expected array to have <=${MAX_EXTRACTIONS_PER_RUN} items`,
          });
        } else if (itemIssues.length === 0 && new Set(ids).size !== ids.length) {
          details.push({ field: 'extraction_ids', message: 'extraction_ids must be distinct' });
        }
      }
      details.push(...unknownKeys(input, ['lab_id', 'platform', 'run_date', 'extraction_ids']));
      if (details.length) return validationError(details);

      const extractionIds = ids as number[];
      for (const id of extractionIds) {
        const extraction = extractionById(id);
        if (!extraction) return notFound('Extraction');
        const denied = projectAccess(user, projectOfSample(extraction.sample_id)!, {
          write: true,
          what: 'Extraction',
        });
        if (denied) return denied;
      }
      const ordered = [...extractionIds].sort((a, b) => a - b);
      for (const id of ordered) {
        const problem = bookingProblem(extractionById(id)!);
        if (problem) return problem;
      }
      const run_id = state.nextRunId++; // used up even when the insert fails
      if (!mockLabs.some((l) => l.lab_id === input.lab_id)) {
        return missingKey('lab_id', input.lab_id, 'laboratories');
      }
      const now = new Date().toISOString();
      const run: SequencingRun = {
        run_id,
        run_code: labCode('RUN-', run_id, 3),
        lab_id: input.lab_id as number,
        platform: (input.platform as string).trim(),
        run_date: input.run_date as string,
        status: 'planned',
        created_at: now,
      };
      state.runs.push(run);
      writeAudit(user.user_id, 'sequencing_runs', run_id, 'insert', null, {
        ...run,
        created_at: jsonbTime(now),
      });
      for (const id of ordered) addLibraryRow(run_id, id, user.user_id, now);
      return ok(runDetail(run, user), undefined, 201);
    },
  },
  {
    // assign_extraction_to_run(): only a planned run takes new libraries.
    method: 'POST',
    path: '/sequencing-runs/:id/libraries',
    action: 'record_lab',
    handler: ({ params, body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const bad = [
        ...checkIdString(params.id, 'id'),
        ...checkId(input.extraction_id, 'extraction_id'),
        ...unknownKeys(input, ['extraction_id']),
      ];
      if (bad.length) return validationError(bad);
      const runId = Number(params.id);
      const projects = projectsOfRun(runId);
      if (projects === null) return notFound('Sequencing run');
      const extraction = extractionById(input.extraction_id as number);
      if (!extraction) return notFound('Extraction');
      const denied = projectAccess(user, projectOfSample(extraction.sample_id)!, {
        write: true,
        what: 'Extraction',
      });
      if (denied) return denied;
      // A run with libraries only in other projects is not the caller's to extend.
      if (projects.length > 0) {
        const hidden = anyProjectAccess(user, projects, { write: true, what: 'Sequencing run' });
        if (hidden) return hidden;
      }
      const run = state.runs.find((r) => r.run_id === runId)!;
      if (run.status !== 'planned') {
        return fail(
          409,
          'invalid_transition',
          `Run ${run.run_code} is ${run.status}; libraries can only be added to a planned run`,
          [],
        );
      }
      const problem = bookingProblem(extraction);
      if (problem) return problem;
      const library = addLibraryRow(
        runId,
        extraction.extraction_id,
        user.user_id,
        new Date().toISOString(),
      );
      return ok(library, undefined, 201);
    },
  },
  {
    method: 'PATCH',
    path: '/sequencing-runs/:id',
    action: 'record_lab',
    handler: ({ params, body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const bad = [
        ...checkIdString(params.id, 'id'),
        ...checkEnum(input.status, 'status', RUN_STATUSES),
        ...unknownKeys(input, ['status']),
      ];
      if (bad.length) return validationError(bad);
      const runId = Number(params.id);
      const projects = projectsOfRun(runId);
      if (projects === null) return notFound('Sequencing run');
      const denied = anyProjectAccess(user, projects, { write: true, what: 'Sequencing run' });
      if (denied) return denied;
      const run = state.runs.find((r) => r.run_id === runId)!;
      const next = input.status as RunStatus;
      if (run.status === next) {
        return fail(409, 'invalid_transition', `Run is already ${run.status}`, []);
      }
      if (!RUN_TRANSITIONS[run.status].includes(next)) {
        return fail(
          409,
          'invalid_transition',
          `Run ${run.run_code} cannot move from ${run.status} to ${next}`,
          [
            {
              message:
                'Allowed: planned -> running, running -> completed or failed, planned -> failed.',
            },
          ],
        );
      }
      writeAudit(
        user.user_id,
        'sequencing_runs',
        run.run_id,
        'update',
        { status: run.status },
        {
          status: next,
        },
      );
      run.status = next;
      return ok({ ...run });
    },
  },

  // Analyses and detections (T23, CONTRACT 1.8) -----------------------------------------------------
  {
    method: 'GET',
    path: '/analyses',
    handler: ({ query, user }) => {
      const status = query.get('status');
      const bad = [
        ...checkIdString(query.get('run_id'), 'run_id'),
        ...(status === null ? [] : checkEnum(status, 'status', ANALYSIS_STATUSES)),
        ...checkIdString(query.get('marker_id'), 'marker_id'),
      ];
      if (bad.length) return validationError(bad);
      const runId = num(query, 'run_id');
      const markerId = num(query, 'marker_id');
      const rows = state.analyses
        .filter(
          (a) =>
            analysisVisible(user, a) &&
            (runId === null || a.run_id === runId) &&
            (!status || a.status === status) &&
            (markerId === null || a.marker_id === markerId),
        )
        .sort((a, b) => a.analysis_id - b.analysis_id)
        .map(analysisView);
      return paginate(rows, query, ['analysis_id', 'created_at'], 'analysis_id');
    },
  },
  {
    method: 'GET',
    path: '/analyses/:id',
    handler: ({ params, user }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const found = authorizeAnalysis(user, Number(params.id));
      if ('status' in found && 'body' in found) return found;
      const analysis = found as AnalysisRunRow;
      const counts = { pass: 0, warn: 0, fail: 0 };
      for (const a of state.assignments) {
        if (a.analysis_id === analysis.analysis_id) counts[a.qc_flag] += 1;
      }
      return ok({ ...analysisView(analysis), assignment_counts: counts });
    },
  },
  {
    method: 'POST',
    path: '/analyses',
    action: 'create_analysis',
    handler: ({ body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const details = [
        ...checkId(input.run_id, 'run_id'),
        ...checkId(input.marker_id, 'marker_id'),
        ...checkText(input.pipeline_name, 'pipeline_name', 200, true),
        ...checkText(input.pipeline_version, 'pipeline_version', 100, true),
        ...checkText(input.reference_db, 'reference_db', 200, true),
        ...(present(input.reference_db_version)
          ? checkText(input.reference_db_version, 'reference_db_version', 100, true)
          : []),
        ...(input.parameters === undefined ? [] : checkParameters(input.parameters)),
        ...(present(input.supersedes_analysis_id)
          ? checkId(input.supersedes_analysis_id, 'supersedes_analysis_id')
          : []),
        ...unknownKeys(input, ANALYSIS_FIELDS),
      ];
      if (details.length) return validationError(details);
      const runId = input.run_id as number;
      const projectIds = projectsOfRun(runId);
      if (projectIds === null) return notFound('Sequencing run');
      const denied = anyProjectAccess(user, projectIds, { write: true, what: 'Sequencing run' });
      if (denied) return denied;
      const supersedes = present(input.supersedes_analysis_id)
        ? (input.supersedes_analysis_id as number)
        : null;
      if (supersedes !== null) {
        const found = authorizeAnalysis(user, supersedes);
        if ('status' in found && 'body' in found) return found;
        const replaced = found as AnalysisRunRow;
        if (replaced.status !== 'approved') {
          return fail(
            422,
            'rule_violation',
            `Analysis ${replaced.analysis_id} is ${replaced.status}; only an approved analysis can be corrected`,
            [{ field: 'supersedes_analysis_id', message: 'must name an approved analysis' }],
          );
        }
      }
      // The insert uses up an id even when the database refuses it (unique, then foreign key).
      const id = state.nextAnalysisId++;
      if (
        supersedes !== null &&
        state.analyses.some((a) => a.supersedes_analysis_id === supersedes)
      ) {
        const detail = `Key (supersedes_analysis_id)=(${supersedes}) already exists.`;
        return fail(409, 'duplicate', detail, [{ message: detail }]);
      }
      if (!mockMarkers.some((m) => m.marker_id === input.marker_id)) {
        return missingKey('marker_id', input.marker_id, 'dna_markers');
      }
      const now = new Date().toISOString();
      const analysis: AnalysisRunRow = {
        analysis_id: id,
        run_id: runId,
        marker_id: input.marker_id as number,
        pipeline_name: (input.pipeline_name as string).trim(),
        pipeline_version: (input.pipeline_version as string).trim(),
        reference_db: (input.reference_db as string).trim(),
        reference_db_version: present(input.reference_db_version)
          ? (input.reference_db_version as string).trim()
          : null,
        parameters: (input.parameters as Record<string, unknown> | undefined) ?? {},
        status: 'draft',
        imported_by: null,
        approved_by: null,
        approved_at: null,
        created_at: now,
        supersedes_analysis_id: supersedes,
      };
      state.analyses.push(analysis);
      writeAudit(user.user_id, 'analysis_runs', id, 'insert', null, {
        ...analysis,
        created_at: jsonbTime(now),
      });
      return ok(analysisView(analysis), undefined, 201);
    },
  },
  {
    // Multipart: analysis_id and file (CONTRACT 12); ?dry_run=true validates only.
    method: 'POST',
    path: '/analyses/import',
    action: 'create_analysis',
    handler: ({ query, user, upload }) => {
      const file = upload?.file ?? null;
      if (file && file.size > MAX_IMPORT_BYTES) {
        return fail(413, 'payload_too_large', 'The upload is too large', [
          { field: 'file', message: 'maximum size is 10 MB' },
        ]);
      }
      if (!file) {
        return fail(422, 'validation_error', 'The upload was rejected', [
          { field: 'file', message: 'is required' },
        ]);
      }
      const fields = upload!.fields;
      const dryRun = query.get('dry_run');
      const details = [
        ...(dryRun === null ? [] : checkEnum(dryRun, 'dry_run', ['true', 'false'])),
        ...(fields.analysis_id === undefined
          ? [
              {
                field: 'analysis_id',
                message: 'Invalid input: expected string, received undefined',
              },
            ]
          : checkIdString(fields.analysis_id, 'analysis_id')),
        ...unknownKeys(fields, ['analysis_id']),
      ];
      if (details.length) return validationError(details);
      const found = authorizeAnalysis(user, Number(fields.analysis_id), { write: true });
      if ('status' in found && 'body' in found) return found;
      const analysis = found as AnalysisRunRow;
      const blocked = importBlocked(analysis);
      if (blocked) return blocked;

      const fileProblem = (message: string) =>
        fail(422, 'validation_error', 'The file is not a valid CSV', [{ field: 'file', message }]);
      if (file.text === null) return fileProblem('must be UTF-8 text');
      const checked = checkDetectionCsv(file.text);
      if (checked.fileProblem) return fileProblem(checked.fileProblem);
      const lookups = resolveImportRows(checked.rows, analysis);
      const errors = [...checked.errors, ...lookups.errors].sort((a, b) => a.row - b.row);
      const listed = errors.slice(0, MAX_REPORTED_ERRORS);
      if (dryRun === 'true') {
        return ok(
          { valid_rows: lookups.resolved.length, errors: listed },
          errors.length > listed.length
            ? { total_errors: errors.length, errors_shown: listed.length }
            : undefined,
        );
      }
      if (errors.length > 0) {
        const capped = errors.length > listed.length ? ` (first ${listed.length} shown)` : '';
        return fail(
          422,
          'validation_error',
          `The file has ${errors.length} error${errors.length === 1 ? '' : 's'}${capped}`,
          listed,
        );
      }
      // import_detections(): every row, then the status change the trigger audits. Its INSERT ...
      // SELECT has no ORDER BY; the plan PostgreSQL picks for it (a hash join on the libraries)
      // numbers the rows library by library, the rows of one library last-in-file first. Copied so
      // ties (same sample and date) list in the same order; the API does not promise this order.
      const insertOrder = lookups.resolved
        .map((row, position) => ({ row, position }))
        .sort((a, b) => a.row.library_id - b.row.library_id || b.position - a.position)
        .map(({ row }) => row);
      for (const row of insertOrder) {
        state.assignments.push({
          assignment_id: state.nextAssignmentId++,
          analysis_id: analysis.analysis_id,
          library_id: row.library_id,
          taxon_id: row.taxon_id,
          read_count: row.read_count,
          confidence: row.confidence,
          qc_flag: row.qc_flag,
        });
      }
      const before = { status: analysis.status, imported_by: analysis.imported_by };
      analysis.status = 'imported';
      analysis.imported_by = user.user_id;
      writeAudit(user.user_id, 'analysis_runs', analysis.analysis_id, 'update', before, {
        status: analysis.status,
        imported_by: analysis.imported_by,
      });
      return ok({ inserted: lookups.resolved.length }, undefined, 201);
    },
  },
  {
    method: 'POST',
    path: '/analyses/:id/approve',
    action: 'decide_analysis',
    handler: ({ params, user }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const found = authorizeAnalysis(user, Number(params.id), { write: true });
      if ('status' in found && 'body' in found) return found;
      const analysis = found as AnalysisRunRow;
      const id = analysis.analysis_id;
      // approve_analysis(): status, importer, detections, the run a correction replaces.
      if (analysis.status === 'approved') {
        return fail(409, 'conflict', `Analysis ${id} is already approved`, [
          { message: 'An analysis can be approved only once.' },
        ]);
      }
      if (analysis.status !== 'imported') {
        return fail(
          409,
          'invalid_transition',
          `Analysis ${id} is ${analysis.status}; only an imported analysis can be approved`,
          [],
        );
      }
      if (analysis.imported_by === null) {
        return fail(
          422,
          'rule_violation',
          `Analysis ${id} has no recorded importer and cannot be approved`,
          [],
        );
      }
      if (analysis.imported_by === user.user_id) {
        return fail(422, 'rule_violation', 'The importer may not approve their own analysis', [
          { message: `User ${user.user_id} imported analysis ${id}.` },
        ]);
      }
      const count = state.assignments.filter((a) => a.analysis_id === id).length;
      if (count === 0) {
        return fail(
          422,
          'rule_violation',
          `Analysis ${id} has no detections and cannot be approved`,
          [],
        );
      }
      const old =
        analysis.supersedes_analysis_id === null
          ? null
          : state.analyses.find((a) => a.analysis_id === analysis.supersedes_analysis_id)!;
      if (old && old.status !== 'approved') {
        return fail(
          409,
          'invalid_transition',
          `Analysis ${old.analysis_id} cannot be superseded: it is ${old.status}, not approved`,
          [
            {
              message: `Analysis ${id} is a correction of analysis ${old.analysis_id}, which must still be approved.`,
            },
          ],
        );
      }
      const now = new Date().toISOString();
      const before = {
        status: analysis.status,
        approved_at: analysis.approved_at,
        approved_by: analysis.approved_by,
      };
      analysis.status = 'approved';
      analysis.approved_by = user.user_id;
      analysis.approved_at = now;
      writeAudit(user.user_id, 'analysis_runs', id, 'update', before, {
        status: 'approved',
        approved_at: jsonbTime(now),
        approved_by: user.user_id,
      });
      pushAudit(user.user_id, 'analysis_runs', id, 'approve', {
        from_status: 'imported',
        to_status: 'approved',
        detection_count: count,
        importer_id: analysis.imported_by,
        ...(old ? { supersedes_analysis_id: old.analysis_id } : {}),
      });
      if (old) {
        old.status = 'superseded';
        writeAudit(
          user.user_id,
          'analysis_runs',
          old.analysis_id,
          'update',
          {
            status: 'approved',
          },
          { status: 'superseded' },
        );
        pushAudit(user.user_id, 'analysis_runs', old.analysis_id, 'update', {
          from_status: 'approved',
          to_status: 'superseded',
          superseded_by: id,
        });
      }
      return ok(analysisView(analysis));
    },
  },
  {
    method: 'POST',
    path: '/analyses/:id/reject',
    action: 'decide_analysis',
    handler: ({ params, body, user }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const bad = [
        ...checkIdString(params.id, 'id'),
        ...checkText(input.reason, 'reason', 1000, true),
        ...unknownKeys(input, ['reason']),
      ];
      if (bad.length) return validationError(bad);
      const found = authorizeAnalysis(user, Number(params.id), { write: true });
      if ('status' in found && 'body' in found) return found;
      const analysis = found as AnalysisRunRow;
      const id = analysis.analysis_id;
      if (analysis.status === 'rejected') {
        return fail(409, 'conflict', `Analysis ${id} is already rejected`, [
          { message: 'An analysis can be rejected only once.' },
        ]);
      }
      if (analysis.status !== 'draft' && analysis.status !== 'imported') {
        return fail(
          409,
          'invalid_transition',
          `Analysis ${id} is ${analysis.status}; only a draft or imported analysis can be rejected`,
          [{ message: 'An approved result is corrected by a new run, never rejected.' }],
        );
      }
      const from = analysis.status;
      analysis.status = 'rejected';
      writeAudit(
        user.user_id,
        'analysis_runs',
        id,
        'update',
        { status: from },
        {
          status: 'rejected',
        },
      );
      pushAudit(user.user_id, 'analysis_runs', id, 'reject', {
        from_status: from,
        to_status: 'rejected',
        reason: (input.reason as string).trim(),
      });
      return ok(analysisView(analysis));
    },
  },

  // Taxa -----------------------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/taxa',
    handler: ({ query }) => {
      const q = query.get('q');
      const rank = query.get('rank');
      const bad = [
        ...(q === null ? [] : checkText(q, 'q', 200, true)),
        ...(rank === null ? [] : checkEnum(rank, 'rank', TAXON_RANKS)),
        ...checkIdString(query.get('parent_taxon_id'), 'parent_taxon_id'),
      ];
      if (bad.length) return validationError(bad);
      // ILIKE 'q%' OR ILIKE '% q%': the name, or a word in it, starts with q (taxa.service.js).
      const needle = q?.trim().toLowerCase() ?? null;
      const parentId = num(query, 'parent_taxon_id');
      const rows = mockTaxa
        .filter((t) => {
          const name = t.scientific_name.toLowerCase();
          return (
            (needle === null || name.startsWith(needle) || name.includes(` ${needle}`)) &&
            (!rank || t.rank === rank) &&
            (parentId === null || t.parent_taxon_id === parentId)
          );
        })
        .sort(
          (a, b) => compareText(a.scientific_name, b.scientific_name) || a.taxon_id - b.taxon_id,
        );
      return paginate(rows, query, ['scientific_name', 'taxon_id'], 'taxon_id');
    },
  },
  {
    method: 'GET',
    path: '/taxa/:id',
    handler: ({ params }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const taxon = mockTaxa.find((t) => t.taxon_id === Number(params.id));
      if (!taxon) return notFound('Taxon');
      const lineage = [];
      for (let t: Taxon | undefined = taxon; t;) {
        lineage.unshift({ taxon_id: t.taxon_id, scientific_name: t.scientific_name, rank: t.rank });
        const parentId: number | null = t.parent_taxon_id;
        t = parentId === null ? undefined : mockTaxa.find((x) => x.taxon_id === parentId);
      }
      return ok({ ...taxon, lineage });
    },
  },
  {
    method: 'GET',
    path: '/taxa/:id/detections',
    handler: ({ user, params, query }) => {
      const range = rangeOf(query);
      const bad = [
        ...checkIdString(params.id, 'id'),
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...checkIdString(query.get('site_id'), 'site_id'),
        ...(Array.isArray(range) ? range : []),
      ];
      if (bad.length) return validationError(bad);
      const { from, to } = range as { from: number | null; to: number | null };
      if (from !== null && to !== null && from > to) return fromAfterTo();
      const sort = query.get('sort')?.trim();
      if (sort && sort.replace(/^-/, '') !== 'collected_at') {
        return fail(422, 'validation_error', `Invalid sort field: ${sort.replace(/^-/, '')}`, [
          { field: 'sort', message: 'Must be one of: collected_at' },
        ]);
      }
      const taxonId = Number(params.id);
      if (!mockTaxa.some((t) => t.taxon_id === taxonId)) return notFound('Taxon');
      const projectId = num(query, 'project_id');
      if (projectId !== null) {
        const denied = projectAccess(user, projectId);
        if (denied) return denied;
      }
      const siteId = num(query, 'site_id');
      const ascending = sort === 'collected_at';
      const rows = approvedDetections(user)
        .filter(
          (d) =>
            d.assignment.taxon_id === taxonId &&
            (projectId === null || d.event.project_id === projectId) &&
            (siteId === null || d.site.site_id === siteId) &&
            (from === null || Date.parse(d.event.collected_at) >= from) &&
            (to === null || Date.parse(d.event.collected_at) <= to),
        )
        .sort(
          (a, b) =>
            (Date.parse(a.event.collected_at) - Date.parse(b.event.collected_at)) *
              (ascending ? 1 : -1) || a.assignment.assignment_id - b.assignment.assignment_id,
        )
        .map(({ assignment, sample, event, site }) => ({
          site_id: site.site_id,
          site_name: site.name,
          sample_id: sample.sample_id,
          sample_code: sample.sample_code,
          collected_at: event.collected_at,
          analysis_id: assignment.analysis_id,
          read_count: assignment.read_count,
          confidence: assignment.confidence,
          qc_flag: assignment.qc_flag,
        }));
      const pageQuery = new URLSearchParams(query);
      pageQuery.delete('sort');
      return paginate(rows, pageQuery);
    },
  },

  // Analytics, dashboard, exports, audit ----------------------------------------------------------------
  {
    method: 'GET',
    path: '/analytics/richness',
    handler: ({ user, query }) => {
      const groupBy = query.get('group_by') ?? 'year';
      const range = rangeOf(query);
      const bad = [
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...checkIdString(query.get('site_id'), 'site_id'),
        ...checkEnum(groupBy, 'group_by', GROUP_BYS),
        ...(Array.isArray(range) ? range : []),
      ];
      // An unknown key does not stop the from/to refine; a field issue does.
      const extra = unknownKeys(Object.fromEntries(query), RICHNESS_KEYS);
      if (bad.length === 0 && !Array.isArray(range)) {
        if (range.from !== null && range.to !== null && range.from > range.to) {
          extra.push({ field: 'from', message: 'must not be after to' });
        }
      }
      if (bad.length || extra.length) return validationError([...bad, ...extra]);
      const { from, to } = range as { from: number | null; to: number | null };
      const scope = scopeProjects(user, num(query, 'project_id'));
      if (!Array.isArray(scope)) return scope;
      const rows = richnessRows({
        projectIds: scope,
        siteId: num(query, 'site_id'),
        groupBy: groupBy as GroupBy,
        from,
        to,
      });
      return ok(rows, { caveat: EDNA_CAVEAT });
    },
  },
  {
    method: 'GET',
    path: '/analytics/detection-frequency',
    handler: ({ user, query }) => {
      const taxonRaw = query.get('taxon_id');
      const bad = [
        ...(taxonRaw === null
          ? [{ field: 'taxon_id', message: 'Invalid input: expected string, received undefined' }]
          : checkIdString(taxonRaw, 'taxon_id')),
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...unknownKeys(Object.fromEntries(query), ['taxon_id', 'project_id']),
      ];
      if (bad.length) return validationError(bad);
      const taxonId = Number(taxonRaw);
      if (!mockTaxa.some((t) => t.taxon_id === taxonId)) return notFound('Taxon');
      const scope = scopeProjects(user, num(query, 'project_id'));
      if (!Array.isArray(scope)) return scope;
      const samples = state.samples.filter((s) =>
        scope.includes(eventById(s.event_id)!.project_id),
      );
      const approvedRuns = new Set(
        state.analyses.filter((a) => a.status === 'approved').map((a) => a.run_id),
      );
      const passing = passingAssignments().filter((a) => a.taxon_id === taxonId);
      const bySite = new Map<number, { detections: number; samples_total: number }>();
      for (const s of samples) {
        const siteId = eventById(s.event_id)!.site_id;
        const row = bySite.get(siteId) ?? { detections: 0, samples_total: 0 };
        const libraries = librariesOfSample(s.sample_id);
        if (libraries.some((l) => approvedRuns.has(l.run_id))) row.samples_total += 1;
        if (passing.some((a) => libraries.some((l) => l.library_id === a.library_id))) {
          row.detections += 1;
        }
        bySite.set(siteId, row);
      }
      const rows = [...bySite.entries()]
        .sort(([a], [b]) => a - b)
        .map(([site_id, row]) => ({ site_id, ...row }));
      return ok(rows, { caveat: EDNA_CAVEAT });
    },
  },
  {
    method: 'GET',
    path: '/dashboard/summary',
    handler: ({ user, query }) => {
      const bad = [
        ...checkIdString(query.get('project_id'), 'project_id'),
        ...unknownKeys(Object.fromEntries(query), ['project_id']),
      ];
      if (bad.length) return validationError(bad);
      const projectId = num(query, 'project_id');
      const scope = scopeProjects(user, projectId);
      if (!Array.isArray(scope)) return scope;
      const everything = isAdmin(user) && projectId === null;
      const events = state.events.filter((e) => scope.includes(e.project_id));
      return ok({
        projects: scope.length,
        sites: everything ? state.sites.length : new Set(scope.flatMap((id) => siteIdsOf(id))).size,
        samples: state.samples.filter((s) => events.some((e) => e.event_id === s.event_id)).length,
        approved_detections: approvedDetections(user).filter((d) =>
          scope.includes(d.event.project_id),
        ).length,
        recent_activity: auditFor(user, projectId).slice(0, 5),
      });
    },
  },
  {
    method: 'POST',
    path: '/exports',
    handler: ({ user, body }) => {
      const input = (body ?? {}) as Record<string, unknown>;
      const checked = checkExportBody(input);
      if (Array.isArray(checked)) return validationError(checked);
      const denied = projectAccess(user, checked.project_id);
      if (denied) return denied;
      const rowCount = exportRows(checked.export_type, checked.project_id, checked.filters).length;
      const id = state.nextExportId++;
      const now = new Date().toISOString();
      const record: StoredExport = {
        export_id: id,
        requested_by: user.user_id,
        project_id: checked.project_id,
        export_type: checked.export_type,
        filters: checked.filters,
        row_count: rowCount,
        created_at: now,
      };
      state.exports.push(record);
      writeAudit(user.user_id, 'data_exports', id, 'insert', null, {
        ...record,
        created_at: jsonbTime(now),
      });
      return ok({ export_id: id, row_count: rowCount }, undefined, 201);
    },
  },
  {
    // A CSV file, not JSON: the body is the text, the headers carry the name, count and caveat.
    method: 'GET',
    path: '/exports/:id/download',
    handler: ({ params, user }) => {
      const bad = checkIdString(params.id, 'id');
      if (bad.length) return validationError(bad);
      const record = state.exports.find(
        (x) => x.export_id === Number(params.id) && x.requested_by === user.user_id,
      );
      if (!record) return notFound('Export');
      const denied = projectAccess(user, record.project_id, { what: 'Export' });
      if (denied) return denied;
      const rows = exportRows(record.export_type, record.project_id, record.filters);
      const text = [csvLine(EXPORT_COLUMNS[record.export_type]), ...rows.map(csvLine)].join('');
      return {
        status: 200,
        body: text,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="ebiotrack-${record.export_type}-${record.export_id}.csv"`,
          'X-Row-Count': String(rows.length),
          'X-Caveat': EDNA_CAVEAT,
        },
      };
    },
  },
  {
    method: 'GET',
    path: '/audit',
    action: 'read_audit_log',
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
  // requireAction: a global role, or a granting project role in some project (the handler then
  // checks the actual project).
  if (route.action && user && !can(user, route.action, undefined, heldProjectRoles(user))) {
    return fail(403, 'forbidden', 'You do not have permission to do this');
  }
  const context = {
    params,
    query: new URLSearchParams(search),
    body: copyBody(body),
    user: user as User,
    upload: await readUpload(body),
  };
  activeAction = route.action;
  try {
    return await route.handler(context);
  } finally {
    activeAction = undefined;
  }
}
