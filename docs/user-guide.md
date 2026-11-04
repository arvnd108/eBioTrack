# eBioTrack user guide

> **Owner:** D (Docs & Demo)
>
> This guide describes the intended research workflow and the records that eBioTrack tracks. The repository is still in development; not every screen or workflow described here is available in a runnable UI yet. Use the API and database documentation for implemented interfaces.

## 1. Sign in and choose a project

1. Sign in with an active account. Access is checked on the server for each request.
2. Open a project you belong to. A project membership grants a project role; your global role is separate.
3. Confirm the project, its linked sites, and your role before creating or changing records. Viewers should use read-only pages and exports.

## 2. Set up field work

1. Register or select a sampling site, including its region, habitat, and coordinates.
2. Create a collection event for the project and site, recording the collection date/time and field context.
3. Add samples to the event. The database assigns a unique sample code; record sample type, volume/depth when known, and storage location.
4. Record environmental measurements against the event.
5. Check the sample registry and status history. Samples progress through valid states; do not bypass the status workflow.

The event, its samples, measurements, audit entries, and initial status history are intended to be created atomically. If the operation fails, the transaction should leave no partial event behind.

## 3. Track laboratory processing

1. Create or select an extraction batch and record DNA extractions for the relevant samples.
2. Record QC results and flags; investigate failed or contaminated controls rather than treating them as ordinary passing samples.
3. Create sequencing libraries from extractions and associate them with a sequencing run.
4. Keep identifiers and processing metadata consistent so a later detection can be traced back through library, extraction, sample, event, and site.

eBioTrack tracks laboratory metadata and results; it does not perform extraction, sequencing, or bioinformatics.

## 4. Import and review taxonomic results

1. Prepare a CSV using the analysis-import contract and include the analysis/run and library identifiers required by the importer.
2. Submit the import for validation. Resolve reported validation errors before retrying; do not edit database tables directly to work around them.
3. Review the imported analysis, its provenance, and QC flags.
4. Approve the analysis only after scientific review. Approval is a controlled workflow, and approved results are protected from silent edits.

Only approved analyses with passing QC are included in the documented biodiversity summaries and detection views.

## 5. Explore detections and summarize biodiversity

1. Search for a taxon or open its detection history.
2. Follow a detection back to its library, extraction, sample, collection event, and site to inspect provenance.
3. Compare richness or detection frequency by site and period, applying consistent filters for project, marker, QC, and approved analyses.
4. Export the filtered results when needed for further analysis.

A detection is not an estimate of abundance. A non-detection does not prove absence; interpret results alongside sampling effort, assay sensitivity, and quality information.

## 6. Audit and permissions

- Use project membership and assigned roles to determine what actions are allowed; do not share accounts.
- Important writes create audit records. Use authorized audit views to investigate who changed a record and when.
- Users are deactivated rather than deleted, preserving provenance.
- Do not place passwords, access tokens, or sensitive credentials in notes or exported filenames.

## 7. Local development and support

The repository README documents the current development setup. For database-backed work, follow the project setup instructions and use a disposable development/test database. See [API overview](../README.md#api-overview), [Field & Samples](slices/field.md), [backup and recovery](backup-recovery.md), and [data sources](data-sources.md).

If a described screen or operation is not present in the running build, treat this guide as workflow guidance rather than evidence that the feature is deployed. Report the missing behavior with the affected project, record type, and a reproducible example; avoid including private sample or user data.
