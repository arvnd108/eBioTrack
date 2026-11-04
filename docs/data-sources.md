# Data sources, attribution, and licensing

## Current repository data

The checked-in seed world and starter detection CSV are **synthetic project fixtures**, not a download of an OBIS, GBIF, or NCBI dataset. They use plausible taxon names and workflow values to exercise joins, QC, approval, and analytics. Do not cite their generated read counts, confidence values, dates, or site records as field observations.

| Asset | What it contains | Provenance / status | License |
|---|---|---|---|
| `database/seeds/010_seed_access.sql` through `040_seed_analysis.sql` | Fixed users, projects, sites, samples, lab records, taxa, analyses, and detections | Synthetic, deterministic development/test fixture data; no external source is declared in the seed files | No separate dataset license is declared in the repository. Confirm before redistributing outside the project. |
| `datasets/sample_detections.csv` | Small CSV with library codes, taxon labels, read counts, confidence, and QC flags | Curated starter/example rows; values are illustrative and not documented as imported observations | No separate dataset license or upstream source is declared. Treat as project fixture, not as public biodiversity evidence. |
| `tests/fixtures/detections_valid.csv`, `detections_invalid_row.csv` | Import-path examples, including invalid input | Test fixtures; not observational data | No external license/source is declared. |
| Volume-data generator and its output | Scaled records for performance and query tests | Synthetic, fixed-seed test data; not for ecological inference | Generated project test data; no separate license is declared. |

The repository's fixture conventions require source, license, and real-versus-synthetic labels. Where the source or license is not recorded for a file, this document deliberately does not infer one. Add explicit metadata before publishing or reusing it externally.

## Planned external sources (not currently represented by an identified imported release)

- **OBIS** — Ocean Biodiversity Information System, a source for marine biodiversity and DNA-derived occurrence records: https://obis.org/
- **GBIF** — Global Biodiversity Information Facility, a source for biodiversity occurrence records: https://www.gbif.org/
- **NCBI Sequence Read Archive (SRA)** — archival raw sequencing data, for advanced workflows: https://www.ncbi.nlm.nih.gov/sra

These are candidate source portals, not citations for the synthetic fixture rows. Before importing a specific release, record its dataset or accession identifier, retrieval date, provider, applicable license/terms, and any attribution wording. Check the license on the actual dataset or record: a portal's general availability does not mean every record has the same reuse terms.

## Ingestion and attribution checklist

For every external import, preserve at minimum:

1. Provider and source URL, dataset/release or accession identifier, and retrieval date.
2. License or terms applicable to the exact source record, plus required attribution.
3. Original identifiers and the mapping into eBioTrack identifiers.
4. Whether values are observed, derived, or synthetic; never invent missing collection, lab, or QC metadata.
5. Any transformation, filtering, taxonomic normalization, or deduplication applied.

Keep source attribution with exported records when the source license or terms require it. Clearly distinguish synthetic demo records from real observations in the UI, reports, and presentations. A database license, application license, and data license are separate matters.
