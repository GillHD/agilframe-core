#!/bin/sh
# AGIL node enrollment/heartbeat loop (runs inside the standard agil-calls image).
#
# This is the default node runtime for the quickstart and the agil-node Helm
# chart. It uses the first-party operator CLI from the core image:
#   node agil/core/scripts/agil-cli.mjs nodes register|heartbeat
#
# No extra image is required. The only persisted state is the node key:
#   $AGIL_NODE_STATE_DIR/node.json     (mode 0600)
#   $AGIL_NODE_STATE_DIR/heartbeat-at  (unix seconds; written only after an
#                                       accepted heartbeat, for readiness probes)
#
# Environment (same names as the CLI/agent contract):
#   AGIL_CORE_URL, AGIL_NODE_TOKEN, AGIL_NODE_KEY, AGIL_NODE_ID, AGIL_NODE_NAME,
#   AGIL_NODE_ROLE, AGIL_NODE_FEATURES, AGIL_NODE_CAPACITY, AGIL_NODE_ENDPOINT,
#   AGIL_NODE_REGION, AGIL_NODE_HEARTBEAT_SEC, AGIL_NODE_STATE_DIR,
#   AGIL_CLI_PATH (default agil/core/scripts/agil-cli.mjs)
#
# Exit behaviour: exits 1 with a clear message when enrollment is impossible
# (no token and no key), so the orchestrator can surface the misconfiguration.
# Transient heartbeat failures are logged and retried every interval.

set -eu

STATE_DIR="${AGIL_NODE_STATE_DIR:-/app/.data}"
CLI="${AGIL_CLI_PATH:-agil/core/scripts/agil-cli.mjs}"
INTERVAL="${AGIL_NODE_HEARTBEAT_SEC:-30}"
NODE_ID="${AGIL_NODE_ID:-$(hostname)}"
STATE_FILE="$STATE_DIR/node.json"
HEARTBEAT_FILE="$STATE_DIR/heartbeat-at"

log() { printf '%s node[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$NODE_ID" "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

[ -r "$CLI" ] || fail "CLI not found at $CLI (run from the repository root / core image)"
[ -n "$INTERVAL" ] || INTERVAL=30
case "$INTERVAL" in *[!0-9]*) fail "AGIL_NODE_HEARTBEAT_SEC must be an integer" ;; esac
[ "$INTERVAL" -ge 5 ] || INTERVAL=5

mkdir -p "$STATE_DIR" || fail "cannot create state dir $STATE_DIR (check volume permissions)"
# A stale timestamp from a previous container must not make a fresh process look
# ready before its first accepted heartbeat (P3-3).
rm -f "$HEARTBEAT_FILE"

read_key() {
  node -e '
    const fs = require("node:fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(typeof state.nodeKey === "string" ? state.nodeKey : "");
    } catch { process.exit(1); }
  ' "$STATE_FILE" 2>/dev/null || true
}

write_key_from_json() {
  # stdin: register response JSON. Writes node.json with mode 0600.
  node -e '
    const fs = require("node:fs");
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let data;
      try { data = JSON.parse(raw); } catch { console.error("invalid JSON from nodes register"); process.exit(1); }
      if (!data || typeof data.nodeKey !== "string" || !data.nodeKey) {
        console.error("register response has no nodeKey");
        process.exit(1);
      }
      const state = {
        nodeId: data.node && data.node.id ? data.node.id : process.argv[1],
        nodeKey: data.nodeKey,
        registeredAt: new Date().toISOString(),
        coreUrl: process.env.AGIL_CORE_URL || null,
      };
      fs.writeFileSync(process.argv[2], JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    });
  ' "$NODE_ID" "$STATE_FILE"
}

write_key_from_env() {
  node -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[2], JSON.stringify({
      nodeId: process.argv[1],
      nodeKey: process.env.AGIL_NODE_KEY,
      registeredAt: new Date().toISOString(),
      source: "AGIL_NODE_KEY",
    }, null, 2) + "\n", { mode: 0o600 });
  ' "$NODE_ID" "$STATE_FILE"
}

if [ ! -s "$STATE_FILE" ]; then
  if [ -n "${AGIL_NODE_KEY:-}" ]; then
    log "importing node key from AGIL_NODE_KEY"
    write_key_from_env || fail "could not persist AGIL_NODE_KEY"
  elif [ -n "${AGIL_NODE_TOKEN:-}" ]; then
    log "enrolling with a one-time token via $CLI"
    if ! register_json=$(node "$CLI" nodes register --json); then
      fail "enrollment failed (token expired/used, duplicate node id, or core unreachable)"
    fi
    printf '%s' "$register_json" | write_key_from_json || fail "could not persist the node key"
    log "enrolled; node key stored in $STATE_FILE"
  else
    fail "no node key in $STATE_FILE and AGIL_NODE_TOKEN is empty; mint a one-time node token (dashboard -> Infrastructure -> Nodes, or POST /v1/admin/cluster/tokens), set AGIL_NODE_TOKEN in .env, then run: docker compose up -d node (or ./install.sh --start)"
  fi
else
  log "using existing node key from $STATE_FILE"
fi

NODE_KEY="$(read_key)"
[ -n "$NODE_KEY" ] || fail "node.json exists but has no nodeKey; delete the state volume and re-enroll"
export AGIL_NODE_KEY="$NODE_KEY"

# The server may have assigned a node id when AGIL_NODE_ID was empty; always
# heartbeat the id stored in node.json.
NODE_ID="$(node -e '
  const fs = require("node:fs");
  try { const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(s.nodeId || ""); } catch {}
' "$STATE_FILE" 2>/dev/null || true)"
[ -n "$NODE_ID" ] || NODE_ID="${AGIL_NODE_ID:-$(hostname)}"
export AGIL_NODE_ID="$NODE_ID"

# heartbeat-at is intentionally NOT written here: readiness must mean "core
# accepted a heartbeat", not "the process started" (P3-3).

log "heartbeat every ${INTERVAL}s to ${AGIL_CORE_URL:-http://127.0.0.1:8787}"

on_term() {
  log "received termination signal, stopping"
  exit 0
}
trap on_term TERM INT

while :; do
  if node "$CLI" nodes heartbeat --id "$NODE_ID" --json >/dev/null 2>"$STATE_DIR/last-heartbeat-error"; then
    date +%s > "$HEARTBEAT_FILE" 2>/dev/null || true
    rm -f "$STATE_DIR/last-heartbeat-error"
  else
    log "heartbeat failed; retrying in ${INTERVAL}s"
    if [ -s "$STATE_DIR/last-heartbeat-error" ]; then
      sed 's/^/  /' "$STATE_DIR/last-heartbeat-error" >&2 || true
    fi
  fi
  sleep "$INTERVAL" &
  wait $! || true
done
