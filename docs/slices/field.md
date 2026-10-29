# Field & Samples

> **Owner:** D (Docs & Demo)
>
> **Related task:** T15-D, GitHub issue [#24](https://github.com/arvnd108/eBioTrack/issues/24)

This slice records where samples are collected, when collection events happen, and the basic details of each sample. The views below give API routes and pages a consistent read-only shape without repeating joins and aggregation logic.

## Views

### `v_sample_registry`

**Purpose:** one row per sample, including its collection details.

| Column | Meaning |
|---|---|
| `sample_id` | Unique database ID for the sample. |
| `sample_code` | Human-readable, unique sample code. |
| `status` | Current sample status: `collected`, `stored`, `extracted`, `sequenced`, `analyzed`, `failed`, or `discarded`. |
| `sample_type` | Sample type name, such as water, soil, sediment, or air. |
| `event_id` | ID of the collection event that produced the sample. |
| `site_id` | ID of the sampling site. |
| `site_name` | Name of the sampling site. |
| `project_id` | ID of the project associated with the collection event. |
| `project_title` | Project title. |
| `collected_at` | Collection date and time (`timestamptz`, stored in UTC). |
| `volume_ml` | Sample volume in millilitres; may be NULL if not recorded. |
| `depth_m` | Collection depth in metres; may be NULL if not recorded. |
| `storage_location` | Where the sample is stored; may be NULL if not recorded. |

**What the view hides:** it joins `samples` to `sample_types`, `collection_events`, `sampling_sites`, and `projects`. A consumer can display the sample and its related names without writing those joins again.

**Who uses it:** sample registry pages, sample API routes, and reporting/export code. It includes samples in every status, including failed samples; it does not silently filter them out.

**Expected fixture count:** 17 rows, one per seeded sample.

Example:

```sql
SELECT sample_id, sample_code, status, sample_type, site_name, project_title
FROM v_sample_registry
ORDER BY sample_id;
```

### `v_site_sample_summary`

**Purpose:** one row per sampling site, with collection activity and sample counts.

| Column | Meaning |
|---|---|
| `site_id` | Unique database ID for the site. |
| `site_name` | Sampling site name. |
| `region_id` | ID of the region containing the site. |
| `region_name` | Region name. |
| `habitat_type` | Site habitat, such as river or estuary. |
| `event_count` | Number of distinct collection events at the site. |
| `total_samples` | Total number of samples collected at the site. |
| `collected_count` | Samples currently in `collected` status. |
| `stored_count` | Samples currently in `stored` status. |
| `extracted_count` | Samples currently in `extracted` status. |
| `sequenced_count` | Samples currently in `sequenced` status. |
| `analyzed_count` | Samples currently in `analyzed` status. |
| `failed_count` | Samples currently in `failed` status. |
| `discarded_count` | Samples currently in `discarded` status. |
| `latest_collection_date` | Latest event collection timestamp; NULL if the site has no events. |

**What the view hides:** it joins sites to regions, collection events and samples, then groups the records by site and counts events and samples by status. It uses LEFT JOINs for events and samples, so a site with no collection activity still appears with zero counts.

**Who uses it:** site overview pages, dashboards and API routes that need a quick summary of collection activity.

**Expected fixture counts:** five site rows and 17 samples in total. For the current seed:

| Site | Events | Samples | Analyzed | Failed |
|---|---:|---:|---:|---:|
| Dakpathar Barrage | 2 | 5 | 4 | 1 |
| Okhla Barrage | 2 | 4 | 4 | 0 |
| Sangam Prayagraj | 2 | 4 | 4 | 0 |
| Diamond Harbour | 1 | 2 | 2 | 0 |
| Kakdwip Bay | 1 | 2 | 2 | 0 |
| **Total** | **8** | **17** | **16** | **1** |

Example:

```sql
SELECT site_name, event_count, total_samples, analyzed_count, failed_count,
       latest_collection_date
FROM v_site_sample_summary
ORDER BY site_id;
```

## Design notes

- Both views are read-only query interfaces; they do not replace the normalized source tables.
- View names follow the project contract's `v_<name>` convention.
- Column names use `snake_case`, consistent with the database and API contract.
- No `ORDER BY` is built into either view. A query using a view should specify its own ordering.
- The site summary uses `COUNT(DISTINCT ce.event_id)` so an event is counted once even when it has multiple samples. Sample counts are calculated from `samples`, not from event counts.
- The SQL is designed to be safely re-applied by the project's database object runner. If a future change renames or removes a view column, the existing view must be dropped before recreating it because PostgreSQL's `CREATE OR REPLACE VIEW` cannot remove or rename existing columns.
