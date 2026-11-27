# AgilFrame — LiveKit SFU scaffold (S0 spike)

Standalone Docker scaffold for the LiveKit media plane. It is **deliberately
separate** from the app compose (`../../docker-compose.yml`): bringing it up
does not restart, rebuild or reconfigure `agil-calls`, and tearing it down does
not touch app volumes. Use it for the S0 lab, capacity checks and as the base
for the S1 media integration.

> **Status:** lab/spike, not production. No TLS, no TURN, no webhooks and no
> egress are enabled by default. See `agil/core/docs/sfu-smoke.md` for the measured S0
> run and known blockers.
>
> **Egress banner:** this scaffold's optional `egress` profile is for the S0 lab
> only. The production egress worker/kit is [`agil/core/deploy/egress/`](../egress/) with
> the runbook in [`agil/core/docs/egress-production.md`](../../docs/egress-production.md).
> Do not point production SFU traffic at this profile.

## Contents

| File | Purpose |
|---|---|
| `docker-compose.yml` | `livekit` + `redis` (optional `egress` behind a profile) |
| `livekit.yaml` | LiveKit config: ports, UDP range, external IP, Redis |
| `egress.yaml` | **Template** for recording/RTMP/HLS egress (S3/MinIO, 152-ФЗ) |
| `.env.example` | Environment variable names; no real secrets |

Pinned versions (bump deliberately, re-run the smoke):

| Image | Pin | Notes |
|---|---|---|
| `livekit/livekit-server` | `v1.13.11` | Go SFU; upstream tag `v1.13` tracks patches |
| `redis` | `7-alpine` | LiveKit room directory / multi-node bus |
| `livekit/egress` | `v1.15.0` | optional profile, not started by default |

## Requirements

- Docker Engine 24+ and Compose v2.
- 2 vCPU / 2 GB RAM minimum for LiveKit + Redis; **+4 GB per concurrent
  recording** if egress is enabled (Chrome/GStreamer).
- A public IPv4 and the ports below open in the **cloud/provider firewall**.
- Outbound UDP for STUN (`use_external_ip: true`) and for egress (S3/RTMP).

## Quick start

```bash
cd agil/core/deploy/livekit
cp .env.example .env

# Generate a key/secret pair (32 random bytes as hex is plenty):
KEY=agil_sfu_$(openssl rand -hex 4)
SECRET=$(openssl rand -hex 32)
# Put KEY/SECRET into .env as LIVEKIT_API_KEY / LIVEKIT_API_SECRET
# (and the same values as AGIL_SFU_API_KEY / AGIL_SFU_API_SECRET).

docker compose up -d          # starts redis + livekit, pulls pinned images
docker compose ps
curl -sS http://127.0.0.1:7880/   # -> OK
docker compose logs -f livekit
```

Run the smoke check (from the repo root; it does not need the AGIL server):

```bash
LIVEKIT_URL=http://127.0.0.1:7880 \
LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
node agil/core/scripts/sfu-smoke.mjs
```

Expected: `PASS` with health, token validation, room create/list, two
WebSocket participants, ping/pong, and room cleanup. The script exits non-zero
on failure and never prints the token. For a resource sample, keep the two
participants connected while you run `docker stats`:

```bash
node agil/core/scripts/sfu-smoke.mjs --hold=15000
```

Teardown:

```bash
cd agil/core/deploy/livekit
docker compose down -v        # -v also deletes the Redis volume
```

## Ports and firewall

| Port | Proto | Purpose | Exposure |
|---|---|---|---|
| 7880 | TCP | HTTP + WebSocket signaling | public (behind TLS proxy in prod) |
| 7881 | TCP | RTC over TCP fallback (UDP-blocked networks) | public |
| 50000–50100 | UDP | RTC media (test range) | public |
| 7882 | UDP | **optional** single-port UDP mux | only if enabled |
| 6380 | TCP | Redis, loopback mapping for host-networked egress | `127.0.0.1` only |
| 6789 | TCP | Prometheus metrics | internal only, not published |
| 8080 | TCP | egress health | internal only (host network when egress is on) |

Open at the provider/security-group level **and** on the host:

```bash
sudo ufw allow 7880/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
# Only if you enable TURN/TLS:
sudo ufw allow 5349/tcp
```

Important Docker caveat: published container ports are DNAT'ed by Docker and
**bypass ufw's `INPUT` rules**. Filter them with the cloud firewall/security
group or the `DOCKER-USER` chain; `ufw` alone is not a boundary for published
ports.

UDP is the usual failure mode: many providers block inbound UDP by default and
some corporate/mobile networks drop it. Check:

```bash
ss -lunp | grep -E ':(5000[0-9]|50100)\b'      # docker-proxy / livekit bound?
docker compose port livekit 7881
nc -vz <public-ip> 7880
nc -vz <public-ip> 7881
```

There is no equivalent one-liner for the UDP range: verify with a real WebRTC
client (`chrome://webrtc-internals` → selected candidate pair) or a
`livekit-cli` load test from outside the host. If the range cannot be opened,
enable the single-port mux (`rtc.udp_port: 7882`, publish `7882/udp`) and keep
`7881/tcp` as fallback.

## Keys and secrets

- LiveKit reads keys from the `LIVEKIT_KEYS` env var, injected by Compose from
  `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`. Keys are **not** in
  `livekit.yaml`.
- The AGIL server will use `AGIL_SFU_API_KEY` / `AGIL_SFU_API_SECRET`
  (`scale.sfu.apiKeyEnv/apiSecretEnv`). Set them to the same values when S1
  wires the app; the media scaffold itself only needs the `LIVEKIT_*` pair.
- `.env` is gitignored. Copy `.env.example`, never commit a filled file. Rotate
  the key by changing both the env pair and restarting `livekit`; existing
  tokens die with the old key.

## Host networking (production recommendation)

The default uses a bridge network with explicit mappings: safer on a shared
host, easy to reason about, and fine for a spike. For a busy SFU, upstream
recommends host networking to avoid the Docker userland proxy and to open a
larger UDP range (e.g. `50000–60000`). Sketch:

```yaml
services:
  livekit:
    network_mode: host          # ports: section is ignored
  redis:
    network_mode: host
    command: ["redis-server", "--appendonly", "yes", "--bind", "127.0.0.1"]
```

Then set `redis.address: 127.0.0.1:6379` in `livekit.yaml` (not `redis:6379`),
keep `LIVEKIT_KEYS` as-is, and make sure the UDP range is free on the host. The
egress service already uses host networking, which is why Redis is published on
`127.0.0.1:6380` in the default compose.

## TLS / TURN (not enabled in the spike)

LiveKit speaks plain HTTP/WS on 7880. Browsers only allow WebRTC on secure
origins, so production/public testing needs `wss://`:

```caddyfile
sfu.example.com {
    reverse_proxy 127.0.0.1:7880
}
```

For TURN, enable the embedded server only after DNS + certificate are ready
(`turn.domain`, `turn.tls_port: 5349`, certificate paths per LiveKit docs) and
open `5349/tcp`. Keep coturn for the mesh path; SFU clients should use LiveKit's
embedded TURN.

## Optional egress (recording / RTMP / HLS)

Egress is behind the `egress` profile so `docker compose up -d` only starts
LiveKit + Redis:

```bash
docker compose --profile egress up -d egress
docker compose --profile egress logs -f egress
```

Recording starts via the LiveKit Egress API (S3 stage in the SFU plan). The
service is configured from `EGRESS_CONFIG_BODY` with env values; `egress.yaml`
is a reference template for a mounted config file. Minimum: 4 GB RAM per concurrent
recording, host networking, and an S3/MinIO bucket in the required region.
Chrome runs **without its sandbox** by default (upstream default). To enable
sandboxing, set `enable_chrome_sandbox: true` and launch with LiveKit's
[seccomp profile](https://github.com/livekit/egress/blob/main/chrome-sandboxing-seccomp-profile.json).
Stop and remove with `docker compose --profile egress down -v` (or plain
`docker compose down -v`, which also removes profiled containers).

## Ops

```bash
docker compose ps
docker stats --no-stream
docker compose logs --tail=100 livekit
curl -s http://127.0.0.1:7880/                         # liveness
# Metrics are NOT published to the host by default. Scrape them from a
# Prometheus/container on the compose network: http://livekit:6789/metrics
# (or use `docker run --rm --network container:<livekit-container> ...`).
```

The metrics port is internal to the compose network by design; do not expose it
to the internet. For UDP/TCP quality and capacity numbers see
`agil/core/docs/sfu-smoke.md` and `agil/core/docs/scaling.md` §7.
