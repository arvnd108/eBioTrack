# eBioTrack user guide

> **Owner:** D (Docs & Demo) · T46 / issue #69
>
> How to use eBioTrack, task by task. Every screenshot was taken from the running application against the real API on a freshly seeded database (see the `README.md` in each folder under [`screenshots/`](screenshots/)). The seeded development accounts are `<role>@ebiotrack.test` with the development password in `tests/fixtures/README.md`; they exist only in a development database.

eBioTrack tracks eDNA research from field sample to taxon detection. It records field, laboratory and analysis information and the people responsible for each step; it does not perform extraction, sequencing or bioinformatics.

## Who can do what

The sidebar shows only the pages your role can use. Every role can read the data of the projects it belongs to.

Your **project role** (owner, manager, contributor, viewer) also counts: anyone can create a project and becomes its owner, and a user who is invited to someone else's project works there with the project role they were given, whatever their global role. The table below shows what each *global* role allows everywhere; a project role adds to it inside that project (owner and manager: edit the project, members, sites, approve analyses; contributor: record events, samples, lab work and analyses; viewer: read only).

| Task | Administrator | Principal investigator | Field researcher | Lab technician | Analyst | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Create projects | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage members and sites of a project | ✓ | ✓ (own projects) | project owner or manager | project owner or manager | project owner or manager | project owner or manager |
| Users and roles (Administration) | ✓ | | | | | |
| Audit log | ✓ | ✓ (own projects) | project owner | project owner | project owner | project owner |
| Add a site | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Record events and samples | ✓ | ✓ | ✓ | | | |
| Change a sample's status | ✓ | ✓ | ✓ | ✓ | | |
| Record extractions, QC results, runs | ✓ | ✓ | | ✓ | | |
| Create analyses, import detections | ✓ | ✓ | | | ✓ | |
| Approve or reject an analysis | ✓ | ✓ | | | | |
| Explore species and analytics, download CSV | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## 1. Create an account and sign in

New here? Choose **Create an account** on the sign-in page. Only name, email and a password (at least 8 characters) are required; organization, job title and phone can be skipped. You are signed in at once with the global *Viewer* role, can create your own projects and can be added to others. An administrator can later change your global role. If the email is already registered you are told so.

Open the application and sign in with your email and password. After five wrong attempts in 15 minutes sign-in is locked for a while; wait and try again.

![Sign-in page](screenshots/t25-projects-admin/01-login.png)

You land on the **Dashboard**: counts for your projects, what is waiting for you, and the newest activity.

![Dashboard of a principal investigator](screenshots/t29-dashboard/01-principal-investigator-all-projects.png)

Use the project selector to look at one project; the choice is kept in the address. If you belong to no project yet, the dashboard tells you what to do next.

![A user in no project](screenshots/t29-dashboard/09-user-in-no-project.png)

## 2. Set up a project (any signed-in user)

1. Open **Projects** and choose **New project**. Enter a title and optionally objectives and a start date. You become its owner.
2. Open the project. The owner can edit it, add members with a project role (owner, manager, contributor, viewer) and link the sampling sites the project may collect at.

![Projects list](screenshots/t25-projects-admin/02-projects-list-administrator.png)
![New project form](screenshots/t25-projects-admin/03-new-project-form-administrator.png)
![Project with members and sites](screenshots/t25-projects-admin/10-project-detail-principal-investigator-owner.png)

A project role is separate from your global role, and you only need to be a member to see a project. Members without the owner or manager role see the project read-only:

![Read-only project](screenshots/t25-projects-admin/13b-project-detail-field-researcher-read-only.png)

**Administrators** also open **Administration** to create users and assign roles, and to read the audit log. You cannot remove your own administrator role or deactivate yourself; users are deactivated, never deleted.

![Administration, users](screenshots/t25-projects-admin/05-admin-users-administrator.png)
![New user form](screenshots/t25-projects-admin/06-admin-new-user-form.png)

## 3. Record sites, events and samples (field researcher and up)

1. **Sampling map** shows the sites. Anyone can choose **New site** to add one: region (or **Add a new region…** for a place that is not listed), name, habitat type (lake, river, wetland, soil, other and so on) and coordinates typed or clicked on the map. You can edit the sites you added.
2. **Collection events** lists visits. Choose **New event**: pick the project and site, the collection time, notes, any environmental measurements and the samples collected. Everything is saved together, or nothing is.
3. The event page shows the measurements and the samples with their generated codes (`EB-YYYYMMDD-<event>-<number>`). **Add sample** adds another.

![Sampling map with a site popup](screenshots/t26-map-events-samples/01-sampling-map.png)
![New site](screenshots/t26-map-events-samples/02-new-site-form.png)
![New event with measurements and samples](screenshots/t26-map-events-samples/04-new-event-form.png)
![Event after saving](screenshots/t26-map-events-samples/05-event-detail.png)

A site must be linked to the project before an event can use it. The collection time cannot be more than a day in the future.

### Find a sample and move it along

**Samples** is the registry; filter by status or code prefix. Open a sample to see its event, site, extractions and full status history. The status control offers only the next statuses that are allowed (for example, a failed sample cannot become analyzed), and you can add a note that appears in the history.

![Sample registry filtered](screenshots/t26-map-events-samples/07-samples-filtered.png)
![Change status](screenshots/t26-map-events-samples/08-sample-detail-change-status.png)
![Status history with a note](screenshots/t26-map-events-samples/09b-sample-detail-status-note.png)

## 4. Track laboratory work (lab technician, principal investigator)

Open **Lab processing**. It has three tabs: Extractions, QC results and Sequencing runs.

1. **Extractions** tab, lower section **Extraction batches**: choose *New batch* with lab, date and kit.
2. **Extractions** tab: *Record extraction* for a sample and batch with concentration and purity. A new extraction waits for a QC verdict; choose **Pass** or **Fail** and confirm. The verdict is final.
3. **QC results** tab: record controls and checks for a sample (or an analysis).
4. **Sequencing runs** tab: *New run* offers only extractions that passed QC and are not booked on another run. A planned run takes more libraries; **Start run** locks it, then **Mark completed** or **Mark failed**.

![Extractions with QC verdicts](screenshots/t27-lab-processing/01-extractions.png)
![Record an extraction](screenshots/t27-lab-processing/02-record-extraction-form.png)
![Confirm a final verdict](screenshots/t27-lab-processing/03-qc-verdict-confirm.png)
![New sequencing run](screenshots/t27-lab-processing/08-new-run-form.png)
![A planned run](screenshots/t27-lab-processing/09-run-planned.png)

Other roles can read these pages but see no action buttons:

![Read-only run](screenshots/t27-lab-processing/14b-run-field-researcher.png)

## 5. Import and review detections (analyst, principal investigator)

1. Open **Analysis import** and choose **New analysis**: the sequencing run (its library codes are shown), the marker, the pipeline and reference database, and parameters as JSON.
2. Open the draft. Prepare a CSV with the required columns (a template is offered). Choose **Check file**: nothing is saved, and any problem is listed by row. Fix the file until it reports that all rows are valid.
3. Choose **Import**. The analysis becomes *Imported* and waits for a principal investigator.
4. A principal investigator opens it and chooses **Approve**, or **Reject** with a reason. The person who imported an analysis cannot approve it. Approved analyses are never edited; to correct one, use **Start a correction**, which copies its settings and supersedes the old analysis when the new one is approved.

![Analyses list](screenshots/t28-analysis-species-analytics/01-analyses-list.png)
![A problem found by Check file](screenshots/t28-analysis-species-analytics/04-dry-run-errors.png)
![A clean check](screenshots/t28-analysis-species-analytics/05-dry-run-clean.png)
![Imported, waiting for approval](screenshots/t28-analysis-species-analytics/06-imported.png)
![Approve or reject](screenshots/t28-analysis-species-analytics/07-approve-or-reject.png)
![Importer cannot approve](screenshots/t28-analysis-species-analytics/10-importer-cannot-approve.png)

Only **approved** analyses and detections with a **pass** QC flag count in the species explorer, the analytics and the downloads.

## 6. Explore species and biodiversity (everyone)

**Species explorer**: search a taxon, see its lineage, the detection frequency by site, and every detection with a link back to its sample. **Download CSV** exports the detections for one project; the caveat travels with the file.

**Biodiversity analytics**: observed species per year or per site, with the sampling effort and a chart and table. A richness CSV can be downloaded.

![Species search and detections](screenshots/t28-analysis-species-analytics/13-species-search-and-detections.png)
![Analytics by year](screenshots/t28-analysis-species-analytics/16-analytics-by-year.png)
![Analytics by site with detection frequency](screenshots/t28-analysis-species-analytics/17-analytics-by-site-with-frequency.png)

**How to read the results.** A detection means DNA of that taxon was found; it is not an estimate of abundance. A non-detection does not prove absence. Interpret results alongside sampling effort, assay sensitivity and QC.

## 7. Follow a detection back to the field

In the species explorer every detection links to its sample. The sample page shows its event and site, status history and extractions; a sequencing run page lists its libraries with their source samples. Together they trace a detection to the library, extraction, sample, event and site it came from.

## 8. Audit and permissions

Important changes are written to the audit log by the database itself, with who and when. Administrators see all entries, principal investigators those of the projects they belong to, and any project owner those of the projects they own, on **Administration → Audit log** (also reached from the dashboard's *Full audit log* link). Never share accounts; do not put passwords or tokens in notes.

![Audit log](screenshots/t25-projects-admin/08-admin-audit-log-administrator.png)

## 9. If something does not work

- A page or button is missing: your role may not allow it (see the table above), or you may not be a member of the project.
- An action is refused with a message: read it; most explain the rule (for example, the sample status change that is not allowed).
- *ML insights* in the sidebar is a placeholder for an optional later task.

When reporting a problem, give the project, the record type and a reproducible example, without private sample or user data. For setup, see the repository README; for the API, [api.md](api.md); for backups, [backup-recovery.md](backup-recovery.md).
