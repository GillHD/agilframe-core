#!/usr/bin/env sh
# Render agil/core/deploy/egress/egress.yaml from .env into a root-owned 0640 file.
# 0640 (not 0600): egress runs as UID 1001 with primary group root, and must be
# able to read the mounted config. The file contains no API keys; Redis AUTH,
# if used, is the only secret in it, readable only by root-group processes.
#
#   cd agil/core/deploy/egress
#   cp .env.example .env && chmod 600 .env
#   $EDITOR .env
#   sh render-config.sh
#
# Why a render step: egress reads `redis.address` and the S3 endpoint/bucket
# from YAML only; compose `.env` interpolation cannot reach inside a mounted
# file. API keys are NOT rendered — egress takes them from LIVEKIT_API_KEY /
# LIVEKIT_API_SECRET in the environment, so no SFU secret is written to disk.
#
# Safety:
#   - never sources/evaluates `.env` as shell code: a small dotenv parser reads
#     KEY=VALUE lines literally, so `$`, backticks, `$(...)`, `;`, spaces and
#     quotes in passwords are preserved;
#   - refuses to write inside the git repository;
#   - writes a 0600 temp file and installs it as 0640 root:root;
#   - prints no secret values;
#   - optionally validates the rendered YAML with python3+PyYAML.
#
# `.env` quoting: an unquoted value is taken literally up to a `#` preceded by
# whitespace; a value wrapped in single or double quotes keeps its contents
# (the outer quotes are stripped). Use single quotes for a value containing
# `"`, double quotes for one containing `'`. Put comments on their own line.
#
# Requirements: POSIX sh, envsubst (Debian/Ubuntu: apt-get install gettext-base).

set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${ENV_FILE:-"$SCRIPT_DIR/.env"}
TEMPLATE="$SCRIPT_DIR/egress.yaml"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "env file not found: $ENV_FILE (copy .env.example to .env)"
[ -f "$TEMPLATE" ] || fail "template not found: $TEMPLATE"
command -v envsubst >/dev/null 2>&1 || fail "envsubst not found (install gettext-base)"
[ "$(id -u)" -eq 0 ] || fail "run as root (sudo sh render-config.sh) so the 0640 root:root config is readable by egress"

# ---------------------------------------------------------------------------
# Safe dotenv parser
# ---------------------------------------------------------------------------
# Exports every KEY=VALUE from the file without evaluating it. The key is
# validated; the value is literal (see the quoting note above). Existing
# exported variables are intentionally overridden by the file, like
# `docker compose`. Nothing is printed (an invalid line reports only its line
# number, never its contents).
parse_env_file() {
  _line_no=0
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line_no=$((_line_no + 1))
    # Strip CR so a CRLF .env works; no other transformation of the value.
    _line=$(printf '%s' "$_line" | tr -d '\r')
    _trim=$(printf '%s' "$_line" | sed 's/^[[:space:]]*//')
    [ -z "$_trim" ] && continue
    case "$_trim" in
      \#*) continue ;;
    esac
    case "$_trim" in
      export[[:space:]]*)
        _trim=$(printf '%s' "$_trim" | sed 's/^export[[:space:]][[:space:]]*//')
        ;;
    esac
    case "$_trim" in
      *=*) ;;
      *) fail "invalid .env line $_line_no: expected KEY=VALUE (contents not shown)" ;;
    esac
    _key=$(printf '%s' "${_trim%%=*}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$_key" in
      ''|*[!A-Za-z0-9_]*|[0-9]*) fail "invalid .env key at line $_line_no (allowed: [A-Za-z_][A-Za-z0-9_]*)" ;;
    esac
    _value=${_trim#*=}
    _value=$(printf '%s' "$_value" | sed 's/^[[:space:]]*//')
    case "$_value" in
      \'*)
        case "$_value" in
          *\') ;;
          *) fail "unterminated single-quoted value at .env line $_line_no" ;;
        esac
        _value=${_value#\'}
        _value=${_value%\'}
        ;;
      \"*)
        case "$_value" in
          *\") ;;
          *) fail "unterminated double-quoted value at .env line $_line_no" ;;
        esac
        _value=${_value#\"}
        _value=${_value%\"}
        # Only the two conventional escapes; everything else stays literal.
        _value=$(printf '%s' "$_value" | sed 's/\\"/"/g; s/\\\\/\\/g')
        ;;
      *)
        # An unquoted `#` starts a comment only after whitespace.
        _value=$(printf '%s' "$_value" | sed 's/[[:space:]]#.*$//; s/[[:space:]]*$//')
        ;;
    esac
    # Only EGRESS_* variables are needed by the renderer. Do not export
    # arbitrary dotenv keys: a hostile/typo'd `IFS=`/`PATH=` line must not
    # change shell behaviour. Compose reads the file itself for LIVEKIT_*/AWS_*.
    case "$_key" in
      EGRESS_*) export "$_key=$_value" ;;
      *) : ;;
    esac
  done < "$1"
}

parse_env_file "$ENV_FILE"

OUT=${EGRESS_CONFIG_FILE:-/etc/agil-egress/egress.yaml}

# Normalise to an absolute path so the write is unambiguous.
case "$OUT" in
  /*) ;;
  *) OUT="$(pwd)/$OUT" ;;
esac

# Never render into the checkout: the rendered file is deployment state, not
# source. (It has no API keys, but it is still environment-specific.)
case "$OUT" in
  "$SCRIPT_DIR"/*) fail "refusing to write inside the repository: $OUT" ;;
esac

OUT_DIR=$(dirname -- "$OUT")
if [ ! -d "$OUT_DIR" ]; then
  install -d -m 750 -o root -g root "$OUT_DIR" || fail "cannot create $OUT_DIR (run with sudo?)"
fi
[ -w "$OUT_DIR" ] || fail "$OUT_DIR is not writable (run with sudo?)"

: "${EGRESS_WS_URL:?set EGRESS_WS_URL in $ENV_FILE}"
: "${EGRESS_REDIS_ADDRESS:?set EGRESS_REDIS_ADDRESS in $ENV_FILE}"

normalize_bool() {
  # $1=name $2=value $3=default (printed as true/false; never echoed raw)
  case "$2" in
    '') printf '%s' "$3" ;;
    1|true|TRUE|yes|YES|on|ON) printf 'true' ;;
    0|false|FALSE|no|NO|off|OFF) printf 'false' ;;
    *) fail "$1 must be true/false (or 1/0); value not shown" ;;
  esac
}

EGRESS_INSECURE=$(normalize_bool EGRESS_INSECURE "${EGRESS_INSECURE:-}" false)
EGRESS_REDIS_TLS=$(normalize_bool EGRESS_REDIS_TLS "${EGRESS_REDIS_TLS:-}" false)
EGRESS_S3_FORCE_PATH_STYLE=$(normalize_bool EGRESS_S3_FORCE_PATH_STYLE "${EGRESS_S3_FORCE_PATH_STYLE:-}" true)

# egress reads `redis.address` as host:port; a URL scheme in that field makes
# the worker fail at startup. TLS is a separate boolean (`use_tls`).
case "$EGRESS_REDIS_ADDRESS" in
  redis://*|rediss://*)
    fail "EGRESS_REDIS_ADDRESS must be host:port (not a URL); set EGRESS_REDIS_TLS=true for rediss"
    ;;
esac

EGRESS_REDIS_DB=${EGRESS_REDIS_DB:-0}
case "$EGRESS_REDIS_DB" in
  ''|*[!0-9]*) fail "EGRESS_REDIS_DB must be a non-negative integer (value not shown)" ;;
esac

EGRESS_REDIS_USERNAME=${EGRESS_REDIS_USERNAME:-}
EGRESS_REDIS_PASSWORD=${EGRESS_REDIS_PASSWORD:-}
EGRESS_S3_REGION=${EGRESS_S3_REGION:-}
EGRESS_S3_ENDPOINT=${EGRESS_S3_ENDPOINT:-}
EGRESS_S3_BUCKET=${EGRESS_S3_BUCKET:-}

# Render strings as YAML single-quoted scalars: `$`, backticks, `#`, `"` and
# `: ` stay literal; a literal `'` is doubled per the YAML spec. envsubst does
# the substitution, so no eval is involved.
yaml_quote() {
  _quoted=$(printf '%s' "$1" | sed "s/'/''/g")
  printf "'%s'" "$_quoted"
}

EGRESS_WS_URL=$(yaml_quote "$EGRESS_WS_URL")
EGRESS_REDIS_ADDRESS=$(yaml_quote "$EGRESS_REDIS_ADDRESS")
EGRESS_REDIS_USERNAME=$(yaml_quote "$EGRESS_REDIS_USERNAME")
EGRESS_REDIS_PASSWORD=$(yaml_quote "$EGRESS_REDIS_PASSWORD")
EGRESS_S3_REGION=$(yaml_quote "$EGRESS_S3_REGION")
EGRESS_S3_ENDPOINT=$(yaml_quote "$EGRESS_S3_ENDPOINT")
EGRESS_S3_BUCKET=$(yaml_quote "$EGRESS_S3_BUCKET")

export EGRESS_WS_URL EGRESS_INSECURE EGRESS_REDIS_ADDRESS EGRESS_REDIS_USERNAME
export EGRESS_REDIS_PASSWORD EGRESS_REDIS_TLS EGRESS_REDIS_DB
export EGRESS_S3_REGION EGRESS_S3_ENDPOINT EGRESS_S3_BUCKET EGRESS_S3_FORCE_PATH_STYLE

TMP=$(mktemp "${OUT}.tmp.XXXXXX") || fail "cannot create temp file next to $OUT"
cleanup() { rm -f -- "$TMP"; }
trap cleanup EXIT HUP INT TERM

# Substitute an explicit list: comments and any future `$` in the template are
# left alone, and a missing variable is caught below instead of silently
# becoming an empty string.
envsubst '${EGRESS_WS_URL} ${EGRESS_INSECURE} ${EGRESS_REDIS_ADDRESS} ${EGRESS_REDIS_USERNAME} ${EGRESS_REDIS_PASSWORD} ${EGRESS_REDIS_TLS} ${EGRESS_REDIS_DB} ${EGRESS_S3_REGION} ${EGRESS_S3_ENDPOINT} ${EGRESS_S3_BUCKET} ${EGRESS_S3_FORCE_PATH_STYLE}' \
  < "$TEMPLATE" > "$TMP" || fail "envsubst failed"

if grep -q '\${EGRESS_' "$TMP"; then
  fail "unresolved \${EGRESS_*} placeholder remains in the rendered config"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  # Suppress parser stderr: PyYAML can echo the offending YAML line, which may
  # contain the Redis password. The generic error is enough for the operator.
  python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1], "r", encoding="utf-8"))' "$TMP" >/dev/null 2>&1 \
    || fail "rendered YAML did not parse (details suppressed to avoid printing secrets)"
fi

install -m 640 "$TMP" "$OUT" || fail "cannot write $OUT"
chown root:root "$OUT" || fail "cannot set root:root ownership on $OUT"
if command -v stat >/dev/null 2>&1; then
  _owner=$(stat -c '%u:%g' "$OUT" 2>/dev/null || true)
  [ -z "$_owner" ] || [ "$_owner" = '0:0' ] || fail "unexpected owner on $OUT: $_owner (expected 0:0)"
fi

printf 'rendered %s (mode 640, no API keys; secrets stay in the environment)\n' "$OUT"
