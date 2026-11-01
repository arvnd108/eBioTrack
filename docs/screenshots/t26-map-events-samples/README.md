# T26 screenshots: Sampling map, Collection events, Samples

For the user guide (T46). Taken at 1280 px wide from the real API (`VITE_USE_MOCK=false`) on a freshly migrated and seeded Postgres 16, in the Asia/Kolkata time zone, signed in as each seeded user (all share the development password in `tests/fixtures/README.md`). Some content was created through the app first, as the screenshots show: Farah Field (field researcher) added the site "Paonta Sahib", Pranav Investigator linked it to Yamuna Biodiversity Survey, and Farah recorded event 1000 there with three measurements and three samples, then moved sample 1000 from Collected to Stored with a note. Names in the status history and the collector column come from the API, so every role sees them (you see "You" for your own entries).

| File                                  | Shows                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `01-sampling-map.png`                 | Sampling map with a site's popup: habitat, region, coordinates, events and samples in your projects, links               |
| `02-new-site-form.png`                | New site form (administrator, principal investigator, field researcher); coordinates typed or map-clicked                |
| `03-collection-events.png`            | Collection events list, newest first, with project, site and day filters                                                 |
| `04-new-event-form.png`               | New collection event: project, site, time, notes, measurements and samples in one save                                   |
| `05-event-detail.png`                 | An event after saving: measurements, samples with their generated codes, Add sample                                      |
| `06-samples-registry.png`             | Sample registry                                                                                                          |
| `07-samples-filtered.png`             | Registry filtered by status and code prefix (`?status=analyzed&q=EB-2026`)                                               |
| `08-sample-detail-change-status.png`  | Sample page: status control offers only the allowed next statuses, with the timeline below                               |
| `09-sample-detail-status-history.png` | A failed sample: full status history and its DNA extraction                                                              |
| `09b-sample-detail-status-note.png`   | A sample moved to Stored with a note: the note is shown in the status history, and the note box is on the status control |
| `10a`, `10b`, `10c`                   | Administrator: map, event 1 (Add sample), sample 17 (status control, names in the timeline)                              |
| `11a`, `11b`, `11c`                   | Principal investigator: same three pages, same actions in their projects                                                 |
| `12a`, `12b`, `12c`                   | Lab technician: no New site or Add sample; may change sample status                                                      |
| `13a`, `13b`, `13c`                   | Analyst: read-only                                                                                                       |
| `14a`, `14b`, `14c`                   | Viewer: read-only                                                                                                        |
