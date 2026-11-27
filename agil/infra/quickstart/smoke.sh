#!/usr/bin/env bash
# AgilFrame — quickstart smoke test: health, static apps, ICE and the first room.
#
# It talks to the LOCAL core (http://127.0.0.1:<port>) by default, creates one
# short-lived room with the API key from .env, issues a guest token, checks the
# room read path and deletes the room. With --keep the room is left in place and
# its join URL is printed so you can complete a real first call in a browser.
#
# Nothing outside the room lifecycle is modified. This is a functional check,
# not a load test.
#
# Usage:
#   ./smoke.sh                 run all checks and clean up
#   ./smoke.sh --keep          keep the room and print the join URL
#   ./smoke.sh --url https://calls.example.com --api-key agil_xxx
#   ./smoke.sh --json          machine-readable result

set -uo pipefail
IFS=$'\n\t'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR" || exit 1

ENV_FILE=".env"
BASE=""
API_KEY=""
KEEP=0
JSON=0
TIMEOUT=15
ROOM_CREATED=0
ROOM_ID=""
JOIN_URL=""
TMP=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${JSON:-0}" -eq 0 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_BLUE=''; C_BOLD=''
fi

get_env() {
  [ -f "$ENV_FILE" ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$ENV_FILE"
}

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) BASE=${2:?--url needs a value}; shift ;;
    --api-key) API_KEY=${2:?--api-key needs a value}; shift ;;
    --keep) KEEP=1 ;;
    --json) JSON=1 ;;
    --timeout) TIMEOUT=${2:?--timeout needs a value}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }

json_get() { # json_get JSON DOTTED_PATH
  local json=$1 path=$2
  if have python3; then
    printf '%s' "$json" | python3 -c '
import json, sys
path = sys.argv[1].split(".")
try:
    value = json.load(sys.stdin)
except Exception:
    sys.exit(3)
for part in path:
    if isinstance(value, dict):
        value = value.get(part)
    elif isinstance(value, list) and part.isdigit():
        index = int(part)
        value = value[index] if index < len(value) else None
    else:
        value = None
    if value is None:
        break
if isinstance(value, (str, int, float)):
    print(value)
' "$path" 2>/dev/null
    return 0
  fi
  if have node; then
    printf '%s' "$json" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  try {
    let v = JSON.parse(s);
    for (const part of process.argv[1].split(".")) {
      if (v && typeof v === "object" && !Array.isArray(v)) v = v[part];
      else if (Array.isArray(v) && /^\d+$/.test(part)) v = v[Number(part)];
      else v = undefined;
      if (v === undefined || v === null) break;
    }
    if (typeof v === "string" || typeof v === "number") process.stdout.write(String(v));
  } catch { process.exit(3); }
});' "$path" 2>/dev/null
    return 0
  fi
  return 3
}

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  RESULTS+=("pass|$1|$2")
  [ "$JSON" -eq 1 ] || printf '%s  ok%s %s %s\n' "$C_GREEN" "$C_RESET" "$1" "$2"
}
note() {
  RESULTS+=("note|$1|$2")
  [ "$JSON" -eq 1 ] || printf '%s  -- %s%s %s\n' "$C_BLUE" "$C_RESET" "$1" "$2"
}
bad() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  RESULTS+=("fail|$1|$2")
  [ "$JSON" -eq 1 ] || printf '%sFAIL%s %s %s\n' "$C_RED" "$C_RESET" "$1" "$2"
}

HTTP_STATUS=""
HTTP_BODY=""
HTTP_ERROR=""

http() { # http METHOD URL DATA HEADER...
  local method=$1 url=$2 data=$3
  shift 3
  local args=(-sS --max-time "$TIMEOUT" -o "${TMP}/body" -w '%{http_code}' -X "$method" -H 'accept: application/json')
  if [ -n "$data" ]; then args+=(-H 'content-type: application/json' --data "$data"); fi
  local header
  for header in "$@"; do [ -n "$header" ] && args+=(-H "$header"); done
  HTTP_STATUS=$(curl "${args[@]}" "$url" 2>"${TMP}/curl.err" || true)
  HTTP_BODY=$(cat "${TMP}/body" 2>/dev/null || true)
  HTTP_ERROR=$(cat "${TMP}/curl.err" 2>/dev/null || true)
}

cleanup() {
  if [ "$ROOM_CREATED" -eq 1 ] && [ "$KEEP" -eq 0 ] && [ -n "$ROOM_ID" ]; then
    http DELETE "${BASE}/v1/rooms/${ROOM_ID}" "" "x-api-key: ${API_KEY}"
    if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "404" ]; then
      note "cleanup" "room ${ROOM_ID} removed"
    else
      note "cleanup" "could not remove room ${ROOM_ID} (HTTP ${HTTP_STATUS}); delete it from the dashboard"
    fi
  fi
  [ -n "$TMP" ] && rm -rf "$TMP"
}

emit_json() {
  if have python3; then
    printf '%s\n' "${RESULTS[@]}" | python3 -c '
import json, sys
rows = []
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    status, name, detail = (line.split("|", 2) + ["", ""])[:3]
    rows.append({"status": status, "check": name, "detail": detail})
print(json.dumps({"ok": not any(r["status"] == "fail" for r in rows),
                  "counts": {"pass": sum(r["status"] == "pass" for r in rows),
                             "fail": sum(r["status"] == "fail" for r in rows)},
                  "checks": rows,
                  "room": {"id": sys.argv[1], "joinUrl": sys.argv[2]} if sys.argv[1] else None},
                 indent=2))
' "$ROOM_ID" "$JOIN_URL"
  elif have node; then
    printf '%s\n' "${RESULTS[@]}" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const rows = s.split("\n").filter(Boolean).map(line => {
    const [status, check, detail] = line.split("|");
    return { status, check, detail };
  });
  const fail = rows.filter(r => r.status === "fail").length;
  console.log(JSON.stringify({ ok: fail === 0, counts: { pass: rows.length - fail, fail }, checks: rows,
    room: process.argv[1] ? { id: process.argv[1], joinUrl: process.argv[2] } : null }, null, 2));
});' "$ROOM_ID" "$JOIN_URL"
  else
    printf '{"ok":false,"error":"python3 or node is required for --json"}\n'
    return 1
  fi
}

main() {
  if ! have curl; then printf 'curl is required\n' >&2; exit 1; fi
  if ! have python3 && ! have node; then printf 'python3 or node is required to parse JSON\n' >&2; exit 1; fi

  if [ -f "$ENV_FILE" ]; then
    if [ -z "$BASE" ]; then
      local port
      port=$(get_env AGIL_HTTP_PORT); [ -n "$port" ] || port=8787
      BASE="http://127.0.0.1:${port}"
    fi
    [ -n "${API_KEY}" ] || API_KEY=$(get_env AGIL_API_KEYS | cut -d',' -f1 | cut -d':' -f1)
  fi
  if [ -z "$BASE" ]; then BASE="http://127.0.0.1:8787"; fi
  BASE=${BASE%/}
  if [ -z "$API_KEY" ]; then
    printf 'No API key. Set one in .env (AGIL_API_KEYS=key:tenant) or pass --api-key.\n' >&2
    exit 1
  fi

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/agil-smoke.XXXXXX") || { printf 'cannot create a temp dir\n' >&2; exit 1; }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  [ "$JSON" -eq 1 ] || printf '%sAGIL quickstart smoke%s — %s\n\n' "$C_BOLD" "$C_RESET" "$BASE"

  # 1. health ---------------------------------------------------------------
  http GET "${BASE}/v1/health" ""
  if [ "$HTTP_STATUS" = "200" ] && printf '%s' "$HTTP_BODY" | grep -q '"ok":true'; then
    pass "GET /v1/health" "ok, rooms=$(json_get "$HTTP_BODY" rooms) tenants=$(json_get "$HTTP_BODY" tenants)"
  else
    bad "GET /v1/health" "HTTP ${HTTP_STATUS}${HTTP_ERROR:+ (${HTTP_ERROR})}"
    [ "$JSON" -eq 1 ] && emit_json
    return 1
  fi

  # 2. static surfaces ------------------------------------------------------
  local path status size type
  for path in / /dashboard/ /editor/; do
    status=$(curl -sS --max-time "$TIMEOUT" -o "${TMP}/page" -w '%{http_code}' "${BASE}${path}" 2>/dev/null || printf '000')
    size=$(wc -c < "${TMP}/page" 2>/dev/null | tr -d ' ')
    type=$(file -b --mime-type "${TMP}/page" 2>/dev/null || true)
    if [ "$status" = "200" ] && [ "${size:-0}" -gt 200 ] && grep -qi '<html' "${TMP}/page" 2>/dev/null; then
      pass "static ${path}" "HTTP 200, ${size} bytes"
    elif [ "$status" = "200" ] && [ "${size:-0}" -gt 0 ]; then
      pass "static ${path}" "HTTP 200, ${size} bytes${type:+ (${type})}"
    else
      bad "static ${path}" "HTTP ${status:-000}, ${size:-0} bytes (is the dist build missing?)"
    fi
  done

  # 3. ICE ------------------------------------------------------------------
  http GET "${BASE}/v1/ice" ""
  local ice_ok=0
  if [ "$HTTP_STATUS" = "200" ] && printf '%s' "$HTTP_BODY" | grep -q '"iceServers"'; then
    ice_ok=$(printf '%s' "$HTTP_BODY" | grep -o '"urls"' | wc -l | tr -d ' ')
  fi
  if [ "$HTTP_STATUS" = "200" ] && [ "${ice_ok:-0}" -gt 0 ]; then
    pass "GET /v1/ice" "${ice_ok} ICE server entr(ies)"
  else
    bad "GET /v1/ice" "HTTP ${HTTP_STATUS}, iceServers=${ice_ok:-0} — check AGIL_ICE_SERVERS"
  fi

  # 4. first room -----------------------------------------------------------
  local tenant room_payload
  tenant=$(get_env AGIL_DEFAULT_TENANT); [ -n "$tenant" ] || tenant="demo"
  ROOM_ID="smoke-$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
  room_payload=$(printf '{"roomId":"%s","name":"AGIL smoke room","maxParticipants":4}' "$ROOM_ID")
  http POST "${BASE}/v1/rooms" "$room_payload" "x-api-key: ${API_KEY}"
  if [ "$HTTP_STATUS" = "200" ]; then
    ROOM_CREATED=1
    ROOM_ID=$(json_get "$HTTP_BODY" room.id)
    JOIN_URL=$(json_get "$HTTP_BODY" joinUrl)
    pass "POST /v1/rooms" "created ${ROOM_ID}"
  else
    bad "POST /v1/rooms" "HTTP ${HTTP_STATUS}: $(json_get "$HTTP_BODY" message || printf '%s' "$HTTP_BODY" | head -c 160)"
    note "hint" "check AGIL_API_KEYS, AGIL_ALLOW_ANONYMOUS, and that the API key belongs to tenant ${tenant}"
    [ "$JSON" -eq 1 ] && emit_json
    return 1
  fi

  # 5. room read + guest token ---------------------------------------------
  http GET "${BASE}/v1/rooms/${ROOM_ID}" "" "x-api-key: ${API_KEY}"
  if [ "$HTTP_STATUS" = "200" ]; then
    pass "GET /v1/rooms/:id" "HTTP 200 (room read path)"
  else
    bad "GET /v1/rooms/:id" "HTTP ${HTTP_STATUS}"
  fi

  local token_payload
  token_payload=$(printf '{"tenantId":"%s","roomId":"%s","participant":{"name":"Smoke Guest","role":"guest"},"ttlSec":300}' "$tenant" "$ROOM_ID")
  http POST "${BASE}/v1/tokens" "$token_payload" "x-api-key: ${API_KEY}"
  if [ "$HTTP_STATUS" = "200" ] && [ -n "$(json_get "$HTTP_BODY" token)" ]; then
    pass "POST /v1/tokens" "guest token issued, expiresAt=$(json_get "$HTTP_BODY" expiresAt)"
  else
    bad "POST /v1/tokens" "HTTP ${HTTP_STATUS}"
  fi

  # 6. WebSocket upgrade (optional, needs curl with ws support; skip cleanly) -
  local ws_status
  ws_status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -H 'connection: Upgrade' -H 'upgrade: websocket' \
    -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' \
    "${BASE}/ws" 2>/dev/null || printf '000')
  case "$ws_status" in
    101) pass "WS /ws" "upgrade accepted" ;;
    400|401|403|426) note "WS /ws" "HTTP ${ws_status} without a join token (expected: upgrade needs a valid token)" ;;
    *) note "WS /ws" "HTTP ${ws_status} (WebSocket signalling not verified by this smoke)" ;;
  esac

  [ "$JSON" -eq 1 ] || printf '\n'
  if [ "$KEEP" -eq 1 ]; then
    note "room kept" "open this URL in Chrome/Safari and allow camera+mic:"
    [ "$JSON" -eq 1 ] || printf '\n  %s\n\n' "${JOIN_URL:-${BASE}/?room=${ROOM_ID}}"
    [ "$JSON" -eq 1 ] || printf 'Delete it later: curl -X DELETE -H "x-api-key: <key>" %s/v1/rooms/%s\n' "$BASE" "$ROOM_ID"
  fi

  if [ "$JSON" -eq 1 ]; then
    emit_json
  else
    printf '%sResult:%s %s passed · %s failed\n' "$C_BOLD" "$C_RESET" "$PASS_COUNT" "$FAIL_COUNT"
    if [ "$FAIL_COUNT" -eq 0 ]; then
      printf 'First call: run ./smoke.sh --keep and open the printed join URL.\n'
    else
      printf 'Next: ./doctor.sh for container/port/TLS diagnostics.\n'
    fi
  fi

  [ "$FAIL_COUNT" -eq 0 ]
}

main "$@"
