#!/usr/bin/env bash
# Unit tests for the quickstart IPv4/TURN_EXTERNAL_IP classifier (P2-3).
#
# Run: bash agil/infra/tools/test-net.sh
# Exit 0 = all cases pass, 1 = at least one mismatch.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
# shellcheck source=../quickstart/lib/net.sh
. "$HERE/../quickstart/lib/net.sh"

FAILURES=0
CHECKS=0

expect() { # expect ADDR EXPECTED_CLASS
  local addr=$1 want=$2 got
  got=$(classify_ipv4 "$addr")
  CHECKS=$((CHECKS + 1))
  if [ "$got" = "$want" ]; then
    printf '  ok   %-18s %s\n' "${addr:-<empty>}" "$got"
  else
    printf '  FAIL %-18s expected %s, got %s\n' "${addr:-<empty>}" "$want" "$got"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "TURN_EXTERNAL_IP classification"
# Public addresses are the only values that are safe for remote participants.
expect 8.8.8.8 public
expect 1.1.1.1 public
expect 203.0.113.10 public
expect 172.32.0.1 public
expect 100.128.0.1 public
expect 192.169.0.1 public
# RFC1918, CGNAT, link-local and reserved ranges.
expect 10.0.0.1 private
expect 10.255.255.255 private
expect 172.16.0.1 private
expect 172.31.255.255 private
expect 192.168.1.10 private
expect 100.64.0.1 private
expect 100.127.255.255 private
expect 169.254.169.254 private
expect 0.1.2.3 private
# Loopback and the unspecified address are rejected for remote origins.
expect 127.0.0.1 loopback
expect 127.255.255.254 loopback
expect 0.0.0.0 unspecified
# Malformed input must never be classified as public.
expect '' invalid
expect 256.1.1.1 invalid
expect 1.2.3 invalid
expect 1.2.3.4.5 invalid
expect 01.2.3.4 invalid
expect 1.2.3.4. invalid
expect ' 1.2.3.4' invalid
expect a.b.c.d invalid

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: ${FAILURES}/${CHECKS} case(s) failed"
  exit 1
fi
echo "PASS: ${CHECKS}/${CHECKS} classifier cases"
