# Backup and recovery runbook

> Owner: D · T44 / issue #67

## Scope and recovery point

The repository scripts create a consistent, checksummed PostgreSQL custom-format snapshot and restore it all-or-nothing into an empty target. This is snapshot recovery, **not** point-in-time recovery: no WAL archiving is configured, and changes after backup starts are not in that snapshot. Backups do not include cluster roles/passwords or files outside the database. Copy dumps off the database host and periodically rehearse restores.

## Create and verify a backup

```bash
database/backup/backup.sh
DUMP=$(database/backup/backup.sh --url "$TEST_DATABASE_URL" --out-dir /tmp/bk)
cd "$(dirname "$DUMP")" && shasum -a 256 -c "$(basename "$DUMP").sha256"
```

The script prints the absolute dump path to stdout. It writes a checksum sidecar, verifies the custom dump is listable, uses a consistent snapshot, and prunes only matching dumps for that database after success (default retention 14). See database/backup/README.md for flags, exit codes, tool-version rules, and Docker fallback.

## Restore to a new database

Use a disposable target name and credentials appropriate to your local PostgreSQL instance:

```bash
database/backup/restore.sh "$DUMP" --url postgres://USER:PASSWORD@localhost:5432/ebiotrack_restore --create
(cd backend && DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/ebiotrack_restore npm run db:status)
```

Replace the example URL locally; do not commit credentials. The target is mandatory. Restore validates the dump/checksum before touching the target, refuses non-empty databases by default, restores in a single transaction, applies the repository grants, analyzes data, and checks sequences. `--create` removes the newly created target if restore fails. Replacing an existing database requires the explicit `--drop-existing --confirm <exact-target-name>` safeguard; never use that against a shared database.

## Scheduled snapshots and operational checklist

Example nightly schedule (adapt the path and secret handling for the host; do not place real credentials in a checked-in crontab):

```cron
30 2 * * * cd /path/to/eBioTrack && DATABASE_URL=... database/backup/backup.sh --quiet >/dev/null
```

1. Confirm the backup command exited successfully and retain the dump plus checksum.
2. Copy the pair to storage on a separate failure domain; same-disk backups are not disaster recovery.
3. Record timestamp, source database, dump size, checksum verification, and result.
4. Periodically restore to a disposable empty database and run the migration/status check.
5. Keep the rehearsal log with the release/demo evidence; do not claim a restore succeeded unless the run actually completed.

## Verified results (T36)

Run on 2026-11-05 on a Mac with PostgreSQL 16.15 client tools against a PostgreSQL 16 server, on the freshly migrated and seeded database (17 samples, 43 taxon assignments, 28 tables). Timings are for the small seed, not for production volumes.

| Step | Result |
|---|---|
| `backup.sh --url <db> --out-dir <dir>` | Exit 0 in about 0.3 s. Dump 174,941 bytes (custom format), 28 tables, checksum sidecar written, `sha256 -c` prints `OK`. |
| `restore.sh <dump> --url <new-db> --create` | Exit 0 in about 0.5 s: checksum ok, 28 tables, about 324 rows, 22 sequences checked, roles and grants applied. Row counts match the source (`samples` 17, `taxon_assignments` 43). |
| `npm run db:status` against the restored database | Lists no pending migration or seed. |
| Restore into a database that already has data | Refused: `database ... is not empty (28 tables ...); nothing was changed`. Replacing needs `--drop-existing --confirm <exact-name>`. |
| Dump with a changed byte | Refused: `checksum mismatch`, before the target is touched. |
| `npm run test:recovery` (in `tests/`, against `ebiotrack_test`) | 35 tests passed in 14.9 s: round trip (same row hashes, constraints, indexes, triggers, functions, views and sequences), accidental delete, dropped table, wrong update, lost database, truncated and corrupted dumps, tampered checksum, refused targets, grants, and no password in any output. |

Two things the run showed that are easy to miss:

- **The application database role must exist.** `restore.sh` applies `database/roles/grants.sql`, whose `ALTER DEFAULT PRIVILEGES FOR ROLE ebiotrack` lines need that role to exist (the Docker setup creates it). On a server without it the data is restored, but the script then fails with `role "ebiotrack" does not exist`. Create the role first (`CREATE ROLE ebiotrack LOGIN`) or, for a throwaway restore, pass `--skip-grants`.
- **Point in time:** rows written after the backup started are not in the restored database. This is tested (`point in time (honesty)`), not just stated.

## Recovery limitations

No PITR/WAL recovery, no cluster-wide role/password backup, and no guarantee for external files. A restore into a differently named database is supported. Follow database/backup/README.md for exact safety checks and exit codes. This runbook documents the implemented scripts; it does not assert a new recovery rehearsal was run for this PR.
