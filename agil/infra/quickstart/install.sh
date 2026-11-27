#!/usr/bin/env bash
# AgilFrame — safe quickstart installer (core + node + TURN + Redis).
#
# What it does:
#   1. checks Docker/Compose, free ports, DNS, disk and memory;
#   2. creates `.env` with fresh random secrets and a first API key (0600);
#   3. writes a STUN/TURN ICE list and detects this host's public IPv4, refusing
#      to advertise an RFC1918/CGNAT/loopback relay address for a remote origin;
#   4. validates the compose file;
#   5. only with --start: builds/starts the stack, waits for /v1/health,
#      mints a one-time node enrollment token and starts the node loop.
#
# Safety contract:
#   * never downloads and pipes a script into a shell;
#   * never edits files outside this directory, host proxies, Caddy, HAProxy,
#     VPN, firewall or any production service;
#   * never overwrites an existing `.env` unless --force (a timestamped backup
#     is created first);
#   * `docker compose down -v` is never run; volumes are never deleted;
#   * every check is read-only.
#
# Usage:
#   ./install.sh                      configure + validate only
#   ./install.sh --start              configure, validate, build and start
#   ./install.sh --domain calls.example.com --start
#   ./install.sh --force --start      regenerate .env (backup kept) and start
#   ./install.sh --check              validate the existing .env only
#   ./install.sh --dry-run --start    print actions, change nothing
#   ./install.sh --turn-ip 203.0.113.10 --start
#   ./install.sh --allow-private-ip   dev/LAN only: accept a private TURN IP
#
# Exit codes: 0 ok, 1 usage/config error, 2 failed check.

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SELF="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
cd "$SCRIPT_DIR"

# shellcheck disable=SC1091
# shellcheck source=lib/net.sh
. "$SCRIPT_DIR/lib/net.sh"

ENV_FILE=".env"
ENV_EXAMPLE=".env.example"
COMPOSE_FILE="docker-compose.yml"

# ---------------------------------------------------------------- cosmetics

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '%sFAIL%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { fail "$*"; exit 1; }

ACTION_START=0
ACTION_CHECK_ONLY=0
DRY_RUN=0
FORCE=0
DOMAIN=""
PUBLIC_ORIGIN_ARG=""
TURN_IP_ARG=""
ICE_HOST_ARG=""
ALLOW_PRIVATE_IP=0

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$SELF"
  cat <<'EOF'

Options:
  --start                 build and start the stack after configuration
  --check                 only validate the existing .env (no writes, no start)
  --domain <fqdn>         public hostname; sets https://<fqdn> as public origin
  --public-origin <url>   explicit public origin (overrides --domain)
  --turn-ip <ipv4>        public IPv4 for TURN relay candidates
  --allow-private-ip      dev/LAN only: accept an RFC1918/CGNAT TURN IP
  --ice-host <host>       host used in STUN/TURN URLs (default: origin host)
  --force                 back up and regenerate .env
  --dry-run               print what would happen, write nothing, start nothing
  -h, --help              this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --start) ACTION_START=1 ;;
    --check) ACTION_CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --domain) DOMAIN=${2:?--domain needs a value}; shift ;;
    --public-origin) PUBLIC_ORIGIN_ARG=${2:?--public-origin needs a value}; shift ;;
    --turn-ip) TURN_IP_ARG=${2:?--turn-ip needs a value}; shift ;;
    --allow-private-ip) ALLOW_PRIVATE_IP=1 ;;
    --ice-host) ICE_HOST_ARG=${2:?--ice-host needs a value}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [ "$ACTION_CHECK_ONLY" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
  die "--check and --force are mutually exclusive"
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run]'
    printf ' %s' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# --------------------------------------------------------------- env helpers

# get_env KEY — print the last KEY=VALUE value from .env (empty if absent).
get_env() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v key="$1" '
    index($0, key "=") == 1 { value = substr($0, length(key) + 2) }
    END { print value }
  ' "$ENV_FILE"
}

# set_env KEY VALUE — replace the line in place, keep everything else.
set_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp "${ENV_FILE}.XXXXXX")
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

have() { command -v "$1" >/dev/null 2>&1; }

rand_hex() { openssl rand -hex "$1"; }

# json_get KEY — read a top-level string field from stdin JSON.
json_get() {
  local key=$1
  if have python3; then
    python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(3)
value = data.get(sys.argv[1], "")
print(value if isinstance(value, str) else "")' "$key"
    return
  fi
  if have node; then
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(typeof v==="string"?v:"")}catch{process.exit(3)}})' "$key"
    return
  fi
  return 3
}

http_get() { curl -fsS --max-time 5 "$1"; }

# --------------------------------------------------------------- preflight

check_docker_cli() {
  info "Docker / Compose"
  have docker || die "docker is not installed. Install Docker Engine 24+ and Compose v2 first."
  if ! docker compose version >/dev/null 2>&1; then
    die "docker compose v2 is required (the 'docker-compose' v1 binary is not supported)"
  fi
  local compose_version compose_major compose_minor rest
  compose_version=$(docker compose version --short 2>/dev/null || echo unknown)
  case "$compose_version" in
    [0-9]*)
      compose_major=${compose_version%%.*}
      rest=${compose_version#*.}
      compose_minor=${rest%%.*}
      if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt 24 ]; }; then
        warn "Compose ${compose_version} is older than 2.24; this project uses 'include' and '!reset' (upgrade Docker Compose)"
      fi
      ;;
  esac
  have openssl || die "openssl is required to generate secrets (install openssl, then re-run)"
  have curl || die "curl is required for health checks and public-IP detection"
}

check_docker() {
  check_docker_cli
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (is it running? are you in the docker group?)"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') · compose $(docker compose version --short 2>/dev/null || echo '?')"
}

# port_free_tcp PORT — read-only listener check.
port_free_tcp() {
  local port=$1
  if have ss; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$" && return 1
  elif have lsof; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 1
  elif have netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$" && return 1
  fi
  return 0
}

port_free_udp() {
  local port=$1
  if have ss; then
    ss -lunH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$" && return 1
  fi
  return 0
}

detect_public_ip() {
  local url ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)
    # Only accept a genuinely public address from the probe; a captive portal or
    # egress filter can answer with a LAN address, which must not be advertised.
    if ipv4_is_valid "$ip" && [ "$(classify_ipv4 "$ip")" = "public" ]; then
      printf '%s' "$ip"; return 0
    fi
  done
  # Last resort: the local interface address. Callers classify it and warn/refuse
  # when it is RFC1918/CGNAT (see validate_turn_ip).
  ip=$(detect_lan_ip)
  [ -n "$ip" ] && printf '%s' "$ip"
  return 0
}

detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true
}

origin_host() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##; s#:[0-9]+$##'
}

is_local_origin() {
  case "${1:-}" in
    http://localhost*|https://localhost*|http://127.*|https://127.*) return 0 ;;
  esac
  return 1
}

# validate_turn_ip IP ORIGIN ALLOW_PRIVATE — returns 1 when the address must not
# be advertised to remote participants. Prints an actionable reason.
validate_turn_ip() {
  local ip=${1:-} origin=${2:-} allow_private=${3:-0} class
  class=$(classify_ipv4 "$ip")
  case "$class" in
    public)
      ok "TURN external IPv4 ${ip} is publicly routable"
      return 0
      ;;
    invalid)
      fail "TURN_EXTERNAL_IP '${ip}' is not a valid IPv4 address (expected e.g. 203.0.113.10)"
      return 1
      ;;
    unspecified)
      fail "TURN_EXTERNAL_IP is 0.0.0.0; it is not a usable relay address for any client"
      return 1
      ;;
    loopback)
      if is_local_origin "$origin"; then
        ok "TURN external IPv4 127.0.0.1 (calls on this host only)"
      else
        warn "TURN_EXTERNAL_IP is loopback while the public origin is ${origin}; remote participants will receive an unroutable candidate."
        warn "fix: re-run with --turn-ip <public-ip>"
      fi
      return 0
      ;;
    private)
      if is_local_origin "$origin"; then
        warn "TURN_EXTERNAL_IP ${ip} is a private (RFC1918/CGNAT) address: only participants that can route to this LAN can use the relay."
        return 0
      fi
      if [ "$allow_private" -eq 1 ]; then
        warn "TURN_EXTERNAL_IP ${ip} is private (RFC1918/CGNAT); --allow-private-ip is set, so this is accepted for a LAN/dev trial only."
        warn "Do not use this for a customer deployment: remote participants cannot reach ${ip}."
        return 0
      fi
      fail "TURN_EXTERNAL_IP ${ip} is a private (RFC1918/CGNAT) address but the public origin is ${origin}."
      fail "Remote participants would receive an unroutable relay candidate (ICE connects, no media)."
      fail "Fix: re-run with --turn-ip <public-ip>. For a LAN/dev trial only, add --allow-private-ip."
      return 1
      ;;
  esac
  fail "could not classify TURN_EXTERNAL_IP '${ip}'"
  return 1
}

check_ports() {
  info "Ports"
  local problems=0 p
  for p in "${AGIL_HTTP_PORT:-8787}" "${TURN_PORT:-3478}"; do
    if port_free_tcp "$p"; then ok "tcp/$p free"; else warn "tcp/$p is already in use (pick another port or stop the other service)"; problems=$((problems + 1)); fi
  done
  if port_free_udp "${TURN_PORT:-3478}"; then ok "udp/${TURN_PORT:-3478} free"; else warn "udp/${TURN_PORT:-3478} is already in use"; problems=$((problems + 1)); fi
  local used=0
  for p in $(seq "${TURN_MIN_PORT:-49200}" "${TURN_MAX_PORT:-49250}"); do
    if ! port_free_udp "$p"; then used=$((used + 1)); fi
  done
  if [ "$used" -eq 0 ]; then ok "udp/${TURN_MIN_PORT:-49200}-${TURN_MAX_PORT:-49250} relay range free"; else warn "${used} port(s) in the TURN relay range are already in use"; problems=$((problems + 1)); fi
  [ "$problems" -eq 0 ]
}

check_dns() {
  info "DNS"
  local host
  host=$(origin_host "$AGIL_PUBLIC_ORIGIN")
  case "$host" in
    localhost|127.0.0.1|"") ok "local origin (${AGIL_PUBLIC_ORIGIN}) — no DNS needed"; return 0 ;;
  esac
  if have getent && getent hosts "$host" >/dev/null 2>&1; then
    ok "${host} resolves ($(getent hosts "$host" | awk '{print $1}' | tr '\n' ' '))"
  elif have dig && [ -n "$(dig +short "$host" 2>/dev/null)" ]; then
    ok "${host} resolves ($(dig +short "$host" | tr '\n' ' '))"
  elif have nslookup && nslookup "$host" >/dev/null 2>&1; then
    ok "${host} resolves"
  else
    warn "${host} does not resolve yet. Create the A/AAAA record before the first call; HTTPS issuance will fail otherwise."
    return 1
  fi
  local public_ip
  public_ip=$(detect_public_ip || true)
  if [ -n "$public_ip" ] && ! printf '%s' "$public_ip" | grep -Eq '^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\.'; then
    info "public IPv4 detected: ${public_ip} (set TURN_EXTERNAL_IP=${public_ip} if this host is directly exposed)"
  fi
  return 0
}

check_resources() {
  info "Disk / memory"
  local avail_kb total_kb
  avail_kb=$(df -Pk "$SCRIPT_DIR" | awk 'NR==2 {print $4}')
  if [ -n "${avail_kb:-}" ]; then
    if [ "$avail_kb" -lt 5242880 ]; then warn "less than 5 GiB free on the volume holding $SCRIPT_DIR"; else ok "$((avail_kb / 1024 / 1024)) GiB free disk"; fi
  fi
  if [ -r /proc/meminfo ]; then
    total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    if [ -n "${total_kb:-}" ]; then
      if [ "$total_kb" -lt 1800000 ]; then warn "less than 2 GiB RAM; core + build may be killed by the OOM killer"; else ok "$((total_kb / 1024 / 1024)) GiB RAM"; fi
    fi
  fi
  local cpus
  cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
  if [ "${cpus:-0}" -ge 2 ]; then ok "${cpus} CPUs"; else warn "1 CPU: builds are slow and a busy call may stutter"; fi
}

# ------------------------------------------------------------------- .env

generate_env() {
  info "Preparing ${ENV_FILE}"

  local token_secret ip_salt api_key turn_password public_origin turn_host turn_ip
  local allow_private_value=0 ice tenant realm
  token_secret=$(rand_hex 32)
  ip_salt=$(rand_hex 16)
  api_key="agil_$(rand_hex 12)"
  turn_password=$(rand_hex 24)

  if [ -n "$PUBLIC_ORIGIN_ARG" ]; then
    public_origin=$PUBLIC_ORIGIN_ARG
  elif [ -n "$DOMAIN" ]; then
    public_origin="https://${DOMAIN}"
  else
    public_origin=$(get_env AGIL_PUBLIC_ORIGIN)
    [ -n "$public_origin" ] || public_origin="http://localhost:8787"
  fi
  public_origin=${public_origin%/}

  turn_host=${ICE_HOST_ARG:-$(origin_host "$public_origin")}
  [ -n "$turn_host" ] || turn_host="127.0.0.1"

  # Pick the relay address. An explicit --turn-ip is authoritative; otherwise
  # keep a routable value already in .env and re-detect only when it is missing,
  # loopback, or malformed. Detection can fall back to the local interface
  # address; validate_turn_ip classifies and refuses private values below.
  if [ -n "$TURN_IP_ARG" ]; then
    turn_ip=$TURN_IP_ARG
  else
    turn_ip=$(get_env TURN_EXTERNAL_IP)
    case "$(classify_ipv4 "$turn_ip")" in
      loopback|invalid|unspecified) turn_ip=$(detect_public_ip || true) ;;
    esac
  fi
  [ -n "$turn_ip" ] || turn_ip="127.0.0.1"

  if [ "$ALLOW_PRIVATE_IP" -eq 1 ] || [ "$(get_env TURN_ALLOW_PRIVATE_IP)" = "1" ]; then
    allow_private_value=1
  fi

  # Validate before writing anything: never persist a config that advertises an
  # unroutable TURN relay candidate to remote participants.
  validate_turn_ip "$turn_ip" "$public_origin" "$allow_private_value" || return 1

  if [ "$FORCE" -eq 1 ] && [ -f "$ENV_FILE" ]; then
    local backup
    backup=".env.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    run cp -p "$ENV_FILE" "$backup"
    warn "existing .env backed up to ${backup} (mode 0600); it contains the old secrets"
  fi
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$ENV_EXAMPLE" ] || die "${ENV_EXAMPLE} is missing"
    run cp "$ENV_EXAMPLE" "$ENV_FILE"
    run chmod 600 "$ENV_FILE"
  fi

  ice=$(printf '[{"urls":"stun:%s:%s"},{"urls":"turn:%s:%s","username":"%s","credential":"%s"}]' \
    "$turn_host" "${TURN_PORT:-3478}" "$turn_host" "${TURN_PORT:-3478}" "${TURN_USER:-agil}" "$turn_password")

  tenant=$(get_env AGIL_DEFAULT_TENANT)
  [ -n "$tenant" ] || tenant="demo"
  realm=${DOMAIN:-$(get_env TURN_REALM)}
  [ -n "$realm" ] || realm="agil.local"

  set_env AGIL_PUBLIC_ORIGIN "$public_origin"
  set_env AGIL_TOKEN_SECRET "$token_secret"
  set_env AGIL_IP_SALT "$ip_salt"
  set_env AGIL_DEFAULT_TENANT "$tenant"
  set_env AGIL_API_KEYS "${api_key}:${tenant}"
  set_env AGIL_ICE_SERVERS "$ice"
  set_env TURN_PASSWORD "$turn_password"
  set_env TURN_EXTERNAL_IP "$turn_ip"
  set_env TURN_ALLOW_PRIVATE_IP "$allow_private_value"
  set_env TURN_REALM "$realm"
  chmod 600 "$ENV_FILE"

  ok "secrets generated (token secret, IP salt, API key, TURN password)"
  ok "public origin: ${public_origin}"
  ok "TURN: ${turn_host}:${TURN_PORT:-3478} · external-ip ${turn_ip}"
  if [ "$allow_private_value" -eq 1 ]; then
    warn "TURN_EXTERNAL_IP is private and TURN_ALLOW_PRIVATE_IP=1 (dev/LAN only; never for a customer deployment)."
  else
    warn "TURN uses one static shared credential for every client (quotas bound abuse); production should use the TURN REST API with short-lived credentials."
  fi
  ok "first API key written to .env (tenant: $(get_env AGIL_DEFAULT_TENANT))"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "${ENV_FILE} not found. Run ./install.sh first."
  AGIL_PUBLIC_ORIGIN=$(get_env AGIL_PUBLIC_ORIGIN)
  AGIL_HTTP_PORT=${AGIL_HTTP_PORT:-$(get_env AGIL_HTTP_PORT)}
  AGIL_HTTP_PORT=${AGIL_HTTP_PORT:-8787}
  TURN_PORT=${TURN_PORT:-$(get_env TURN_PORT)}
  TURN_PORT=${TURN_PORT:-3478}
  TURN_MIN_PORT=${TURN_MIN_PORT:-$(get_env TURN_MIN_PORT)}
  TURN_MIN_PORT=${TURN_MIN_PORT:-49200}
  TURN_MAX_PORT=${TURN_MAX_PORT:-$(get_env TURN_MAX_PORT)}
  TURN_MAX_PORT=${TURN_MAX_PORT:-49250}
  TURN_USER=${TURN_USER:-$(get_env TURN_USER)}
  TURN_USER=${TURN_USER:-agil}
}

validate_env() {
  info "Validating ${ENV_FILE}"
  [ "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo 600)" = "600" ] \
    || warn "${ENV_FILE} should be mode 0600 (chmod 600 ${ENV_FILE})"

  local required key value missing=0
  for required in AGIL_PUBLIC_ORIGIN AGIL_TOKEN_SECRET AGIL_API_KEYS AGIL_IP_SALT AGIL_ICE_SERVERS TURN_PASSWORD; do
    value=$(get_env "$required")
    if [ -z "$value" ]; then fail "${required} is empty"; missing=1; fi
  done
  [ "$missing" -eq 0 ] || die "fill the missing values or run ./install.sh --force"

  case "$AGIL_PUBLIC_ORIGIN" in
    http://*|https://*) ;;
    *) die "AGIL_PUBLIC_ORIGIN must start with http:// or https:// (got '${AGIL_PUBLIC_ORIGIN}')" ;;
  esac
  if printf '%s' "$AGIL_PUBLIC_ORIGIN" | grep -qE '/$'; then warn "AGIL_PUBLIC_ORIGIN has a trailing slash; remove it"; fi

  local token_secret
  token_secret=$(get_env AGIL_TOKEN_SECRET)
  [ "${#token_secret}" -ge 32 ] || die "AGIL_TOKEN_SECRET must be at least 32 characters"
  case "$(get_env AGIL_API_KEYS)" in
    *:*) ok "API key format looks valid" ;;
    *) die "AGIL_API_KEYS must be 'key:tenant' (comma-separated for several keys)" ;;
  esac
  printf '%s' "$(get_env AGIL_ICE_SERVERS)" | grep -q '"urls"' || die "AGIL_ICE_SERVERS must be a JSON array with a urls field"
  printf '%s' "$(get_env AGIL_ICE_SERVERS)" | grep -q 'turn:' || warn "AGIL_ICE_SERVERS has no turn: URL; calls through NAT/corporate networks will fail"

  # TURN port/range sanity: host mapping, container listener and coturn all use
  # these same numbers, so an invalid range breaks media instead of failing.
  local port
  for port in "$TURN_PORT" "$TURN_MIN_PORT" "$TURN_MAX_PORT"; do
    case "$port" in
      ''|*[!0-9]*) die "TURN_PORT/TURN_MIN_PORT/TURN_MAX_PORT must be integers (got '${port}')" ;;
    esac
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
      die "TURN port ${port} is outside 1..65535"
    fi
  done
  [ "$TURN_MAX_PORT" -ge "$TURN_MIN_PORT" ] || die "TURN_MAX_PORT (${TURN_MAX_PORT}) must be >= TURN_MIN_PORT (${TURN_MIN_PORT})"
  if [ "$TURN_MIN_PORT" -le 1024 ]; then
    warn "TURN relay range ${TURN_MIN_PORT}-${TURN_MAX_PORT} overlaps privileged ports; keep it above 1024"
  fi

  local quota
  for quota in TURN_TOTAL_QUOTA TURN_USER_QUOTA; do
    value=$(get_env "$quota")
    [ -n "$value" ] || continue
    case "$value" in
      ''|*[!0-9]*) die "${quota} must be a non-negative integer (got '${value}')" ;;
    esac
  done

  # Refuse to start with an unroutable relay address (P2-3): RFC1918/CGNAT is
  # accepted only for a local origin or with an explicit dev opt-in.
  local turn_ip allow_private
  turn_ip=$(get_env TURN_EXTERNAL_IP)
  [ -n "$turn_ip" ] || turn_ip="127.0.0.1"
  allow_private=$(get_env TURN_ALLOW_PRIVATE_IP)
  [ -n "$allow_private" ] || allow_private=0
  [ "$ALLOW_PRIVATE_IP" -eq 1 ] && allow_private=1
  validate_turn_ip "$turn_ip" "$AGIL_PUBLIC_ORIGIN" "$allow_private" \
    || die "refusing to start with an unroutable TURN relay address (see above)"
  if [ "$(get_env TURN_ALLOW_PRIVATE_IP)" = "1" ]; then
    warn "TURN_ALLOW_PRIVATE_IP=1: private relay address accepted for dev/LAN only"
  fi

  if [ "$(get_env AGIL_ALLOW_ANONYMOUS)" = "1" ]; then
    warn "AGIL_ALLOW_ANONYMOUS=1: anyone can create rooms. Use 0 for a customer deployment."
  fi

  info "Validating compose file"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] docker compose -f %s config -q\n' "$COMPOSE_FILE"
  elif have docker && docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" config -q || die "docker compose config failed (see the error above)"
    ok "compose config is valid"
  else
    warn "docker compose is not available; skipped compose config validation"
  fi
}

# ------------------------------------------------------------------ start

wait_for_core() {
  local url="http://127.0.0.1:${AGIL_HTTP_PORT}/v1/health" i
  info "Waiting for core health (${url})"
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -q '"ok":true'; then
      ok "core is healthy after ~$((i * 3))s"
      return 0
    fi
    sleep 3
  done
  warn "core did not become healthy in 180s. Inspect: docker compose logs --tail=100 core"
  return 1
}

mint_node_token() {
  local api_key core_url response token
  api_key=$(get_env AGIL_API_KEYS | cut -d',' -f1 | cut -d':' -f1)
  core_url="http://127.0.0.1:${AGIL_HTTP_PORT}"
  info "Minting a one-time node enrollment token"
  response=$(curl -sS --max-time 10 -X POST \
    -H "content-type: application/json" \
    -H "x-api-key: ${api_key}" \
    -d '{"kind":"node","role":"sfu","features":["sfu"],"ttlSec":3600,"uses":1,"label":"quickstart"}' \
    "${core_url}/v1/admin/cluster/tokens" 2>/dev/null || true)
  token=$(printf '%s' "$response" | json_get token 2>/dev/null || true)
  if [ -z "$token" ]; then
    warn "could not mint a node token automatically. Response: $(printf '%s' "$response" | head -c 300)"
    warn "Open <origin>/dashboard/ → Cluster/Nodes, create a node token, put it in .env as AGIL_NODE_TOKEN, then:"
    warn "  docker compose up -d node"
    return 1
  fi
  set_env AGIL_NODE_TOKEN "$token"
  ok "node enrollment token stored in .env (one-time, 1h TTL)"
}

start_stack() {
  info "Building the core image (also used by the node enrollment loop)"
  run docker compose build core || die "image build failed"
  info "Starting core, TURN and Redis"
  run docker compose up -d core turn redis || die "docker compose up failed"
  [ "$DRY_RUN" -eq 1 ] && return 0
  wait_for_core || exit 2

  if [ -n "$(get_env AGIL_NODE_TOKEN)" ]; then
    ok "AGIL_NODE_TOKEN already present; reusing it"
  else
    mint_node_token || warn "node will not be started until a token is set"
  fi

  if [ -n "$(get_env AGIL_NODE_TOKEN)" ]; then
    info "Starting node enrollment loop"
    run docker compose up -d node || die "could not start the node loop"
    sleep 2
    docker compose ps node >/dev/null 2>&1 || true
  fi

  echo
  ok "stack is up"
  printf '  demo:       %s/\n' "$AGIL_PUBLIC_ORIGIN"
  printf '  dashboard:  %s/dashboard/\n' "$AGIL_PUBLIC_ORIGIN"
  printf '  editor:     %s/editor/\n' "$AGIL_PUBLIC_ORIGIN"
  printf '  health:     http://127.0.0.1:%s/v1/health\n' "$AGIL_HTTP_PORT"
  printf '  smoke:      ./smoke.sh\n'
  printf '  doctor:     ./doctor.sh\n'
  printf '  first room: ./smoke.sh --keep   (prints a join URL)\n'
}

# ------------------------------------------------------------------- main

main() {
  info "AgilFrame quickstart installer"
  info "directory: ${SCRIPT_DIR}"
  [ "$DRY_RUN" -eq 1 ] && warn "dry-run: no files, containers or networks will be changed"

  if [ "$ACTION_CHECK_ONLY" -eq 1 ]; then
    # Read-only validation must not require a running Docker daemon (P3-10).
    if have docker && docker compose version >/dev/null 2>&1; then
      check_docker_cli
      docker info >/dev/null 2>&1 || warn "the Docker daemon is not reachable; skipped live container checks (compose config does not need it)"
    else
      warn "docker compose is not available; skipped compose config validation"
    fi
    [ -f "$ENV_FILE" ] || die "${ENV_FILE} not found; nothing to check"
    load_env
    validate_env
    check_ports || warn "some ports are busy; see the warnings above"
    check_dns || true
    check_resources
    ok "check complete"
    return 0
  fi

  check_docker

  # Dry-run without an existing .env: never touch disk, just report checks.
  if [ "$DRY_RUN" -eq 1 ] && [ ! -f "$ENV_FILE" ]; then
    AGIL_PUBLIC_ORIGIN=${PUBLIC_ORIGIN_ARG:-${DOMAIN:+https://$DOMAIN}}
    AGIL_PUBLIC_ORIGIN=${AGIL_PUBLIC_ORIGIN:-http://localhost:8787}
    AGIL_HTTP_PORT=8787; TURN_PORT=3478; TURN_MIN_PORT=49200; TURN_MAX_PORT=49250; TURN_USER=agil
    info "would generate ${ENV_FILE} from ${ENV_EXAMPLE} (secrets, ICE list, API key)"
    check_ports || warn "fix port conflicts before starting"
    check_dns || warn "DNS is not ready"
    check_resources
    if [ "$ACTION_START" -eq 1 ]; then
      info "would run: docker compose build core"
      info "would run: docker compose up -d core turn redis"
      info "would wait for /v1/health, mint a node token, then start node"
    fi
    return 0
  fi

  if [ -f "$ENV_FILE" ] && [ "$FORCE" -eq 0 ]; then
    load_env
    if [ -z "$(get_env AGIL_TOKEN_SECRET)" ] || [ -z "$(get_env AGIL_API_KEYS)" ] || [ -z "$(get_env TURN_PASSWORD)" ]; then
      die "${ENV_FILE} exists but has empty secrets. Re-run with --force to create a backup and regenerate it."
    fi
    info "using existing ${ENV_FILE} (pass --force to regenerate secrets)"
    AGIL_PUBLIC_ORIGIN=$(get_env AGIL_PUBLIC_ORIGIN)
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      info "would generate ${ENV_FILE} from ${ENV_EXAMPLE}"
      AGIL_PUBLIC_ORIGIN=${PUBLIC_ORIGIN_ARG:-${DOMAIN:+https://$DOMAIN}}
      AGIL_PUBLIC_ORIGIN=${AGIL_PUBLIC_ORIGIN:-http://localhost:8787}
    else
      generate_env
      load_env
    fi
  fi

  load_env
  validate_env
  check_ports || warn "fix port conflicts before starting"
  check_dns || warn "DNS is not ready; HTTP still works locally"
  check_resources

  if [ "$ACTION_START" -eq 1 ]; then
    start_stack
  else
    echo
    ok "configuration is ready"
    printf '  start:  ./install.sh --start   (mints a node token, recommended)\n'
    printf '  or:     docker compose up -d --build   (core/turn/redis; node needs AGIL_NODE_TOKEN)\n'
    printf '  check:  ./doctor.sh\n'
  fi
}

main "$@"
