# eBioTrack API Reference

> **Owner:** D (Docs & Demo) · T42 · Contract v1.9  
> This reference is drafted from `planning/CONTRACT.md` §§8–12. Route-level verification and runnable curl examples remain part of finalization.

## Conventions

- Base path: `/api`; JSON fields use `snake_case`.
- Authenticated endpoints use the session cookie established by login. Send JSON with `Content-Type: application/json`; successful JSON responses use `{ "data": ... }`. List responses may include `meta` for pagination.
- List endpoints are paginated and filterable as specified below. Timestamps are UTC ISO-8601.
- The minimum global role is shown; project membership and project role can further restrict access. Unauthorized or inaccessible project-scoped resources may be hidden as `404`.
- Errors use `{ "error": { "code": "...", "message": "..." } }`. Validation errors use `422`; missing/inaccessible resources `404`; conflicts or invalid state transitions `409`; unauthenticated `401`; insufficient permission `403`. Oversized CSV uploads return `413 payload_too_large`.
- Login throttling: after 5 failed sign-ins for the same client IP and email within 15 minutes, login returns `429 too_many_attempts` with `Retry-After` in whole seconds. A successful login resets the count. These are current in-memory implementation values and reset on restart.
- Analytics and exports include only approved analyses and `pass` detections. Responses include the caveat: “Detection does not indicate abundance; non-detection does not indicate absence.”

## Endpoints

“Any” means an authenticated user; project scope and visibility still apply.

### Authentication and users

| Method | Path | Minimum role | Request | Success |
|---|---|---|---|---|
| POST | `/auth/login` | Public | `{ email, password }` | User/session |
| POST | `/auth/logout` | Any | — | `204` |
| GET | `/auth/me` | Any | — | Current user |
| GET | `/users` | Administrator | `?active&role` | Users |
| POST | `/users` | Administrator | `{ full_name, email, password, role_ids[] }` | User |
| PATCH | `/users/:id` | Administrator | `{ active?, full_name?, role_ids? }` | User |
| GET | `/roles` | Any | — | Roles |

### Projects and access

| Method | Path | Minimum role | Request | Success |
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

| Method | Path | Minimum role | Request | Success |
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

| Method | Path | Minimum role | Request | Success |
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

QC verdict changes are final (409 on attempted change). Run visibility follows the library's project. Batch, QC, extraction and library responses include related names/codes as defined in contract §10.

### Analysis, taxonomy, analytics and exports

| Method | Path | Minimum role | Request | Success |
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

Analysis rows include run/marker/person names and rejection details where applicable. Correction runs use `supersedes_analysis_id`; approved results are not edited in place.

## Detection CSV import

UTF-8 CSV, maximum 10 MB, header required. Exact columns (any order): `library_code`, `scientific_name`, `taxon_rank`, `read_count`, `confidence`, `qc_flag`. Missing, repeated or extra columns are errors. BOM, CRLF and quoted fields are accepted. Values: non-negative integer read count; confidence 0–1; lowercase `pass|warn|fail`; rank from the contract enum. Library must belong to the analysis run; each library/taxon pair must be unique in the file. Import is all-or-nothing. Errors are `{ row, field, message }` (header is row 1), capped at 100 with `meta.total_errors`. Oversize upload returns 413.

## Examples

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

## Verification status

This is the contract-based draft. Route-by-route comparison and execution of examples against the running API are still required for final T42 acceptance after T20–T23.
