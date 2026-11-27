#!/usr/bin/env bash
# Linux/WSL root. Two clients with the same LAN addresses behind separate NAT gateways.
set -euo pipefail

core_target=${AGIL_QA_NAT_CORE_TARGET:-}
chrome_binary=${AGIL_QA_NAT_CHROMIUM:-}
sfu_port=${AGIL_QA_NAT_SFU_PORT:-}
server_ip=198.18.90.1
lan_ip=10.66.0.2
turn_port=45584
tls_port=45585
core_port=45583
cdp_port_a=45581
cdp_port_b=45582
coturn_image=coturn/coturn:4.6
chrome_image=livekit/egress:v1.15.0

if [[ ${EUID} != 0 ]]; then
  echo 'Run the TURN NAT fixture as root on Linux/WSL.' >&2
  exit 1
fi
for tool in ip iptables docker openssl python3; do
  command -v "$tool" >/dev/null
done
docker image inspect "$coturn_image" >/dev/null
if [[ -n $core_target ]]; then
  command -v socat curl setsid >/dev/null
  if [[ -n $chrome_binary ]]; then
    command -v setpriv >/dev/null
    [[ $chrome_binary == /* && -x $chrome_binary ]] || {
      echo 'AGIL_QA_NAT_CHROMIUM must be an absolute path to a Linux browser executable.' >&2
      exit 1
    }
  else
    docker image inspect "$chrome_image" >/dev/null
  fi
fi
if [[ -n $sfu_port ]]; then
  [[ -n $core_target && $sfu_port =~ ^[1-9][0-9]{3,4}$ && $sfu_port -gt 45620 && $sfu_port -lt 65376 ]] || {
    echo 'Set a lab SFU base port above 45620 and a Windows Core target.' >&2
    exit 1
  }
  docker image inspect agil-node-all-in-one:qa-turn-tls redis:7-alpine >/dev/null
fi

work=$(mktemp -d /tmp/agil-turn-nat.XXXXXX)
prefix=agil-tn-${work##*.}
server=$prefix-turn
client_a=$prefix-client-a
client_b=$prefix-client-b
nat_a=$prefix-nat-a
nat_b=$prefix-nat-b
proxy_pids=()

cleanup() {
  for pid in "${proxy_pids[@]}"; do
    kill -- "-$pid" 2>/dev/null || true
  done
  if [[ -n $sfu_port ]]; then
    docker rm -f "$prefix-sfu-a" "$prefix-sfu-b" "$prefix-redis" >/dev/null 2>&1 || true
  fi
  for namespace in "$server" "$client_a" "$client_b" "$nat_a" "$nat_b"; do
    ip netns delete "$namespace" 2>/dev/null || true
  done
  docker rm -f "$client_a" "$client_b" "$server" >/dev/null 2>&1 || true
  if [[ -n $chrome_binary ]]; then
    rm -rf -- "$work/browser-a" "$work/browser-b"
    rm -f -- "$work"/chrome-{a,b}.log
  fi
  rm -f -- "$work"/{core,cdp-a,cdp-b,sfu-a,sfu-b,sfu-gateway}.sock "$work"/{certificate.pem,key.pem,secret,turn.conf}
  rmdir -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -n $sfu_port ]]; then
  printf 'SFU_FIXTURE_PID=%s\n' "$$"
fi

umask 077
openssl rand -hex 32 > "$work/secret"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=$server_ip" -addext "subjectAltName=IP:$server_ip" \
  -keyout "$work/key.pem" -out "$work/certificate.pem" 2>/dev/null
cat > "$work/turn.conf" <<EOF
listening-ip=$server_ip
relay-ip=$server_ip
listening-port=$turn_port
tls-listening-port=$tls_port
min-port=45600
max-port=45619
realm=agil-turn-nat-qa
use-auth-secret
static-auth-secret=$(cat "$work/secret")
cert=/qa/certificate.pem
pkey=/qa/key.pem
no-cli
no-dtls
no-multicast-peers
no-tcp-relay
no-stdout-log
EOF

start_container_namespace() {
  local name=$1
  local image=$2
  docker run -d --name "$name" --network none --user root --entrypoint sleep \
    -v "$work:/qa:ro" "$image" infinity >/dev/null
  ip netns attach "$name" "$(docker inspect --format '{{.State.Pid}}' "$name")"
}

start_container_namespace "$server" "$coturn_image"
client_image=$coturn_image
if [[ -n $core_target && -z $chrome_binary ]]; then
  client_image=$chrome_image
fi
start_container_namespace "$client_a" "$client_image"
start_container_namespace "$client_b" "$client_image"

ip -n "$server" link add br-up type bridge
ip -n "$server" addr add "$server_ip/24" dev br-up
ip -n "$server" link set br-up up

connect_lan() {
  local client=$1
  local nat=$2
  local port=$3
  local wan_ip=$4
  ip netns add "$nat"
  ip -n "$nat" link add wan type veth peer name "$port" netns "$server"
  ip -n "$nat" link add lan type veth peer name eth1 netns "$client"
  ip -n "$server" link set "$port" master br-up
  ip -n "$server" link set "$port" up
  ip -n "$nat" link set lo up
  ip -n "$nat" addr add "$wan_ip/24" dev wan
  ip -n "$nat" link set wan up
  ip -n "$nat" addr add 10.66.0.1/24 dev lan
  ip -n "$nat" link set lan up
  ip -n "$client" link set lo up
  ip -n "$client" addr add "$lan_ip/24" dev eth1
  ip -n "$client" link set eth1 up
  ip -n "$client" route add default via 10.66.0.1
  ip netns exec "$nat" sysctl -qw net.ipv4.ip_forward=1
  ip netns exec "$nat" iptables -w -t nat -A POSTROUTING -s 10.66.0.0/24 -o wan -j SNAT --to-source "$wan_ip"
  # Model port-preserving inbound UDP on the direct ICE path. The public
  # address belongs to a single client, and these rules never leave the lab.
  local first_port last_port
  read -r first_port last_port < <(ip netns exec "$client" sysctl -n net.ipv4.ip_local_port_range)
  ip netns exec "$nat" iptables -w -t nat -A PREROUTING -i wan -d "$wan_ip" -p udp \
    --dport "$first_port:$last_port" -j DNAT --to-destination "$lan_ip"
}

connect_lan "$client_a" "$nat_a" up-a 198.18.90.2
connect_lan "$client_b" "$nat_b" up-b 198.18.90.3
docker exec -d "$server" turnserver -c /qa/turn.conf

stun_mapping() {
  ip netns exec "$1" python3 - "$lan_ip" "$server_ip" "$turn_port" "$2" <<'PY'
import secrets
import socket
import struct
import sys
import time

lan, server, port, expected = sys.argv[1:]
cookie = bytes.fromhex('2112a442')
transaction = secrets.token_bytes(12)
request = struct.pack('!HH', 1, 0) + cookie + transaction
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
    client.bind((lan, 46000))
    client.connect((server, int(port)))
    client.settimeout(0.5)
    for attempt in range(45):
        try:
            client.send(request)
            response = client.recv(1024)
            break
        except (ConnectionRefusedError, TimeoutError):
            if attempt == 44:
                raise
            time.sleep(0.5)

assert response[:2] == b'\x01\x01' and response[4:20] == cookie + transaction
offset = 20
while offset + 4 <= len(response):
    kind, size = struct.unpack_from('!HH', response, offset)
    value = response[offset + 4:offset + 4 + size]
    if kind == 0x0020 and len(value) == 8 and value[1] == 1:
        address = socket.inet_ntoa(bytes(left ^ right for left, right in zip(value[4:], cookie)))
        mapped_port = struct.unpack('!H', value[2:4])[0] ^ 0x2112
        assert (address, mapped_port) == (expected, 46000), (address, mapped_port)
        print(f'PASS STUN {lan}:46000 -> {address}:{mapped_port}')
        break
    offset += 4 + ((size + 3) & ~3)
else:
    raise AssertionError('STUN response did not have an IPv4 XOR-MAPPED-ADDRESS')
PY
}

stun_mapping "$client_a" 198.18.90.2
stun_mapping "$client_b" 198.18.90.3
if [[ -z $core_target ]]; then
  relay() {
    local client=$1
    local transport=$2
    shift 2
    local result
    if ! result=$(timeout 30 docker exec "$client" turnutils_uclient -y -c -n 5 -z 150 \
      -W "$(cat "$work/secret")" "$@" "$server_ip" 2>&1) ||
      ! grep -Eq 'tot_recv_msgs=[1-9][0-9]*' <<< "$result"; then
      printf 'TURN/%s test failed in %s\n' "$transport" "$client" >&2
      printf '%s\n' "$result" >&2
      return 1
    fi
    printf 'PASS TURN/%s over NAT for %s\n' "$transport" "$client"
  }
  for client in "$client_a" "$client_b"; do
    relay "$client" UDP -p "$turn_port"
    relay "$client" TLS -t -S -E /qa/certificate.pem -p "$tls_port"
  done
  exit
fi

# The Unix sockets cross private network namespaces without adding host routes or firewall rules.
# CDP is exposed only on the named lab interface and only while the fixture is running.
host_ip=${AGIL_QA_NAT_CDP_BIND:-$(ip -4 route get "${core_target%:*}" | awk '{
  for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}
}')}
core_origin="http://$server_ip:$core_port"
start_proxy() {
  setsid "$@" &
  proxy_pids+=("$!")
}
start_proxy socat "UNIX-LISTEN:$work/core.sock,fork" "TCP:$core_target"
start_proxy ip netns exec "$server" socat \
  "TCP-LISTEN:$core_port,bind=$server_ip,reuseaddr,fork" "UNIX-CONNECT:$work/core.sock"

sfu_json=
if [[ -n $sfu_port ]]; then
  sfu_second=$((sfu_port + 10))
  sfu_gateway=$((sfu_port + 6))
  start_proxy socat "UNIX-LISTEN:$work/sfu-gateway.sock,fork" "TCP:${core_target%:*}:$sfu_gateway"
  start_proxy ip netns exec "$server" socat \
    "TCP-LISTEN:$sfu_gateway,bind=$server_ip,reuseaddr,fork" "UNIX-CONNECT:$work/sfu-gateway.sock"
  for side in a b; do
    port=$sfu_port
    [[ $side == a ]] || port=$sfu_second
    start_proxy ip netns exec "$server" socat \
      "UNIX-LISTEN:$work/sfu-$side.sock,fork" "TCP:127.0.0.1:$port"
    start_proxy socat "TCP-LISTEN:$port,bind=$host_ip,reuseaddr,fork" \
      "UNIX-CONNECT:$work/sfu-$side.sock"
  done
  sfu_json=$(printf ',"sfu":{"namespaceContainer":"%s","prefix":"%s","apiHost":"%s","browserHost":"%s","basePort":%s,"gatewayPort":%s}' \
    "$server" "$prefix" "$host_ip" "$server_ip" "$sfu_port" "$sfu_gateway")
fi

spki=$(openssl x509 -in "$work/certificate.pem" -pubkey -noout \
  | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
start_browser() {
  local namespace=$1
  local side=$2
  local cdp_port=$3
  local profile=/tmp/agil-chrome
  local flags=(--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
    --disable-breakpad --disable-crash-reporter --disable-background-networking --no-proxy-server
    --no-first-run --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
    --autoplay-policy=no-user-gesture-required --remote-debugging-port=9222
    "--unsafely-treat-insecure-origin-as-secure=$core_origin"
    "--ignore-certificate-errors-spki-list=$spki")
  if [[ -n $chrome_binary ]]; then
    profile=$work/browser-$side
    chmod 0711 "$work"
    install -d -m 0700 -o nobody -g nogroup "$profile"
    start_proxy ip netns exec "$namespace" setpriv --reuid nobody --regid nogroup --clear-groups \
      env "HOME=$profile" "$chrome_binary" "${flags[@]}" "--user-data-dir=$profile/profile" about:blank \
      > "$work/chrome-$side.log" 2>&1
  else
    docker exec -d --user egress "$namespace" sh -c 'exec "$@" > /tmp/agil-chrome.log 2>&1' _ \
      /usr/bin/google-chrome "${flags[@]}" "--user-data-dir=$profile" about:blank
  fi
  for attempt in {1..75}; do
    if ip netns exec "$namespace" curl --noproxy '*' -fsS --max-time 1 \
      http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      break
    fi
    if [[ $attempt == 75 ]]; then
      if [[ -n $chrome_binary ]]; then
        tail -n 20 "$work/chrome-$side.log" >&2 || true
      else
        docker exec "$namespace" tail -n 20 /tmp/agil-chrome.log >&2 || true
      fi
      printf 'Chromium %s did not start its CDP service\n' "$side" >&2
      return 1
    fi
    sleep 1
  done
  start_proxy ip netns exec "$namespace" socat \
    "UNIX-LISTEN:$work/cdp-$side.sock,fork" TCP:127.0.0.1:9222
  start_proxy socat "TCP-LISTEN:$cdp_port,bind=$host_ip,reuseaddr,fork" \
    "UNIX-CONNECT:$work/cdp-$side.sock"
  for attempt in {1..8}; do
    if curl --noproxy '*' -fsS --max-time 1 "http://$host_ip:$cdp_port/json/version" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  printf 'Chromium %s did not open CDP at %s:%s\n' "$side" "$host_ip" "$cdp_port" >&2
  return 1
}
start_browser "$client_a" a "$cdp_port_a"
start_browser "$client_b" b "$cdp_port_b"
printf '{"fixturePid":%s,"coreOrigin":"%s","cdpA":"http://%s:%s","cdpB":"http://%s:%s","turnUdp":"turn:%s:%s","turnTls":"turns:%s:%s?transport=tcp","tlsSpki":"%s","secretFile":"%s/secret"%s}\n' \
  "$$" "$core_origin" "$host_ip" "$cdp_port_a" "$host_ip" "$cdp_port_b" \
  "$server_ip" "$turn_port" "$server_ip" "$tls_port" "$spki" "$work" "$sfu_json"
wait
