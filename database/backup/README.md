<!-- Owner: C (Testing & QA) -->
<!-- Purpose: Usage, exit codes, safety rules and limits of backup.sh and restore.sh (source for docs/backup-recovery.md) -->

# Backup and restore scripts

`backup.sh` takes a consistent, verified, checksummed copy of one eBioTrack database. `restore.sh` brings it back into an empty database, all or nothing. Both are plain Bash (3.2 on macOS, any Linux), non-interactive, and each runs on its own: the URL parsing and tool discovery block is duplicated in both on purpose (there is no `lib.sh`).

A backup is a **snapshot**. There is no point-in-time recovery and no WAL archiving: you get back the database as it was when `backup.sh` started.

## Quick start

```bash
# Back up the database named in .env (DATABASE_URL) into ./backups/
database/backup/backup.sh

# Back up the test database somewhere else; the dump path is printed on stdout
DUMP=$(database/backup/backup.sh --url "$TEST_DATABASE_URL" --out-dir /tmp/bk)

# Restore into a new database (created, and removed again if the restore fails)
database/backup/restore.sh "$DUMP" --url postgres://ebiotrack:change_me@localhost:5432/ebiotrack_restore --create

# Replace a database that already has data (the name must be repeated exactly)
database/backup/restore.sh "$DUMP" --url postgres://ebiotrack:change_me@localhost:5432/ebiotrack_restore \
  --drop-existing --confirm ebiotrack_restore

# Check that the application sees a clean, fully migrated database
(cd backend && DATABASE_URL=postgres://ebiotrack:change_me@localhost:5432/ebiotrack_restore npm run db:status)
```

- **Laptop with Docker** (`docker compose up -d db`): if `pg_dump`, `pg_restore` and `psql` are not on the host, the scripts run them inside the compose `db` container and say so (`using docker compose exec`). This only happens when the URL host is `localhost`, `127.0.0.1` or `::1` and the `db` service is running.
- **Laptop with a local PostgreSQL**: the client tools must be on `PATH`, version at least that of the server.
- **CI** (`postgres:16` service on `localhost:5432`): the `ubuntu-latest` runner has PostgreSQL client tools; use the same command lines.

## backup.sh

```
backup.sh [--url <postgres-url>] [--out-dir <dir>] [--keep <N>] [--quiet] [--help]
```

| Option / variable | Meaning |
| --- | --- |
| `--url` | database to back up. Otherwise `BACKUP_DATABASE_URL`, then `DATABASE_URL`, then the `DATABASE_URL` line of `.env` in the repository root (read as `KEY=VALUE`, never executed) |
| `--out-dir` | output directory, default `<repository>/backups` (git-ignored, created with mode 700) |
| `--keep N` | after a successful backup keep the newest N dumps of this database in the directory, default 14, `0` = keep everything |
| `--quiet` | errors only |

- **File names**: `ebiotrack_<dbname>_<UTC YYYYMMDDTHHMMSSZ>.dump` (mode 600) and `<same>.dump.sha256` beside it (`<hash>  <file name>`, check with `cd <dir> && shasum -a 256 -c <file>.sha256`). An existing file is never overwritten: two backups in the same second make the second one fail with exit 1.
- **What it does**: `pg_dump --format=custom --no-owner --no-acl` (one repeatable-read snapshot: consistent, does not block writers, no `LOCK TABLE`) into `<name>.dump.partial`; then `pg_restore --list` must succeed and list at least as many tables as the database has in `public`; then the checksum is written and the file renamed. A failed or interrupted run (including `SIGINT`/`SIGTERM`) removes its `.partial` and leaves no `.dump`.
- **Output**: stdout is the absolute path of the dump (one line); everything else goes to stderr.
- **Retention**: only files of exactly the form `ebiotrack_<this dbname>_<timestamp>.dump` (and their `.sha256`) in `--out-dir` are considered, oldest by the timestamp in the name; other files and other databases are never touched. Pruning runs only after a successful backup.
- **Not in the dump**: cluster roles and passwords, other databases, files outside the database. The `session` table is in the dump; sessions expire anyway.

## restore.sh

```
restore.sh <dump-file> --url <target-postgres-url>
           [--create] [--drop-existing --confirm <target-db-name>] [--allow-dev-target] [--skip-grants] [--quiet] [--help]
```

The target is mandatory: there is no default. Output: the target database name on stdout, messages on stderr.

Order of events: validate the dump (`pg_restore --list`, `.sha256` if present, a missing `.sha256` is only a warning) -> connect -> safety checks -> create or drop/recreate the database if asked -> `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` -> apply `database/roles/grants.sql` -> `ANALYZE` -> check that no identity/serial sequence will hand out an id that a restored row already has -> summary.

Restoring into a different database name than the dump's source is fully supported (the dump has no database name inside).

### Safety rules

| Situation | Result |
| --- | --- |
| no `<dump-file>` or no `--url`, unknown option | exit 2 |
| target is the development database `ebiotrack` | exit 3 unless `--allow-dev-target`; even then only if empty, and `--drop-existing` on it is always refused |
| target does not exist, no `--create` | exit 3 |
| target has any relation in `public` (tables, views, sequences) | exit 3, message with the table count, nothing changed. This also protects the database the dump came from |
| `--drop-existing` without `--confirm`, or `--confirm` different from the target name | exit 3 |
| `--drop-existing --confirm <name>` | the only way to replace a non-empty database: `DROP DATABASE ... WITH (FORCE)` (connected sessions are terminated, the number is printed), then an empty database is created and restored. If this restore fails the empty database stays |
| `--create` and the restore fails | the database this run created is dropped again; a database that existed before is never dropped |
| dump missing, empty, not listable, checksum mismatch | exit 5, before anything is touched |
| bad credentials, server unreachable | exit 4 (host, port, database, user are shown, never the password) |
| any error inside `pg_restore` | the single transaction rolls back, exit 1, the target has no restored data |

### Grants and roles (the decision)

The dump is taken with `--no-owner --no-acl`, so it contains **no** role names, `OWNER TO` or `GRANT`. Objects are created as the connecting user. `restore.sh` then runs `database/roles/grants.sql` (idempotent; creates `ebiotrack_readonly`, `ebiotrack_app`, `ebiotrack_admin` if missing). That file is the single source of truth for grants, and a restore onto a fresh cluster works without any role existing beforehand. Running it needs a role that may `CREATE ROLE` (the compose user `ebiotrack` can). If it cannot, the script says so after restoring the data (exit 1): run `database/roles/grants.sql` as an administrator, or use `--skip-grants`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 1 | unexpected failure (restore: rolled back; a failed grants step or sequence check happens after the data is committed and says so) |
| 2 | usage error (missing or unknown argument, malformed URL) |
| 3 | refused by a safety check |
| 4 | connection or authentication failure |
| 5 | dump invalid (not listable, checksum mismatch, missing file) |
| 6 | client tools missing, or `pg_dump` older than the server (a newer client is fine) |

## Passwords

The password is parsed from the URL (percent-decoding supported, IPv6 hosts, `?sslmode=`) and passed to the tools through `PGPASSWORD`; the tools get host, port, user and database through `PGHOST/PGPORT/PGUSER/PGDATABASE`. It never appears on a command line (not in `ps`), in a message, or in a file. The scripts never use `set -x`.

## Routine (example, not installed)

```cron
# every night at 02:30, keep two weeks
30 2 * * * cd /path/to/eBioTrack && DATABASE_URL=postgres://... database/backup/backup.sh --quiet >/dev/null
```

Copy the dumps off the machine (they stay on the same disk as the database otherwise), and do a test restore now and then: `tests/recovery/` (T36) does this automatically against the test database.

## Limits

- Snapshot only: changes after the backup started are lost; no point-in-time recovery, no WAL archiving.
- Roles and their passwords are not backed up; only the three `ebiotrack_*` roles are re-created, without login or password.
- One database per run; extensions or objects outside `public` are only included if `pg_dump` includes them for that database.
- The dump is read and written as one stream; very large databases would need `--format=directory` and parallel jobs, which these scripts do not use.
