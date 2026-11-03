#!/usr/bin/env bash
# Owner: C (Testing & QA)
# Purpose: pg_dump backup script
#
# Take a consistent, verified, checksummed backup of one eBioTrack database.
#
# Usage: database/backup/backup.sh [--url <postgres-url>] [--out-dir <dir>] [--keep <N>] [--quiet] [--help]
#
#   --url <url>      database to back up. Default: $BACKUP_DATABASE_URL, then $DATABASE_URL, then the
#                    DATABASE_URL line of the .env file in the repository root.
#   --out-dir <dir>  where the dump goes (default: <repository>/backups, created with mode 700).
#   --keep <N>       after a successful backup keep only the newest N dumps of this database in the
#                    output directory (default 14, 0 = never delete anything).
#   --quiet          only errors on stderr.
#
# Result: the absolute path of the dump on stdout (one line); every message goes to stderr.
# Files:  ebiotrack_<dbname>_<UTC YYYYMMDDTHHMMSSZ>.dump (mode 600) and a .sha256 file beside it.
#         An existing file is never overwritten: a second backup in the same second fails (exit 1).
#
# Exit codes: 0 ok | 1 unexpected failure | 2 usage error | 3 refused by a safety check
#             4 connection or authentication failure | 5 dump invalid | 6 missing or client tools of the wrong version (older or newer than the server)
#
# What it does: pg_dump --format=custom --no-owner --no-acl in one repeatable-read snapshot. That is a
# consistent point-in-time copy of a live database; writers are not blocked (no LOCK TABLE). Roles
# and grants are not in the dump: restore.sh re-applies database/roles/grants.sql. The dump goes to
# <name>.dump.partial, is verified (pg_restore --list, table count) and only then renamed, so a failed
# or interrupted run never leaves a .dump file behind. The password is read from the URL and handed
# to the tools through PGPASSWORD; it is never put on a command line or printed.
#
# If pg_dump is not on PATH and a docker compose "db" service is running (URL host localhost,
# 127.0.0.1 or ::1) the tools run inside that container ("using docker compose exec" is printed).
# Bash 3.2 compatible (macOS) and Linux.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="backup"
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

URL=""; OUT_DIR=""; KEEP=14
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) [[ $# -ge 2 ]] || { usage_short >&2; die 2 "--url needs a value"; }; URL=$2; shift 2 ;;
    --out-dir) [[ $# -ge 2 ]] || { usage_short >&2; die 2 "--out-dir needs a value"; }; OUT_DIR=$2; shift 2 ;;
    --keep) [[ $# -ge 2 ]] || { usage_short >&2; die 2 "--keep needs a value"; }; KEEP=$2; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage_short >&2; die 2 "unknown argument: $1" ;;
  esac
done
[[ "$KEEP" =~ ^[0-9]+$ ]] || die 2 "--keep must be a non-negative integer"

if [[ -z "$URL" ]]; then URL=${BACKUP_DATABASE_URL:-}; fi
if [[ -z "$URL" ]]; then URL=${DATABASE_URL:-}; fi
if [[ -z "$URL" ]]; then URL=$(env_file_value DATABASE_URL); fi
[[ -n "$URL" ]] || die 2 "no database URL: pass --url, or set BACKUP_DATABASE_URL or DATABASE_URL, or put DATABASE_URL in $REPO_ROOT/.env"

parse_url "$URL"
URL=""
[[ -n "$OUT_DIR" ]] || OUT_DIR="$REPO_ROOT/backups"

PARTIAL=""; SHA_PARTIAL=""; DUMP_PID=""; FINAL=""; TMP_FILES=(); MOVED=""; DONE=""
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n "$DUMP_PID" ]]; then kill "$DUMP_PID" 2>/dev/null || true; wait "$DUMP_PID" 2>/dev/null || true; fi
  if [[ -n "$PARTIAL" ]]; then rm -f -- "$PARTIAL"; fi
  if [[ -n "$SHA_PARTIAL" ]]; then rm -f -- "$SHA_PARTIAL"; fi
  if [[ -n "$MOVED" && -z "$DONE" ]]; then rm -f -- "$FINAL" "$FINAL.sha256"; fi
  if [[ ${#TMP_FILES[@]} -gt 0 ]]; then rm -f -- "${TMP_FILES[@]}"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'warn "interrupted"; exit 130' INT
trap 'warn "terminated"; exit 143' TERM

find_tools
export_connection

CLIENT_MAJOR=$(major_of "$(pg pg_dump --version 2>/dev/null)")
ERR_FILE=$(mktemp); LISTING=$(mktemp); TMP_FILES=("$ERR_FILE" "$LISTING")
if ! pg psql -X -Atq -c 'SELECT 1' >/dev/null 2>"$ERR_FILE"; then
  detail=$(tail -n 1 "$ERR_FILE" 2>/dev/null || true)
  die 4 "cannot connect to database $URL_DB as ${URL_USER:-<default user>} at $URL_HOST:$URL_PORT${detail:+ ($detail)}"
fi
SERVER_NUM=$(pg psql -X -Atq -c 'SHOW server_version_num')
SERVER_MAJOR=$((SERVER_NUM / 10000))
info "client pg_dump $CLIENT_MAJOR, server PostgreSQL $SERVER_MAJOR, database $URL_DB at $URL_HOST:$URL_PORT"
if [[ "$TOOL_MODE" == "native" && "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]]; then
  die 6 "pg_dump $CLIENT_MAJOR is older than the server ($SERVER_MAJOR): it would refuse to dump. Install the PostgreSQL $SERVER_MAJOR client tools (or use the compose db container)"
fi
if [[ "$TOOL_MODE" == "native" && "$CLIENT_MAJOR" -gt "$SERVER_MAJOR" ]]; then
  die 6 "pg_dump $CLIENT_MAJOR is newer than the server ($SERVER_MAJOR): its dump could not be restored into a PostgreSQL $SERVER_MAJOR server (e.g. SET transaction_timeout). Install the PostgreSQL $SERVER_MAJOR client tools (or use the compose db container)"
fi

umask 077
if [[ ! -d "$OUT_DIR" ]]; then
  mkdir -p -- "$OUT_DIR" || die 1 "cannot create $OUT_DIR"
  chmod 700 "$OUT_DIR"
fi
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASENAME="ebiotrack_${URL_DB}_${STAMP}.dump"
if [[ -e "$OUT_DIR/$BASENAME" || -e "$OUT_DIR/$BASENAME.sha256" || -e "$OUT_DIR/$BASENAME.partial" ]]; then
  die 1 "$BASENAME already exists in $OUT_DIR (two backups in the same second); nothing was overwritten, run again"
fi
FINAL="$OUT_DIR/$BASENAME"
PARTIAL="$FINAL.partial"
SHA_PARTIAL="$FINAL.sha256.partial"

START=$SECONDS
info "dumping to $BASENAME"
: > "$PARTIAL"
pg pg_dump --format=custom --no-owner --no-acl > "$PARTIAL" &
DUMP_PID=$!
if ! wait "$DUMP_PID"; then
  DUMP_PID=""
  die 1 "pg_dump failed; no backup was written"
fi
DUMP_PID=""

# Verify: the archive lists, and has at least as many tables as the source.
SRC_TABLES=$(pg psql -X -Atq -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
[[ -s "$PARTIAL" ]] || die 5 "the dump is empty"
list_dump() {
  if [[ "$TOOL_MODE" == "native" ]]; then pg pg_restore --list "$1"; else pg pg_restore --list < "$1"; fi
}
if ! list_dump "$PARTIAL" > "$LISTING" 2>/dev/null; then
  die 5 "the dump cannot be listed with pg_restore --list; it was deleted"
fi
DUMP_TABLES=$(grep -c ' TABLE public ' "$LISTING" || true)
if [[ "$DUMP_TABLES" -lt "$SRC_TABLES" ]]; then
  die 5 "the dump lists $DUMP_TABLES tables but the database has $SRC_TABLES; it was deleted"
fi

if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$PARTIAL"); else HASH=$(shasum -a 256 "$PARTIAL"); fi
printf '%s  %s\n' "${HASH%% *}" "$BASENAME" > "$SHA_PARTIAL"
chmod 600 "$PARTIAL" "$SHA_PARTIAL"
mv -- "$PARTIAL" "$FINAL"; PARTIAL=""; MOVED=1
mv -- "$SHA_PARTIAL" "$FINAL.sha256"; SHA_PARTIAL=""
DONE=1

SIZE=$(wc -c < "$FINAL" | tr -d ' ')
info "ok: $FINAL, $SIZE bytes, $DUMP_TABLES tables, $((SECONDS - START)) s (point-in-time snapshot; roles and grants are not in the dump)"

# Retention: same database only, exact name pattern, newest N kept (sorted by the timestamp in the name).
if [[ "$KEEP" -gt 0 ]]; then
  PATTERN="^ebiotrack_${URL_DB}_[0-9]{8}T[0-9]{6}Z\\.dump\$"
  MATCHES=()
  for f in "$OUT_DIR"/ebiotrack_"${URL_DB}"_*.dump; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    [[ "$(basename "$f")" =~ $PATTERN ]] && MATCHES+=("$f")
  done
  COUNT=${#MATCHES[@]}
  if [[ "$COUNT" -gt "$KEEP" ]]; then
    for ((i = 0; i < COUNT - KEEP; i++)); do
      info "retention: removing $(basename "${MATCHES[$i]}")"
      rm -f -- "${MATCHES[$i]}" "${MATCHES[$i]}.sha256"
    done
  fi
fi

printf '%s\n' "$FINAL"
