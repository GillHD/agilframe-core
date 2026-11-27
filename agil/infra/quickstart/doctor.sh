#!/usr/bin/env bash
# AgilFrame — read-only health doctor for the quickstart stack.
#
# Checks: containers, core health, static apps, Redis, node enrollment,
# TURN/ports, DNS, disk, memory and TLS expiry. It changes nothing: no
# restarts, no writes, no firewall/proxy edits.
#
# Usage:
#   ./doctor.sh              human report
#   ./doctor.sh --json       one JSON object (needs python3 or node)
#   ./doctor.sh --quiet      only warnings/failures
#
# Exit codes: 0 all good, 1 warnings, 2 at least one critical failure.

set -uo pipefail
IFS=$'\n\t'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR" || exit 1

# shellcheck disable=SC1091
# shellcheck source=lib/net.sh
. "$SCRIPT_DIR/lib/net.sh"

ENV_FILE=".env"
COMPOSE_FILE="docker-compose.yml"

JSON=0
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "$JSON" -eq 0 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''
fi

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
RESULTS=()

have() { command -v "$1" >/dev/null 2>&1; }

PY=""
if have python3; then PY=python3; elif have python; then PY=python; fi
if [ -n "$PY" ]; then export PYTHONIOENCODING=utf-8; fi

record() { # record STATUS NAME DETAIL
  local status=$1 name=$2 detail=${3:-}
  RESULTS+=("${status}|${name}|${detail}")
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac
  if [ "$JSON" -eq 1 ]; then return 0; fi
  if [ "$QUIET" -eq 1 ] && [ "$status" = "PASS" ]; then return 0; fi
  case "$status" in
    PASS) printf '%s  ok %s%s %s\n' "$C_GREEN" "$C_RESET" "$name" "$detail" ;;
    WARN) printf '%swarn%s %s %s\n' "$C_YELLOW" "$C_RESET" "$name" "$detail" ;;
    FAIL) printf '%sFAIL%s %s %s\n' "$C_RED" "$C_RESET" "$name" "$detail" ;;
  esac
}

section() { [ "$JSON" -eq 1 ] && return 0; printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

get_env() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$ENV_FILE"
}

origin_host() { printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##; s#:[0-9]+$##'; }

is_loopback() { case "$1" in 127.*|localhost|::1|"") return 0 ;; esac; return 1; }

http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || printf '000'; }

json_field() { # json_field KEY — top-level string field from stdin
  local key=$1
  if [ -n "$PY" ]; then
    "$PY" -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(3)
v=d.get(sys.argv[1], "")
print(v if isinstance(v,str) else ("" if v is None else v))' "$key" 2>/dev/null
  elif have node; then
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(v))}catch{process.exit(3)}})' "$key" 2>/dev/null
  else
    return 3
  fi
}

# ------------------------------------------------------------------- env

load_settings() {
  AGIL_PUBLIC_ORIGIN=$(get_env AGIL_PUBLIC_ORIGIN)
  [ -n "$AGIL_PUBLIC_ORIGIN" ] || AGIL_PUBLIC_ORIGIN="http://localhost:8787"
  AGIL_HTTP_PORT=$(get_env AGIL_HTTP_PORT); [ -n "$AGIL_HTTP_PORT" ] || AGIL_HTTP_PORT=8787
  TURN_PORT=$(get_env TURN_PORT); [ -n "$TURN_PORT" ] || TURN_PORT=3478
  TURN_MIN_PORT=$(get_env TURN_MIN_PORT); [ -n "$TURN_MIN_PORT" ] || TURN_MIN_PORT=49200
  TURN_MAX_PORT=$(get_env TURN_MAX_PORT); [ -n "$TURN_MAX_PORT" ] || TURN_MAX_PORT=49250
  TURN_EXTERNAL_IP=$(get_env TURN_EXTERNAL_IP)
  AGIL_DISK_WARN_PCT=${AGIL_DISK_WARN_PCT:-80}
  AGIL_DISK_CRIT_PCT=${AGIL_DISK_CRIT_PCT:-90}
  AGIL_MEM_WARN_PCT=${AGIL_MEM_WARN_PCT:-85}
  AGIL_MEM_CRIT_PCT=${AGIL_MEM_CRIT_PCT:-95}
  AGIL_TLS_WARN_DAYS=${AGIL_TLS_WARN_DAYS:-21}
  AGIL_TLS_CRIT_DAYS=${AGIL_TLS_CRIT_DAYS:-7}
  LOCAL_BASE="http://127.0.0.1:${AGIL_HTTP_PORT}"
}

# ------------------------------------------------------------------ checks

check_env_file() {
  section "Configuration"
  if [ ! -f "$ENV_FILE" ]; then
    record FAIL "env file" "${ENV_FILE} missing — run ./install.sh"
    return
  fi
  local mode
  mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '?')
  if [ "$mode" = "600" ]; then record PASS "env file mode" "0600"; else record WARN "env file mode" "${mode} (recommended 0600: chmod 600 ${ENV_FILE})"; fi

  local missing="" key
  for key in AGIL_PUBLIC_ORIGIN AGIL_TOKEN_SECRET AGIL_API_KEYS AGIL_IP_SALT AGIL_ICE_SERVERS TURN_PASSWORD; do
    [ -n "$(get_env "$key")" ] || missing="${missing} ${key}"
  done
  if [ -n "$missing" ]; then record FAIL "required env" "empty:${missing}"; else record PASS "required env" "all required values set"; fi

  local token_secret
  token_secret=$(get_env AGIL_TOKEN_SECRET)
  if [ "${#token_secret}" -ge 32 ]; then record PASS "token secret length" "${#token_secret} chars"; else record FAIL "token secret length" "${#token_secret} (need >=32)"; fi

  case "$(get_env TURN_PASSWORD)" in
    ""|CHANGE_ME*|changeme*) record FAIL "turn password" "unset or placeholder" ;;
    *) record PASS "turn password" "set" ;;
  esac

  if [ "$(get_env AGIL_ALLOW_ANONYMOUS)" = "1" ]; then record WARN "anonymous rooms" "AGIL_ALLOW_ANONYMOUS=1 (demo only)"; else record PASS "anonymous rooms" "disabled"; fi

  case "$AGIL_PUBLIC_ORIGIN" in
    https://*) record PASS "public origin" "$AGIL_PUBLIC_ORIGIN (https)" ;;
    http://localhost*|http://127.*) record WARN "public origin" "$AGIL_PUBLIC_ORIGIN (local trial only)";;
    http://*) record FAIL "public origin" "$AGIL_PUBLIC_ORIGIN (http is not acceptable for a customer deployment)";;
    *) record FAIL "public origin" "invalid: $AGIL_PUBLIC_ORIGIN";;
  esac

  if [ "$(get_env AGIL_DOCS_ENABLED)" = "1" ]; then record WARN "docs exposure" "AGIL_DOCS_ENABLED=1 — keep /docs behind the admin allowlist or disable"; else record PASS "docs exposure" "disabled"; fi
  if [ "$(get_env AGIL_ADMIN_API_ENABLED)" = "1" ]; then record PASS "admin API" "enabled (expects an API key/allowlist at the proxy)"; else record PASS "admin API" "disabled"; fi
}

check_docker() {
  section "Docker"
  if ! have docker; then record FAIL "docker" "not installed"; return 1; fi
  if ! docker info >/dev/null 2>&1; then record FAIL "docker daemon" "not reachable"; return 1; fi
  record PASS "docker" "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
  if docker compose version >/dev/null 2>&1; then
    record PASS "compose" "$(docker compose version --short 2>/dev/null || echo v2)"
  else
    record FAIL "compose" "docker compose v2 not available"
    return 1
  fi
  return 0
}

check_compose_config() {
  section "Compose"
  if docker compose -f "$COMPOSE_FILE" config -q >/dev/null 2>&1; then
    record PASS "compose config" "valid"
  else
    record FAIL "compose config" "invalid — run: docker compose -f ${COMPOSE_FILE} config"
  fi
}

check_containers() {
  section "Containers"
  local svc cid state health
  for svc in core node turn redis; do
    cid=$(docker compose -f "$COMPOSE_FILE" ps -a -q "$svc" 2>/dev/null | head -n1)
    if [ -z "$cid" ]; then
      record FAIL "container ${svc}" "not created"
      continue
    fi
    state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)
    if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
      record PASS "container ${svc}" "running (${health})"
    elif [ "$state" = "running" ]; then
      record WARN "container ${svc}" "running, health=${health}"
    else
      record FAIL "container ${svc}" "state=${state} health=${health}"
    fi
  done
}

check_core() {
  section "Core"
  local body code
  body=$(curl -fsS --max-time 8 "${LOCAL_BASE}/v1/health" 2>/dev/null)
  code=$?
  if [ "$code" -eq 0 ] && printf '%s' "$body" | grep -q '"ok":true'; then
    local version rooms
    version=$(printf '%s' "$body" | json_field version 2>/dev/null || true)
    rooms=$(printf '%s' "$body" | json_field rooms 2>/dev/null || true)
    record PASS "GET /v1/health" "ok ${version:+v$version }rooms=${rooms:-?}"
  else
    record FAIL "GET /v1/health" "no healthy response on ${LOCAL_BASE}"
  fi

  if printf '%s' "$body" | grep -q '"ok":true'; then
    local path status
    for path in / /dashboard/ /editor/; do
      status=$(http_code "${LOCAL_BASE}${path}")
      case "$status" in
        200) record PASS "static ${path}" "HTTP 200" ;;
        000) record FAIL "static ${path}" "no response (is core running?)" ;;
        *) record WARN "static ${path}" "HTTP ${status} (build may be missing ${path%%/})" ;;
      esac
    done
    status=$(http_code "${LOCAL_BASE}/v1/ice")
    if [ "$status" = "200" ]; then record PASS "GET /v1/ice" "ICE list available"; else record FAIL "GET /v1/ice" "HTTP ${status}"; fi
  fi
}

check_redis() {
  section "Redis"
  if docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    record PASS "redis ping" "PONG"
  else
    record WARN "redis ping" "no PONG (expected only if redis is stopped; core does not need it yet)"
  fi
}

check_node() {
  section "Node enrollment"
  local age
  if docker compose -f "$COMPOSE_FILE" exec -T node sh -c 'test -s /app/.data/node.json' >/dev/null 2>&1; then
    age=$(docker compose -f "$COMPOSE_FILE" exec -T node sh -c \
      'now=$(date +%s); last=$(cat /app/.data/heartbeat-at 2>/dev/null || echo 0); echo $((now-last))' 2>/dev/null | tr -d '\r\n ')
    if [ -n "$age" ] && [ "$age" -lt 90 ] 2>/dev/null; then
      record PASS "node heartbeat" "accepted ${age}s ago"
    else
      record WARN "node heartbeat" "stale or missing (${age:-?}s) — check logs and the node token"
    fi
  else
    record WARN "node enrollment" "not enrolled — token missing/used, core unreachable, or state volume empty"
  fi

  local api_key cluster nodes
  api_key=$(get_env AGIL_API_KEYS | cut -d',' -f1 | cut -d':' -f1)
  if [ -n "$api_key" ]; then
    cluster=$(curl -sS --max-time 8 -H "x-api-key: ${api_key}" "${LOCAL_BASE}/v1/admin/cluster/status" 2>/dev/null || true)
    if printf '%s' "$cluster" | grep -q '"nodes"'; then
      if [ -n "$PY" ]; then
        nodes=$(printf '%s' "$cluster" | "$PY" -c 'import json,sys
d=json.load(sys.stdin)
print(len(d.get("nodes",[])), d.get("counts",{}).get("online", "?"))' 2>/dev/null || true)
      fi
      record PASS "cluster registry" "nodes=${nodes:-registered} (GET /v1/admin/cluster/status)"
    elif printf '%s' "$cluster" | grep -q '"error"'; then
      record WARN "cluster registry" "admin cluster API rejected the key (or is not in this core build)"
    else
      record WARN "cluster registry" "no cluster status (older core / admin API disabled)"
    fi
  else
    record WARN "cluster registry" "no API key in .env"
  fi
}

check_turn() {
  section "TURN / WebRTC"
  if timeout 3 bash -c "</dev/tcp/127.0.0.1/${TURN_PORT}" 2>/dev/null; then
    record PASS "turn tcp/${TURN_PORT}" "accepting connections"
  else
    record FAIL "turn tcp/${TURN_PORT}" "not listening on 127.0.0.1"
  fi

  local udp
  udp=$(ss -lunH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${TURN_PORT}$" && echo yes || echo no)
  if [ "$udp" = "yes" ]; then record PASS "turn udp/${TURN_PORT}" "bound"; else record WARN "turn udp/${TURN_PORT}" "not visible via ss (could be in a netns)"; fi

  local relay=0 p
  for p in $(seq "$TURN_MIN_PORT" "$TURN_MAX_PORT"); do
    if ss -lunH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}$"; then relay=$((relay + 1)); fi
  done
  if [ "$relay" -gt 0 ]; then record PASS "turn relay range" "${relay} UDP port(s) bound in ${TURN_MIN_PORT}-${TURN_MAX_PORT}"; else record WARN "turn relay range" "no bound relay ports detected"; fi

  case "$(classify_ipv4 "$TURN_EXTERNAL_IP")" in
    public) record PASS "turn external ip" "$TURN_EXTERNAL_IP" ;;
    loopback)
      case "$AGIL_PUBLIC_ORIGIN" in
        http://localhost*|http://127.*|https://localhost*|https://127.*) record PASS "turn external ip" "127.0.0.1 (local trial)" ;;
        *) record FAIL "turn external ip" "loopback while origin is ${AGIL_PUBLIC_ORIGIN}; remote calls will fail" ;;
      esac
      ;;
    private)
      if [ "$(get_env TURN_ALLOW_PRIVATE_IP)" = "1" ]; then
        record WARN "turn external ip" "${TURN_EXTERNAL_IP} is private (dev/LAN opt-in)"
      else
        case "$AGIL_PUBLIC_ORIGIN" in
          http://localhost*|http://127.*|https://localhost*|https://127.*) record WARN "turn external ip" "${TURN_EXTERNAL_IP} is private (LAN-only trial)" ;;
          *) record FAIL "turn external ip" "${TURN_EXTERNAL_IP} is RFC1918/CGNAT while origin is ${AGIL_PUBLIC_ORIGIN}; remote media will fail (P2-3)" ;;
        esac
      fi
      ;;
    unspecified) record FAIL "turn external ip" "0.0.0.0 is not a usable relay address" ;;
    *) record FAIL "turn external ip" "invalid IPv4 '${TURN_EXTERNAL_IP}'" ;;
  esac

  local ice
  ice=$(get_env AGIL_ICE_SERVERS)
  if printf '%s' "$ice" | grep -q 'turn:'; then record PASS "ice config" "turn URL present"; else record FAIL "ice config" "no turn: URL"; fi
  if printf '%s' "$ice" | grep -q 'stun:'; then record PASS "ice config" "stun URL present"; else record WARN "ice config" "no stun: URL"; fi
}

check_ports() {
  section "Host ports"
  local p
  for p in 80 443 "${AGIL_HTTP_PORT}" "${TURN_PORT}"; do
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}$"; then
      record PASS "tcp/${p}" "listening"
    else
      case "$p" in
        80|443) record WARN "tcp/${p}" "not listening — expected only when a local proxy terminates TLS" ;;
        *) record FAIL "tcp/${p}" "not listening" ;;
      esac
    fi
  done
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '[:.](80|443)$'; then
    record PASS "reverse proxy" "something listens on 80/443"
  else
    record WARN "reverse proxy" "no listener on 80/443 — set one up before announcing the domain (see ../examples/)"
  fi
}

check_disk() {
  section "Disk"
  local path=${AGIL_DISK_PATH:-$SCRIPT_DIR}
  local pct
  pct=$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {total=$3+$4; if (total>0) printf "%d", $3*100/total}')
  if [ -z "$pct" ]; then record WARN "disk" "could not read usage for ${path}"; return; fi
  if [ "$pct" -ge "$AGIL_DISK_CRIT_PCT" ]; then record FAIL "disk" "${pct}% used on ${path} (crit ${AGIL_DISK_CRIT_PCT}%)"
  elif [ "$pct" -ge "$AGIL_DISK_WARN_PCT" ]; then record WARN "disk" "${pct}% used on ${path} (warn ${AGIL_DISK_WARN_PCT}%)"
  else record PASS "disk" "${pct}% used on ${path}"; fi

  local root
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$root" ] && [ -d "$root" ]; then
    local docker_pct
    docker_pct=$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {total=$3+$4; if (total>0) printf "%d", $3*100/total}')
    if [ -n "$docker_pct" ]; then
      if [ "$docker_pct" -ge "$AGIL_DISK_CRIT_PCT" ]; then record FAIL "docker disk" "${docker_pct}% used on ${root}"
      elif [ "$docker_pct" -ge "$AGIL_DISK_WARN_PCT" ]; then record WARN "docker disk" "${docker_pct}% used on ${root}"
      else record PASS "docker disk" "${docker_pct}% used on ${root}"; fi
    fi
  fi
}

check_memory() {
  section "Memory"
  if [ ! -r /proc/meminfo ]; then
    local total_bytes
    total_bytes=$(sysctl -n hw.memsize 2>/dev/null || true)
    if [ -n "$total_bytes" ]; then record PASS "memory" "$((total_bytes / 1024 / 1024 / 1024)) GiB total (usage not parsed on this OS)"; fi
    return
  fi
  local total avail pct
  total=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  avail=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  [ -n "$avail" ] || avail=$(awk '/MemFree/ {print $2}' /proc/meminfo)
  pct=$(( (total - avail) * 100 / total ))
  if [ "$pct" -ge "$AGIL_MEM_CRIT_PCT" ]; then record FAIL "memory" "${pct}% used (crit ${AGIL_MEM_CRIT_PCT}%)"
  elif [ "$pct" -ge "$AGIL_MEM_WARN_PCT" ]; then record WARN "memory" "${pct}% used (warn ${AGIL_MEM_WARN_PCT}%)"
  else record PASS "memory" "${pct}% used, $((avail / 1024)) MiB available"; fi
}

check_dns() {
  section "DNS"
  local host
  host=$(origin_host "$AGIL_PUBLIC_ORIGIN")
  if is_loopback "$host"; then record PASS "dns" "local origin, no DNS needed"; return; fi
  if have getent && getent hosts "$host" >/dev/null 2>&1; then
    record PASS "dns ${host}" "$(getent hosts "$host" | awk '{print $1}' | tr '\n' ' ')"
  elif have dig && [ -n "$(dig +short "$host" 2>/dev/null)" ]; then
    record PASS "dns ${host}" "$(dig +short "$host" | tr '\n' ' ')"
  else
    record FAIL "dns ${host}" "does not resolve"
  fi
}

check_tls() {
  section "TLS"
  case "$AGIL_PUBLIC_ORIGIN" in
    https://*) ;;
    *) record WARN "tls" "public origin is http; terminate TLS at the proxy before a customer deployment"; return ;;
  esac
  local host
  host=$(origin_host "$AGIL_PUBLIC_ORIGIN")
  if ! have openssl; then record WARN "tls" "openssl not installed"; return; fi
  local cert
  cert=$(printf '' | timeout 10 openssl s_client -connect "${host}:443" -servername "$host" 2>/dev/null)
  if [ -z "$cert" ]; then record FAIL "tls" "cannot connect to ${host}:443"; return; fi
  local not_after end_epoch now_epoch days
  not_after=$(printf '%s' "$cert" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$not_after" ]; then record FAIL "tls" "no certificate returned by ${host}:443"; return; fi
  end_epoch=$(date -d "$not_after" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$not_after" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  if [ "$end_epoch" -le 0 ]; then record WARN "tls" "certificate expires ${not_after} (could not compute days)"; return; fi
  days=$(( (end_epoch - now_epoch) / 86400 ))
  if [ "$days" -le 0 ]; then record FAIL "tls" "certificate expired (${not_after})"
  elif [ "$days" -lt "$AGIL_TLS_CRIT_DAYS" ]; then record FAIL "tls" "expires in ${days} days (crit <${AGIL_TLS_CRIT_DAYS})"
  elif [ "$days" -lt "$AGIL_TLS_WARN_DAYS" ]; then record WARN "tls" "expires in ${days} days (warn <${AGIL_TLS_WARN_DAYS})"
  else record PASS "tls" "valid for ${days} days (${not_after})"; fi

  if printf '%s' "$cert" | openssl x509 -noout -checkhost "$host" >/dev/null 2>&1; then
    record PASS "tls hostname" "${host} in certificate SAN"
  else
    record WARN "tls hostname" "certificate may not cover ${host}"
  fi
}

# ------------------------------------------------------------------- output

emit_json() {
  if [ -n "$PY" ]; then
    printf '%s\n' "${RESULTS[@]}" | "$PY" -c '
import json, sys
rows = []
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    status, name, detail = (line.split("|", 2) + ["", ""])[:3]
    rows.append({"status": status.lower(), "check": name, "detail": detail})
print(json.dumps({"ok": not any(r["status"] != "pass" for r in rows),
                  "counts": {"pass": sum(r["status"] == "pass" for r in rows),
                             "warn": sum(r["status"] == "warn" for r in rows),
                             "fail": sum(r["status"] == "fail" for r in rows)},
                  "checks": rows}, indent=2))
'
  elif have node; then
    printf '%s\n' "${RESULTS[@]}" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const rows = s.split("\n").filter(Boolean).map(line => {
    const [status, check, detail] = line.split("|");
    return { status: status.toLowerCase(), check, detail };
  });
  const count = st => rows.filter(r => r.status === st).length;
  console.log(JSON.stringify({ ok: count("fail") === 0, counts: { pass: count("pass"), warn: count("warn"), fail: count("fail") }, checks: rows }, null, 2));
});'
  else
    printf '{"error":"python3 or node is required for --json"}\n'
    return 1
  fi
}

main() {
  load_settings
  if [ "$JSON" -eq 0 ]; then
    printf '%sAGIL quickstart doctor%s\n' "$C_BOLD" "$C_RESET"
    printf 'origin: %s · local: %s\n' "$AGIL_PUBLIC_ORIGIN" "$LOCAL_BASE"
  fi

  check_env_file
  if check_docker; then
    check_compose_config
    check_containers
    check_core
    check_redis
    check_node
    check_turn
    check_ports
    check_disk
    check_memory
    check_dns
    check_tls
  fi

  if [ "$JSON" -eq 1 ]; then
    emit_json
  else
    printf '\n%sSummary:%s %s ok · %s warn · %s fail\n' "$C_BOLD" "$C_RESET" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
    [ "$WARN_COUNT" -gt 0 ] && printf 'See ../README.md §Troubleshooting and agil/core/docs/operations.md for runbooks.\n'
  fi

  if [ "$FAIL_COUNT" -gt 0 ]; then exit 2; fi
  if [ "$WARN_COUNT" -gt 0 ]; then exit 1; fi
  exit 0
}

main "$@"
