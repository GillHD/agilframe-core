#!/bin/sh
# AgilFrame — stop the local SIP lab.
#
#   ./scripts/lab-down.sh            # stop containers, keep recordings/logs
#   ./scripts/lab-down.sh --clean    # also delete recordings + asterisk logs
#
# Recordings are evidence for the RTP checks; the plain form leaves them.
set -eu

cd "$(dirname "$0")/.."

echo "==> docker compose down"
docker compose down

if [ "${1:-}" = "--clean" ]; then
  for dir in recordings logs/asterisk; do
    target="$(pwd)/$dir"
    # Only delete inside this lab directory; refuse anything else.
    case "$target" in
      "$(pwd)"/*) ;;
      *) echo "refusing to delete $target" >&2; exit 1 ;;
    esac
    if [ -d "$target" ]; then
      find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
      echo "    cleaned $target"
    fi
  done
fi

echo "done. .env is kept (lab keys only)."
