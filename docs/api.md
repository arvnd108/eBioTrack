# eBioTrack API Reference

> **T42 · Contract v1.9 · Verified against the running API**
>
> This reference follows `planning/CONTRACT.md` §§8–12 (v2.0). Every endpoint, role, status code, error shape and example was run against the real backend on a freshly reset and seeded database; the verification record is at the end.

## Quick start

1. Start the API locally (`cd backend && npm run db:reset && npm run dev`) and use the seeded development accounts: `<role>@ebiotrack.test` for `administrator`, `principal_investigator`, `field_researcher`, `lab_technician`, `analyst` and `viewer`, all with the development password `ebiotrack-dev-2026`. These accounts exist only in the seed; never use them outside a development database.
2. Log in to establish the session cookie (see [Login](#login)).
3. Send that cookie with subsequent requests.
4. For protected routes, access also depends on project membership and project role—not only the global role listed below.

Base URL: `http://localhost:4000/api` (the default `PORT` is 4000; replace the host/port for your environment). Requests that change data from a browser must come from an origin in `ALLOWED_ORIGINS`; `curl` sends no `Origin` header and is accepted.

## Shared conventions

- JSON request and response fields use `snake_case`. Send JSON with `Content-Type: application/json`.
- Successful JSON responses use a `data` envelope. Paginated lists add `meta: { page, limit, total }`. Logout and delete operations return `204 No Content` with no body.
- Timestamps are UTC ISO-8601. List routes support the filters shown in the endpoint tables.
- **Pagination:** `?page=1&limit=25` (default 25). A limit above 100 is silently capped at 100 (the `meta.limit` returned shows the value used); `limit=0` or a non-integer is `422`. Paginated: users, audit, sites, events, samples, extractions, QC results, extraction batches, sequencing runs, analyses, taxa and taxon detections. Not paginated (short reference lists): roles, regions, sample types, labs and markers. Analytics, dashboard and exports return their own shapes.
- **Invalid ids** such as `/samples/abc` return `422 validation_error`, not `400`.
- “Any” means an authenticated user. Project visibility and membership still apply. Some inaccessible project-scoped resources may be returned as `404` to avoid revealing their existence.
- The minimum global role is shown. A **project role** can grant the same action inside a project the caller belongs to: `owner` and `manager` may do everything a project allows (edit, members, sites, approve or reject analyses); `contributor` may also record events, samples, lab work and analyses; `viewer` is read-only. An action is allowed when either the global role or the project role allows it. Not a member of the project: `404`; member without enough rights: `403`.

### Error responses

Every error has this shape; `details` is present for validation, upload and duplicate errors:

```json
{ "error": { "code": "validation_error", "message": "Invalid input: expected string, received undefined",
             "details": [{ "field": "collected_at", "message": "Invalid input: expected string, received undefined" }] } }
```

Observed codes: `unauthenticated` (401), `invalid_credentials` (401), `forbidden` (403), `not_found` (404), `invalid_transition` (409, an illegal sample or analysis status change), `duplicate` (409, a unique key already exists), `validation_error` (422), `payload_too_large` (413) and `too_many_attempts` (429).

| Status | Meaning |
|---|---|
| `400` | Malformed request (for example unparsable JSON) |
| `401` | Not authenticated |
| `403` | Authenticated but not permitted |
| `404` | Missing or inaccessible resource |
| `409` | Conflict or invalid state transition |
| `413` | Upload too large |
| `422` | Validation failure |
| `429` | Rate limit exceeded |

Login throttling is documented as 5 failed attempts for the same client IP and email within 15 minutes, followed by `429 too_many_attempts` and a `Retry-After` header (900 seconds in the observed run, on the sixth attempt). A successful login resets the count. The state is held in memory, so it resets when the server restarts.

Analytics and exports include only approved analyses and `pass` detections, with the caveat: “Detection does not indicate abundance; non-detection does not indicate absence.”

## Endpoint reference

The request and success columns are concise summaries, not complete JSON Schemas. Optional fields are marked with `?`.

### Authentication and users

| Method | Path | Minimum global role | Request / query | Success |
|---|---|---|---|---|
| POST | `/auth/login` | Public | `{ email, password }` | User/session |
| POST | `/auth/register` | Public | `{ full_name, email, password, organization?, job_title?, phone? }` | User/session (`201`; new accounts get the global `viewer` role and are signed in; `409 email_taken` if the email exists; `422` for a missing name, bad email or password shorter than 8 characters) |
| POST | `/auth/logout` | Any | — | `204` |
| GET | `/auth/me` | Any | — | Current user |
| GET | `/users` | Administrator | `?active&role` | Users |
| POST | `/users` | Administrator | `{ full_name, email, password, role_ids[] }` | User |
| PATCH | `/users/:id` | Administrator | `{ active?, full_name?, role_ids? }` | User |
| GET | `/roles` | Any | — | Roles |

### Projects and access

| Method | Path | Minimum global role | Request / query | Success |
|---|---|---|---|---|
| GET | `/projects` | Any | `?status` | Accessible projects |
| POST | `/projects` | Any (signed in) | `{ title, objectives?, start_date? }` | Project |
| GET | `/projects/:id` | Project member | — | Project, members, sites |
| PATCH | `/projects/:id` | Project owner/manager | `{ title?, objectives?, status?, end_date? }` | Project |
| POST | `/projects/:id/members` | Project owner/manager | `{ user_id, project_role }` | Member |
| DELETE | `/projects/:id/members/:userId` | Project owner/manager | — | `204` |
| POST | `/projects/:id/sites` | Project owner/manager | `{ site_id }` | `201` |
| DELETE | `/projects/:id/sites/:siteId` | Project owner/manager | — | `204` |
| GET | `/audit` | Administrator / PI | `?entity_type&entity_id&actor_id&from&to` | Audit entries |

### Field and samples

| Method | Path | Minimum global role | Request / query | Success |
|---|---|---|---|---|
| GET | `/regions` | Any | — | Regions |
| GET | `/sites` | Any | `?project_id&region_id&habitat_type` | Sites |
| POST | `/sites` | Field researcher | `{ region_id, name, latitude, longitude, habitat_type, description? }` | Site |
| GET | `/sites/:id` | Any | — | Site |
| PATCH | `/sites/:id` | Field researcher | Site fields | Site |
| GET | `/events` | Any | `?project_id&site_id&from&to` | Events |
| POST | `/events` | Field researcher | `{ project_id, site_id, collected_at, notes?, measurements?, samples? }` | Event with samples/measurements; one transaction |
| GET | `/events/:id` | Any | — | Event, samples, measurements |
| GET | `/sample-types` | Any | — | Sample types |
| GET | `/samples` | Any | `?project_id&site_id&event_id&status&q` | Samples |
| POST | `/samples` | Field researcher | `{ event_id, sample_type_id, volume_ml?, depth_m?, storage_location? }` | Sample |
| GET | `/samples/:id` | Any | — | Sample with event, site, extractions, status history |
| PATCH | `/samples/:id/status` | Field researcher / lab technician | `{ new_status, note? }` | Updated sample; note saved in history |

Event objects include `collector_name`; sample status-history entries include `changed_by_name` and `note`.

### Laboratory and sequencing

| Method | Path | Minimum global role | Request / query | Success |
|---|---|---|---|---|
| GET | `/labs` | Any | — | Laboratories |
| GET | `/markers` | Any | — | DNA markers |
| GET | `/extraction-batches` | Any | `?lab_id` | Batches |
| POST | `/extraction-batches` | Lab technician | `{ lab_id, extraction_date, kit_name?, notes? }` | Batch |
| GET | `/extractions` | Any | `?sample_id&batch_id&qc_status` | Extractions |
| POST | `/extractions` | Lab technician | `{ sample_id, batch_id, concentration_ng_ul?, purity_a260_280? }` | Extraction; attempt assigned |
| PATCH | `/extractions/:id` | Lab technician | `{ qc_status?, concentration_ng_ul?, purity_a260_280? }` | Extraction |
| POST | `/qc-results` | Lab technician | `{ sample_id?, analysis_id?, qc_type, result, metric_value?, notes? }` | QC result |
| GET | `/qc-results` | Any | `?sample_id&analysis_id&result` | QC results |
| GET | `/sequencing-runs` | Any | `?lab_id&status` | Runs |
| POST | `/sequencing-runs` | Lab technician | `{ lab_id, platform, run_date, extraction_ids[] }` | Run with libraries; all-or-nothing |
| GET | `/sequencing-runs/:id` | Any | — | Run with libraries/source samples |
| POST | `/sequencing-runs/:id/libraries` | Lab technician | `{ extraction_id }` | Library |
| PATCH | `/sequencing-runs/:id` | Lab technician | `{ status }` | Run |

QC verdict changes are final (attempted changes return `409`). Run visibility follows the library's project. Batch, QC, extraction, and library responses include related names/codes as defined in contract §10.

### Analysis, taxonomy, analytics, and exports

| Method | Path | Minimum global role | Request / query | Success |
|---|---|---|---|---|
| GET | `/analyses` | Any | `?run_id&status&marker_id` | Analyses |
| POST | `/analyses` | Analyst | `{ run_id, marker_id, pipeline_name, pipeline_version, reference_db, reference_db_version?, parameters?, supersedes_analysis_id? }` | Draft analysis |
| GET | `/analyses/:id` | Any | — | Analysis and pass/warn/fail counts |
| POST | `/analyses/import` | Analyst | Multipart `analysis_id`, `file`; optional `?dry_run=true` | Validation result or inserted count |
| POST | `/analyses/:id/approve` | Principal investigator, or project owner/manager | — | Approved analysis |
| POST | `/analyses/:id/reject` | Principal investigator, or project owner/manager | `{ reason }` | Rejected analysis |
| GET | `/taxa` | Any | `?q&rank&parent_taxon_id` | Taxa |
| GET | `/taxa/:id` | Any | — | Taxon with lineage |
| GET | `/taxa/:id/detections` | Any | `?project_id&site_id&from&to` | Approved, passing detections |
| GET | `/analytics/richness` | Any | `?project_id&site_id&group_by=year\|month\|site&from&to` | Richness rows |
| GET | `/analytics/detection-frequency` | Any | `?taxon_id&project_id` | Detection frequency |
| GET | `/dashboard/summary` | Any | `?project_id` | Counts and recent activity |
| POST | `/exports` | Any | `{ export_type, project_id, filters? }` | `{ export_id, row_count }` |
| GET | `/exports/:id/download` | Requester | — | CSV download |

Analysis rows include run/marker/person names and rejection details where applicable. Corrections use `supersedes_analysis_id`; approved results are not edited in place.

## Response fields added in contract 1.6 to 1.9

These names were added so pages need no extra lookups; all were observed in live responses.

| Resource | Fields |
|---|---|
| Event (`/events`, `/events/:id`) | `collector_name` |
| Sample (`/samples/:id`) `status_history[]` | `changed_by_name`, `note` |
| Extraction (`/extractions`) | `sample_code`, `project_id`, `active_run_id`, `active_run_code` (the planned or running run the extraction is booked on, else `null`) |
| QC result (`/qc-results`) | `sample_code`, `recorded_by_name` |
| Extraction batch (`/extraction-batches`) | `operator_name` |
| Analysis (`/analyses`, `/analyses/:id`) | `run_code`, `marker_name`, `imported_by_name`, `approved_by_name`, `rejection` (`null` unless rejected), and on `/analyses/:id` `assignment_counts` `{ pass, warn, fail }` |
| Audit entry (`/audit`, `/dashboard/summary` `recent_activity`) | `actor_name` |

## Detection CSV import

- Upload UTF-8 CSV, maximum 10 MB, with a header.
- Required columns, in any order: `library_code`, `scientific_name`, `taxon_rank`, `read_count`, `confidence`, `qc_flag`. Missing, repeated, or extra columns are errors.
- BOM, CRLF, and quoted fields are accepted.
- Values: non-negative integer read count; confidence from 0 to 1; lowercase `pass|warn|fail`; rank from the contract enum.
- Each library must belong to the analysis run; each library/taxon pair must be unique in the file.
- Import is all-or-nothing. Errors use `{ row, field, message }` (header is row 1) inside `error.details`, are capped at 100, and include `meta.total_errors`. A rejected file is `422`; an oversize upload is `413 payload_too_large`.
- `POST /analyses/import` takes `multipart/form-data` with `analysis_id` and `file`. With `?dry_run=true` it validates and returns `{ "data": { "valid_rows": 14, "errors": [] } }` without writing; without it, success is `{ "data": { "inserted": 14 } }`. The analysis must be a `draft` (a second import returns `409`).

## Examples

Every example below was run against a freshly seeded database; the output is what the API returned (long bodies shortened with `…`). The cookie jar `cookies.txt` is per role, so log in as the role the step needs.

### Login and current user

```bash
curl -s -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"field_researcher@ebiotrack.test","password":"ebiotrack-dev-2026"}' \
  http://localhost:4000/api/auth/login
curl -s -b cookies.txt http://localhost:4000/api/auth/me
```

```json
{"data":{"user_id":3,"full_name":"Farah Field","email":"field_researcher@ebiotrack.test","roles":["field_researcher"],"active":true}}
```

A wrong password is `401 invalid_credentials`; the sixth wrong attempt within 15 minutes is `429 too_many_attempts` with `Retry-After: 900`.

### List sites for a project

```bash
curl -s -b cookies.txt 'http://localhost:4000/api/sites?project_id=1&limit=2'
```

```json
{"data":[{"site_id":1,"region_id":2,"name":"Dakpathar Barrage","latitude":30.505,"longitude":77.795,"habitat_type":"river","description":"Upper reaches near Yamuna barrage"},{"site_id":2,"…":"…"}],"meta":{"page":1,"limit":2,"total":3}}
```

### Create an event with a sample and a measurement (one transaction)

```bash
curl -s -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"project_id":1,"site_id":1,"collected_at":"2026-03-12T09:30:00Z","notes":"Clear water","measurements":[{"parameter":"ph","value":7.4,"unit":"pH"}],"samples":[{"sample_type_id":1,"volume_ml":1000,"depth_m":0.5,"storage_location":"Freezer A"}]}' \
  http://localhost:4000/api/events
```

```json
201 {"data":{"event_id":1000,"project_id":1,"site_id":1,"collector_id":3,"collector_name":"Farah Field","collected_at":"2026-03-12T09:30:00.000Z","notes":"Clear water","samples":[{"sample_id":1000,"sample_code":"EB-20260312-1000-001","status":"collected","…":"…"}],"measurements":[{"measurement_id":1000,"parameter":"ph","…":"…"}],"…":"…"}}
```

Failures: omitting `collected_at` gives `422 validation_error` with `details[0].field = "collected_at"`; the same request as a `viewer` gives `403 forbidden`; without a cookie, `401 unauthenticated`.

### Change a sample status

```bash
curl -s -b cookies.txt -X PATCH -H 'Content-Type: application/json' \
  -d '{"new_status":"analyzed"}' http://localhost:4000/api/samples/17/status
```

```json
409 {"error":{"code":"invalid_transition","message":"Invalid sample status transition: failed -> analyzed"}}
```

### Create a lab extraction batch (as `lab_technician`)

```bash
curl -s -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"lab_id":1,"extraction_date":"2026-03-12","kit_name":"Example kit"}' \
  http://localhost:4000/api/extraction-batches
```

```json
201 {"data":{"batch_id":1000,"lab_id":1,"operator_id":4,"operator_name":"Lakshmi Lab","extraction_date":"2026-03-12","kit_name":"Example kit","notes":null,"created_at":"…"}}
```

### Import detections (as `analyst`), then approve (as `principal_investigator`)

```bash
curl -s -b cookies.txt -F analysis_id=4 -F file=@tests/fixtures/detections_valid.csv \
  'http://localhost:4000/api/analyses/import?dry_run=true'      # {"data":{"valid_rows":14,"errors":[]}}
curl -s -b cookies.txt -F analysis_id=4 -F file=@tests/fixtures/detections_valid.csv \
  http://localhost:4000/api/analyses/import                      # {"data":{"inserted":14}}
curl -s -b cookies.txt -F analysis_id=4 -F file=@tests/fixtures/detections_invalid_row.csv \
  http://localhost:4000/api/analyses/import
```

The last call leaves the analysis unchanged and returns `422`:

```json
{"error":{"code":"validation_error","message":"The file has 1 error","details":[{"row":8,"field":"library_code","message":"library LIB-0009 belongs to another sequencing run (analysis 4 uses run 1)"}]}}
```

Approving a draft is `409 invalid_transition`; the analyst approving is `403 forbidden`; rejecting without a `reason` is `422`. A principal investigator approves an `imported` analysis with `POST /api/analyses/4/approve`.

### Create an export and download it

```bash
curl -s -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"export_type":"samples_csv","project_id":1}' http://localhost:4000/api/exports
curl -s -b cookies.txt -o samples.csv http://localhost:4000/api/exports/1000/download
```

```json
201 {"data":{"export_id":1000,"row_count":14}}
```

The download is `200 text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="ebiotrack-samples_csv-1000.csv"`. An unknown export id is `404 not_found`.

## Verification record

Verified on 2026-11-05 against `main` (contract v1.9) with PostgreSQL 16, a database reset and seeded with `npm run db:reset`, and the server started with `npm run dev` on port 4000.

- Every `GET` route in the tables above was called as `administrator`; the listed paginated and unpaginated behaviour, the contract 1.6 to 1.9 fields and the 404 for an unknown export were observed.
- All six seeded roles were logged in. The write examples above were run as the roles stated; the permission failures shown (`403`, `401`) were observed with a `viewer`, an `analyst` and an unauthenticated request.
- Error shape and codes, the 422 for invalid ids and limits, the limit cap of 100, the import dry run, the all-or-nothing rejection, the 10 MB limit (`413`) and the login throttle (`429`, `Retry-After: 900`) were each triggered once.
- The remaining write routes were also called once and behaved as documented: `PATCH /sites/:id`, `PATCH /projects/:id`, member and site assignment and removal (`201`, `204`), `PATCH /extractions/:id`, `PATCH /users/:id` (`active: false`), and `PATCH /sequencing-runs/:id` (`409 invalid_transition` for a run that is already completed). A `viewer` adding a project member is `403`.
