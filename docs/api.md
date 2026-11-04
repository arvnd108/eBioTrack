# eBioTrack API Reference

> **T42 · Contract v1.9 · Draft**
>
> This reference summarizes the API contract in `planning/CONTRACT.md` §§8–12. It is a contract-based guide, not yet a runtime-verified specification. Endpoint details, examples, and implementation behavior must be checked against the API before T42 is accepted.

## Quick start

1. Start the API locally and use the configured development credentials.
2. Log in to establish the session cookie (see [Login](#login)).
3. Send that cookie with subsequent requests.
4. For protected routes, access also depends on project membership and project role—not only the global role listed below.

Base URL: `http://localhost:3000/api` (replace the host/port for your environment).

## Shared conventions

- JSON request and response fields use `snake_case`. Send JSON with `Content-Type: application/json`.
- Successful JSON responses use a `data` envelope. List responses may include `meta` for pagination or import diagnostics. Logout and delete operations may return `204 No Content`.
- Timestamps are UTC ISO-8601. List routes support the filters shown in the endpoint tables; pagination details should be confirmed against the running API.
- “Any” means an authenticated user. Project visibility and membership still apply. Some inaccessible project-scoped resources may be returned as `404` to avoid revealing their existence.
- The minimum global role is shown; project-specific authorization can impose additional restrictions.

### Error responses

The documented error shape is:

```json
{ "error": { "code": "validation_error", "message": "..." } }
```

| Status | Meaning |
|---|---|
| `400` | Malformed request |
| `401` | Not authenticated |
| `403` | Authenticated but not permitted |
| `404` | Missing or inaccessible resource |
| `409` | Conflict or invalid state transition |
| `413` | Upload too large |
| `422` | Validation failure |
| `429` | Rate limit exceeded |

Login throttling is documented as 5 failed attempts for the same client IP and email within 15 minutes, followed by `429 too_many_attempts` and a `Retry-After` header. A successful login resets the count. The current contract describes this as in-memory state, so it resets on restart. Verify these details against the implementation.

Analytics and exports include only approved analyses and `pass` detections, with the caveat: “Detection does not indicate abundance; non-detection does not indicate absence.”

## Endpoint reference

The request and success columns are concise summaries, not complete JSON Schemas. Optional fields are marked with `?`.

### Authentication and users

| Method | Path | Minimum global role | Request / query | Success |
|---|---|---|---|---|
| POST | `/auth/login` | Public | `{ email, password }` | User/session |
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
| POST | `/projects` | Principal investigator | `{ title, objectives?, start_date? }` | Project |
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
| POST | `/analyses/:id/approve` | Principal investigator | — | Approved analysis |
| POST | `/analyses/:id/reject` | Principal investigator | `{ reason }` | Rejected analysis |
| GET | `/taxa` | Any | `?q&rank&parent_taxon_id` | Taxa |
| GET | `/taxa/:id` | Any | — | Taxon with lineage |
| GET | `/taxa/:id/detections` | Any | `?project_id&site_id&from&to` | Approved, passing detections |
| GET | `/analytics/richness` | Any | `?project_id&site_id&group_by=year\|month\|site&from&to` | Richness rows |
| GET | `/analytics/detection-frequency` | Any | `?taxon_id&project_id` | Detection frequency |
| GET | `/dashboard/summary` | Any | `?project_id` | Counts and recent activity |
| POST | `/exports` | Any | `{ export_type, project_id, filters? }` | `{ export_id, row_count }` |
| GET | `/exports/:id/download` | Requester | — | CSV download |

Analysis rows include run/marker/person names and rejection details where applicable. Corrections use `supersedes_analysis_id`; approved results are not edited in place.

## Detection CSV import

- Upload UTF-8 CSV, maximum 10 MB, with a header.
- Required columns, in any order: `library_code`, `scientific_name`, `taxon_rank`, `read_count`, `confidence`, `qc_flag`. Missing, repeated, or extra columns are errors.
- BOM, CRLF, and quoted fields are accepted.
- Values: non-negative integer read count; confidence from 0 to 1; lowercase `pass|warn|fail`; rank from the contract enum.
- Each library must belong to the analysis run; each library/taxon pair must be unique in the file.
- Import is all-or-nothing. Errors use `{ row, field, message }` (header is row 1), are capped at 100, and include `meta.total_errors`. Oversize uploads return `413`.

## Examples

Examples below assume a local API at port 3000 and a development account configured by the project. Replace IDs and credentials with valid values. These examples are illustrative until executed against the current implementation.

### Login

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"principal_investigator@ebiotrack.test","password":"YOUR_PASSWORD"}' \
  http://localhost:3000/api/auth/login
```

### Read current user

```bash
curl -b cookies.txt http://localhost:3000/api/auth/me
```

### List sites for a project

```bash
curl -b cookies.txt 'http://localhost:3000/api/sites?project_id=1'
```

### Create an event

```bash
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"project_id":1,"site_id":1,"collected_at":"2026-03-12T09:30:00Z","notes":"Clear water","measurements":[{"parameter":"ph","value":7.4,"unit":"pH"}],"samples":[{"sample_type_id":1,"volume_ml":1000,"depth_m":0.5,"storage_location":"Freezer A"}]}' \
  http://localhost:3000/api/events
```

### Create a lab extraction batch

```bash
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"lab_id":1,"extraction_date":"2026-03-12","kit_name":"Example kit"}' \
  http://localhost:3000/api/extraction-batches
```

### Download an export

```bash
curl -b cookies.txt -o detections.csv \
  http://localhost:3000/api/exports/1/download
```

## Acceptance checklist

Before marking T42 complete:

- [ ] Compare every documented method/path, role, request field, and response with the actual route/controller implementation.
- [ ] Confirm status codes, error shapes, authorization behavior, pagination/filter semantics, and CSV validation against the implementation.
- [ ] Run the examples against a running API with valid fixtures; update them to match observed behavior.
- [ ] Add representative success and failure response bodies, plus field-level request/response schemas where needed.
- [ ] Record the test command/environment and verification result here.

**Current status:** contract-based draft; route-by-route comparison and live example execution are not yet recorded. Do not treat the examples or implementation-specific notes as runtime-verified until the checklist is completed.
