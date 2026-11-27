#!/usr/bin/env bash
# IPv4 classification helpers for the AGIL quickstart.
#
# Sourced by install.sh (bash) and unit-tested by ../../tools/test-net.sh.
# Uses builtins only: no external commands, so it also works on minimal hosts
# where `ip`/`dig` are unavailable. The point is to never advertise an
# unroutable TURN relay address (RFC1918 / CGNAT / loopback) to participants.
#
# Classification used by install.sh:
#   public      routable on the internet (the only value safe for customers)
#   private     RFC1918, CGNAT 100.64/10, link-local 169.254/16, 0/8, 127/8
#   loopback    127/8 (valid only for calls on the same host)
#   unspecified 0.0.0.0 (never a usable relay address)
#   invalid     not a dotted-quad IPv4 address

# ipv4_is_valid ADDR — four decimal octets, each 0-255, no leading zeros.
ipv4_is_valid() {
  local rest=${1:-} octet count=0
  [ -n "$rest" ] || return 1
  case "$rest" in
    .*|*.) return 1 ;;
  esac
  while [ -n "$rest" ]; do
    count=$((count + 1))
    [ "$count" -le 4 ] || return 1
    octet=${rest%%.*}
    case "$rest" in
      *.*) rest=${rest#*.} ;;
      *) rest='' ;;
    esac
    case "$octet" in
      ''|*[!0-9]*|0?*) return 1 ;;
    esac
    [ "$octet" -le 255 ] || return 1
  done
  [ "$count" -eq 4 ]
}

# ipv4_is_loopback ADDR — 127.0.0.0/8.
ipv4_is_loopback() {
  ipv4_is_valid "${1:-}" || return 1
  [ "${1%%.*}" = "127" ]
}

# ipv4_is_unspecified ADDR — 0.0.0.0.
ipv4_is_unspecified() {
  [ "${1:-}" = "0.0.0.0" ]
}

# ipv4_is_private ADDR — non-public ranges that must not be advertised remotely.
# Includes loopback and 0/8 so callers that only ask "is it public?" are safe.
ipv4_is_private() {
  local first second rest
  ipv4_is_valid "${1:-}" || return 1
  first=${1%%.*}
  rest=${1#*.}
  second=${rest%%.*}
  case "$first" in
    0|10|127) return 0 ;;
    100) [ "$second" -ge 64 ] && [ "$second" -le 127 ] && return 0 ;;
    169) [ "$second" -eq 254 ] && return 0 ;;
    172) [ "$second" -ge 16 ] && [ "$second" -le 31 ] && return 0 ;;
    192) [ "$second" -eq 168 ] && return 0 ;;
  esac
  return 1
}

# classify_ipv4 ADDR — print public|private|loopback|unspecified|invalid.
classify_ipv4() {
  ipv4_is_valid "${1:-}" || { printf 'invalid\n'; return 0; }
  ipv4_is_unspecified "$1" && { printf 'unspecified\n'; return 0; }
  ipv4_is_loopback "$1" && { printf 'loopback\n'; return 0; }
  ipv4_is_private "$1" && { printf 'private\n'; return 0; }
  printf 'public\n'
}
