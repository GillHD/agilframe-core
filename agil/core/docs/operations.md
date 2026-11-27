# AgilFrame — production operations (HA, observability, backups, runbooks)

> **Date:** 16.11.2026 · **Status:** production-hardening kit, **nothing deployed by
> this change** · **App code changed:** none · **Secrets in repo:** none
>
> This is the operator-facing companion to [`agil/core/docs/deployment.md`](deployment.md):
> how to know the service is healthy, what to alert on, how to back up and
> restore `AGIL_DATA_DIR`, how to run the two-node SFU + Redis + egress setup on
> separate hosts, and what to do when something breaks.
>
> Artefacts in this kit:
>
> | Path | Purpose |
> |---|---|
> | `agil/core/docs/operations.md` (this file) | architecture, health, SLOs, alerts, runbooks, HA, capacity, DR |
> | [`agil/core/scripts/backup-data.sh`](../scripts/backup-data.sh) | safe data backup (tar + optional SQLite snapshot + checksum + retention + optional S3/MinIO) |
> | [`agil/core/scripts/restore-data.sh`](../scripts/restore-data.sh) | verified restore from a backup archive (checksum + listing, `--dry-run`) |
> | [`agil/core/scripts/ops-check.mjs`](../scripts/ops-check.mjs) | read-only health sweep (app, SFU nodes, Redis, TLS/domain, disk/mem) with JSON output |
> | [`agil/core/deploy/observability/`](../deploy/observability/) | Prometheus scrape config, alert rules, blackbox modules, Grafana dashboard, optional loopback-only stack |
>
> **Read-only by default.** `ops-check.mjs` only performs GET/`PING`/`INFO`-class
> reads. `backup-data.sh` never writes into the data directory. `restore-data.sh`
> refuses to touch a non-empty target without `--force`.

---

## 1. Topology

### 1.1 Current production shape (Server 3)

```
Internet :443
   │
   ▼
HAProxy (host, SNI routing; shared with the VPN stack)
   │  proxy-protocol
   ▼
Caddy 127.0.0.1:9443  (Let's Encrypt for calls.<domain>, sfu.<domain>)
   │  reverse_proxy
   ├──────────────────────────────► app 127.0.0.1:8787   Docker: agil-calls
   │                                  │  volume agil-calls_agil-data → /app/.data
   │                                  │  healthcheck: GET /v1/health
   │                                  ▼
   │                                coturn (host net, UDP 3478, relay 49200–49250)
   │
   └──► sfu.<domain> (:9443 round_robin) ──► LiveKit node 1 127.0.0.1:7880  RTC 50000–50100
                                          └─► LiveKit node 2 127.0.0.1:7890  RTC 50200–50300
                                                     │
                                                     ▼
                                               Redis 6379 (room directory + psrpc bus)
                                                     ▲
                                                     │ private network / SSH tunnel
                                          Egress worker (separate host, 8 vCPU / 8 GB)
```

Facts that drive the runbooks:

- **The app VPS is one node with in-memory room/WS state.** A container restart
  ends all active calls, chats and lobby state. `/v1/health` is liveness only;
  it does not prove an active call still works.
- **Redis use by the app is opt-in.** `AGIL_REDIS_URL` enables the Core leader
  lease/standby/failover baseline ([`agil/core/docs/ha-leader.md`](ha-leader.md));
  without it the app runs standalone. `scale.signaling.redisUrl` is a declared,
  validated setting whose multi-node signalling is not implemented
  ([`agil/core/docs/scaling.md`](scaling.md) §9). Redis otherwise remains the
  **SFU's** room directory and message bus, plus the egress job bus.
- **LiveKit pins a room to one node.** Two nodes scale the number of rooms and
  provide HA for *new* rooms; they do not extend one room's participant limit.
  Losing a node drops the rooms hosted on it ([`agil/core/docs/sfu-multinode.md`](sfu-multinode.md)).
- **Egress is deliberately off the app host.** One 720p composite with MP4 +
  RTMP + HLS measured 5.41 CPU cores / 1.95 GB RSS; the app host is 1 vCPU / 2 GB
  ([`agil/core/docs/egress-production.md`](egress-production.md) §13).
- **Caddy has no active upstream health check** in the current SFU vhost. A dead
  SFU node keeps receiving its share of new WebSocket attempts until it is
  removed from the upstream list (change window, see §8.3).

### 1.2 Ports and exposure

| Component | Port / proto | Exposure | Notes |
|---|---|---|---|
| HAProxy | 443/tcp | public | SNI ACLs, proxy-protocol to Caddy |
| Caddy | 9443/tcp | loopback | TLS termination for app + SFU hosts |
| App | 8787/tcp | **loopback only** | `127.0.0.1:${AGIL_HOST_PORT:-8787}` |
| SFU node 1 | 7880/tcp, 7881/tcp, 50000–50100/udp | public (behind TLS proxy for signaling) | `agil/core/deploy/livekit/livekit.yaml` |
| SFU node 2 | 7890/tcp, 7891/tcp, 50200–50300/udp | public | `agil/core/deploy/livekit/livekit-node2.yaml` |
| SFU metrics | 6789/tcp + 6790/tcp | **internal only** | Prometheus scrape target |
| Redis | 6379/tcp (host-mapped 6380) | loopback / private | never public |
| TURN (coturn) | 3478/udp+tcp, relay 49200–49250/udp, optional 5349/tcp | public | `AGIL_ICE_SERVERS`; see [TURN checks and rollback](#25-turn) |
| Egress health | 8080/tcp | internal (`DENY` at firewall) | `curl 127.0.0.1:8080/` |
| Egress metrics | 9090/tcp | internal | `livekit_egress_*` |
| Egress templates | 7980/tcp | internal | never publish |

Docker publishes ports through DNAT, which **bypasses ufw `INPUT` rules**. Filter
at the provider firewall or the `DOCKER-USER` chain, not with ufw alone
([`agil/core/deploy/livekit/README.md`](../deploy/livekit/README.md)).

---

## 2. Health checks

Run the whole sweep from any host that can reach the endpoints:

```bash
# read-only, JSON, exit 0=ok 1=warn 2=critical
node agil/core/scripts/ops-check.mjs --json
node agil/core/scripts/ops-check.mjs \
  --app-url=https://calls.example.com \
  --sfu=http://10.0.0.11:6789,http://10.0.0.12:6790 \
  --redis=10.0.0.11:6379 \
  --tls-host=calls.example.com \
  --disk-path=/var/lib/docker/volumes/agil-calls_agil-data
```

### 2.1 Application — `GET /v1/health`

A healthy response is `200` with:

```json
{
  "ok": true,
  "name": "agil-calls-server",
  "version": "0.1.0",
  "uptimeSec": 12345,
  "rooms": 3,
  "tenants": 2,
  "security": {
    "geoEnabled": true,
    "integrityEnabled": false,
    "sttConfigured": false,
    "aiAgentConfigured": false,
    "recordingsDir": "/app/.data/recordings",
    "docsEnabled": false,
    "adminApiEnabled": true,
    "mcpHttpEnabled": false,
    "mediaMode": "sfu",
    "scaleConfigured": true
  }
}
```

What to assert:

| Assertion | Why |
|---|---|
| HTTP 200 within 2 s | liveness + event-loop responsiveness |
| `ok: true` | handler ran, tenant config loaded |
| `uptimeSec` not resetting | detects crash loops that still answer health |
| `security.docsEnabled === false`, `mcpHttpEnabled === false` in prod | public agil/core/docs/MCP exposure is a security regression |
| `security.adminApiEnabled` matches the plan | admin API should be allowlisted if public |
| `mediaMode` matches the tenant plan | a silent fallback to `mesh` after a config edit |
| `rooms` is consistent with dashboards | in-memory state was lost on restart if it drops to 0 unexpectedly |

`/v1/health` is **not** a readiness gate for media. A green health check with a
dead SFU still breaks new SFU rooms. Always pair it with the SFU probes below.

### 2.2 SFU nodes

| Check | Command | Healthy |
|---|---|---|
| HTTP liveness | `curl -fsS -m 3 http://127.0.0.1:7880/` | body `OK` |
| Signaling TCP | `nc -vz <public-ip> 7880` | connected |
| RTC TCP fallback | `nc -vz <public-ip> 7881` | connected |
| UDP media range | from outside: browser `/webrtc-internals` or `lk load-test` | selected candidate pair on 50000–50100 |
| Metrics | `curl -fsS http://127.0.0.1:6789/metrics \| grep livekit_` | exposition, no 5xx |
| Redis link | `docker compose logs livekit \| grep -i redis` | no reconnect storm |

`agil/core/scripts/ops-check.mjs` checks the HTTP liveness and TLS for every URL passed in
`--sfu`. Local checks are: `docker compose ps`, `docker compose logs --tail=100
livekit`.

#### Direct SFU ingress per room

Keep `AGIL_SFU_URL` as the shared fallback and set `AGIL_SFU_NODE_URLS` on Core
to map tenant IDs and registered node IDs to client-visible WebSocket URLs.
For example, `{"demo":{"sfu-a":"wss://sfu-a.example.com","sfu-b":"wss://sfu-b.example.com"}}`.
The endpoints must serve the same LiveKit deployment, with shared Redis and
matching API credentials. Keep room continuity enabled. Each mapped agent must
report `sfuReady: true` before Core can choose it for a new room.

REST join and WebSocket welcome use the room's assigned ingress. Core picks
the eligible node with the fewest open rooms assigned by this Core. A positive
`capacity.maxRooms` excludes a node from new assignments once that count reaches
the effective limit. The node can report a limit in its heartbeat and an
organization admin can override it in **Infrastructure**. A value of `0` leaves
this capacity unspecified. Closing a room frees its assignment. During drain,
new rooms use another eligible endpoint and existing ones retain theirs. With
no eligible node, new rooms use `AGIL_SFU_URL` or the single tenant SFU URL.
An explicit `AGIL_SFU_NODE_ID` that appears in the tenant's endpoint map
prefers that node while it is ready and has capacity. During drain, new rooms
use another eligible mapped node or the shared fallback. An ID outside the
tenant's map remains a logical pin for room state.
LiveKit owns media placement inside the cluster. If the direct ingress is lost, the web
client first retries it, then tries the shared endpoint with the same room
and identity. Configure the shared endpoint to route around failed and
draining LiveKit nodes. Drain keeps existing rooms joinable, so maintenance
still needs an admission control that stays in force across a restart.
Core can renew an expired media token over the existing signaling WebSocket
for a participant who is still in the room.

The URLs are set by the Core operator. A node's advertised registry address
cannot replace them. Roll back by removing the mapping and restarting Core so
both REST and WebSocket issuance use the shared endpoint again.

### 2.3 Redis

```bash
docker compose exec redis redis-cli PING              # PONG
docker compose exec redis redis-cli INFO persistence  # aof_enabled:1, rdb_last_bgsave_status:ok
docker compose exec redis redis-cli INFO memory       # used_memory_human, maxmemory
docker compose exec redis redis-cli INFO stats        # rejected_connections, evicted_keys
docker compose exec redis redis-cli PUBSUB CHANNELS   # egress psrpc channels present
docker compose exec redis redis-cli PUBSUB NUMSUB EgressInternal StartEgress

# HA Core leader lease (only when the app runs with AGIL_REDIS_URL)
redis-cli --scan --pattern 'agil:cluster:*'
redis-cli PTTL agil:cluster:<clusterId>:leader   # > 0 while the leader is alive
redis-cli GET  agil:cluster:<clusterId>:leader   # leader Core id
redis-cli HGETALL agil:cluster:<clusterId>:state # advisory leader/heartbeat hash
```

Expected: at least one subscriber per egress worker on the psrpc channels. Zero
subscribers means the worker is not registered, even if the worker container is
`running` ([`agil/core/scripts/egress-health.mjs`](../scripts/egress-health.mjs)).

**Read-only rule:** `PING`/`INFO`/`PUBSUB` are safe. Never run `CONFIG SET`,
`FLUSHALL`, `KEYS *` or `MONITOR` in production. Never `SET`/`DEL` the
`agil:cluster:*` leader keys by hand: deleting the lease forces a failover, and
writing it can delay one — the old leader is fenced at its `validUntil` either
way.

### 2.4 Egress

```bash
sudo node agil/core/scripts/egress-health.mjs --env-file .env          # dry-run, read-only
curl -fsS http://127.0.0.1:8080/ | python3 -m json.tool
curl -fsS http://127.0.0.1:9090/metrics | grep livekit_egress
docker compose -f /opt/agil-egress/docker-compose.yml ps
```

Healthy: worker registered in Redis, `lk egress list` reachable through the SFU
Twirp API, `livekit_egress_available == 1`, disk under 80 %.

### 2.5 TURN

The quickstart uses coturn on a Docker bridge with explicit port mappings.
Apply these rules on the provider firewall and on the host firewall where
Docker forwarding is filtered. [Quickstart ports](../../infra/quickstart/README.md#6-ports)

| Purpose | Default | Required when |
| --- | --- | --- |
| STUN and TURN listener | 3478/UDP | Offering UDP |
| TURN TCP fallback | 3478/TCP | Offering `turn:…?transport=tcp` |
| Relay allocations | 49200–49250/UDP | Relaying WebRTC media with the quickstart defaults |
| TURN over TLS | 5349/TCP | Offering `turns:` with a trusted certificate |

Keep `TURN_PORT`, `TURN_MIN_PORT` and `TURN_MAX_PORT` consistent with coturn,
Docker, NAT and both firewalls. Relay ports must map one-to-one. Set
`TURN_EXTERNAL_IP` to the address reachable by clients. When enabling TLS,
mount the certificate and key read-only into coturn, publish 5349/TCP and
verify the certificate hostname before advertising the endpoint. The default
quickstart leaves TLS disabled. [coturn server options](https://github.com/coturn/coturn/blob/master/README.turnserver)

**Acceptance before switching traffic**

1. On the relay host, check the expected Docker bindings and listeners.
   From another network, use a STUN Binding check for UDP and, if TLS is
   enabled, verify the TLS hostname and certificate chain. An open listener
   only confirms the first hop.
2. Use a dedicated test room on the Core that advertises the candidate relay.
   Set `AGIL_QA_BASE_URL` to that Core and `AGIL_QA_JOIN_TOKEN` to the test
   room token in the process environment. Run `node agil/core/scripts/turn-smoke.mjs`
   from a workstation that can reach the relay. For a TCP-only check, run
   `node agil/core/scripts/turn-smoke-tcp2.mjs`. The scripts read ICE settings
   from the room welcome. Public `/v1/ice` provides STUN discovery.
3. Confirm relay allocation and a working data channel. To validate the
   meeting experience, repeat with two browsers on separate networks and
   confirm bidirectional audio and video. For TCP or TLS, also inspect
   `relayProtocol` in WebRTC stats. The Core health response reports Core
   readiness. It cannot attest to relay allocation or media flow.

**Rollback**

Keep the previous relay configuration and endpoint available during a
replacement. If liveness, allocation or media checks fail, restore the
previous organization's TURN pool or Core ICE configuration before advertising
the replacement again. If Core starts with `AGIL_ICE_SERVERS`, reload or
restart it through the normal deployment procedure to apply the restored
environment. Verify a fresh room join and a forced relay call with the old
endpoint. Leave the working relay running while existing allocations drain.
Stop the failed replacement and undo only its new firewall or NAT rules.

#### Temporary coturn credentials

1. Configure coturn with `use-auth-secret` and a dedicated `static-auth-secret`.
   Store the secret in the relay's deployment configuration. Use a random
   value of at least 32 characters. [coturn authentication](https://github.com/coturn/coturn/blob/master/README.turnserver)
2. Set `AGIL_COTURN_REST_SECRETS` in Core's private environment. This is JSON
   indexed by organization ID, then relay ID. For a relay called `regional`
   in organization `demo`, the shape is `{"demo":{"regional":"<signing-key>"}}`.
   Use the same key as in coturn. Restart Core to read the new value.
3. In the organization's TURN pool, choose temporary credentials for the
   relay and save. API clients set `scale.turn[].credentialMode` to `"rest"`.
   The static username and `credentialEnv` are unused in this mode. The
   panel shows whether Core has a key for the exact organization and relay.
4. Join a fresh QA room and run the forced-relay checks above. The public
   ICE route stays STUN-only. The room welcome includes a signed credential
   and expiration, while the signing key stays in the two deployments.

The default credential lifetime is 3,600 seconds. Set
`AGIL_COTURN_REST_TTL_SEC` within 300–86,400 seconds. Core issues credentials
on room welcome and refreshes them on the first widget heartbeat after half
the lifetime has elapsed. The widget applies them to future ICE gathering
and leaves the current connection in place. Older clients can rejoin to
receive fresh credentials. [WebRTC ICE configuration](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-setconfiguration)

#### Link a TURN relay to an enrolled node

In the organization's scaling settings, enter the node ID for the TURN
relay. API clients set `scale.turn[].nodeId` to the registered node ID.
Core includes the relay in ICE when that node belongs to the organization,
is online, accepts new work, and has reported a running TURN module without
a failed health check within the last 90 seconds. A node heartbeat without
a module inventory does not extend that window. After an explicit Docker
failure or shutdown, Core waits for a fresh module report. In the panel,
**Refresh TURN status** shows why a relay is excluded and preserves unsaved
scaling edits. API clients can read this reason in
`GET /v1/admin/scale` at `turn[].nodeState`. Run an allocation test to verify
that clients can reach the relay.

To take a relay out of rotation before maintenance, enable drain on the node.
Core omits it from new welcomes and subsequent ICE refreshes. Widgets that
requested refresh apply this change on a subsequent heartbeat. Keep the
container running while current allocations finish. Restore the relay to
rotation by turning off drain once the module is ready. The binding takes
precedence over duplicate `turn:` addresses in the global fallback and the
organization's unbound pool. Keep at least one independently configured
fallback when clients rely on TURN.

### 2.6 TLS and domain

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' https://calls.example.com/v1/health
echo | openssl s_client -connect calls.example.com:443 -servername calls.example.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
getent hosts calls.example.com
```

`ops-check.mjs --tls-host` performs certificate expiry, hostname and DNS checks
and reports `warn` below 21 days, `crit` below 7 days, expired or mismatched.

### 2.7 Disk and memory

```bash
df -h / /var/lib/docker /opt/agil-calls
free -m
du -xhd1 /var/lib/docker/volumes/agil-calls_agil-data/_data
docker stats --no-stream
lsof +L1 2>/dev/null | head          # deleted-but-open files after a cleanup
```

`ops-check.mjs` reads `node:fs.statfs` for the data path and cgroup v2
`memory.max`/`memory.current` when running inside a container, so thresholds
match the container limit rather than the host.

### 2.8 Data directory

| Check | Expected |
|---|---|
| `test -w "$AGIL_DATA_DIR"` (as the app user) | writable |
| `ls "$AGIL_DATA_DIR"/tenants/*.json \| wc -l` | equals `tenants` in `/v1/health` |
| newest `audit/*.jsonl` mtime | recent activity during office hours |
| `find "$AGIL_DATA_DIR" -name '*.tmp' -mtime +1` | none (atomic writes finish) |
| free space on the data volume | > 20 % |

---

## 3. SLOs and error budget

Targets are **proposed and must be ratified** with the product owner; no
historical measurement exists yet. They are written so the alert thresholds in
§5 map to them directly.

| SLI | Definition | Target (30 days) |
|---|---|---|
| API availability | blackbox `probe_success` on `/v1/health`, 1-min interval | **99.5 %** (≈3 h 36 m downtime) |
| API latency | `probe_duration_seconds` p95 for `/v1/health` | < 300 ms |
| Room create/join API | non-5xx share of `POST /v1/rooms`, `POST /v1/rooms/:id/join` | ≥ 99.5 % |
| Media join (SFU) | successful `SfuEngine.connect` within 5 s / attempts | ≥ 99 % (needs client telemetry; see §4.4) |
| Recording job success | `egress.started` → `egress.stopped` without `EGRESS_FAILED` | ≥ 99 % |
| Backup freshness | age of newest verified backup | ≤ 24 h (RPO) |
| Restore | time to restore config + audit from backup into a clean host | ≤ 2 h (RTO) |
| Alert latency | alert fires → on-call acknowledges | ≤ 15 min (business hours) |

Error budget for 99.5 % availability = **3 h 36 m / 30 days**. A single app
container restart is ~10–30 s; a host rebuild can consume the whole budget.
When the budget is exhausted, freeze feature deploys and work on reliability
items (see §9 change management).

**Measurement gaps (honest):** the app exposes no Prometheus endpoint, so
availability is synthetic (blackbox) and latency is probe latency, not
per-endpoint latency. Media join success requires client-side telemetry
(`quality-changed` / join events) that is not wired to a backend yet.

---

## 4. Monitoring

### 4.1 What exists vs what is added

| Signal | Source | Notes |
|---|---|---|
| App liveness/latency/TLS | **blackbox exporter** → Prometheus | synthetic probe of `/v1/health` |
| Host CPU/RAM/disk/network | **node_exporter** | per host |
| Container CPU/RAM/restarts | cAdvisor (optional) or `docker stats` | alert on restart count |
| SFU rooms/participants/NACK/RTT | LiveKit `:6789`/`:6790` metrics | `livekit_room_total`, `livekit_participant_total`, `livekit_nack_total`, `livekit_rtt_ms` |
| Egress availability | LiveKit egress `:9090` metrics | `livekit_egress_available` |
| Redis | `redis_exporter` (optional) | `redis_up`, memory, connected clients |
| Application errors/audit | container logs + `.data/audit/*.jsonl` → Loki/SIEM | log-based alerts |
| Backup freshness | node_exporter textfile metric `agil_backup_*` | written by `backup-data.sh --metrics-textfile` |

The app itself has **no `/metrics` endpoint** (by design: no app code change in
this kit). Do not point Prometheus at `:8787/metrics`; it would 404 and produce
permanent false alerts. If per-endpoint metrics are required later, that is an
application change with its own review.

### 4.2 Prometheus layout

[`agil/core/deploy/observability/prometheus.yml`](../deploy/observability/prometheus.yml)
defines these jobs (replace the `*.internal` placeholders before use):

| Job | Target | Purpose |
|---|---|---|
| `agil-app-health` | blackbox → `https://calls.example.com/v1/health` | availability, latency, cert |
| `agil-sfu-1`, `agil-sfu-2` | `sfu-1.internal:6789`, `sfu-2.internal:6790` | LiveKit metrics |
| `agil-sfu-egress` | `egress.internal:9090` | egress worker metrics |
| `agil-node-agent` | private all-in-one agent address, port 8080 by default | scrape health, Core heartbeat and readiness of supervised media (optional) |
| `node` | `server3.internal:9100`, … | host resources |
| `cadvisor` | `cadvisor:8080` on the compose network (host `127.0.0.1:8081`) | per-container resources (optional) |
| `redis` | `redis-exporter.internal:9121` | Redis health (optional) |

Runbook for the stack itself: [`agil/core/deploy/observability/README.md`](../deploy/observability/README.md).
The optional compose binds every UI/API port to `127.0.0.1`; reach Grafana over
an SSH tunnel. Metrics name rooms and hosts and have no authentication of their
own — never expose `:6789`, `:9090` or an unauthenticated Prometheus to the
internet.

The optional [media node monitoring setup](node-image.md#monitor-the-node)
adds a host exporter and explains the agent, heartbeat and media readiness alerts.

### 4.3 Alert thresholds

Rules live in
[`agil/core/deploy/observability/agil-alerts.yml`](../deploy/observability/agil-alerts.yml);
this table is the human-readable contract. Thresholds are starting points —
tune after two weeks of baseline.

| Alert | Severity | Expression (summary) | For | Runbook |
|---|---|---|---|---|
| `AgilAppHealthDown` | critical | `probe_success{job="agil-app-health"} == 0` | 2 m | §8.7 |
| `AgilAppHealthFlapping` | warning | `avg_over_time(probe_success[10m]) < 0.95` | 10 m | §8.7 |
| `AgilAppHealthNoData` | warning | `absent(probe_success{job="agil-app-health"})` | 15 m | §4.2 |
| `AgilAppSlowProbe` | warning | `probe_duration_seconds > 1` | 10 m | §8.7 |
| `AgilTlsExpiringSoon` | warning | cert expiry `- time() < 21d` | 1 h | §8.8 |
| `AgilTlsExpiryCritical` | critical | cert expiry `- time() < 7d` | 10 m | §8.8 |
| `AgilSfuNodeDown` | critical | `up{job=~"agil-sfu-.*"} == 0` | 2 m | §8.1 |
| `AgilSfuSignalingUnreachable` | critical | `probe_success{job="agil-sfu-tcp"} == 0` | 2 m | §8.1 |
| `AgilSfuNoMetrics` | warning | `absent(livekit_room_total{job=~"agil-sfu-.*"})` | 10 m | §2.2 |
| `AgilSfuNackRate` | warning | NACK/packet ratio > 5 % | 15 m | §8.1 |
| `AgilSfuRoomSkew` | warning | one node hosts > 80 % of rooms (≥ 5 rooms) | 30 m | §5.3 |
| `AgilEgressHealthDown` | critical | `probe_success{job="agil-egress-health"} == 0` | 3 m | §8.5 |
| `AgilEgressUnavailable` | warning | `livekit_egress_available == 0` | 5 m | §8.5 |
| `AgilDiskHigh` | warning | filesystem free < 20 % | 15 m | §8.4 |
| `AgilDiskCritical` | critical | filesystem free < 10 % | 5 m | §8.4 |
| `AgilMemoryHigh` | warning | `MemAvailable / MemTotal < 15 %` | 15 m | §8.7 |
| `AgilAppContainerRestarting` | warning | `changes(container_start_time_seconds[15m]) > 2` | 5 m | §8.7 |
| `AgilRedisDown` | critical | `redis_up == 0` or `up{job="agil-redis"} == 0` | 1 m | §8.2 |
| `AgilBackupStale` | warning | newest backup age > 26 h | 1 h | §8.9 |
| `AgilBackupMissing` | critical | newest backup age > 48 h | 1 h | §8.9 |

Alert routing: `critical` → page (phone/Telegram with escalation), `warning` →
ticket/chat. Every alert must name a runbook anchor; an alert without an action
is deleted, not muted.

### 4.4 Logs

| What | Where | Retention |
|---|---|---|
| App stdout/stderr | `docker compose logs agil-calls`; Docker json-file under `/var/lib/docker/containers/<id>/<id>-json.log` | compose default (unbounded) — add `logging` limits (see note) |
| App audit (JSONL) | `$AGIL_DATA_DIR/audit/<tenantId>.jsonl`, one JSON object per line, append-only | per tenant policy; ship to SIEM |
| App startup/shutdown | structured `createLogger` lines: `AgilFrame server started`, `listening`, `received SIGTERM`, `shutdown complete` | same as stdout |
| SFU nodes | `docker compose logs livekit` / `livekit2` (`roomallocator`, `redis`, `rtc`) | compose default |
| Redis | `docker compose logs redis` | compose default |
| Egress worker | `/opt/agil-egress` → `docker compose logs egress`; json-file capped 50 MB × 5 | 5 files |
| coturn | volume `coturn-logs` (`/var/log`) | volume |
| Caddy | Caddy service logs (`journalctl`/docker logs) + access log if enabled | per infra policy |
| HAProxy | `journalctl -u haproxy` / container logs; retain request errors | per infra policy |
| Backups | `agil/core/scripts/backup-data.sh` stdout (+ `$OUT_DIR/backup.log` if tee'd) | 90 days of run records recommended |

Log-shipping rules:

1. **Never ship secrets.** The app does not log tokens or API keys; do not add
   request-body logging in the proxy. Scrub `Authorization`, `x-api-key`,
   `Cookie`, RTMP URLs, S3 credentials.
2. Ship app logs and audit to the company SIEM/Loki; keep audit at least as long
   as the tenant policy requires ([`agil/core/docs/security.md`](security.md) §4).
3. Cap Docker json-file logs for the app, egress and MinIO; an unbounded log file
   is a common cause of §8.4 "disk full".
4. Keep the audit JSONL on the same disk as data until shipped, then rotate by
   size; a full disk stops audit writes, and audit failures are a security event.

Suggested compose logging block (applied in a change window, not by this kit):

```yaml
logging:
  driver: json-file
  options:
    max-size: "20m"
    max-file: "5"
```

---

## 5. HA topology on separate hosts

### 5.1 Current reality vs target

| Layer | Now (Server 3) | Failure impact | Target |
|---|---|---|---|
| App | 1 container, in-memory state | restart = all calls drop | warm standby + fast restore (§5.3), later active-active |
| Entry proxy | HAProxy + Caddy on the same host, shared with VPN stack | host loss = full outage | HAProxy pair + keepalived VIP or cloud L4 |
| SFU | 2 nodes, **same host** | host loss = both nodes gone | one node per host, separate failure domains |
| Redis | 1 instance on the SFU host | new rooms/multi-node/egress break | primary + replica + Sentinel (or managed Redis) |
| Egress | 1 worker on a separate host | recordings fail, calls continue | 2 workers behind the shared Redis bus |
| TURN | coturn on the app host | calls fail on restrictive networks | 2 TURN servers in different networks/providers |

**The app now has a leader/standby baseline** (`AGIL_REDIS_URL`): one Core holds
a fenced Redis lease, the standby is read-only (`409 not_leader`) and takes over
mutations after the lease expires — see
[`agil/core/docs/ha-leader.md`](ha-leader.md). That is **not** active-active:
room/presence state, tenant config and the node registry are not replicated, so a
failover starts with an empty room set, and there is no pub/sub bus, room
ownership/lease or shared file storage
([`agil/core/docs/scaling.md`](scaling.md) §4). Do not build an HA design that
assumes two app replicas behind a load balancer sharing live rooms: chat/presence/
room state would diverge and `/v1/health` would be green on both. Point writes at
the leader (or retry `409 not_leader`) until room-state replication lands.

### 5.2 Recommended target topology (separate hosts)

```
                       DNS (TTL 60–300 s)
                              │
                  ┌───────────▼───────────┐
                  │  edge-1 / edge-2      │  HAProxy pair + VIP, SNI
                  └───────┬───────┬───────┘
             ┌────────────▼──┐ ┌──▼────────────┐
             │ app-1         │ │ app-2 (warm   │   app-2 runs the same image,
             │ Server 3      │ │ standby)      │   data restored, no traffic
             └───────┬───────┘ └───────┬───────┘
                     │  shared storage (NFS/object) or scheduled sync
        ┌────────────▼───────────────▼────────────┐
        │  sfu-1 (host A)      sfu-2 (host B)     │  separate hosts, same Redis
        └────────────┬───────────────┬────────────┘
                     │               │
              ┌──────▼──────┐  ┌─────▼───────┐
              │ redis-1     │  │ redis-2     │  primary + replica + sentinel
              └─────────────┘  └─────────────┘
        ┌─────────────┐ ┌─────────────┐
        │ egress-1    │ │ egress-2    │  same Redis bus, 1 job each
        └─────────────┘ └─────────────┘
        ┌─────────────┐ ┌─────────────┐
        │ turn-1      │ │ turn-2      │  different providers/regions
        └─────────────┘ └─────────────┘
        mon-1: Prometheus + Alertmanager + Grafana + Loki, offsite backup target
```

Rules for this topology:

- **One failure domain per row.** Two SFU nodes on one VPS is routing validation,
  not HA ([`agil/core/docs/sfu-multinode.md`](sfu-multinode.md) "Ограничения").
- **Sticky entry for the app** by `roomId`/cookie if a second app node is ever
  added; without the Redis bus, keep traffic on exactly one app node.
- **Redis must not be a single point** for the SFU: replica + Sentinel, or a
  managed Redis with automatic failover. The SFU reconnect loop tolerates short
  blips; a lost Redis loses room ownership.
- **Egress HA is active/active through Redis**; one worker per host, 8 vCPU/8 GB
  each, one composite job each.
- **TURN pool** across providers: `AGIL_ICE_SERVERS` carries all of them, the
  browser picks a working one.
- **Monitoring is its own failure domain** and survives the app host.
- **Time sync** (chrony/systemd-timesyncd) on every host — JWT expiry, TLS and
  audit ordering depend on it.

### 5.3 App HA now: warm standby + restore

Because active-active is out of scope, the practical HA for the app is:

1. `app-2` (or a spare host) runs the same image and has the latest verified
   backup restored (see [`agil/core/scripts/restore-data.sh`](../scripts/restore-data.sh)).
2. HAProxy/DNS can be pointed at `app-2` in minutes; TLS is reissued by Caddy or
   the certificate is copied.
3. Accept the RPO from §7 (≤ 24 h; lower for config with hourly backups).
4. Rehearse the switch quarterly; record the time-to-serve as RTO evidence.

---

## 6. Capacity and sizing

### 6.1 Measured reference points

| Workload | Measured / documented | Source |
|---|---|---|
| App container | 1 vCPU / 2 GB host, `mem_limit: 768m`, healthcheck | `docker-compose.yml`, `agil/core/docs/deployment-record.md` |
| App signalling | ~5–10k WS connections per node on 1 vCPU/1 GB (orientation, untested) | `agil/core/docs/scaling.md` §7 |
| SFU node | ~1–2k subscriptions per streaming node (CPU-dependent) | `agil/core/docs/scaling.md` §7 |
| SFU media ports | 101 UDP ports per node in the current ranges | `agil/core/deploy/livekit/livekit.yaml` |
| Egress 720p composite (MP4+RTMP+HLS) | peak 5.41 cores, 1.95 GB RSS, ~50 MB/min to disk | `agil/core/docs/egress-production.md` §13 |
| Egress single output | 3.19–3.86 cores, ~1.8 GB RSS | same |
| TURN relay | ~1–3 Gbps per server | `agil/core/docs/scaling.md` §7 |
| 720p subscriber | ~2–3 Mbps | `agil/core/docs/scaling.md` §5 |

### 6.2 Sizing formulas

- **SFU CPU:** budget ~0.5–1 core per 100 concurrent subscriptions for 720p
  (orientation); monitor `livekit_rtt_ms`, NACK ratio and CPU, and scale nodes
  before 70 % sustained.
- **UDP range:** LiveKit needs a port per RTP session; keep at least
  `2 × peak concurrent participants per room × safety 1.5` ports, or use
  `rtc.udp_port` single-port mux when the firewall only allows one port.
- **Recording disk:** `minutes × 50 MB` for a 720p composite (MP4+HLS). 100 GB
  ≈ 33 h; 200 GB if `/out` backups are kept during S3 outages.
- **Egress workers:** `ceil(peak concurrent recordings / 1 per 8 vCPU worker)`;
  set `room_composite_cpu_cost` and `max_memory` to match the worker size.
- **Backup disk:** daily archive ≈ compressed size of `.data` (JSON is highly
  compressible; recordings are not). Keep 7 daily + 4 weekly.

### 6.3 Scale triggers (alert → action)

| Trigger | Action |
|---|---|
| SFU CPU > 70 % sustained 15 m, or NACK ratio > 5 % | add a third SFU node on a new host, rebalance by draining |
| One room > 100 participants | dedicated larger SFU node; note the room stays on one node |
| Egress queue depth > 0 for 5 m with `available == 0` | add a second egress worker |
| App CPU > 70 % or RSS near 768 MB limit | raise limit after checking leaks, then add a node only when the Redis bus exists |
| Data volume > 70 % | apply retention/offload recordings to S3, then expand |
| TURN relay > 60 % of NIC | add a TURN server to the pool |

---

## 7. Backup and disaster recovery

### 7.1 Scope and policy

| Data | Path under `AGIL_DATA_DIR` | Backup | Rationale |
|---|---|---|---|
| Tenant configs | `tenants/*.json` | **required**, daily | product state |
| Audit trail | `audit/*.jsonl` | **required**, daily + SIEM shipping | security/legal |
| Billing counters | `billing/**/*.json` | required, daily | invoicing |
| SCIM mappings | `scim/*.json` | required, daily | provisioning |
| Custom domains | `domains.json` | required, daily | white-label |
| API key hashes | `api-keys.json` | required, daily (hashes only) | auth continuity |
| Docs CMS | `agil/core/docs/**` | required, daily | tenant content |
| Uploaded files | `files/**` | required per policy | user content |
| Recordings | `recordings/**` | **policy-dependent**, can be excluded | large, often in S3 |
| Temporary/scratch | `tmp/`, `*.log`, `sfu-bin/` | excluded | rebuildable / dev-only |
| Secrets | `.env`, `*.pem`, `*.key`, certs | **never in data backups**; keep in the secret manager | compromise blast radius |
| Proxy configs | Caddyfile, haproxy.cfg | separate infra backup (with timestamps) | change rollback |
| SFU/egress configs | `agil/core/deploy/livekit/`, `agil/core/deploy/egress/` | in git | versioned |
| Observability configs | `agil/core/deploy/observability/` | in git | versioned |

**Never** place `.env`, private keys or certificates in a data backup archive.
`agil/core/scripts/backup-data.sh` excludes them by name and pattern and refuses to back up
into the data directory itself.

### 7.2 RPO / RTO

| Scenario | RPO | RTO | Method |
|---|---|---|---|
| Tenant config accidentally edited | ≤ 24 h (hourly optional) | ≤ 30 min | restore `tenants/` only |
| Host/disk lost | ≤ 24 h | ≤ 2 h | last archive + new host + `agil/core/deploy/livekit` |
| Audit tampering/corruption | ≤ 24 h | ≤ 4 h | restore `audit/` from archive + SIEM copy |
| Ransomware on the data host | ≤ 24 h | ≤ 4 h | offsite S3 with versioning/object lock |
| Region/provider loss | ≤ 24 h | ≤ 8 h | offsite archive + rebuild with `agil/core/docs/deployment.md` |

Recordings are governed by the retention policy, not the DR RPO. If recordings
live in S3/MinIO, the bucket policy (versioning + lifecycle) is the backup.

### 7.3 Running backups

```bash
# dry-run: prints the plan, checks tools/space, writes nothing
agil/core/scripts/backup-data.sh --dry-run --data-dir /var/lib/docker/volumes/agil-calls_agil-data/_data

# real run (default retention 14 days, keep at least 7)
agil/core/scripts/backup-data.sh \
  --data-dir /var/lib/docker/volumes/agil-calls_agil-data/_data \
  --out-dir /opt/backups/agil \
  --retention-days 14 --keep 7

# skip recordings (large), then upload with checksum verification
agil/core/scripts/backup-data.sh --skip-recordings --s3-uri s3://agil-backups/calls/daily

# docker volume mode (no host path needed; read-only mount inside the helper)
agil/core/scripts/backup-data.sh --volume agil-calls_agil-data --out-dir /opt/backups/agil
```

The script produces `agil-data-<UTC timestamp>.tar.gz`, a `.sha256` file, and a
`manifest` inside the archive. It verifies the archive by listing it after
creation, enforces a lock so two runs cannot overlap, and prunes only files that
match its own naming pattern.

Schedule (host cron, 03:15 UTC, as root because it reads root-owned volumes):

```cron
15 3 * * * /opt/agil-calls/scripts/backup-data.sh \
  --data-dir /var/lib/docker/volumes/agil-calls_agil-data/_data \
  --out-dir /opt/backups/agil --retention-days 14 --keep 7 \
  --metrics-textfile /var/lib/node_exporter/textfile/agil_backup.prom \
  >> /var/log/agil-backup.log 2>&1
```

The `--metrics-textfile` flag emits `agil_backup_last_success_timestamp_seconds`
(plus byte/entry/duration gauges) for the `AgilBackupStale` alert; scrape it with
node_exporter's textfile collector as described in
[`agil/core/deploy/observability/README.md`](../deploy/observability/README.md).

Add `--s3-uri` (and `AGIL_BACKUP_S3_ENDPOINT_URL` for MinIO) for offsite copies.
Use a dedicated bucket with versioning and a lifecycle rule; do not reuse the
recording bucket.

### 7.4 Restoring

```bash
# 1. inspect the archive without touching anything
agil/core/scripts/restore-data.sh --archive /opt/backups/agil/agil-data-20261116T031500Z.tar.gz \
  --into /srv/restore/agil-data --dry-run

# 2. restore into an empty staging directory, then verify
agil/core/scripts/restore-data.sh --archive /opt/backups/agil/agil-data-20261116T031500Z.tar.gz \
  --into /srv/restore/agil-data --yes

# 3. or restore into the docker volume (a volume restore always needs --force)
docker compose stop agil-calls
agil/core/scripts/restore-data.sh --archive ... --volume agil-calls_agil-data --force --yes
docker compose start agil-calls

# 4. verify
curl -fsS http://127.0.0.1:8787/v1/health
ls "$AGIL_DATA_DIR/tenants" | wc -l
tail -n 1 "$AGIL_DATA_DIR/audit/<tenant>.jsonl"
```

The restore script verifies the checksum and archive listing before extracting,
refuses traversal paths, and writes only inside the target. For a full DR
rebuild, follow [`agil/core/docs/deployment.md`](deployment.md) §2, restore data, then
redeploy the SFU/egress from `agil/core/deploy/livekit` and `agil/core/deploy/egress`.

**Restore drill (quarterly, mandatory):** restore the newest archive into a
staging host, start the app on port 8788 with `AGIL_DATA_DIR` pointing at the
restored tree, then run:

```bash
node agil/core/scripts/ops-check.mjs --app-url http://127.0.0.1:8788 --skip=sfu,redis,tls,disk,mem
```

Confirm tenants/audit/files and record the RTO.

### 7.5 Encryption and offsite

- Encrypt offsite archives (`age`/`gpg`) or rely on SSE-S3/SSE-KMS plus bucket
  policy; keep the key outside the bucket account.
- Object lock/versioning protects against ransomware and accidental deletion.
- Test that the offsite copy is restorable, not just present.
- Backups are personal data: apply the same access control and retention as the
  production data (`agil/core/docs/security.md` §4).

---

## 8. Incident runbooks

Common rules: **diagnose read-only first**, take a note of times and commands,
do not restart more than one component at a time, and never paste secrets into
tickets or chat. Commands are for a Debian/Ubuntu host running the compose files
from this repo.

### 8.1 SFU node down

**Symptoms:** `ops-check` SFU check fails for one node, `up{job="agil-sfu-N"} ==
0`, new SFU rooms fail or land only on one node, participants on the dead node
disconnect, `roomallocator` errors in the surviving node's logs.

**Impact:** rooms hosted on the dead node are lost (LiveKit pins rooms); other
rooms continue. Chat/signalling (app WS) is unaffected because it does not go
through LiveKit.

1. Confirm from the SFU host: `docker compose ps`, `docker compose logs
   --tail=200 livekit2`, `curl -m 3 http://127.0.0.1:7890/`.
2. Check host resources: `free -m`, `df -h`, `dmesg -T | tail -50` (OOM kills),
   `ss -lunp | grep -E ':(7890|7891|502)'`.
3. Check Redis reachability from the node: `docker compose logs redis`,
   `docker compose exec redis redis-cli PING`.
4. If the container is dead: `docker compose up -d livekit2` (or `livekit` for
   node 1). Restarting is safe but **drops that node's rooms**.
5. If the host is down: leave the node out of DNS/Caddy upstream until it is
   healthy. Removing an upstream is a proxy change — do it in a change window
   with a config backup (§8.3) or, if unavoidable, accept the 50 % failed
   handshakes and rely on client reconnect.
6. Verify: `curl http://127.0.0.1:7890/` → `OK`, `up{job="agil-sfu-2"} == 1`,
   create a test room, confirm `media.url`/node in the join response, run
   `node agil/core/scripts/sfu-smoke.mjs` against the public URL.
7. Post-incident: collect logs, check for OOM, review UDP range/firewall changes,
   and decide whether the node needs a bigger host.

### 8.2 Redis down

**Symptoms:** LiveKit logs `redis` reconnect errors; new rooms fail with
`roomallocator`/`psrpc` errors; egress jobs stop being dispatched; existing media
on one node may continue until the client reconnects.

**Impact:** SFU room directory and multi-node bridging degrade; egress and
recordings fail; the app API and mesh calls keep working (no Redis dependency).

1. `docker compose ps redis`, `docker compose logs --tail=200 redis`.
2. `docker compose exec redis redis-cli PING`; check `df -h` (AOF write failure),
   `free -m` (OOM), and `dmesg` for the OOM killer.
3. If Redis is OOM-killed or out of disk: free space / raise the container
   memory, then `docker compose up -d redis`.
4. After Redis comes back, **restart the SFU nodes one at a time** so they
   re-register; expect the rooms on the restarted node to be lost. Do not restart
   both simultaneously.
5. Re-check egress registration: `redis-cli PUBSUB NUMSUB EgressInternal
   StartEgress`, then `node agil/core/scripts/egress-health.mjs`.
6. Prevent: replica + Sentinel (or managed Redis), AOF `everysec`, disk and
   memory alerts, `maxmemory-policy noeviction` (a silent eviction breaks live
   rooms in confusing ways).

### 8.3 Caddy / HAProxy failure

**Symptoms:** `502/503` from the edge, TLS handshake failures, all app and SFU
URLs down at once, `probe_success == 0`.

**Impact:** total outage even though the app is healthy.

1. Confirm the app locally: `curl -fsS http://127.0.0.1:8787/v1/health`.
2. Check the proxy containers/processes: `docker ps --filter name=caddy`,
   `systemctl status haproxy` (or the container), `journalctl -u haproxy -n 100`.
3. Validate config before touching it:
   `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
   and `haproxy -c -f /opt/3x-ui/haproxy.cfg` (path per installation).
4. Reload, do not hard-restart, when possible:
   `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.
   A Caddy reload is graceful (existing connections are kept).
5. HAProxy: `systemctl reload haproxy` (or `docker restart haproxy` only if
   reload is impossible). **HAProxy is shared with the VPN stack** — a restart
   briefly drops other sessions; record it in the incident.
6. If the config was changed recently: restore the timestamped backup
   (`Caddyfile.bak-*`, `haproxy.cfg.bak-*`), validate, reload, then investigate.
7. Verify: `curl -sS -o /dev/null -w '%{http_code}' https://calls.example.com/v1/health`,
   `curl https://sfu.example.com/` → `OK`, a real two-participant call.

Never edit `Caddyfile`/`haproxy.cfg` directly during an incident without a copy:
`cp Caddyfile Caddyfile.bak-$(date +%Y%m%d-%H%M%S)` first.

### 8.4 Disk full

**Symptoms:** app 5xx, `ENOSPC` in app/Redis/egress logs, audit writes failing,
recordings aborting, Docker "no space left on device", health check flapping.

**Impact:** data loss risk (audit/files), recordings fail, containers crash.

1. `df -h`; identify the full mount (`/`, `/var/lib/docker`, data volume, `/out`).
2. `du -xhd1 /var/lib/docker`, `docker system df`,
   `du -xhd1 "$AGIL_DATA_DIR"`, `du -sh /srv/agil-egress/out/backup`.
3. `lsof +L1 | head` — deleted-but-open files keep space until the process
   restarts.
4. Fast, safe relief (in this order):
   - stop/abort active egress jobs (largest writer) — §8.5;
   - rotate/compress application and proxy logs;
   - `docker image prune -f` and `docker builder prune -f` (removes only
     unreferenced images/build cache — schedule, never during a deploy);
   - move old recordings to S3/MinIO or delete per retention.
5. **Do not** `rm -rf` anything under `.data`, `/var/lib/docker/volumes`, or
   `/opt/backups` to free space. Move first, verify, then delete.
6. Verify audit writes resume and `/v1/health` is stable; run the backup
   afterwards and investigate the growth source.
7. Prevent: retention limits, log caps, recordings offloaded, disk alert at 70 %
   (act), 80 % (warn), 90 % (critical).

### 8.5 Egress stuck / failed

**Symptoms:** recording never finishes, `egress.activeCount` not dropping,
`EGRESS_FAILED`/`EGRESS_ABORTED` in `GET /v1/rooms/:id/egress`, `docker stats`
shows a Chrome/GStreamer process at high CPU for hours, `/out` filling,
`livekit_egress_available == 0`.

**Impact:** recordings/streams fail; calls continue. A full `/out` can take the
worker (and the host) down.

1. `node agil/core/scripts/egress-health.mjs --env-file .env` (read-only) — checks Redis
   subscriptions, `lk egress list`, config.
2. `docker compose logs --tail=300 egress | grep -Ei 'error|fail|redis|rtmp|s3|chrome'`.
3. `curl -fsS http://127.0.0.1:8080/` and `curl -fsS
   http://127.0.0.1:9090/metrics | grep livekit_egress`.
4. Stop the stuck job through the app API (`DELETE /v1/rooms/:id/egress` or the
   admin egress stop endpoint) rather than killing processes.
5. If the worker is wedged: `docker compose restart egress` — **this aborts every
   recording on that worker**; check with the room owner first.
6. If S3/MinIO is down, egress falls back to `/out/backup`; free space or restore
   storage, then copy backups and restart the failed jobs.
7. If Redis is the cause, fix §8.2 first; the worker cannot register without it.
8. Verify: start one short test recording, confirm the object in S3, check
   `livekit_egress_available == 1`, and confirm `/out` usage is back to baseline.

### 8.6 Auth / key compromise or rotation

**Symptoms:** 401/403 spike, leaked key in a public place, `join.denied` /
`password.failed` spikes, audit anomaly, a tenant asking for rotation.

**Impact:** depending on the key: tenant API access, room joins, SFU media,
recordings, or admin access.

1. Identify which credential: tenant API key (`AGIL_API_KEYS`, hashed in
   `api-keys.json`), platform key (`AGIL_PLATFORM_KEY`), JWT secret
   (`AGIL_TOKEN_SECRET`), SFU key (`AGIL_SFU_API_KEY/SECRET`), TURN credentials,
   webhook HMAC, `AGIL_IP_SALT`, `AGIL_E2EE_SECRET`, OIDC client secret.
2. Tenant API key: rotate via the admin API
   (`POST /v1/admin/tenants/:id/keys`), distribute the new key, revoke the old
   one; verify with one request.
3. `AGIL_TOKEN_SECRET`: generate `openssl rand -hex 32`, update the secret
   store, `docker compose up -d` (rolling restart), expect **all outstanding
   join tokens to become invalid** — announce it.
4. SFU keys: update `.env` for the app and `agil/core/deploy/livekit/.env` for every SFU
   node and egress, restart SFU nodes one at a time and the egress worker;
   existing media sessions survive a key rotation only until reconnect.
5. `AGIL_IP_SALT`: changing it breaks correlation with old audit hashes — this is
   expected and documented; announce before rotating.
6. `AGIL_E2EE_SECRET`: new joins get new E2EE keys; do not rotate mid-call
   without telling participants.
7. TURN credentials: update `AGIL_ICE_SERVERS` and coturn, restart both; new
   joins get the new credentials.
8. Verify: `/v1/health`, one authenticated API call, one join, one SFU room,
   audit entries for the change (do not log the secret).
9. Post-incident: search audit/logs for use of the old key, revoke sessions,
   update the incident record; rotate anything that may have been co-located.

### 8.7 App container crash loop / 5xx

1. `docker compose ps` (restart count, status), `docker compose logs --tail=300
   agil-calls`.
2. Check OOM: `dmesg -T | grep -i oom`, `docker inspect -f
   '{{.State.OOMKilled}} {{.RestartCount}}' agil-calls`.
3. Check disk (§8.4) and permissions on `.data` (`ls -ln`, container runs as
   `node`).
4. Check the proxy path: a healthy app on loopback with public 5xx points to
   §8.3.
5. If the last deploy caused it: roll back the image tag / `git checkout` the
   previous commit, `docker compose up -d --build`; data in the volume is
   untouched by a rollback.
6. Verify `/v1/health`, a two-participant call, audit writes.

### 8.8 TLS expiry / domain failure

1. `echo | openssl s_client -connect host:443 -servername host` → check dates
   and SAN.
2. `getent hosts host` / `dig +short host` → DNS still points at the edge.
3. Caddy obtains/renews certificates automatically; check its logs for ACME
   errors (`rate limit`, `challenge failed`, port 80 blocked).
4. If port 80 is blocked for HTTP-01, use DNS-01 or the existing certificate
   path; **do not delete the ACME storage** to "force" renewal.
5. For custom domains, verify the `on_demand_tls ask` endpoint
   (`/v1/domain/ask`) is not publicly reachable: `AGIL_DOMAIN_ASK_SECRET` is
   **mandatory** (empty = `403` always; the Caddy ask URL carries `?key=…`), the
   `Host` must be in `AGIL_DOMAIN_ASK_HOSTS` (Caddy asks `127.0.0.1`; a proxied
   external request keeps the public Host), and the public site block must
   `respond 404` for `/v1/domain/ask`. The proxy **TCP peer** must be in
   `AGIL_DOMAIN_ASK_ALLOW_IPS` (default loopback — `X-Forwarded-For` is ignored,
   in Docker the peer is usually the bridge gateway, e.g. `172.17.0.1`).
   Failed secrets are limited per client and successful asks per peer, so an
   external flood cannot starve Caddy re-issuance; `429` comes from that limiter
   (`AGIL_DOMAIN_ASK_RATE_LIMIT_PER_MIN`).
6. Verify with `ops-check --tls-host` (warn < 21 days, crit < 7 days).

### 8.9 Backup failure

1. Read the script output / `--json` summary; common causes: lock left by a
   killed run (`--force-unlock` after checking no run is active), out of space,
   unreadable data dir (run as root), missing `tar`, S3 credentials/endpoint.
2. Re-run with `--dry-run` to see the resolved plan without writing.
3. If the archive was created but the checksum failed, treat it as failed and
   re-run; do not upload unverified archives.
4. If S3 upload fails, keep the local archive (retention still applies) and fix
   credentials/endpoint; re-upload with `aws s3 cp` and verify size.
5. After any failure, run a restore drill from the last good archive before
   closing the incident.

### 8.10 Data loss / wrong tenant deletion

1. **Stop writes**: `docker compose stop agil-calls` (calls drop; that is the
   point).
2. Identify the newest verified archive that predates the change; verify its
   checksum.
3. Restore into staging (`--into`), inspect `tenants/`, `audit/`, `files/`, then
   restore into the volume (`--force --yes`) — §7.4.
4. If only one tenant is affected, restore that tenant's JSON and audit file
   instead of the whole tree; keep the current tree as `.bak` first.
5. Restart, verify `/v1/health`, tenant count, audit continuity, and a test call.
6. Record the data gap (between backup time and incident) in the incident report;
   notify the tenant if personal data was affected.

---

## 9. Change management and deploy safety

This kit **does not deploy anything**. When you do:

1. Take a verified backup first (`agil/core/scripts/backup-data.sh`) and note its
   checksum.
2. Back up every proxy config you touch with a timestamp; validate before
   reload.
3. Deploy the app image in a low-traffic window; a restart drops all calls.
4. For SFU changes: update one node, verify rooms schedule to it, then the
   second. Bumping the LiveKit pin requires re-running `agil/core/scripts/sfu-smoke.mjs`.
5. For egress changes: stop new recordings, drain active jobs, update, run
   `agil/core/scripts/egress-health.mjs --run` smoke.
6. Keep the previous image tag and the previous proxy configs until the next
   business day.
7. Update this document when a runbook step changes — an outdated runbook is an
   incident amplifier.

Change freeze triggers: error budget exhausted, active incident, unresolved
backup failure, TLS expiry < 7 days.

---

## 10. Validation status and limitations

**Validated in this change (no production access):**

- shell syntax of both scripts (`bash -n`), `--help`, and a dry-run plus a real
  backup → verify → restore round-trip against a scratch data directory
  (including secret-exclusion, checksum-mismatch, path-traversal, retention and
  non-empty-target negative tests);
- Node syntax (`node --check`) and a live run of `ops-check.mjs` against a mock
  `/v1/health`, including warn/crit exit codes;
- YAML parse of Prometheus config, rules, blackbox modules and compose; JSON
  parse of the Grafana dashboard.

**Limitations / open items:**

- The app has no Prometheus endpoint; availability is synthetic and media
  metrics come from LiveKit only.
- The app has a leader/standby baseline through a Redis lease
  ([`agil/core/docs/ha-leader.md`](ha-leader.md)): the standby is read-only and
  takes over mutations after the TTL, but room/presence/config state is not
  replicated, so failover loses live rooms. Active-active application HA still
  requires the signalling bus from `agil/core/docs/scaling.md` §4.
- The SFU pair currently shares one host; a host loss takes both nodes down.
- Redis is a single instance today (replica + Sentinel are a target, not a
  deployment).
- Caddy has no active SFU health check, so failover depends on client reconnect.
- No Alertmanager/Grafana deployment is performed here; the stack is optional
  and loopback-bound.
- Recording success and media join SLOs need client telemetry that is not wired
  to a backend yet.
- `ops-check.mjs` cannot verify UDP media or TURN allocations from inside a
  corporate network; run it from the public edge or combine it with a real
  client check (`agil/core/scripts/turn-smoke.mjs`, `chrome://webrtc-internals`).

---

## 11. File map

| File | What it is |
|---|---|
| [`agil/core/docs/operations.md`](operations.md) | this document |
| [`agil/core/docs/deployment.md`](deployment.md) | first install, Docker, TLS/TURN, scaling |
| `agil/core/docs/deployment-record.md` | factual Server 3 deployment, proxy backups, rollback |
| [`agil/core/docs/sfu-multinode.md`](sfu-multinode.md) | two-node LiveKit routing, measured run |
| [`agil/core/docs/egress-production.md`](egress-production.md) | egress worker kit, capacity, health |
| [`agil/core/docs/security.md`](security.md) | threat model, secrets, data retention |
| [`agil/core/scripts/backup-data.sh`](../scripts/backup-data.sh) | backup with retention, checksum, optional S3 |
| [`agil/core/scripts/restore-data.sh`](../scripts/restore-data.sh) | verified restore, dry-run |
| [`agil/core/scripts/ops-check.mjs`](../scripts/ops-check.mjs) | read-only health sweep, JSON |
| [`agil/core/scripts/egress-health.mjs`](../scripts/egress-health.mjs) | egress worker health/smoke |
| [`agil/core/deploy/observability/prometheus.yml`](../deploy/observability/prometheus.yml) | scrape config |
| [`agil/core/deploy/observability/agil-alerts.yml`](../deploy/observability/agil-alerts.yml) | alert rules |
| [`agil/core/deploy/observability/grafana/agil-calls-ops.json`](../deploy/observability/grafana/agil-calls-ops.json) | minimal Grafana dashboard |
