# Member D — Documentation & Demo

**Database slice:** Field & Samples

Related documents: [TEAM_ROLES](../TEAM_ROLES.md) · [ARCHITECTURE](../ARCHITECTURE.md) · [WORKFLOW](../WORKFLOW.md)

---

## 1. Your role

You make the project understandable and presentable: the ER diagram, the normalization report, the API reference, the DBMS demonstration document, the user guide, and the final demo. You keep the repository documentation consistent as the code changes. You also own the database slice for sites, collection events, and samples, which is where the ER modeling and normalization demonstration starts.

Much of your documentation can be drafted early from the plan and finalized when the features land, so you rarely have to wait with nothing to do.

## 2. What you need to do

**Documentation**
- Combined ER/EER diagram from all slices
- Normalization report: a flat sample sheet decomposed to 3NF/BCNF, built from each member's slice notes
- API reference
- DBMS demonstration document: every view, procedure, trigger, transaction, and index mapped to the DBMS concept it shows
- User guide with screenshots
- Backup and recovery documentation
- Query-plan benchmark report
- Data sourcing, attribution, and license notes
- README upkeep and consistency across `docs/` and `planning/`

**Demo**
- Demo script, slides, and rehearsal coordination; each member presents their own segment

**Database slice: Field & Samples**

| Tables (7) | `regions`, `sampling_sites`, `collection_events`, `sample_types`, `samples`, `environmental_measurements`, `sample_status_history` |
|---|---|

| Deliverable | Detail |
|---|---|
| Migration and constraints | PK, FK, UNIQUE, CHECK, NOT NULL (`020`); coordinate ranges, non-negative depth, unique sample codes |
| 3 complex queries | Sample count per site; samples per event with latest status; environmental readings per site over time |
| 2 views | `v_sample_registry`, `v_site_sample_summary` |
| 1 stored procedure | `register_sample()` (generates and validates the sample code) |
| 1 trigger | Enforce valid status transitions and write `sample_status_history` |
| 1 transaction | Register an event with its samples and measurements atomically |
| 2 indexes | Unique `samples(sample_code)`, `collection_events(site_id, collected_at)`, justified with `EXPLAIN (ANALYZE, BUFFERS)` |
| Write-up | Slice and normalization notes in `docs/slices/field.md` |

## 3. Files and folders you own

| Area | Path |
|---|---|
| Documentation | `docs/**` except the slice write-ups of other members: `api.md`, `er-diagram.md`, `normalization.md`, `dbms-demonstration.md`, `user-guide.md`, `backup-recovery.md`, `query-plan-report.md`, `data-sources.md`, `demo-script.md` |
| Planning | `planning/**` (`ARCHITECTURE.md`, `TEAM_ROLES.md`, `WORKFLOW.md`, `eBioTrack_README.md`, `roles/`) |
| Root and data docs | `README.md`, `datasets/README.md` |
| Your slice | `database/migrations/020_field_samples.sql`, `database/seeds/020_seed_field.sql` |
| | `database/views/field_views.sql`, `database/procedures/field_procedures.sql`, `database/triggers/field_triggers.sql` |
| | `database/queries/field_queries.sql`, `database/indexes/field_indexes.sql`, `database/transactions/field_transaction.sql` |
| Docs input | `docs/slices/field.md` |

The other three slice write-ups (`docs/slices/access.md`, `lab.md`, `analysis.md`) are written by their slice owners; you compile them into the normalization report.

## 4. Your workflow

Task IDs match [WORKFLOW.md](../WORKFLOW.md).

1. **T00** Take part in the contract workshop and record the result: table list, keys, statuses, and endpoint list. Your ER diagram and `api.md` start here.
2. **T03** Field migration.
3. **T07** ER diagram draft; finalize after the cross-slice constraints (T06) are merged.
4. **T40** Draft your slice write-up early; finalize after your objects exist. Remind the other three to write theirs.
5. **T42** Draft `api.md` from the contract.
6. **T11** Seed rows for your slice, using the agreed ID ranges.
7. Your slice SQL, in this order: **T14** queries → **T15** views → **T16** `register_sample()` → **T17** trigger → **T18** transaction → **T19** indexes.
8. As each dependency lands, finish the matching document: **T41** normalization, **T43** DBMS demonstration, **T44** backup and recovery, **T45** query-plan report, **T46** user guide, **T47** data sources.
9. **T48** Demo script and slides once database objects are verified (gate G5).
10. **T50 – T52** End-to-end run and demo rehearsal; you run the rehearsal.

Branches: `d/<task-id>-<short-name>` (for example `d/t03-field-migration`). One pull request per task, one reviewer (A reviews yours).

## 5. Tasks you can start now

After the contract workshop (T00):

- **T03** Field migration
- **T07** ER diagram draft
- **T40** Slice write-up draft
- **T42** `api.md` draft from the endpoint list

You can also outline `dbms-demonstration.md`, `user-guide.md`, and the demo script structure from the plan.

## 6. Tasks that need someone else first

| Your task | Needs | From | While you wait |
|---|---|---|---|
| T07 Final ER diagram | T06 cross-slice FKs | A | Draft from the contract |
| T11 Load your seeds | T06 schema complete (G1) | A | Write the seed file from the agreed ID ranges |
| T17 Attach audit trigger | T17-A generic audit function | A | Write your status-transition trigger first |
| T19 Indexes with `EXPLAIN` | T12 volume data | C | Write the index definitions; compare when data exists |
| T41 Normalization report | T40 from all four members | A, B, C | Prepare the flat sample sheet example and your slice |
| T42 Final `api.md` | T20 – T23 routes | A | Draft from the contract |
| T43 DBMS demonstration | T14 – T18 from all slices | A, B, C | Prepare the concept-to-object table with empty cells |
| T44 Backup and recovery doc | T37 scripts and T36 test | A, C | Outline the procedure |
| T45 Query-plan report | T35 benchmark results | C | Prepare the report template |
| T46 User guide | T25 – T29 pages | B | Outline sections; collect screenshots later |
| T47 Data sources doc | T12 dataset and source notes | C | Gather license text for candidate sources |
| T48 Demo script and slides | G5 database objects verified | All | Draft the running order |
| T50 End-to-end run | Everyone's work (gates G4, G5) | All | Note gaps in the docs |

## 7. Who is waiting on you

| Person | Task | Waiting for |
|---|---|---|
| A | T06 cross-slice FKs | Your migration (T03) |
| A | T21 sites, events, samples routes | Your `register_sample()` (T16-D) |
| C | T12 fixtures | Sample codes from your seeds (T11) |
| C | T30 – T35 tests of your slice | Your triggers, transaction, queries, indexes (T14 – T19) |
| Everyone | Final documentation, demo script, rehearsal | T48, T52 |

## 8. Rules and done criteria

- Documentation must describe what exists, not what is planned. If the code and a doc disagree, ask the owner and fix whichever is wrong.
- Keep the ownership table in `ARCHITECTURE.md` and the tasks in `WORKFLOW.md` current when files or tasks change.
- Never describe eDNA results as abundance or confirmed absence. Keep the scientific caveats from the specification in every user-facing document.
- Label datasets as real or synthetic and keep source and license notes.
- Done means: the document is accurate, links work, diagrams render, and screenshots match the current UI.
