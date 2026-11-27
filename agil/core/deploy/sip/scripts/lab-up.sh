#!/bin/sh
# AgilFrame — local SIP lab bring-up.
#
#   ./scripts/lab-up.sh
#
# Starts the stack declared in ../docker-compose.yml and waits until Redis,
# LiveKit, the LiveKit SIP worker and Asterisk answer. Requires Docker with
# host networking (Linux or a WSL2 distro running Docker Engine), because the
# SIP/RTP peers must reach each other on the host network.
#
# After this script succeeds:
#   node scripts/lab-init.mjs      # create the trunks
#   node scripts/e2e.mjs           # run the RTP/DTMF/inbound/list/stop checks
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "missing .env — run: cp .env.example .env" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed/in PATH — the lab needs Docker Engine with host networking" >&2
  exit 1
fi

# The Asterisk image ships no sound files; the dialplan plays generated tones.
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to generate the lab tone prompts (scripts/gen-tones.mjs)" >&2
  exit 1
fi
echo "==> generating tone prompts"
node scripts/gen-tones.mjs

echo "==> docker compose up -d"
docker compose up -d

wait_for() {
  label="$1"
  shift
  attempts=60
  while [ "$attempts" -gt 0 ]; do
    if "$@" >/dev/null 2>&1; then
      echo "    $label ready"
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 2
  done
  echo "timeout waiting for $label" >&2
  docker compose ps >&2 || true
  return 1
}

http_ready() {
  node -e 'fetch(process.argv[1], {signal: AbortSignal.timeout(2000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' "$1"
}

echo "==> waiting for services"
wait_for "redis" docker compose exec -T redis redis-cli -p 6385 ping
wait_for "livekit HTTP" http_ready http://127.0.0.1:7880/
wait_for "livekit SIP worker" http_ready http://127.0.0.1:28083/
wait_for "asterisk" docker compose exec -T asterisk sh -c "asterisk -rx 'core show uptime'"

echo
echo "Stack is up. Ports (host/WSL2):"
echo "  7880/tcp livekit Twirp   -> AGIL_SIP_URL=http://127.0.0.1:7880"
echo "  5060/udp asterisk PJSIP  <- LiveKit outbound trunk"
echo "  5070/udp livekit SIP     <- asterisk inbound trunk"
echo "  28083/tcp livekit SIP health"
echo "  5038/tcp asterisk AMI    (lab scripts only)"
echo
echo "Next:"
echo "  node scripts/lab-init.mjs            # create trunks (prints ST_... id)"
echo "  node scripts/e2e.mjs                 # run the local SIP lab checks"
echo "  docker compose logs -f asterisk sip  # call traces, AGIL_LAB_* markers"
