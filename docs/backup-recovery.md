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

## Recovery limitations

No PITR/WAL recovery, no cluster-wide role/password backup, and no guarantee for external files. A restore into a differently named database is supported. Follow database/backup/README.md for exact safety checks and exit codes. This runbook documents the implemented scripts; it does not assert a new recovery rehearsal was run for this PR.
