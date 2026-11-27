#!/usr/bin/env bash
# AgilFrame — safe data backup for AGIL_DATA_DIR.
#
# Creates a gzip-compressed tar of the data directory (tenants, audit JSONL,
# files, recordings, billing, SCIM, domains, API-key hashes, CMS docs), adds a
# manifest and optional crash-consistent SQLite snapshots, verifies the archive,
# writes a SHA-256 checksum, optionally uploads to S3/MinIO, and applies
# retention. Secrets are excluded by name and pattern and are never archived.
#
#   scripts/backup-data.sh --help
#   scripts/backup-data.sh --dry-run
#   scripts/backup-data.sh --data-dir /srv/agil/.data --out-dir /opt/backups/agil
#   scripts/backup-data.sh --volume agil-calls_agil-data --skip-recordings \
#     --s3-uri s3://agil-backups/calls/daily
#
# Exit codes: 0 = success (or a clean dry-run), 1 = runtime failure,
#             2 = usage / precondition failure.
#
# Safety properties:
#   * read-only w.r.t. the data directory (never writes into it);
#   * refuses to put the backup inside the data directory;
#   * lock directory prevents overlapping runs;
#   * writes to a .partial file and renames only after the archive verifies;
#   * retention only deletes files matching its own archive naming pattern;
#   * no secret is ever printed (only paths, sizes and counts).
#
# Requires: bash 4+, GNU tar, gzip. Optional: sqlite3, aws (for --s3-uri),
# docker (for --volume).

set -euo pipefail

VERSION="1.1.0"
TOOL="agil/core/scripts/backup-data.sh"

umask 077

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

QUIET=0
VERBOSE=0
JSON=0

log() {
  if [ "$QUIET" -eq 0 ]; then printf '%s\n' "$*"; fi
}
vlog() {
  if [ "$VERBOSE" -eq 1 ] && [ "$QUIET" -eq 0 ]; then printf '  %s\n' "$*"; fi
}
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-1}"
}
usage_error() {
  printf 'error: %s\n' "$*" >&2
  printf 'Run %s --help for usage.\n' "$TOOL" >&2
  exit 2
}

usage() {
  cat <<'EOF'
AgilFrame — data backup (safe, read-only on the source)

Usage:
  scripts/backup-data.sh [options]

Source (choose one; default: $AGIL_DATA_DIR or ./.data):
  --data-dir PATH        directory to archive (host path)
  --volume NAME          docker volume to archive via a read-only helper
                         container (streams tar to the host; requires docker)

Destination:
  --out-dir PATH         where archives are written (default: $AGIL_BACKUP_DIR
                         or ./backups)
  --tag NAME             suffix for this run, e.g. "predeploy"
                         -> agil-data-<UTC>-predeploy.tar.gz

Content:
  --skip-recordings      exclude recordings/ (usually the largest directory)
  --no-sqlite            do not snapshot SQLite databases
  --sqlite PATH          additional SQLite DB outside the data dir (repeatable)
  --exclude PATTERN      extra tar exclude pattern (repeatable)

Retention (local):
  --retention-days N     delete archives older than N days (default 14,
                         env AGIL_BACKUP_RETENTION_DAYS)
  --keep N               always keep at least the N newest archives (default 7,
                         env AGIL_BACKUP_KEEP)

Offsite (optional):
  --s3-uri URI           s3://bucket/prefix (env AGIL_BACKUP_S3_URI)
  --s3-endpoint URL      custom endpoint for MinIO (env
                         AGIL_BACKUP_S3_ENDPOINT_URL)
  --no-s3-verify         skip the post-upload size check (not recommended)

Monitoring:
  --metrics-textfile PATH  write Prometheus node_exporter textfile metrics on
                         success (env AGIL_BACKUP_TEXTFILE), e.g.
                         /var/lib/node_exporter/textfile/agil_backup.prom
                         -> agil_backup_last_success_timestamp_seconds

Behaviour:
  --dry-run              print the plan, check tools/space, write nothing
  --force-unlock         remove a stale lock after verifying no run is active
  --json                 print a single JSON summary as the last line
  --quiet                only warnings and errors
  --verbose              more detail on stdout
  --help, -h             this help

Environment:
  AGIL_DATA_DIR, AGIL_BACKUP_DIR, AGIL_BACKUP_RETENTION_DAYS, AGIL_BACKUP_KEEP,
  AGIL_BACKUP_S3_URI, AGIL_BACKUP_S3_ENDPOINT_URL, AGIL_BACKUP_TAG,
  AGIL_BACKUP_VOLUME_IMAGE, AGIL_BACKUP_TEXTFILE

Never include .env, private keys or certificates. The script excludes them by
name and pattern even if they live inside the data directory.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

DATA_DIR="${AGIL_DATA_DIR:-./.data}"
DATA_DIR_FLAG=0
OUT_DIR="${AGIL_BACKUP_DIR:-./backups}"
RETENTION_DAYS="${AGIL_BACKUP_RETENTION_DAYS:-14}"
KEEP="${AGIL_BACKUP_KEEP:-7}"
S3_URI="${AGIL_BACKUP_S3_URI:-}"
S3_ENDPOINT="${AGIL_BACKUP_S3_ENDPOINT_URL:-}"
TAG="${AGIL_BACKUP_TAG:-}"
TEXTFILE="${AGIL_BACKUP_TEXTFILE:-}"
VOLUME=""
DRY_RUN=0
FORCE_UNLOCK=0
SKIP_RECORDINGS=0
NO_SQLITE=0
S3_VERIFY=1
EXTRA_SQLITE=()
EXTRA_EXCLUDES=()

need_value() {
  if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then usage_error "missing value for $1"; fi
}

while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --data-dir) need_value "$@"; DATA_DIR="$2"; DATA_DIR_FLAG=1; shift 2 ;;
    --data-dir=*) DATA_DIR="${arg#*=}"; DATA_DIR_FLAG=1; shift ;;
    --volume) need_value "$@"; VOLUME="$2"; shift 2 ;;
    --volume=*) VOLUME="${arg#*=}"; shift ;;
    --out-dir) need_value "$@"; OUT_DIR="$2"; shift 2 ;;
    --out-dir=*) OUT_DIR="${arg#*=}"; shift ;;
    --tag) need_value "$@"; TAG="$2"; shift 2 ;;
    --tag=*) TAG="${arg#*=}"; shift ;;
    --skip-recordings) SKIP_RECORDINGS=1; shift ;;
    --no-sqlite) NO_SQLITE=1; shift ;;
    --sqlite) need_value "$@"; EXTRA_SQLITE+=("$2"); shift 2 ;;
    --sqlite=*) EXTRA_SQLITE+=("${arg#*=}"); shift ;;
    --exclude) need_value "$@"; EXTRA_EXCLUDES+=("$2"); shift 2 ;;
    --exclude=*) EXTRA_EXCLUDES+=("${arg#*=}"); shift ;;
    --retention-days) need_value "$@"; RETENTION_DAYS="$2"; shift 2 ;;
    --retention-days=*) RETENTION_DAYS="${arg#*=}"; shift ;;
    --keep) need_value "$@"; KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${arg#*=}"; shift ;;
    --s3-uri) need_value "$@"; S3_URI="$2"; shift 2 ;;
    --s3-uri=*) S3_URI="${arg#*=}"; shift ;;
    --s3-endpoint) need_value "$@"; S3_ENDPOINT="$2"; shift 2 ;;
    --s3-endpoint=*) S3_ENDPOINT="${arg#*=}"; shift ;;
    --no-s3-verify) S3_VERIFY=0; shift ;;
    --metrics-textfile) need_value "$@"; TEXTFILE="$2"; shift 2 ;;
    --metrics-textfile=*) TEXTFILE="${arg#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force-unlock) FORCE_UNLOCK=1; shift ;;
    --json) JSON=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    *) usage_error "unknown option: $arg" ;;
  esac
done

case "$RETENTION_DAYS" in ''|*[!0-9]*) usage_error "--retention-days must be a non-negative integer" ;; esac
case "$KEEP" in ''|*[!0-9]*) usage_error "--keep must be a non-negative integer" ;; esac
if [ -n "$VOLUME" ] && [ "$DATA_DIR_FLAG" -eq 1 ]; then
  usage_error "--volume and --data-dir are mutually exclusive"
fi

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

abspath() {
  if have realpath; then
    realpath "$1"
  else
    ( cd "$1" 2>/dev/null && pwd -P )
  fi
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\010\013\014\016-\037'
}

human_kb() {
  awk -v kb="${1:-0}" 'BEGIN {
    if (kb >= 1048576) printf "%.1f GiB", kb/1048576;
    else if (kb >= 1024) printf "%.1f MiB", kb/1024;
    else printf "%d KiB", kb;
  }'
}

to_int() {
  case "${1:-}" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
stamp_utc() { date -u +%Y%m%dT%H%M%SZ; }

sha256_file() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "no SHA-256 tool found (sha256sum, shasum or openssl)" 2
  fi
}

file_size_bytes() {
  wc -c < "$1" | tr -d ' '
}

file_mtime_epoch() {
  if stat -c %Y "$1" >/dev/null 2>&1; then
    stat -c %Y "$1"
  else
    stat -f %m "$1"
  fi
}

# ---------------------------------------------------------------------------
# Plan / validation
# ---------------------------------------------------------------------------

START_EPOCH=$(date +%s)
STAMP="$(stamp_utc)"
SUFFIX=""
if [ -n "$TAG" ]; then
  SAFE_TAG="$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '-')"
  SUFFIX="-${SAFE_TAG}"
fi
ARCHIVE_NAME="agil-data-${STAMP}${SUFFIX}.tar.gz"

SRC_KIND="dir"
SRC_DISPLAY=""
if [ -n "$VOLUME" ]; then
  SRC_KIND="volume"
  SRC_DISPLAY="docker volume: $VOLUME"
  if ! have docker; then
    die "--volume requires the docker CLI" 2
  fi
  if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    die "docker volume not found: $VOLUME" 2
  fi
  if [ "$NO_SQLITE" -eq 0 ]; then
    warn "volume mode cannot safely snapshot SQLite databases; use --data-dir with the host path for SQLite, or pass --no-sqlite to acknowledge"
    NO_SQLITE=1
  fi
else
  if [ ! -d "$DATA_DIR" ]; then
    die "data directory not found: $DATA_DIR" 2
  fi
  DATA_DIR="$(abspath "$DATA_DIR")"
  SRC_DISPLAY="$DATA_DIR"
  if [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    die "data directory is empty: $DATA_DIR" 2
  fi
  if [ ! -r "$DATA_DIR" ]; then
    die "data directory is not readable (run as root or the owner): $DATA_DIR" 2
  fi
fi

# Destination: resolve the parent when the directory does not exist yet.
if [ -d "$OUT_DIR" ]; then
  OUT_ABS="$(abspath "$OUT_DIR")"
  OUT_PARENT_ABS="$(dirname "$OUT_ABS")"
else
  OUT_PARENT="$(dirname "$OUT_DIR")"
  if [ ! -d "$OUT_PARENT" ]; then
    die "backup parent directory does not exist: $OUT_PARENT" 2
  fi
  OUT_PARENT_ABS="$(abspath "$OUT_PARENT")"
  OUT_ABS="$OUT_PARENT_ABS/$(basename "$OUT_DIR")"
fi

if [ "$SRC_KIND" = "dir" ]; then
  case "$OUT_ABS/" in
    "$DATA_DIR/"*)
      die "refusing to write backups inside the data directory ($OUT_ABS is under $DATA_DIR)" 2
      ;;
  esac
  case "$DATA_DIR/" in
    "$OUT_ABS/"*)
      warn "the data directory is inside the backup directory; verify retention cannot delete data"
      ;;
  esac
fi

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$OUT_ABS" || die "cannot create backup directory: $OUT_ABS" 2
fi
if [ -d "$OUT_ABS" ] && [ ! -w "$OUT_ABS" ]; then
  die "backup directory is not writable: $OUT_ABS" 2
fi
ARCHIVE="$OUT_ABS/$ARCHIVE_NAME"
CHECKSUM="$ARCHIVE.sha256"
MANIFEST="$ARCHIVE.manifest.json"

# Tool checks.
if ! have tar; then die "tar is required" 2; fi
if ! have gzip; then die "gzip is required" 2; fi
TAR_VERSION="$(tar --version 2>/dev/null | head -n 1 || true)"
case "$TAR_VERSION" in
  *"GNU tar"*) : ;;
  *) die "GNU tar is required (found: ${TAR_VERSION:-unknown})" 2 ;;
esac
if [ -n "$S3_URI" ]; then
  if ! have aws; then die "--s3-uri requires the aws CLI" 2; fi
  case "$S3_URI" in
    s3://*) : ;;
    *) usage_error "--s3-uri must start with s3://" ;;
  esac
fi
if [ "$NO_SQLITE" -eq 0 ] && ! have sqlite3; then
  warn "sqlite3 not found; SQLite files will be copied, not snapshotted"
fi

# Exclusions: secrets and rebuildable/scratch data, plus user patterns.
EXCLUDES=(
  "tmp"
  "tmp/*"
  "*.tmp"
  "*.partial"
  "*.log"
  ".env"
  ".env.*"
  "*.pem"
  "*.key"
  "*.crt"
  "*.p12"
  "*.pfx"
  "*.jks"
  "*.keystore"
  "*id_rsa*"
  "*id_ed25519*"
  "*secret*"
  "*password*"
  "*credentials*"
  ".git"
  "node_modules"
  "sfu-bin"
  "sfu-harness-dist"
)
if [ "$SKIP_RECORDINGS" -eq 1 ]; then
  EXCLUDES+=("recordings" "recordings/*")
fi
if [ "${#EXTRA_EXCLUDES[@]}" -gt 0 ]; then
  EXCLUDES+=("${EXTRA_EXCLUDES[@]}")
fi

EXCLUDE_ARGS=()
for pattern in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=("--exclude=${pattern}")
done

# Size / free-space estimates (best effort, never fatal for the plan).
DATA_SIZE_KB=0
if [ "$SRC_KIND" = "dir" ] && have du; then
  DATA_SIZE_KB="$(to_int "$(du -sk "$DATA_DIR" 2>/dev/null | awk '{print $1}')")"
fi
FREE_KB=0
if have df; then
  FREE_KB="$(to_int "$(df -Pk "$OUT_PARENT_ABS" 2>/dev/null | awk 'NR==2 {print $4}')")"
fi

# ---------------------------------------------------------------------------
# Dry run
# ---------------------------------------------------------------------------

print_plan() {
  log "AgilFrame backup plan"
  log "  tool:            $TOOL $VERSION"
  log "  source:          $SRC_DISPLAY"
  if [ "$SRC_KIND" = "dir" ]; then
    log "  source size:     $(human_kb "$DATA_SIZE_KB") (estimate, before compression)"
  fi
  log "  destination:     $ARCHIVE"
  log "  retention:       ${RETENTION_DAYS} days, keep >= ${KEEP}"
  log "  recordings:      $([ "$SKIP_RECORDINGS" -eq 1 ] && echo excluded || echo included)"
  log "  sqlite:          $([ "$NO_SQLITE" -eq 1 ] && echo disabled || echo enabled)"
  log "  offsite:         ${S3_URI:-disabled}"
  log "  metrics textfile: ${TEXTFILE:-disabled}"
  log "  free at target:  $(human_kb "$FREE_KB")"
  log "  exclude patterns (${#EXCLUDES[@]}):"
  if [ "$VERBOSE" -eq 1 ]; then
    for pattern in "${EXCLUDES[@]}"; do log "    - $pattern"; done
  else
    log "    (use --verbose to list them; secrets are always excluded)"
  fi
  if [ "$SRC_KIND" = "volume" ]; then
    log "  command:         docker run --rm -v ${VOLUME}:/data:ro <helper> tar -cf - ... > <tmp.tar>"
    log "                   tar -rf <tmp.tar> -C <staging> . && gzip -c <tmp.tar> > <archive.partial>"
  else
    log "  command:         tar -czf <archive.partial> -C ${DATA_DIR} ${EXCLUDE_ARGS[*]:-} . -C <staging> ."
  fi
  log "  after success:   verify archive listing, write .sha256 + .manifest.json, prune old archives"
}

if [ "$DRY_RUN" -eq 1 ]; then
  print_plan
  if [ "$FREE_KB" -gt 0 ] && [ "$DATA_SIZE_KB" -gt 0 ] && [ "$FREE_KB" -lt "$DATA_SIZE_KB" ]; then
    warn "free space $(human_kb "$FREE_KB") is below the uncompressed data size $(human_kb "$DATA_SIZE_KB"); a real run may fail"
  fi
  if [ ! -d "$OUT_ABS" ]; then
    log "  note:            $OUT_ABS does not exist yet and would be created"
  fi
  log "dry-run: nothing was written"
  if [ "$JSON" -eq 1 ]; then
    printf '{"ok":true,"dryRun":true,"tool":"%s","version":"%s","source":"%s","archive":"%s","retentionDays":%s,"keep":%s,"excludedPatterns":%s,"recordingsIncluded":%s,"sqliteEnabled":%s,"s3":"%s"}\n' \
      "$TOOL" "$VERSION" "$(json_escape "$SRC_DISPLAY")" "$(json_escape "$ARCHIVE")" \
      "$RETENTION_DAYS" "$KEEP" "${#EXCLUDES[@]}" \
      "$([ "$SKIP_RECORDINGS" -eq 1 ] && echo false || echo true)" \
      "$([ "$NO_SQLITE" -eq 1 ] && echo false || echo true)" \
      "$(json_escape "$S3_URI")"
  fi
  exit 0
fi

if [ "$FREE_KB" -gt 0 ] && [ "$DATA_SIZE_KB" -gt 0 ] && [ "$FREE_KB" -lt "$DATA_SIZE_KB" ]; then
  die "not enough free space at $OUT_ABS ($(human_kb "$FREE_KB") < $(human_kb "$DATA_SIZE_KB"))" 2
fi

# ---------------------------------------------------------------------------
# Lock + cleanup
# ---------------------------------------------------------------------------

LOCK_DIR="$OUT_ABS/.agil-backup.lock"
STAGING=""
TMP_ARCHIVE=""
TMP_TAR=""
RUN_LOG=""
CLEANED=0

cleanup() {
  if [ "$CLEANED" -eq 1 ]; then return; fi
  CLEANED=1
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ -n "$TMP_ARCHIVE" ] && [ -f "$TMP_ARCHIVE" ]; then rm -f "$TMP_ARCHIVE"; fi
  if [ -n "$TMP_TAR" ] && [ -f "$TMP_TAR" ]; then rm -f "$TMP_TAR"; fi
  if [ -n "$RUN_LOG" ] && [ -f "$RUN_LOG" ]; then rm -f "$RUN_LOG"; fi
  if [ -d "$LOCK_DIR" ] && [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap cleanup EXIT INT TERM

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  local holder=""
  if [ -f "$LOCK_DIR/pid" ]; then holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"; fi
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    die "another backup is running (pid $holder, lock $LOCK_DIR); wait or remove the lock after checking" 2
  fi
  if [ "$FORCE_UNLOCK" -eq 1 ]; then
    warn "removing stale lock $LOCK_DIR"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" || die "cannot create lock $LOCK_DIR" 2
    printf '%s' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  die "stale lock found ($LOCK_DIR, pid ${holder:-unknown}); verify no backup is running, then use --force-unlock" 2
}

acquire_lock

RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/agil-backup.XXXXXX")" || die "cannot create a temp log" 1
STAGING="$(mktemp -d "$OUT_ABS/.staging-${STAMP}.XXXXXX")" || die "cannot create staging directory" 1
mkdir -p "$STAGING/.agil-backup"

# ---------------------------------------------------------------------------
# SQLite snapshots + manifest (staged, then appended to the archive)
# ---------------------------------------------------------------------------

SQLITE_JSON=""
SQLITE_COUNT=0

snapshot_sqlite() {
  local db="$1" label="$2"
  local rel="${label#/}"
  local dest="$STAGING/.agil-backup/sqlite/$rel"
  mkdir -p "$(dirname "$dest")"
  if have sqlite3; then
    if ! sqlite3 "$db" ".backup '$dest'" 2>/dev/null; then
      warn "sqlite3 .backup failed for $db; copying the file instead"
      cp -p "$db" "$dest"
    fi
    if [ -f "$dest" ]; then
      local check
      check="$(sqlite3 "$dest" 'PRAGMA integrity_check;' 2>/dev/null || true)"
      if [ "$check" != "ok" ]; then
        die "SQLite integrity check failed for $db (${check:-no output}); refusing to publish an unsafe archive" 1
      fi
    fi
  else
    cp -p "$db" "$dest"
  fi
  local bytes
  bytes="$(file_size_bytes "$dest")"
  SQLITE_COUNT=$((SQLITE_COUNT + 1))
  SQLITE_JSON="${SQLITE_JSON}${SQLITE_JSON:+,}{\"source\":\"$(json_escape "$db")\",\"bytes\":${bytes}}"
  vlog "sqlite snapshot: $db -> .agil-backup/sqlite/$rel (${bytes} bytes)"
}

if [ "$NO_SQLITE" -eq 0 ] && [ "$SRC_KIND" = "dir" ]; then
  while IFS= read -r db; do
    [ -z "$db" ] && continue
    rel="${db#"$DATA_DIR"/}"
    case "$rel" in
      tmp/*|*/tmp/*|.git/*|node_modules/*|sfu-bin/*|sfu-harness-dist/*|recordings/*) continue ;;
    esac
    snapshot_sqlite "$db" "$rel"
  done < <(find "$DATA_DIR" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) 2>/dev/null | sort)
fi
if [ "$NO_SQLITE" -eq 0 ] && [ "${#EXTRA_SQLITE[@]}" -gt 0 ]; then
  for db in "${EXTRA_SQLITE[@]}"; do
    if [ ! -f "$db" ]; then die "extra SQLite DB not found: $db" 1; fi
    db_abs="$(abspath "$db")"
    if [ "$SRC_KIND" = "dir" ]; then
      case "$db_abs" in
        "$DATA_DIR"/*) continue ;;
      esac
    fi
    snapshot_sqlite "$db_abs" "external/$(basename "$db_abs")"
  done
fi

{
  echo "AgilFrame data backup manifest"
  echo "tool: $TOOL $VERSION"
  echo "created_at_utc: $(now_utc)"
  echo "host: $(hostname 2>/dev/null || echo unknown)"
  echo "source: $SRC_DISPLAY"
  echo "source_size_estimate_kb: $DATA_SIZE_KB"
  echo "recordings_included: $([ "$SKIP_RECORDINGS" -eq 1 ] && echo no || echo yes)"
  echo "sqlite_snapshots: $SQLITE_COUNT"
  echo "excluded_patterns:"
  for pattern in "${EXCLUDES[@]}"; do echo "  - $pattern"; done
  echo "notes:"
  echo "  - secrets (.env, keys, certificates, credential files) are excluded by policy"
  echo "  - audit/*.jsonl is append-only; a line cut mid-write during the snapshot is possible"
  echo "  - SQLite snapshots live under .agil-backup/sqlite/ and pass PRAGMA integrity_check"
  echo "  - restore with scripts/restore-data.sh --archive <this archive>"
} > "$STAGING/.agil-backup/MANIFEST.txt"

# ---------------------------------------------------------------------------
# Create, verify, checksum
# ---------------------------------------------------------------------------

TMP_ARCHIVE="$ARCHIVE.partial"
START_TS="$(now_utc)"

log "AgilFrame backup"
log "  source:      $SRC_DISPLAY"
log "  destination: $ARCHIVE"
log "  staging:     sqlite=${SQLITE_COUNT}, recordings=$([ "$SKIP_RECORDINGS" -eq 1 ] && echo excluded || echo included)"

if [ "$SRC_KIND" = "volume" ]; then
  HELPER_IMAGE="${AGIL_BACKUP_VOLUME_IMAGE:-debian:bookworm-slim}"
  if ! docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1; then
    log "  pulling helper image: $HELPER_IMAGE"
    docker pull -q "$HELPER_IMAGE" >/dev/null || die "cannot pull helper image $HELPER_IMAGE" 1
  fi
  TMP_TAR="$OUT_ABS/.payload-${STAMP}.tar"
  set +e
  docker run --rm -v "$VOLUME:/data:ro" "$HELPER_IMAGE" \
    tar -cf - -C /data "${EXCLUDE_ARGS[@]}" . >"$TMP_TAR" 2>"$RUN_LOG"
  PULL_STATUS=$?
  set -e
  if [ "$PULL_STATUS" -ne 0 ] || [ ! -s "$TMP_TAR" ]; then
    cat "$RUN_LOG" >&2 || true
    die "helper container backup failed (status $PULL_STATUS)" 1
  fi
  set +e
  tar -rf "$TMP_TAR" -C "$STAGING" . 2>>"$RUN_LOG"
  APPEND_STATUS=$?
  set -e
  if [ "$APPEND_STATUS" -ne 0 ]; then
    cat "$RUN_LOG" >&2 || true
    die "failed to append staging data to the archive (status $APPEND_STATUS)" 1
  fi
  set +e
  gzip -c "$TMP_TAR" >"$TMP_ARCHIVE" 2>>"$RUN_LOG"
  TAR_STATUS=$?
  set -e
else
  set +e
  tar -czf "$TMP_ARCHIVE" -C "$DATA_DIR" "${EXCLUDE_ARGS[@]}" . -C "$STAGING" . 2>"$RUN_LOG"
  TAR_STATUS=$?
  set -e
fi

if [ "$TAR_STATUS" -ne 0 ] && [ "$TAR_STATUS" -ne 1 ]; then
  cat "$RUN_LOG" >&2 || true
  die "archive creation failed (status $TAR_STATUS)" 1
fi
if [ "$TAR_STATUS" -eq 1 ]; then
  warn "tar reported changed files while reading (status 1); verifying the archive"
fi

if [ ! -s "$TMP_ARCHIVE" ]; then
  die "archive was not created: $TMP_ARCHIVE" 1
fi

# Verify by listing every member; a truncated gzip fails here.
set +e
ENTRY_COUNT="$(tar -tzf "$TMP_ARCHIVE" 2>"$RUN_LOG" | wc -l | tr -d ' ')"
VERIFY_STATUS=$?
set -e
ENTRY_COUNT="$(to_int "$ENTRY_COUNT")"
if [ "$VERIFY_STATUS" -ne 0 ] || [ "$ENTRY_COUNT" -eq 0 ]; then
  cat "$RUN_LOG" >&2 || true
  die "archive verification failed (tar -tzf); refusing to publish it" 1
fi

mv -f "$TMP_ARCHIVE" "$ARCHIVE"
TMP_ARCHIVE=""
if [ -n "$TMP_TAR" ] && [ -f "$TMP_TAR" ]; then rm -f "$TMP_TAR"; TMP_TAR=""; fi

ARCHIVE_BYTES="$(file_size_bytes "$ARCHIVE")"
ARCHIVE_SHA="$(sha256_file "$ARCHIVE")"
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE_NAME" > "$CHECKSUM"
chmod 600 "$ARCHIVE" "$CHECKSUM" 2>/dev/null || true

log "  verified:    $ENTRY_COUNT entries, $(human_kb $((ARCHIVE_BYTES / 1024))) compressed"
log "  sha256:      $ARCHIVE_SHA"

# ---------------------------------------------------------------------------
# Sidecar manifest (machine-readable, no secrets)
# ---------------------------------------------------------------------------

FINISHED_TS="$(now_utc)"
DURATION_MS=$(( ( $(date +%s) - START_EPOCH ) * 1000 ))
cat > "$MANIFEST" <<EOF
{
  "tool": "$TOOL",
  "version": "$VERSION",
  "createdAt": "$START_TS",
  "finishedAt": "$FINISHED_TS",
  "host": "$(json_escape "$(hostname 2>/dev/null || echo unknown)")",
  "source": "$(json_escape "$SRC_DISPLAY")",
  "archive": "$(json_escape "$ARCHIVE_NAME")",
  "bytes": ${ARCHIVE_BYTES},
  "sha256": "${ARCHIVE_SHA}",
  "entries": ${ENTRY_COUNT},
  "recordingsIncluded": $([ "$SKIP_RECORDINGS" -eq 1 ] && echo false || echo true),
  "sqlite": ${SQLITE_COUNT},
  "excludedPatterns": ${#EXCLUDES[@]},
  "durationMs": ${DURATION_MS},
  "s3": "$(json_escape "$S3_URI")"
}
EOF
chmod 600 "$MANIFEST" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Optional node_exporter textfile metric (for the AgilBackupStale alert)
# ---------------------------------------------------------------------------

TEXTFILE_WRITTEN=0
if [ -n "$TEXTFILE" ]; then
  TEXTFILE_DIR="$(dirname "$TEXTFILE")"
  mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
  if [ ! -d "$TEXTFILE_DIR" ]; then
    warn "cannot create textfile directory, skipping metrics: $TEXTFILE_DIR"
  else
    TEXTFILE_TMP="$TEXTFILE.tmp.$$"
    cat > "$TEXTFILE_TMP" <<EOF
# HELP agil_backup_last_success_timestamp_seconds Unix time of the last successful AgilFrame data backup.
# TYPE agil_backup_last_success_timestamp_seconds gauge
agil_backup_last_success_timestamp_seconds $(date +%s)
# HELP agil_backup_bytes Size of the newest backup archive in bytes.
# TYPE agil_backup_bytes gauge
agil_backup_bytes ${ARCHIVE_BYTES}
# HELP agil_backup_entries Number of archive members in the newest backup.
# TYPE agil_backup_entries gauge
agil_backup_entries ${ENTRY_COUNT}
# HELP agil_backup_duration_seconds Duration of the last successful backup run.
# TYPE agil_backup_duration_seconds gauge
agil_backup_duration_seconds $(( DURATION_MS / 1000 ))
EOF
    if mv -f "$TEXTFILE_TMP" "$TEXTFILE"; then
      chmod 644 "$TEXTFILE" 2>/dev/null || true
      TEXTFILE_WRITTEN=1
      vlog "metrics textfile: $TEXTFILE"
    else
      rm -f "$TEXTFILE_TMP" 2>/dev/null || true
      warn "could not write metrics textfile: $TEXTFILE"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Optional offsite upload
# ---------------------------------------------------------------------------

S3_UPLOADED=0
if [ -n "$S3_URI" ]; then
  S3_BASE="${S3_URI%/}"
  AWS_ARGS=(--only-show-errors)
  if [ -n "$S3_ENDPOINT" ]; then AWS_ARGS+=(--endpoint-url "$S3_ENDPOINT"); fi
  log "  uploading:   ${S3_BASE}/${ARCHIVE_NAME}"
  aws "${AWS_ARGS[@]}" s3 cp "$ARCHIVE" "${S3_BASE}/${ARCHIVE_NAME}" >/dev/null \
    || die "S3 upload failed; the local archive and checksum are intact" 1
  aws "${AWS_ARGS[@]}" s3 cp "$CHECKSUM" "${S3_BASE}/${ARCHIVE_NAME}.sha256" >/dev/null \
    || die "S3 upload of the checksum failed; the local archive and checksum are intact" 1
  aws "${AWS_ARGS[@]}" s3 cp "$MANIFEST" "${S3_BASE}/${ARCHIVE_NAME}.manifest.json" >/dev/null \
    || warn "S3 upload of the manifest failed (archive + checksum are uploaded)"
  if [ "$S3_VERIFY" -eq 1 ]; then
    REMOTE="$(aws "${AWS_ARGS[@]}" s3 ls "${S3_BASE}/${ARCHIVE_NAME}" 2>/dev/null | awk 'NR==1 {print $3}')"
    if [ "${REMOTE:-}" != "$ARCHIVE_BYTES" ]; then
      die "S3 size verification failed (remote=${REMOTE:-missing}, local=${ARCHIVE_BYTES}); keep the local archive" 1
    fi
    log "  s3 verified:  ${REMOTE} bytes"
  fi
  S3_UPLOADED=1
fi

# ---------------------------------------------------------------------------
# Retention (local only; archives are named by this tool)
# ---------------------------------------------------------------------------

DELETED=()
DELETE_COUNT=0
if [ "$KEEP" -eq 0 ] && [ "$RETENTION_DAYS" -eq 0 ]; then
  vlog "retention disabled (keep=0, retention-days=0)"
else
  NOW_EPOCH="$(date +%s)"
  CUTOFF=$(( NOW_EPOCH - RETENTION_DAYS * 86400 ))
  ALL_ARCHIVES=()
  while IFS= read -r line; do
    [ -n "$line" ] && ALL_ARCHIVES+=("${line#* }")
  done < <(find "$OUT_ABS" -maxdepth 1 -type f -name 'agil-data-*.tar.gz' -print 2>/dev/null \
    | while IFS= read -r f; do printf '%s %s\n' "$(file_mtime_epoch "$f")" "$f"; done | sort -n)
  TOTAL="${#ALL_ARCHIVES[@]}"
  KEEP_FROM=$(( TOTAL - KEEP ))
  if [ "$KEEP_FROM" -lt 0 ]; then KEEP_FROM=0; fi
  idx=0
  for candidate in "${ALL_ARCHIVES[@]}"; do
    idx=$((idx + 1))
    [ "$candidate" = "$ARCHIVE" ] && continue
    if [ "$idx" -le "$KEEP_FROM" ] && [ "$(file_mtime_epoch "$candidate")" -lt "$CUTOFF" ]; then
      if rm -f "$candidate" "$candidate.sha256" "$candidate.manifest.json"; then
        DELETE_COUNT=$((DELETE_COUNT + 1))
        DELETED+=("$(basename "$candidate")")
        vlog "retention: deleted $(basename "$candidate")"
      else
        warn "could not delete $candidate"
      fi
    fi
  done
  log "  retention:   deleted ${DELETE_COUNT} archive(s), kept newest ${KEEP}"
fi

ln -sfn "$ARCHIVE_NAME" "$OUT_ABS/latest" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log "backup complete: $ARCHIVE"

if [ "$JSON" -eq 1 ]; then
  DELETED_JSON=""
  if [ "${#DELETED[@]}" -gt 0 ]; then
    for name in "${DELETED[@]}"; do
      [ -z "$name" ] && continue
      DELETED_JSON="${DELETED_JSON}${DELETED_JSON:+,}\"$(json_escape "$name")\""
    done
  fi
  printf '{"ok":true,"tool":"%s","version":"%s","archive":"%s","sha256":"%s","bytes":%s,"entries":%s,"sqlite":%s,"recordingsIncluded":%s,"deleted":[%s],"s3":%s,"durationMs":%s}\n' \
    "$TOOL" "$VERSION" "$(json_escape "$ARCHIVE")" "$ARCHIVE_SHA" "$ARCHIVE_BYTES" "$ENTRY_COUNT" "$SQLITE_COUNT" \
    "$([ "$SKIP_RECORDINGS" -eq 1 ] && echo false || echo true)" \
    "$DELETED_JSON" \
    "$([ "$S3_UPLOADED" -eq 1 ] && printf '{"uploaded":true,"uri":"%s"}' "$(json_escape "$S3_URI")" || printf '{"uploaded":false}')" \
    "$DURATION_MS"
fi

exit 0
