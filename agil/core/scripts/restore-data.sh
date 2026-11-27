#!/usr/bin/env bash
# AgilFrame — verified restore of a data backup produced by backup-data.sh.
#
# Inspect with --dry-run first; a real restore requires --yes, an explicit target
# (--into or --volume), and --force when the target is not empty.
#
#   scripts/restore-data.sh --archive /opt/backups/agil/agil-data-...tar.gz --dry-run
#   scripts/restore-data.sh --archive ... --into /srv/restore/agil-data
#   scripts/restore-data.sh --archive ... --into /var/lib/docker/volumes/.../_data --force --yes
#   scripts/restore-data.sh --archive ... --volume agil-calls_agil-data --force --yes
#
# Exit codes: 0 = success (or a clean dry-run / --verify-only),
#             1 = verification or extraction failure, 2 = usage / precondition.
#
# Safety properties:
#   * verifies the SHA-256 sidecar and the complete tar listing before writing;
#   * rejects archives containing absolute paths or `..` members;
#   * never writes outside the chosen target;
#   * refuses `/` and refuses a non-empty target without --force;
#   * excludes the backup's internal metadata unless --with-metadata is given.

set -euo pipefail

VERSION="1.1.0"
TOOL="agil/core/scripts/restore-data.sh"
umask 022

QUIET=0
JSON=0
DRY_RUN=0
ASSUME_YES=0
FORCE=0
SKIP_CHECKSUM=0
WITH_METADATA=0
RESTORE_SQLITE=0
VERIFY_ONLY=0
ARCHIVE=""
INTO=""
VOLUME=""
OWNER=""

log() { if [ "$QUIET" -eq 0 ]; then printf '%s\n' "$*"; fi; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$1" >&2; exit "${2:-1}"; }
usage_error() { printf 'error: %s\n' "$*" >&2; printf 'Run %s --help for usage.\n' "$TOOL" >&2; exit 2; }

usage() {
  cat <<'EOF'
AgilFrame — restore a data backup

Usage:
  scripts/restore-data.sh --archive FILE (--into DIR | --volume NAME) [options]

Required:
  --archive PATH         archive created by scripts/backup-data.sh
  --into DIR             restore into a host directory
  --volume NAME          restore into a docker volume (requires docker)

Safety / verification:
  --dry-run              verify + print the plan, write nothing
  --verify-only          verify checksum and archive listing, then exit
  --yes                  required for a real restore (non-interactive)
  --force                allow restoring into a non-empty target
  --skip-checksum        do not verify the .sha256 sidecar (not recommended)
  --with-metadata        also extract .agil-backup/ (manifest + sqlite snapshots)
  --restore-sqlite       copy verified SQLite snapshots over the restored DBs
                         (host directory mode only)
  --owner UID:GID        force ownership of extracted files (default: as stored)

Other:
  --json                 print a single JSON summary as the last line
  --quiet                only warnings and errors
  --help, -h             this help

Examples:
  $ scripts/restore-data.sh --archive /opt/backups/agil/agil-data-20261116T031500Z.tar.gz --dry-run
  $ scripts/restore-data.sh --archive ... --into /srv/restore/agil-data
  $ docker compose stop agil-calls
  $ scripts/restore-data.sh --archive ... --volume agil-calls_agil-data --force --yes
  $ docker compose start agil-calls

The archive contains user data. Keep the restored tree at the same permissions
as the original (the app runs as the `node` user in the Docker image).
EOF
}

need_value() {
  if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then usage_error "missing value for $1"; fi
}

while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --archive) need_value "$@"; ARCHIVE="$2"; shift 2 ;;
    --archive=*) ARCHIVE="${arg#*=}"; shift ;;
    --into) need_value "$@"; INTO="$2"; shift 2 ;;
    --into=*) INTO="${arg#*=}"; shift ;;
    --volume) need_value "$@"; VOLUME="$2"; shift 2 ;;
    --volume=*) VOLUME="${arg#*=}"; shift ;;
    --owner) need_value "$@"; OWNER="$2"; shift 2 ;;
    --owner=*) OWNER="${arg#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-checksum) SKIP_CHECKSUM=1; shift ;;
    --with-metadata) WITH_METADATA=1; shift ;;
    --restore-sqlite) RESTORE_SQLITE=1; shift ;;
    --json) JSON=1; shift ;;
    --quiet) QUIET=1; shift ;;
    *) usage_error "unknown option: $arg" ;;
  esac
done

[ -n "$ARCHIVE" ] || usage_error "--archive is required"
if [ -z "$INTO" ] && [ -z "$VOLUME" ] && [ "$VERIFY_ONLY" -eq 0 ]; then
  usage_error "choose a target: --into DIR or --volume NAME"
fi
if [ -n "$INTO" ] && [ -n "$VOLUME" ]; then
  usage_error "--into and --volume are mutually exclusive"
fi
if [ "$RESTORE_SQLITE" -eq 1 ] && [ -n "$VOLUME" ]; then
  usage_error "--restore-sqlite is supported for --into only (extract the volume on the host first)"
fi
if [ -n "$OWNER" ]; then
  if ! printf '%s' "$OWNER" | grep -Eq '^[0-9]+:[0-9]+$'; then
    usage_error "--owner must be UID:GID (numeric, e.g. 1000:1000)"
  fi
  if [ -n "$VOLUME" ]; then
    warn "--owner is ignored for --volume restores (files keep the archive ownership)"
  fi
fi

have() { command -v "$1" >/dev/null 2>&1; }

abspath() {
  if have realpath; then realpath "$1"; else ( cd "$1" 2>/dev/null && pwd -P ); fi
}

to_int() { case "${1:-}" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }

sha256_file() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else return 1; fi
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\010\013\014\016-\037'
}

# ---------------------------------------------------------------------------
# Verify the archive before touching anything
# ---------------------------------------------------------------------------

START_EPOCH=$(date +%s)

[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE" 2
[ -r "$ARCHIVE" ] || die "archive is not readable: $ARCHIVE" 2
ARCHIVE="$(abspath "$ARCHIVE")"
ARCHIVE_DIR="$(dirname "$ARCHIVE")"
ARCHIVE_BASE="$(basename "$ARCHIVE")"

if ! have tar; then die "tar is required" 2; fi
TAR_VERSION="$(tar --version 2>/dev/null | head -n 1 || true)"
case "$TAR_VERSION" in
  *"GNU tar"*) : ;;
  *) die "GNU tar is required (found: ${TAR_VERSION:-unknown})" 2 ;;
esac

log "AgilFrame restore"
log "  archive:     $ARCHIVE"

ARCHIVE_BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"

CHECKSUM_STATUS="missing"
CHECKSUM_FILE="$ARCHIVE.sha256"
EXPECTED_SHA=""
ACTUAL_SHA=""
if [ "$SKIP_CHECKSUM" -eq 1 ]; then
  CHECKSUM_STATUS="skipped"
  warn "checksum verification skipped by request"
elif [ -f "$CHECKSUM_FILE" ]; then
  EXPECTED_SHA="$(awk 'NR==1 {print $1}' "$CHECKSUM_FILE")"
  if [ -z "$EXPECTED_SHA" ]; then
    die "checksum file is empty or malformed: $CHECKSUM_FILE" 1
  fi
  ACTUAL_SHA="$(sha256_file "$ARCHIVE")" || die "no SHA-256 tool available to verify the archive" 2
  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    die "checksum mismatch: expected $EXPECTED_SHA, got $ACTUAL_SHA — do not restore this archive" 1
  fi
  CHECKSUM_STATUS="ok"
elif [ "$DRY_RUN" -eq 1 ] || [ "$VERIFY_ONLY" -eq 1 ]; then
  CHECKSUM_STATUS="missing"
  warn "no .sha256 sidecar next to the archive; integrity was not verified"
else
  die "no .sha256 sidecar next to the archive ($CHECKSUM_FILE); pass --skip-checksum only if you trust the file" 2
fi
[ -n "$ACTUAL_SHA" ] || ACTUAL_SHA="$EXPECTED_SHA"

# Full listing; also validates gzip integrity.
LIST_FILE="$(mktemp "${TMPDIR:-/tmp}/agil-restore-list.XXXXXX")" || die "cannot create temp file" 1
cleanup() {
  [ -f "$LIST_FILE" ] && rm -f "$LIST_FILE"
  [ -f "$LIST_FILE.err" ] && rm -f "$LIST_FILE.err"
  return 0
}
trap cleanup EXIT INT TERM

set +e
tar -tzf "$ARCHIVE" > "$LIST_FILE" 2>"$LIST_FILE.err"
LIST_STATUS=$?
set -e
if [ "$LIST_STATUS" -ne 0 ]; then
  cat "$LIST_FILE.err" >&2 || true
  die "archive listing failed (corrupt or not a gzip tar): $ARCHIVE" 1
fi
rm -f "$LIST_FILE.err"
ENTRY_COUNT="$(to_int "$(wc -l < "$LIST_FILE" | tr -d ' ')")"
if [ "$ENTRY_COUNT" -eq 0 ]; then
  die "archive contains no entries" 1
fi

# Reject path traversal / absolute members before any extraction.
UNSAFE="$(awk '
  /^\// { print; next }
  { n = split($0, parts, "/"); for (i = 1; i <= n; i++) if (parts[i] == "..") { print; next } }
' "$LIST_FILE" | head -n 5)"
if [ -n "$UNSAFE" ]; then
  printf 'unsafe members:\n%s\n' "$UNSAFE" >&2
  die "archive contains absolute paths or '..' members; refusing to restore" 1
fi

METADATA_MEMBERS="$(grep -c '^\./\.agil-backup/' "$LIST_FILE" 2>/dev/null || true)"
METADATA_MEMBERS="$(to_int "$METADATA_MEMBERS")"

log "  entries:     $ENTRY_COUNT"
log "  size:        $ARCHIVE_BYTES bytes"
log "  sha256:      ${ACTUAL_SHA:-not verified} (${CHECKSUM_STATUS})"
log "  metadata:    ${METADATA_MEMBERS} internal member(s) under .agil-backup/"

if [ "$VERIFY_ONLY" -eq 1 ]; then
  log "verify-only: archive is intact ($ENTRY_COUNT entries, checksum ${CHECKSUM_STATUS})"
  if [ "$JSON" -eq 1 ]; then
    printf '{"ok":true,"verifyOnly":true,"archive":"%s","entries":%s,"bytes":%s,"sha256":"%s","checksum":"%s"}\n' \
      "$(json_escape "$ARCHIVE")" "$ENTRY_COUNT" "$ARCHIVE_BYTES" "$(json_escape "$ACTUAL_SHA")" "$CHECKSUM_STATUS"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve and validate the target
# ---------------------------------------------------------------------------

TARGET_KIND="dir"
TARGET_DISPLAY=""
TARGET_ABS=""
TARGET_EMPTY=1
HELPER_IMAGE="${AGIL_RESTORE_VOLUME_IMAGE:-debian:bookworm-slim}"

if [ -n "$VOLUME" ]; then
  TARGET_KIND="volume"
  TARGET_DISPLAY="docker volume: $VOLUME"
  # A volume is never assumed empty: always require --force for a volume restore.
  TARGET_EMPTY=0
  if ! have docker; then die "--volume requires the docker CLI" 2; fi
  if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    die "docker volume not found: $VOLUME" 2
  fi
else
  TARGET_KIND="dir"
  if [ -z "$INTO" ]; then die "--into is required" 2; fi
  case "$INTO" in
    /) die "refusing to restore into /" 2 ;;
  esac
  if [ -e "$INTO" ] && [ ! -d "$INTO" ]; then
    die "target exists and is not a directory: $INTO" 2
  fi
  if [ -d "$INTO" ]; then
    TARGET_ABS="$(abspath "$INTO")"
    if [ -n "$(ls -A "$TARGET_ABS" 2>/dev/null)" ]; then
      TARGET_EMPTY=0
    fi
  else
    parent="$(dirname "$INTO")"
    if [ -d "$parent" ]; then
      TARGET_ABS="$(abspath "$parent")/$(basename "$INTO")"
    else
      # Dry-run only: keep the user-supplied path for the plan.
      TARGET_ABS="$INTO"
    fi
  fi
  if [ -n "$OWNER" ]; then
    TARGET_DISPLAY="$TARGET_ABS (owner $OWNER)"
  else
    TARGET_DISPLAY="$TARGET_ABS"
  fi
fi

if [ "$TARGET_EMPTY" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  die "target is not empty: $TARGET_ABS — pass --force to overwrite (make a backup first)" 2
fi

# Extraction excludes: internal metadata is opt-in.
EXTRACT_EXCLUDES=()
if [ "$WITH_METADATA" -eq 0 ]; then
  EXTRACT_EXCLUDES+=("--exclude=./.agil-backup" "--exclude=./.agil-backup/*")
fi
if [ "$TARGET_KIND" = "volume" ] && [ "$TARGET_EMPTY" -eq 0 ] && [ "$FORCE" -eq 1 ]; then
  log "  note:        volume restore overwrites matching files; extra files in the volume are kept"
fi

# ---------------------------------------------------------------------------
# Dry-run / verify-only
# ---------------------------------------------------------------------------

print_plan() {
  log "  target:      $TARGET_DISPLAY"
  log "  target state: $([ "$TARGET_EMPTY" -eq 1 ] && echo 'empty (or will be created)' || echo 'NON-EMPTY (--force)')"
  log "  metadata:    $([ "$WITH_METADATA" -eq 1 ] && echo 'extracted (manifest + sqlite snapshots)' || echo 'skipped (.agil-backup/)')"
  log "  sqlite:      $([ "$RESTORE_SQLITE" -eq 1 ] && echo 'snapshots will replace restored DB files' || echo 'not applied')"
  if [ "$TARGET_KIND" = "volume" ]; then
    log "  command:     docker run --rm -v ${VOLUME}:/data -v ${ARCHIVE_DIR}:/backup:ro ${HELPER_IMAGE} tar -xzf /backup/${ARCHIVE_BASE} -C /data ${EXTRACT_EXCLUDES[*]:-}"
  else
    log "  command:     tar -xzf ${ARCHIVE} ${EXTRACT_EXCLUDES[*]:-} -C ${TARGET_ABS}"
  fi
  local top
  top="$(awk -F/ 'NF>=2 && $2 != "" {print $2}' "$LIST_FILE" | sort -u | head -n 12 | tr '\n' ' ')"
  log "  top entries: ${top:-none}"
}

if [ "$DRY_RUN" -eq 1 ]; then
  print_plan
  log "dry-run: nothing was restored"
  if [ "$JSON" -eq 1 ]; then
    printf '{"ok":true,"dryRun":true,"archive":"%s","entries":%s,"target":"%s","targetKind":"%s","nonEmpty":%s,"metadata":%s,"sqlite":%s,"checksum":"%s"}\n' \
      "$(json_escape "$ARCHIVE")" "$ENTRY_COUNT" "$(json_escape "$TARGET_DISPLAY")" "$TARGET_KIND" \
      "$([ "$TARGET_EMPTY" -eq 0 ] && echo true || echo false)" \
      "$([ "$WITH_METADATA" -eq 1 ] && echo true || echo false)" \
      "$([ "$RESTORE_SQLITE" -eq 1 ] && echo true || echo false)" "$CHECKSUM_STATUS"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Real restore
# ---------------------------------------------------------------------------

if [ "$ASSUME_YES" -eq 0 ]; then
  die "refusing to restore without --yes (run --dry-run first to inspect)" 2
fi

log "  target:      $TARGET_DISPLAY"

if [ "$TARGET_KIND" = "dir" ]; then
  mkdir -p "$TARGET_ABS" || die "cannot create target directory: $TARGET_ABS" 1
  set +e
  tar -xzf "$ARCHIVE" "${EXTRACT_EXCLUDES[@]}" -C "$TARGET_ABS" 2>"$LIST_FILE.err"
  EXTRACT_STATUS=$?
  set -e
else
  if ! docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1; then
    log "  pulling helper image: $HELPER_IMAGE"
    docker pull -q "$HELPER_IMAGE" >/dev/null || die "cannot pull helper image $HELPER_IMAGE" 1
  fi
  set +e
  docker run --rm -v "$VOLUME:/data" -v "$ARCHIVE_DIR:/backup:ro" "$HELPER_IMAGE" \
    tar -xzf "/backup/$ARCHIVE_BASE" "${EXTRACT_EXCLUDES[@]}" -C /data 2>"$LIST_FILE.err"
  EXTRACT_STATUS=$?
  set -e
fi

if [ "$EXTRACT_STATUS" -ne 0 ]; then
  cat "$LIST_FILE.err" >&2 || true
  die "extraction failed (status $EXTRACT_STATUS)" 1
fi
rm -f "$LIST_FILE.err"

EXTRACTED=1
SQLITE_RESTORED=0

# Optional: apply the crash-consistent SQLite snapshots over the raw DB copies.
if [ "$RESTORE_SQLITE" -eq 1 ]; then
  if [ "$METADATA_MEMBERS" -eq 0 ]; then
    warn "archive has no .agil-backup/sqlite snapshots; nothing to apply"
  else
    SNAP_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agil-restore-sqlite.XXXXXX")"
    set +e
    tar -xzf "$ARCHIVE" -C "$SNAP_TMP" --wildcards './.agil-backup/sqlite/*' 2>/dev/null
    SNAP_STATUS=$?
    set -e
    if [ "$SNAP_STATUS" -ne 0 ]; then
      warn "could not extract SQLite snapshots; restored raw DB files were kept"
    else
      while IFS= read -r snap; do
        [ -z "$snap" ] && continue
        rel="${snap#"$SNAP_TMP"/.agil-backup/sqlite/}"
        dest="$TARGET_ABS/$rel"
        mkdir -p "$(dirname "$dest")"
        if [ -f "$dest" ]; then cp -p "$dest" "$dest.pre-restore" 2>/dev/null || true; fi
        cp -p "$snap" "$dest"
        if have sqlite3; then
          check="$(sqlite3 "$dest" 'PRAGMA integrity_check;' 2>/dev/null || true)"
          if [ "$check" != "ok" ]; then
            die "restored SQLite failed integrity_check: $dest (${check:-no output})" 1
          fi
        fi
        SQLITE_RESTORED=$((SQLITE_RESTORED + 1))
      done < <(find "$SNAP_TMP/.agil-backup/sqlite" -type f 2>/dev/null | sort)
    fi
    rm -rf "$SNAP_TMP"
  fi
fi

if [ -n "$OWNER" ] && [ "$TARGET_KIND" = "dir" ]; then
  if have chown; then
    chown -R "$OWNER" "$TARGET_ABS" 2>/dev/null || warn "chown -R $OWNER failed (run as root)"
  else
    warn "--owner ignored: chown not available"
  fi
fi

# ---------------------------------------------------------------------------
# Post-restore checks + summary
# ---------------------------------------------------------------------------

TENANT_COUNT=0
if [ -d "$TARGET_ABS/tenants" ] 2>/dev/null; then
  TENANT_COUNT="$(find "$TARGET_ABS/tenants" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  TENANT_COUNT="$(to_int "$TENANT_COUNT")"
elif [ "$TARGET_KIND" = "volume" ]; then
  TENANT_COUNT="$(to_int "$(docker run --rm -v "$VOLUME:/data:ro" "$HELPER_IMAGE" sh -c 'ls -1 /data/tenants/*.json 2>/dev/null | wc -l' 2>/dev/null || true)")"
fi

log "  extracted:   $ENTRY_COUNT entries"
log "  tenants:     $TENANT_COUNT config file(s)"
if [ "$RESTORE_SQLITE" -eq 1 ]; then
  log "  sqlite:      $SQLITE_RESTORED snapshot(s) applied"
fi

log ""
log "Next steps:"
if [ "$TARGET_KIND" = "dir" ] && [ "$TARGET_ABS" = "${AGIL_DATA_DIR:-}" ]; then
  log "  1. start the app:            docker compose up -d agil-calls"
else
  log "  1. point AGIL_DATA_DIR (or the compose volume) at the restored tree"
fi
log "  2. health:                   curl -fsS http://127.0.0.1:8787/v1/health"
log "  3. verify tenant + audit:    ls tenants | wc -l; tail -n 1 audit/<tenant>.jsonl"
log "  4. run:                      node scripts/ops-check.mjs"

log "restore complete"

DURATION_MS=$(( ( $(date +%s) - START_EPOCH ) * 1000 ))
if [ "$JSON" -eq 1 ]; then
  printf '{"ok":true,"archive":"%s","entries":%s,"target":"%s","targetKind":"%s","tenants":%s,"sqliteRestored":%s,"checksum":"%s","durationMs":%s}\n' \
    "$(json_escape "$ARCHIVE")" "$ENTRY_COUNT" "$(json_escape "$TARGET_DISPLAY")" "$TARGET_KIND" \
    "$TENANT_COUNT" "$SQLITE_RESTORED" "$CHECKSUM_STATUS" "$DURATION_MS"
fi

exit 0
