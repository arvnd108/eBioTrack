#!/usr/bin/env bash
# Owner: C (Testing & QA)
# Purpose: Restore script
#
# Restore a backup made by backup.sh into an empty database, all or nothing.
#
# Usage: database/backup/restore.sh <dump-file> --url <target-postgres-url>
#        [--create] [--drop-existing --confirm <target-db-name>] [--allow-dev-target] [--skip-grants] [--quiet] [--help]
#
#   <dump-file>        a .dump from backup.sh (custom format). A .sha256 file beside it is checked.
#   --url <url>        the target database. Required: there is no default target.
#   --create           create the target database if it does not exist (dropped again if this run
#                      created it and the restore fails; a database that already existed is never dropped).
#   --drop-existing --confirm <name>
#                      the only way to replace a non-empty database: drops and recreates it
#                      (DROP DATABASE ... WITH (FORCE), connected sessions are terminated). --confirm must
#                      equal the target database name exactly.
#   --allow-dev-target allow the development database "ebiotrack" as the target, but only when it is empty.
#   --skip-grants      do not run database/roles/grants.sql afterwards.
#   --quiet            only errors on stderr.
#
# Result: the target database name on stdout; every message goes to stderr.
#
# Exit codes: 0 ok | 1 unexpected failure (the restore is rolled back) | 2 usage error
#             3 refused by a safety check | 4 connection or authentication failure
#             5 dump invalid (not listable, checksum mismatch) | 6 missing or too old client tools
#
# Safety: the target must exist and be empty (no relation in schema public), or be created by --create.
# A non-empty target is refused (exit 3). Restoring into "ebiotrack" needs --allow-dev-target and an empty
# database. pg_restore runs with --single-transaction --exit-on-error --no-owner --no-acl, so any error
# leaves the target as it was. The dump has no roles or grants; afterwards database/roles/grants.sql is
# applied (idempotent, creates the three ebiotrack_* roles if missing; needs a role that may CREATE ROLE,
# otherwise use --skip-grants and run the file as an administrator). Then ANALYZE and a sequence check:
# every identity/serial sequence must be at or above the maximum of its column. The password is taken
# from the URL and handed to the tools through PGPASSWORD only.
#
# Bash 3.2 compatible (macOS) and Linux.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="restore"
QUIET=0

# ---- shared block (identical in restore.sh; each script runs on its own) --------------------------
if [[ -t 2 ]]; then C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_OFF=$'\033[0m'; else C_RED=""; C_YEL=""; C_OFF=""; fi
info() { [[ "$QUIET" == 1 ]] || printf '[%s] %s\n' "$TAG" "$*" >&2; }
warn() { printf '%s[%s] warning: %s%s\n' "$C_YEL" "$TAG" "$*" "$C_OFF" >&2; }
die() { local code=$1; shift; printf '%s[%s] error: %s%s\n' "$C_RED" "$TAG" "$*" "$C_OFF" >&2; exit "$code"; }

# Percent-decode a URL component.
urldecode() {
  local s=$1
  s=${s//\\/\\\\}
  s=$(printf '%s' "$s" | sed 's/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')
  printf '%b' "$s"
}

# Split postgres://user:pass@host:port/db?sslmode=x into URL_* variables. Never prints the URL.
parse_url() {
  local url=$1 rest authority path userinfo hostport query pair
  URL_HOST=""; URL_PORT=""; URL_USER=""; URL_PASS=""; URL_DB=""; URL_SSLMODE=""
  case "$url" in
    postgres://*) rest=${url#postgres://} ;;
    postgresql://*) rest=${url#postgresql://} ;;
    *) die 2 "the database URL must start with postgres:// or postgresql://" ;;
  esac
  authority=${rest%%/*}
  if [[ "$rest" == */* ]]; then path=${rest#*/}; else path=""; fi
  query=""
  if [[ "$path" == *\?* ]]; then query=${path#*\?}; path=${path%%\?*}; fi
  userinfo=""
  hostport=$authority
  if [[ "$authority" == *@* ]]; then userinfo=${authority%@*}; hostport=${authority##*@}; fi
  if [[ -n "$userinfo" ]]; then
    if [[ "$userinfo" == *:* ]]; then
      URL_USER=$(urldecode "${userinfo%%:*}"); URL_PASS=$(urldecode "${userinfo#*:}")
    else
      URL_USER=$(urldecode "$userinfo")
    fi
  fi
  if [[ "$hostport" == \[* ]]; then
    URL_HOST=${hostport%%]*}; URL_HOST=${URL_HOST#\[}
    local after=${hostport#*]}
    [[ "$after" == :* ]] && URL_PORT=${after#:}
  else
    URL_HOST=${hostport%%:*}
    [[ "$hostport" == *:* ]] && URL_PORT=${hostport##*:}
  fi
  URL_DB=$(urldecode "$path")
  local IFS='&'
  for pair in $query; do
    [[ "$pair" == sslmode=* ]] && URL_SSLMODE=${pair#sslmode=}
  done
  [[ -n "$URL_DB" ]] || die 2 "the database URL has no database name"
  [[ "$URL_DB" =~ ^[A-Za-z0-9_]+$ ]] || die 2 "the database name may only contain letters, digits and underscores"
  [[ -z "$URL_PORT" || "$URL_PORT" =~ ^[0-9]+$ ]] || die 2 "the port in the database URL is not a number"
  [[ -n "$URL_HOST" ]] || URL_HOST="localhost"
  [[ -n "$URL_PORT" ]] || URL_PORT="5432"
}

# DATABASE_URL from the repository .env: KEY=VALUE lines only, the file is never executed.
env_file_value() {
  local key=$1 file="$REPO_ROOT/.env" line value=""
  [[ -r "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    case "$line" in "$key="*) value=${line#"$key="}; ;; esac
  done < "$file"
  value=${value#\"}; value=${value%\"}; value=${value#\'}; value=${value%\'}
  printf '%s' "$value"
}

# Find the PostgreSQL client tools: on PATH, else inside the compose "db" container (localhost only).
TOOL_MODE=""
find_tools() {
  if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
    TOOL_MODE="native"; return 0
  fi
  case "$URL_HOST" in
    localhost|127.0.0.1|::1)
      if command -v docker >/dev/null 2>&1 \
        && (cd "$REPO_ROOT" && docker compose ps --status running --services 2>/dev/null) | grep -qx 'db'; then
        TOOL_MODE="docker"
        info "pg_dump, pg_restore and psql are not all on PATH: using docker compose exec (service db)"
        return 0
      fi ;;
  esac
  die 6 "PostgreSQL client tools (pg_dump, pg_restore, psql) not found: install the PostgreSQL client tools, or start the compose db service for a localhost database"
}

# Run a client tool with the PG* environment (password via PGPASSWORD only).
pg() {
  local tool=$1; shift
  if [[ "$TOOL_MODE" == "native" ]]; then
    "$tool" "$@"
  else
    (cd "$REPO_ROOT" && docker compose exec -T -e PGPASSWORD -e PGUSER -e PGHOST -e PGPORT -e PGDATABASE -e PGSSLMODE -e PGCONNECT_TIMEOUT db "$tool" "$@")
  fi
}

# Export the connection for the tools. In docker mode the server is local to the container.
export_connection() {
  export PGCONNECT_TIMEOUT=5
  if [[ "$TOOL_MODE" == "docker" ]]; then export PGHOST=localhost PGPORT=5432; else export PGHOST="$URL_HOST" PGPORT="$URL_PORT"; fi
  if [[ -n "$URL_USER" ]]; then export PGUSER="$URL_USER"; else unset PGUSER; fi
  if [[ -n "$URL_PASS" ]]; then export PGPASSWORD="$URL_PASS"; else unset PGPASSWORD; fi
  if [[ -n "$URL_SSLMODE" ]]; then export PGSSLMODE="$URL_SSLMODE"; else unset PGSSLMODE; fi
  export PGDATABASE="$URL_DB"
}

major_of() { printf '%s' "$1" | sed 's/[^0-9]*\([0-9][0-9]*\).*/\1/'; }
# ---- end of shared block ---------------------------------------------------------------------------

usage() { sed -n '5,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; /^#$/d'; }
usage_short() { sed -n '/^# Usage:/,/^#$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; /^$/d'; }

DUMP=""; URL=""; CREATE=0; DROP_EXISTING=0; CONFIRM=""; HAVE_CONFIRM=0; ALLOW_DEV=0; SKIP_GRANTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) [[ $# -ge 2 ]] || { usage_short >&2; die 2 "--url needs a value"; }; URL=$2; shift 2 ;;
    --create) CREATE=1; shift ;;
    --drop-existing) DROP_EXISTING=1; shift ;;
    --confirm) [[ $# -ge 2 ]] || { usage_short >&2; die 2 "--confirm needs a value"; }; CONFIRM=$2; HAVE_CONFIRM=1; shift 2 ;;
    --allow-dev-target) ALLOW_DEV=1; shift ;;
    --skip-grants) SKIP_GRANTS=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) usage_short >&2; die 2 "unknown argument: $1" ;;
    *) [[ -z "$DUMP" ]] || { usage_short >&2; die 2 "more than one dump file given"; }; DUMP=$1; shift ;;
  esac
done
[[ -n "$DUMP" ]] || { usage_short >&2; die 2 "the dump file is required"; }
[[ -n "$URL" ]] || { usage_short >&2; die 2 "--url is required: a destructive tool must be told where to restore"; }

parse_url "$URL"
URL=""
TARGET=$URL_DB

CREATED=0; TMP_FILES=(); RESTORING=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ $rc -ne 0 && "$CREATED" == 1 && "$RESTORING" == 1 ]]; then
    # Only a database this run created itself (never one that existed before).
    PGDATABASE=postgres pg psql -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET\" WITH (FORCE)" >/dev/null 2>&1 \
      && printf '[%s] removed the database this run created: %s\n' "$TAG" "$TARGET" >&2
  fi
  if [[ ${#TMP_FILES[@]} -gt 0 ]]; then rm -f -- "${TMP_FILES[@]}"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'warn "interrupted"; exit 130' INT
trap 'warn "terminated"; exit 143' TERM

# Validate the dump before anything else is touched (exit 5).
[[ -f "$DUMP" && -r "$DUMP" ]] || die 5 "dump file not found or not readable: $DUMP"
[[ -s "$DUMP" ]] || die 5 "dump file is empty: $DUMP"
DUMP="$(cd "$(dirname "$DUMP")" && pwd)/$(basename "$DUMP")"

find_tools
export_connection
CLIENT_MAJOR=$(major_of "$(pg pg_restore --version 2>/dev/null)")

list_dump() {
  if [[ "$TOOL_MODE" == "native" ]]; then pg pg_restore --list "$1"; else pg pg_restore --list < "$1"; fi
}
LISTING=$(mktemp); ERR_FILE=$(mktemp); TMP_FILES=("$LISTING" "$ERR_FILE")
list_dump "$DUMP" > "$LISTING" 2>"$ERR_FILE" || die 5 "pg_restore --list cannot read the dump ($(tail -n 1 "$ERR_FILE")); is it a backup.sh dump?"
DUMP_TABLES=$(grep -c ' TABLE public ' "$LISTING" || true)
[[ "$DUMP_TABLES" -gt 0 ]] || die 5 "the dump lists no tables in schema public"

if [[ -f "$DUMP.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$DUMP"); else HASH=$(shasum -a 256 "$DUMP"); fi
  WANT=$(awk 'NR == 1 { print $1 }' "$DUMP.sha256")
  [[ "${HASH%% *}" == "$WANT" ]] || die 5 "checksum mismatch: $(basename "$DUMP") does not match $(basename "$DUMP").sha256"
  [[ "$(wc -l < "$DUMP.sha256" | tr -d ' ')" == 1 ]] || die 5 "$(basename "$DUMP").sha256 has unexpected content"
  info "checksum ok"
else
  warn "no $(basename "$DUMP").sha256 beside the dump: integrity not checked"
fi

# Connect to the maintenance database (exit 4).
sql() { local db=$1; shift; PGDATABASE=$db pg psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
if ! sql postgres -c 'SELECT 1' >/dev/null 2>"$ERR_FILE"; then
  die 4 "cannot connect to the maintenance database postgres as ${URL_USER:-<default user>} at $URL_HOST:$URL_PORT ($(tail -n 1 "$ERR_FILE"))"
fi
SERVER_MAJOR=$(( $(sql postgres -c 'SHOW server_version_num') / 10000 ))
info "client pg_restore $CLIENT_MAJOR, server PostgreSQL $SERVER_MAJOR, target $TARGET at $URL_HOST:$URL_PORT"
if [[ "$TOOL_MODE" == "native" && "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]]; then
  die 6 "pg_restore $CLIENT_MAJOR is older than the server ($SERVER_MAJOR): install the PostgreSQL $SERVER_MAJOR client tools"
fi

EXISTS=$(sql postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'")
RELATIONS=0; TABLES=0
if [[ "$EXISTS" == 1 ]]; then
  if ! sql "$TARGET" -c 'SELECT 1' >/dev/null 2>"$ERR_FILE"; then
    die 4 "cannot connect to database $TARGET ($(tail -n 1 "$ERR_FILE"))"
  fi
  TABLES=$(sql "$TARGET" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
  RELATIONS=$(sql "$TARGET" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')")
fi

# Safety checks, in this order (exit 3).
if [[ "$TARGET" == "ebiotrack" ]]; then
  if [[ "$ALLOW_DEV" != 1 ]]; then
    die 3 "refusing to restore into the development database ebiotrack (pass --allow-dev-target if it is empty and you mean it)"
  fi
  if [[ "$DROP_EXISTING" == 1 ]]; then
    die 3 "--drop-existing is never allowed on the development database ebiotrack"
  fi
fi
if [[ "$HAVE_CONFIRM" == 1 && "$CONFIRM" != "$TARGET" ]]; then
  die 3 "--confirm '$CONFIRM' does not equal the target database name '$TARGET'"
fi
if [[ "$DROP_EXISTING" == 1 && "$HAVE_CONFIRM" != 1 ]]; then
  die 3 "--drop-existing needs --confirm $TARGET"
fi
if [[ "$EXISTS" == 1 && "$RELATIONS" -gt 0 && "$DROP_EXISTING" != 1 ]]; then
  die 3 "database $TARGET is not empty ($TABLES tables, $RELATIONS relations in schema public); nothing was changed. To replace it: --drop-existing --confirm $TARGET"
fi
if [[ "$EXISTS" != 1 && "$CREATE" != 1 && "$DROP_EXISTING" != 1 ]]; then
  die 3 "database $TARGET does not exist (pass --create to create it)"
fi

# Prepare the target.
if [[ "$EXISTS" == 1 && "$DROP_EXISTING" == 1 ]]; then
  SESSIONS=$(sql postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$TARGET' AND pid <> pg_backend_pid()")
  warn "dropping database $TARGET ($TABLES tables) and terminating $SESSIONS connected session(s)"
  sql postgres -c "DROP DATABASE \"$TARGET\" WITH (FORCE)" >/dev/null
  sql postgres -c "CREATE DATABASE \"$TARGET\"" >/dev/null
  info "recreated empty database $TARGET (left empty if the restore fails)"
elif [[ "$EXISTS" != 1 ]]; then
  sql postgres -c "CREATE DATABASE \"$TARGET\"" >/dev/null
  CREATED=1
  info "created database $TARGET"
fi

START=$SECONDS
info "restoring $(basename "$DUMP") ($DUMP_TABLES tables) into $TARGET, single transaction"
RESTORING=1
if [[ "$TOOL_MODE" == "native" ]]; then
  pg pg_restore --single-transaction --exit-on-error --no-owner --no-acl --dbname "$TARGET" "$DUMP" \
    || die 1 "pg_restore failed; the restore was rolled back and $TARGET has no restored data"
else
  pg pg_restore --single-transaction --exit-on-error --no-owner --no-acl --dbname "$TARGET" < "$DUMP" \
    || die 1 "pg_restore failed; the restore was rolled back and $TARGET has no restored data"
fi
RESTORING=0
info "data restored in $((SECONDS - START)) s"

# Grants: the dump has none (--no-acl); grants.sql is the single source of truth.
if [[ "$SKIP_GRANTS" == 1 ]]; then
  warn "--skip-grants: no roles or grants were applied; run database/roles/grants.sql as an administrator"
else
  GRANTS="$SCRIPT_DIR/../roles/grants.sql"
  [[ -f "$GRANTS" ]] || die 1 "grants file not found: $GRANTS (the data is restored; use --skip-grants)"
  if ! { if [[ "$TOOL_MODE" == "native" ]]; then sql "$TARGET" -f "$GRANTS"; else sql "$TARGET" -f - < "$GRANTS"; fi; } >/dev/null 2>"$ERR_FILE"; then
    if grep -q 'permission denied to create role' "$ERR_FILE"; then
      die 1 "the data is restored, but this user may not CREATE ROLE, so grants.sql could not run. Run database/roles/grants.sql against $TARGET as an administrator, or re-run with --skip-grants"
    fi
    die 1 "the data is restored, but grants.sql failed: $(grep -m 1 'ERROR' "$ERR_FILE" || tail -n 1 "$ERR_FILE")"
  fi
  info "roles and grants applied from database/roles/grants.sql"
fi

sql "$TARGET" -c 'ANALYZE' >/dev/null

# Sequences must never hand out an id that already exists. The failure case is the classic restore bug
# (sequence reset to 1): the next value is already in the table. A sequence that is merely below the
# maximum id (rows loaded with explicit ids, as the volume generator does) is reported as a note.
SEQ_CHECK="DO \$\$
DECLARE r record; nxt bigint; lv bigint; called boolean; taken boolean; mx bigint; bad text := ''; low text := ''; n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE a.attnum > 0 AND NOT a.attisdropped
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    n := n + 1;
    EXECUTE format('SELECT last_value, is_called FROM %s', r.seq) INTO lv, called;
    nxt := CASE WHEN called THEN lv + 1 ELSE lv END;
    EXECUTE format('SELECT max(%I), bool_or(%I = \$1) FROM %I', r.col, r.col, r.tbl) INTO mx, taken USING nxt;
    IF coalesce(taken, false) THEN
      bad := bad || format(' %s.%s (next id %s exists)', r.tbl, r.col, nxt);
    ELSIF mx IS NOT NULL AND nxt <= mx THEN
      low := low || format(' %s.%s (next %s, max %s)', r.tbl, r.col, nxt, mx);
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'SEQUENCES WOULD COLLIDE:%', bad; END IF;
  IF low <> '' THEN RAISE NOTICE 'sequence below max id (next id is still free):%', low; END IF;
  RAISE NOTICE 'sequences checked: %', n;
END \$\$"
if ! sql "$TARGET" -c "$SEQ_CHECK" >/dev/null 2>"$ERR_FILE"; then
  grep -v '^$' "$ERR_FILE" >&2 || true
  die 1 "sequence check failed: the next value of a sequence is already used by a restored row"
fi
if grep -q 'sequence below max id' "$ERR_FILE"; then
  warn "$(grep 'sequence below max id' "$ERR_FILE" | sed 's/^NOTICE:  //')"
fi
SEQS=$(sed -n 's/.*sequences checked: \([0-9]*\).*/\1/p' "$ERR_FILE" | tail -n 1)

TABLES=$(sql "$TARGET" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
ROWS=$(sql "$TARGET" -c "SELECT coalesce(sum(reltuples::bigint), 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")
info "ok: $TARGET has $TABLES tables, about $ROWS rows, ${SEQS:-?} sequences checked, restored in $((SECONDS - START)) s"
info "next: (cd backend && DATABASE_URL=<target> npm run db:status) should list nothing pending"

printf '%s\n' "$TARGET"
