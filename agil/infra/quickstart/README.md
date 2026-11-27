# AgilFrame — quickstart (15–30 minutes to the first call)

This is the sales/demo deployment path: **one Linux host, four containers**, no
Kubernetes, no cloud account, no production changes. It brings up AGIL Core, a
node enrollment loop, coturn (TURN/STUN) and Redis. The compose project is split
into a core bundle and a node/TURN bundle so the same definitions can run on
split hosts (see §2.3).

```
                    your DNS: calls.example.com  (A → this host)
                                  │
                    ┌─────────────▼──────────────┐
   :443/:80  ──────►│ your reverse proxy (BYO)   │  TLS terminates here
                    │ nginx / Caddy / HAProxy …  │  examples in ../examples/
                    └─────────────┬──────────────┘
                                  │ 127.0.0.1:8787
                    ┌─────────────▼──────────────┐
                    │ core                       │  API + WS + demo/dashboard/editor
                    │  /v1/health  /ws  /docs    │  volume: agil-data
                    └──────┬──────────────┬──────┘
                           │ enroll +     │ ICE credentials
                           │ heartbeat    │
                    ┌──────▼────────┐  ┌────▼──────────────┐
                    │ node          │  │ turn (coturn)      │  UDP 3478 + relay range
                    │ CLI loop      │  │ STUN/TURN          │  must be reachable from clients
                    └───────────────┘  └────────────────────┘
                    ┌─────────────┐
                    │ redis :6379 │  media-plane bus (not required by core 0.1.0)
                    └─────────────┘
```

Only the reverse proxy is public. Core binds to `127.0.0.1:8787` by default,
Redis has no published port, and the node publishes no ports at all: it only
makes outbound enrollment/heartbeat calls to core.

---

## 1. What you need (5 minutes)

| Requirement | Minimum | Notes |
|---|---|---|
| Linux host / VM | 2 vCPU, 2 GiB RAM, 10 GiB free disk | Docker Desktop works for a local trial; TURN UDP is less reliable there |
| Docker Engine | 24+ with Compose **2.24+** | `docker compose version` must work; the project uses `include` and `!reset` |
| Ports (public) | `80/tcp`, `443/tcp`, `3478/tcp+udp`, `49200-49250/udp` | `80` only for ACME HTTP-01; `443` handled by your proxy; relay range must match `TURN_MIN_PORT`/`TURN_MAX_PORT` |
| DNS | `A`/`AAAA` record for the public hostname → this host | Not needed for `http://localhost:8787` |
| TLS | certificate for the hostname at the proxy | See [`../examples/`](../examples/); the app never terminates TLS |
| Tooling | `openssl` + `curl` for `install.sh`; `python3` or `node` for JSON in `smoke.sh`/token minting |

> **Network reality check:** WebRTC media is UDP. If your provider firewall or
> corporate network blocks inbound UDP 3478 and the relay range, calls will
> connect then fail. Open them at the cloud security group *and* the host
> firewall; Docker-published ports bypass `ufw INPUT` rules, so use the
> provider firewall or the `DOCKER-USER` chain.

## 2. Configure and start (5–10 minutes)

From this directory:

```bash
cd agil/infra/quickstart

# Configure + validate only (recommended first run, nothing starts):
./install.sh --domain calls.example.com

# Or configure + build + start:
./install.sh --domain calls.example.com --start
```

`install.sh` is safe and non-destructive:

- checks Docker/Compose (warns below Compose 2.24), free TCP/UDP ports, DNS,
  disk, RAM and CPU;
- creates `.env` with fresh random values (token secret, IP salt, API key,
  TURN password) and mode `0600`;
- detects the public IPv4 for `TURN_EXTERNAL_IP` and refuses an
  RFC1918/CGNAT/loopback address when the public origin is remote (see
  §2.1), then writes the `AGIL_ICE_SERVERS` JSON;
- validates `docker compose config`;
- with `--start`: builds `core`, starts `core + turn + redis`,
  waits for `/v1/health`, mints a **one-time node token**, starts `node`;
- never overwrites `.env` without `--force` (which keeps a timestamped backup),
  never edits host proxies/firewall/VPN, never deletes volumes.

`docker compose up -d` alone starts core/turn/redis but the `node` container
stops with a clear "no node key / AGIL_NODE_TOKEN is empty" error until a token
exists (bounded restarts, not an infinite crash-loop). Use `./install.sh --start`
for the first run — it mints the token before starting node.

Without a domain (local trial only):

```bash
./install.sh --start
# public origin defaults to http://localhost:8787
```

If TURN runs on a **different host** than core (e.g. the AWS reference: core VM
+ node VM), tell the installer where clients should reach TURN:

```bash
./install.sh --domain calls.example.com --turn-ip <turn-public-ip> \
  --ice-host turn.example.com --start
```

Otherwise the generated `AGIL_ICE_SERVERS` points at the core host and relay
candidates are unreachable. The node/TURN host itself must use the node bundle
(§2.3), not the all-in-one installer.

Manual equivalent, if you prefer no script:

```bash
cp .env.example .env
# fill AGIL_TOKEN_SECRET, AGIL_API_KEYS, AGIL_IP_SALT, TURN_PASSWORD, AGIL_ICE_SERVERS
# and a routable TURN_EXTERNAL_IP (or set TURN_ALLOW_PRIVATE_IP=1 for a LAN trial)
docker compose up -d --build
# node stays down until you mint a token and set AGIL_NODE_TOKEN:
#   ./install.sh --start   (does it for you)
```

### 2.1 TURN relay IP validation

Remote participants receive `TURN_EXTERNAL_IP` as their relay candidate. A
private value (RFC1918 `10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10`,
link-local, loopback) is unreachable from the internet: ICE appears to connect,
then no media flows. Therefore:

- `install.sh` accepts a private address only when the origin itself is local
  (`http://localhost…`) or when you pass `--allow-private-ip` (`TURN_ALLOW_PRIVATE_IP=1`
  in `.env`) for a LAN/dev trial;
- for anything customer-facing pass `--turn-ip <public-ip>` explicitly, or make
  sure the host can reach an IP echo service so detection succeeds;
- `./install.sh --check` re-validates the stored value and exits `1` if it is
  unroutable for the configured origin.

```bash
# explicit public address (recommended when auto-detection is blocked)
./install.sh --domain calls.example.com --turn-ip 203.0.113.10 --start

# LAN-only trial on a private network (never for a customer)
./install.sh --allow-private-ip --start
```

### 2.2 TURN relay port mapping

The relay range is published **1:1**: host range == container range == coturn
`--min-port/--max-port`. If you override `TURN_MIN_PORT`/`TURN_MAX_PORT`, keep
the same values everywhere and open exactly that range on the cloud security
group *and* the host firewall (`DOCKER-USER` chain; Docker bypasses
`ufw INPUT`). A shifted mapping (e.g. host `50000-50050` → container
`49200-49250`) still lets STUN/TURN signalling on 3478 work, but media never
flows — the classic "ICE connects, no media" failure.

### 2.3 Remote node / TURN host

To run node + coturn on a different host than core (the AWS reference topology),
do **not** run the all-in-one installer there — it would start a second core and
the real core's registry would never see the node. Use the node bundle instead:

```bash
cd agil/infra/quickstart
cp node.env.example .env
# set TURN_* for this host, AGIL_NODE_TOKEN (minted on core) and
# AGIL_CORE_URL (core private IP in the same VPC, or the public HTTPS origin)
docker compose -f docker-compose.node.yml -f docker-compose.node-remote.yml up -d
```

`docker-compose.node-remote.yml` removes the local-core `depends_on` and makes
`AGIL_CORE_URL` mandatory, so a node can never silently register with a local
core. Start from [`node.env.example`](node.env.example) — it intentionally has
no core secrets (`AGIL_TOKEN_SECRET`, `AGIL_API_KEYS`, `AGIL_IP_SALT`); do not
copy the core `.env` to a node host.

## 3. First call (5–10 minutes)

```bash
./smoke.sh --keep
```

It checks health, the three static surfaces, ICE and a real room create/read/
token/delete cycle, then prints a **join URL**. Open that URL in Chrome or
Safari, allow camera + microphone, and join from a second tab or phone.

- Demo UI: `https://calls.example.com/`
- Dashboard (API-key login): `https://calls.example.com/dashboard/`
- Visual config editor: `https://calls.example.com/editor/`
- Health: `http://127.0.0.1:8787/v1/health`

For a remote participant, send them the join link (or the room URL from the
dashboard). On a LAN-only trial, `localhost` is a secure context; remote
participants need HTTPS or a tunnel.

**Delete the smoke room when done** (it has a guest token):

```bash
curl -X DELETE -H "x-api-key: $(grep '^AGIL_API_KEYS=' .env | cut -d= -f2 | cut -d, -f1 | cut -d: -f1)" \
  "http://127.0.0.1:8787/v1/rooms/<room-id>"
```

## 4. Verify and operate (5 minutes)

```bash
./doctor.sh          # human report: containers, health, ports, TURN, Redis, node, disk, RAM, TLS
./doctor.sh --json   # same as JSON for monitoring/CI
docker compose ps
docker compose logs -f --tail=100 core
```

`doctor.sh` is read-only. Exit codes: `0` ok, `1` warnings, `2` critical.

### Day-2 commands

```bash
docker compose ps
docker compose restart core          # drops live calls (in-memory state)
docker compose logs --tail=200 node
docker compose down                  # keeps volumes
docker compose down -v               # DESTROYS agil-data, node-state, redis-data — never in production
```

Back up the data volume before any upgrade:

```bash
docker run --rm -v agil-quickstart_agil-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/agil-data-$(date +%F).tgz -C /data .
```

## 5. Node enrollment (what the `node` container does)

AGIL Core keeps a node registry. A node is a **role record** (`sfu`, `turn`,
`stun`, `all`), not a second core: rooms are still pinned to this one core
process.

1. Create a one-time token (dashboard → Infrastructure, or the API):

   ```bash
   curl -sS -X POST https://calls.example.com/v1/admin/cluster/tokens \
     -H "x-api-key: $AGIL_API_KEY" -H 'content-type: application/json' \
     -d '{"kind":"node","role":"sfu","features":["sfu"],"ttlSec":3600,"uses":1}'
   ```

2. Put it into `.env` as `AGIL_NODE_TOKEN`, then `docker compose up -d node`.
   `install.sh --start` does both automatically. Without a token (and without a
   persisted key) the node exits with a clear error and restarts at most 5 times;
   it does not spin forever. On a remote node host see §2.3.
3. The `node` container runs the **same `agil-calls` image** with the official
   CLI: `node agil/core/scripts/agil-cli.mjs nodes register` once, then
   `nodes heartbeat` every 30 s. It stores the returned node key in the
   `node-state` volume (`/app/.data/node.json`, mode 0600) and writes a
   `heartbeat-at` timestamp used by the container healthcheck. A node with no
   heartbeat for 90 s is shown offline but stays registered.
4. Tokens are hashed at rest, TTL/use-limited and revocable. A leaked token is
   worth one registration; revoke unused tokens in the dashboard.

Useful endpoints (API key required):

```bash
GET  /v1/admin/cluster/status   # cluster id, nodes, counts, limitations
GET  /v1/admin/nodes            # node records
GET  /v1/admin/cluster/tokens   # enrollment tokens + status
```

The loop script is [`../node/node-loop.sh`](../node/node-loop.sh) and is mounted
read-only into the standard image; there is no separate node image and no
media process in the `node` container. LiveKit/TURN stay separate
(`agil/core/deploy/livekit/`). An optional HTTP-probe agent
([`../node-agent/`](../node-agent/README.md)) implements the same contract for
operators who want `/metrics`; it is not used by default.

## 6. Ports

| Port | Proto | Service | Exposure |
|---|---|---|---|
| 80 | TCP | your proxy (ACME + redirect) | public |
| 443 | TCP | your proxy (TLS/WSS) | public |
| 8787 | TCP | core (API/WS/static) | **loopback** by default (`AGIL_BIND_ADDR`) |
| 3478 | TCP+UDP | coturn STUN/TURN | public |
| `TURN_MIN_PORT`–`TURN_MAX_PORT` | UDP | coturn relay range (default 49200–49250) | public |
| 5349 | TCP | TURN over TLS (`turns:`) | not published in this compose; see §7 |
| 6379 | TCP | Redis | internal Docker network only |

Docker publishes the relay range as `host:container` with the **same** numbers
(the compose file repeats `TURN_MIN_PORT`/`TURN_MAX_PORT` on both sides). Keep it
that way: coturn allocates inside the container on exactly that range. Open the
same range on the provider firewall and the host (`DOCKER-USER`), not just
3478 — otherwise signalling works and media fails.

The compose `127.0.0.1:8787` binding means the proxy is the only public entry
point. Keep it that way. If you must expose 8787 directly, set
`AGIL_BIND_ADDR=0.0.0.0` **and** restrict it in the provider firewall.

## 7. TLS and TURN over TLS

- **App TLS** is out of scope by design: use nginx, Caddy, HAProxy or Traefik.
  Ready-to-edit snippets: [`../examples/`](../examples/). Every sample keeps
  WebSocket upgrades, a ≥1 h read timeout, `client_max_body_size ≥ 30m` and
  `X-Forwarded-*` headers.
- **TURN over TLS** (`turns:5349`) is optional and needs a certificate coturn
  can read. The default compose disables TURN TLS (`--no-tls --no-dtls`) and
  does not publish 5349. To enable it, add a read-only certificate mount,
  replace the flags, publish `5349`, and open it on the firewall; see the
  coturn documentation and `agil/core/docs/deployment.md` §3.2. Keep plain
  `turn:` as the fallback for networks that block 5349.
- Do not put a self-signed certificate in front of participants: browsers will
  fail WebSocket/TURN connections without a warning path.

## 8. Environment reference (the values you will touch)

| Variable | Default | Meaning |
|---|---|---|
| `AGIL_PUBLIC_ORIGIN` | `http://localhost:8787` | Public URL in join links, CORS, custom domains; no trailing slash |
| `AGIL_BIND_ADDR` / `AGIL_HTTP_PORT` | `127.0.0.1` / `8787` | Host binding for core |
| `AGIL_TOKEN_SECRET` | generated | Signs join/admin tokens; rotating invalidates old links |
| `AGIL_API_KEYS` | generated | `key:tenant` pairs; dashboard login + room creation |
| `AGIL_IP_SALT` | generated | Salt for hashed IPs in audit/logs |
| `AGIL_ALLOW_ANONYMOUS` | `0` | `1` allows room creation without a key (demo only) |
| `AGIL_ICE_SERVERS` | generated | JSON STUN/TURN list handed to clients |
| `TURN_EXTERNAL_IP` | detected | Public IPv4 coturn advertises; **must** be reachable by clients. Private values are refused for a remote origin unless `--allow-private-ip` |
| `TURN_ALLOW_PRIVATE_IP` | `0` | `1` = accept a private relay IP (LAN/dev only; `--allow-private-ip` writes it) |
| `TURN_USER` / `TURN_PASSWORD` | `agil` / generated | TURN long-term credentials (also in the ICE JSON); **one static credential for all clients** — demo only |
| `TURN_MIN_PORT`/`TURN_MAX_PORT` | `49200`/`49250` | Relay range, published 1:1 (host == container == coturn); open the same range on the firewall |
| `TURN_TOTAL_QUOTA`/`TURN_USER_QUOTA` | `100`/`0` | coturn allocation quotas (0 = unlimited); bound relay abuse from the shared credential |
| `AGIL_CORE_URL` | `http://core:8787` | Core base URL for the node loop; required and explicit on a remote node host (§2.3) |
| `AGIL_NODE_TOKEN` | generated once | One-time enrollment token; burned on first register |
| `AGIL_NODE_ID` | `agil-node-1` | Unique node id; duplicate live ids are rejected (409) |

**Secrets:** `.env` is gitignored and mode 0600. The compose model deliberately
does **not** load it wholesale into core: `docker-compose.core.yml` passes an
explicit `AGIL_*` environment list, so the public-facing core never receives
`TURN_PASSWORD`, `AGIL_NODE_TOKEN` or `AGIL_NODE_KEY`. Node/TURN live in
`docker-compose.node.yml` and only receive their own values. Never commit
`.env`, never put it into a container image, and rotate `AGIL_TOKEN_SECRET`, the
API key and the TURN password if it leaks. For a node/TURN host that talks to a
remote core, use `node.env.example` (no core secrets). Prefer a secret manager
for customer deployments.

**TURN credentials are shared and client-visible.** `TURN_PASSWORD` is embedded
in the public ICE list and every participant uses the same username/password;
anyone who can open the demo can relay traffic. The chart sets
`--total-quota`/`--user-quota` (default 100 allocations) to bound abuse, but
production should switch coturn to the TURN REST API (`--use-auth-secret` with
short-lived credentials) and/or a dedicated relay service. Consider
`--denied-peer-ip` ranges for private networks after testing your LAN/mobile
cases.

## 9. Upgrade and rollback

```bash
# 1) back up the data volume (see §4)
# 2) pin the new image tag in .env
AGIL_CORE_IMAGE=registry.example.com/agil/calls:0.2.0
# 3) rebuild/recreate only what changed
docker compose pull core        # if using a registry image
docker compose up -d core
./doctor.sh && ./smoke.sh
```

Rollback: set `AGIL_CORE_IMAGE` back to the previous tag and
`docker compose up -d core`. Schema/state migrations are forward-only in the
current release; restore the data volume from the backup if a downgrade needs
it. The node keeps only `node-state` (delete the volume to re-enroll). Keep
`AGIL_TOKEN_SECRET` stable across upgrades or all existing links break.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| `core` restarts / unhealthy | `docker compose logs core`; missing env, port 8787 conflict, `.data` permissions |
| `smoke.sh` returns 401 | API key in `.env` vs `AGIL_API_KEYS`; `AGIL_ALLOW_ANONYMOUS=0` requires `x-api-key` |
| HTTP works, calls fail | UDP 3478/relay blocked; `TURN_EXTERNAL_IP` wrong; `doctor.sh` TURN section |
| ICE connects, then no media | relay range not open end-to-end, or host≠container mapping changed; keep `TURN_MIN_PORT`/`TURN_MAX_PORT` identical on both sides (§2.2) |
| Calls connect on LAN only | TURN not reachable, `AGIL_ICE_SERVERS` lacks `turn:`, or `TURN_EXTERNAL_IP` is private (installer refuses this for a remote origin; use `--turn-ip` or `--allow-private-ip` for a LAN trial) |
| `install.sh --check` exits 1 with "private (RFC1918/CGNAT)" | set a public `--turn-ip`, or opt into a LAN trial with `--allow-private-ip` |
| WebSocket disconnects every ~60 s | proxy read timeout too low or missing `Upgrade`/`Connection` headers — see `../examples/` |
| `static /dashboard/` 503 | image built without the dashboard dist; rebuild `core` from the repo root |
| `node` unhealthy / exited | token missing/expired/used, duplicate node id, or core unreachable; inspect `docker compose logs node`; delete `node-state` only for a fresh enrollment |
| remote node registers locally | you ran the all-in-one compose/installer on the node host; use `docker-compose.node.yml` + `docker-compose.node-remote.yml` (§2.3) |
| `TLS` warning in doctor | certificate expires soon or hostname missing from SAN; renew at the proxy |
| `docker compose` port error | another service owns 8787/3478; change `AGIL_HTTP_PORT`/`TURN_PORT` |

## 11. What this kit is not

- Not an SFU deployment. Mesh calls work; for 10+ participants or recording,
  deploy LiveKit (`agil/core/deploy/livekit/`) and set `AGIL_SFU_*`.
- Not multi-node signalling. The registry is a contract; room ownership/broadcast
  across cores is not implemented in 0.1.0 (`multiNodeActive: false`).
- Not a Postgres deployment. Core state is file-backed under `agil-data`;
  Postgres/Redis are forward-looking in the Helm chart.
- Not a TLS/ACME implementation. Your proxy owns certificates.
- Not HA. One core process means one restart drops live calls.

For the full topology, security model and limitations see
[`../README.md`](../README.md); for runbooks see
[`agil/core/docs/operations.md`](../../core/docs/operations.md).
