#!/bin/sh
# Readiness check for the node enrollment loop (used by the quickstart compose).
# Exit 0 when a heartbeat was accepted in the last 90 seconds.
set -u
state_dir="${AGIL_NODE_STATE_DIR:-/app/.data}"
now="$(date +%s)"
last="$(cat "$state_dir/heartbeat-at" 2>/dev/null || echo 0)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac
[ $((now - last)) -lt 90 ]
