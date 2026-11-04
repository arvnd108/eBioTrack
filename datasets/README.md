# Datasets

This directory contains starter/example data for development and testing. The current checked-in CSV is illustrative and synthetic; it is not a verified download from an external biodiversity portal.

## Files

| File | Purpose | Data status |
|---|---|---|
| `sample_detections.csv` | Small example of detection-import columns: library code, scientific name, rank, read count, confidence, and QC flag | Synthetic/illustrative fixture; not an observed dataset |

The deterministic database seeds and test/volume fixtures are also synthetic. Their fixed values make tests repeatable; they are not ecological measurements and must not be used to support scientific conclusions.

## Source and license

No upstream dataset identifier, external source URL, or separate dataset license is declared for `sample_detections.csv` in this repository. Do not assume that the application’s license, if any, licenses this data or that the file is public-domain. Confirm the intended reuse terms with the project owner before redistributing it.

External OBIS, GBIF, or NCBI SRA data is a future ingestion possibility, not the provenance of this file. When adding a real dataset, update [the data-source register](../docs/data-sources.md) with the exact release/accession, retrieval date, applicable license/terms, attribution, and transformation notes. Do not fill missing metadata with invented values.
