# LiveKit Egress — production deployment kit

> **Date:** 16.11.2026 · **Status:** deployment kit + runbook, **not deployed**;
> QA P1/P2 fixes applied, **retest pending** ·
> **App code changed:** egress controller + dashboard card (see §18 items 5–6) ·
> **Secrets in repo:** none
>
> This document covers the dedicated LiveKit Egress worker for AgilFrame. It is
> based on the local lab that proved **MP4, RTMP, HLS and combined output** with
> `livekit/egress:v1.15.0` against the production SFU
> (`agil/core/docs/egress-local-test.md`). The kit is in
> [`agil/core/deploy/egress/`](../deploy/egress/); the health/smoke helper is
> [`agil/core/scripts/egress-health.mjs`](../scripts/egress-health.mjs); the independent
> QA report and per-finding status are in
> `agil/core/docs/qa-egress-ops.md`.
>
> **The app VPS (1 vCPU / 2 GB) must not run egress.** The worker needs 8 vCPU /
> 8 GB for one 720p multi-output composite, a 2.5 GB image, Chrome/GStreamer,
> and host networking.

## 0. TL;DR

| Item | Value |
|---|---|
| Worker image | `livekit/egress:v1.15.0` (pinned; lab-proven with LiveKit `v1.13.11`) |
| Worker host | dedicated 8 vCPU / 8 GB / 100+ GB SSD, host networking |
| Redis | **the same Redis as the SFU**; private network or SSH tunnel to the SFU loopback |
| SFU endpoint used by the worker | `wss://sfu.example.com` |
| App env | `AGIL_EGRESS_URL=https://sfu.example.com`, `AGIL_EGRESS_ENABLED=1` |
| App egress keys | default to `AGIL_SFU_API_KEY` / `AGIL_SFU_API_SECRET`; no separate key required |
| Storage | S3-compatible bucket in the required jurisdiction; `/out` is fallback/backup only |
| Health | `node agil/core/scripts/egress-health.mjs` (dry-run by default) |
| Smoke | `node agil/core/scripts/egress-health.mjs --run --room=<id> --token=<host-token> --publisher` |
| Rollback | append/force `AGIL_EGRESS_ENABLED=0`, force-recreate the app, assert `enabled=false`, then stop the worker |

**Why a dedicated host:** the lab measured **5.41 CPU cores / 1.95 GB RSS** for
one 720p composite with MP4 + RTMP + HLS. The app VPS has 1 vCPU / 2 GB. Putting
egress there would OOM the app or drop the recording; it would also violate the
current production assumption that the app host is separate from the media
plane.

## 1. Topology

```
                         public TLS
Browser ── WSS/WebRTC ───────────────►  LiveKit SFU  (v1.13.11, 2 nodes)
   │                                        │
   │                                        │  room state + psrpc bus
   │                                        ▼
   │                                   Redis (private, SFU-local 127.0.0.1:6379)
   │                                        ▲
   │                                        │  same Redis (SSH tunnel or VPC)
   │                                        │
   └── HTTPS ──► App API ── HTTPS Twirp ──► SFU
                    │                       │
                    │  /v1/rooms/:id/egress │  dispatch StartEgress
                    │  (app VPS)            ▼
                    │                 Egress worker (8 vCPU / 8 GB, host network)
                    │                       │
                    │                       ├─ Chrome + GStreamer: MP4 / HLS / RTMP
                    │                       ├─ /out (local fallback/backup)
                    │                       └─ S3/MinIO ──► CDN (HLS / VOD)
                    │
                    └─ dashboard uses the same app API (see limitations)
```

Data path, in words:

1. The app mints a room token and calls `POST /v1/rooms/:id/egress/start`.
2. The app's egress controller (`agil/core/apps/server/src/egress.ts`) sends a Twirp
   `StartRoomCompositeEgress` to the LiveKit server at `AGIL_EGRESS_URL`.
3. The LiveKit server publishes the job on the **Redis/psrpc bus**. It does not
   connect to the worker directly; the worker subscribes to the bus.
4. The worker joins the LiveKit room over `wss://` and receives media over
   WebRTC/UDP, then runs Chrome/GStreamer and writes outputs.
5. MP4/HLS are uploaded to S3-compatible storage (or fall back to `/out`);
   RTMP(S) is pushed to the provider. HLS/VOD is served from S3 directly or via
   CDN.

**Hard rule:** the worker's `redis.address` must be the Redis used by the
LiveKit server that dispatches the job. A worker with a local Redis and a
production `ws_url` cannot receive jobs — that was the central finding of the
lab (§2).
There is **no egress Twirp API on the worker**; the Twirp API is on the LiveKit
server. Port 8080 on the worker is health only.

## 2. Files in this kit

| File | Purpose |
|---|---|
| [`agil/core/deploy/egress/docker-compose.yml`](../deploy/egress/docker-compose.yml) | worker service: host network, pin, shm, 8 vCPU/8 GB limits, `/out`, optional MinIO profile |
| [`agil/core/deploy/egress/egress.yaml`](../deploy/egress/egress.yaml) | egress config template: `ws_url`, Redis, storage, ports, limits |
| [`agil/core/deploy/egress/.env.example`](../deploy/egress/.env.example) | variable names and non-secret defaults; copy to `.env` |
| [`agil/core/deploy/egress/render-config.sh`](../deploy/egress/render-config.sh) | renders the template to a root-owned 0640 file outside the repo |
| [`agil/core/scripts/egress-health.mjs`](../scripts/egress-health.mjs) | Redis worker check + `lk egress list` + optional app status/smoke |
| this document | topology, firewall, Redis, S3, retention, capacity, security, rollout |

Nothing in this kit is wired into the repo-root `docker-compose.yml` or the app
image. Deploying it does not restart or rebuild `agil-calls`.

## 3. Prerequisites

- [ ] A **dedicated** Linux host with 8 vCPU, 8 GB RAM, 100+ GB SSD (200 GB
      recommended for local fallback), 1 Gbps NIC.
- [ ] Docker Engine 24+ and Compose v2.
- [ ] The SFU's API key/secret (the same pair the app uses as
      `AGIL_SFU_API_KEY` / `AGIL_SFU_API_SECRET`).
- [ ] Reachability to the SFU: `wss://` (443) and RTC media (UDP; the production
      SFU uses `50000–50100` on node 1 and `50200–50300` on node 2).
- [ ] Redis access: private VPC route to the SFU's Redis **or** SSH access to the
      SFU host for a loopback tunnel (default, no SFU changes).
- [ ] An S3-compatible bucket and a least-privilege key, or the optional MinIO
      profile for a lab/offline deployment.
- [ ] An `lk` binary (livekit-cli; the lab used `v2.19.4`) for health checks and
      the optional publisher. Install from
      <https://github.com/livekit/livekit-cli/releases>.
- [ ] Node.js 20+ for `agil/core/scripts/egress-health.mjs` (no npm dependencies), or run
      the script from an admin workstation.
- [ ] Admin access to the app VPS (`/opt/agil-calls/.env`) for the final
      `AGIL_EGRESS_*` change.

## 4. Worker host preparation

Examples are Ubuntu 24.04; adjust package names for your distro.

```bash
# 1. Verify capacity and that the host is not the app VPS.
nproc                      # expect 8
free -g                    # expect >= 8 GiB total
df -h /                    # expect >= 100 GB free
ip -4 addr show            # note the private address, if any

# 2. Make sure the egress ports are free on this dedicated host. The lab hit a
#    8080 collision with nginx-rtmp; health/metrics must not collide.
ss -lntp | grep -E ':(8080|9090|7980)\b' || true

# 3. Docker + compose plugin.
docker --version
docker compose version
sudo systemctl enable --now docker

# 4. Dedicated directory and unprivileged egress UID (image runs as UID 1001).
sudo install -d -m 750 -o root -g root /opt/agil-egress
sudo install -d -m 750 -o 1001 -g 1001 /srv/agil-egress/out
sudo install -d -m 750 -o 1001 -g 1001 /srv/agil-egress/out/backup

# 5. Copy the kit (rsync/git; never overwrite the operator's .env or agil/core/scripts/).
sudo rsync -a --exclude '.env' --exclude '.env*' --exclude 'out/' agil/core/deploy/egress/ /opt/agil-egress/
sudo chown -R root:root /opt/agil-egress
sudo chmod 750 /opt/agil-egress

# 6. Pre-pull the 2.5 GB image before the maintenance window.
sudo docker pull livekit/egress:v1.15.0
```

Deploy as root via `sudo docker compose ...` or add the operator to the
`docker` group. Membership in `docker` is root-equivalent; use a dedicated
operator and SSH keys.

## 5. Redis access (the critical dependency)

Egress and the LiveKit server must share one Redis. Production Redis is internal
to the SFU cluster; do not publish 6379 to the internet.

### 5.1 Option A — private network / VPC (recommended long term)

If the worker and SFU share a private L2/L3 network:

- Bind Redis to the private interface (or keep it on loopback and add a
  WireGuard/private route), and allow only the worker's private IP on 6379.
- Prefer Redis TLS (`rediss://`) and ACLs if the network is not fully trusted.
  The worker config takes `address` as **host:port** only; set
  `EGRESS_REDIS_TLS=true` (rendered as `redis.use_tls`) and
  `EGRESS_REDIS_DB=<n>` for a non-zero database.
- Set `EGRESS_REDIS_ADDRESS=<sfu-private-ip>:6379` and render the config.
- Do **not** change `bind` to `0.0.0.0`; never expose Redis publicly. Changing
  the SFU Redis is a production change with its own maintenance window.

This option has no SSH process to babysit and is the best steady state.

### 5.2 Option B — SSH loopback tunnel (default in this kit; no SFU change)

The SFU Redis listens on `127.0.0.1:6379`. Forward a local port on the worker to
that loopback:

```
worker 127.0.0.1:16379  ──SSH──►  sfu 127.0.0.1:6379
```

The worker has host networking, so egress reaches the tunnel at
`127.0.0.1:16379`. Set `EGRESS_REDIS_ADDRESS=127.0.0.1:16379`.

The SFU's Redis port may differ from 6379. Verify it before writing the
tunnel: `ssh root@<sfu> 'ss -lntp | grep -i redis; docker ps --format "{{.Names}} {{.Ports}}" | grep -i redis'`.
The repo's lab scaffold publishes `127.0.0.1:6380`; the 2-node production SFU
runbook uses 6379. If Redis is only on a Docker bridge and not published on the
SFU host loopback, a plain `127.0.0.1:6379` tunnel cannot reach it: publish it
on loopback on the SFU (a controlled SFU change) or target the Redis container's
reachable address, and record the actual port in the systemd `-L` and
`EGRESS_REDIS_ADDRESS`.

Create a dedicated tunnel account and a restricted key on the **SFU**:

```bash
# On the SFU host, as root:
sudo useradd --system --create-home --shell /usr/sbin/nologin egress-tunnel
sudo install -d -m 700 -o egress-tunnel -g egress-tunnel /home/egress-tunnel/.ssh
sudo -u egress-tunnel ssh-keygen -t ed25519 -N '' \
  -f /home/egress-tunnel/.ssh/id_ed25519 -C 'agil-egress-tunnel'
sudo cat /home/egress-tunnel/.ssh/id_ed25519.pub
```

Add the **public** key to the SFU tunnel account's `authorized_keys` with a
forced restriction (replace the key text):

```text
restrict,port-forwarding,permitopen="127.0.0.1:6379" ssh-ed25519 AAAA... agil-egress-tunnel
```

`restrict` disables PTY/agent/X11 forwarding; `port-forwarding` re-enables only
the forward permitted by `permitopen`. The tunnel account cannot run commands.

On the **worker**, create the same `egress-tunnel` account first (a clean
worker has no such user; without it `install -o egress-tunnel` fails and
systemd exits with `217/USER`):

```bash
# On the worker, as root:
sudo useradd --system --create-home --shell /usr/sbin/nologin egress-tunnel
id egress-tunnel

# Copy the PRIVATE key from the SFU to the worker (or generate the pair on the
# worker and only move the public key). Mode 600, owned by the tunnel user.
sudo install -d -m 700 -o egress-tunnel -g egress-tunnel /home/egress-tunnel/.ssh
sudo install -m 600 -o egress-tunnel -g egress-tunnel \
  ./id_ed25519 /home/egress-tunnel/.ssh/id_ed25519

# Pin the SFU host key (verify the fingerprint out of band first).
sudo -u egress-tunnel ssh-keyscan -t ed25519 203.0.113.7 \
  | sudo tee -a /home/egress-tunnel/.ssh/known_hosts >/dev/null
sudo chown egress-tunnel:egress-tunnel /home/egress-tunnel/.ssh/known_hosts
```

The account name must be identical on both hosts (the unit connects as
`egress-tunnel@<sfu>`); if your organisation uses an existing account, replace
**every** `egress-tunnel` reference below consistently (user, home, key, unit
`User=`/`Group=`).

Systemd unit `/etc/systemd/system/agil-egress-redis-tunnel.service`
(replace `203.0.113.7` with the SFU host, and `16379` with the local port you
chose):

```ini
[Unit]
Description=AGIL egress Redis tunnel (SFU loopback 6379 -> worker 16379)
After=network-online.target
Wants=network-online.target

[Service]
User=egress-tunnel
Group=egress-tunnel
ExecStart=/usr/bin/ssh -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -i /home/egress-tunnel/.ssh/id_ed25519 \
  -L 127.0.0.1:16379:127.0.0.1:6379 \
  egress-tunnel@203.0.113.7
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/egress-tunnel

[Install]
WantedBy=multi-user.target
```

Enable and verify:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agil-egress-redis-tunnel.service
systemctl status agil-egress-redis-tunnel.service --no-pager
ss -lntp | grep 127.0.0.1:16379

# Redis PING through the tunnel (docker is fine for a one-off client):
sudo docker run --rm --network host redis:7-alpine \
  redis-cli -h 127.0.0.1 -p 16379 ping
# PONG
```

If Redis AUTH/ACL is enabled, do **not** pass `-a` (it appears in `ps` and
shell history). Read the password without echo and hand it to `redis-cli` via
`REDISCLI_AUTH` in the environment:

```bash
read -r -s -p 'redis password: ' REDISCLI_AUTH; echo; export REDISCLI_AUTH
sudo --preserve-env=REDISCLI_AUTH docker run --rm --network host -e REDISCLI_AUTH \
  redis:7-alpine redis-cli -h 127.0.0.1 -p 16379 ping
unset REDISCLI_AUTH
```

Use the same `REDISCLI_AUTH` pattern for the `PUBSUB` checks in §5.3 when AUTH
is enabled.

If the SFU Redis requires a password, set `EGRESS_REDIS_USERNAME` /
`EGRESS_REDIS_PASSWORD`; they are rendered into the 0640 config (egress has no
Redis-password env override). A loopback tunnel to a no-auth Redis is simpler
and keeps the secret out of files.

### 5.3 Verify the worker registered (without starting a job)

After the worker starts, the egress service subscribes to psrpc channels. On a
healthy pair you should see:

```bash
sudo docker run --rm --network host redis:7-alpine \
  redis-cli -h 127.0.0.1 -p 16379 pubsub channels '*EgressInternal*'
# EgressInternal|StartEgress|REQ
# EgressInternal|StartEgress|RCLAIM
# EgressInternal|ListActiveEgress|REQ

sudo docker run --rm --network host redis:7-alpine \
  redis-cli -h 127.0.0.1 -p 16379 pubsub numsub 'EgressInternal|StartEgress|REQ'
# EgressInternal|StartEgress|REQ
# 1
```

The count is the number of worker subscriptions (one per worker). If you set a
`cluster_id` in `egress.yaml`, the channel name includes it between the method
and `|REQ`; the health script matches the prefix/suffix, so it still works.
`PUBSUB` is the right primitive here: psrpc uses Redis pub/sub for worker
registration and job delivery, not persistent keys.

The authoritative end-to-end check is still:

```bash
export LK_NO_SKILLS_PROMPT=1
export LIVEKIT_URL=https://sfu.example.com
export LIVEKIT_API_KEY='<sfu-key>'
export LIVEKIT_API_SECRET='<sfu-secret>'
lk egress list --json
```

An empty list is success: the SFU reached a worker through Redis. Depending on
the CLI version, `--json` may print `[]` or `null` for no jobs; both mean the
same. `no response from egress service` means the SFU cannot see any egress
worker (wrong Redis, tunnel down, worker not running, or all workers full). See
the lab FAQ (§6).

## 6. Storage: S3 / MinIO / CDN

### 6.1 External S3 (recommended)

1. Create a private bucket in the required jurisdiction (for 152-ФЗ, a RU
   region/provider). Enable versioning and default encryption (SSE-S3 or KMS).
2. Create a dedicated key with the minimum policy. Egress needs `PutObject`,
   `AbortMultipartUpload`, and multipart list/upload permissions under the
   recording prefix; it does not need bucket-wide read/delete:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EgressWrite",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::agil-recordings/*"
    }
  ]
}
```

If your provider needs `ListBucket` for multipart/listing, scope it to the
prefix. Do not grant `s3:*`. Do not enable public read; serve HLS/VOD through
signed URLs or a CDN with an origin-access identity.

3. Set in `agil/core/deploy/egress/.env`:

```dotenv
EGRESS_S3_ENDPOINT=https://s3.example.com
EGRESS_S3_REGION=ru-msk
EGRESS_S3_BUCKET=agil-recordings
EGRESS_S3_ACCESS_KEY=...
EGRESS_S3_SECRET_KEY=...
```

Prefer an instance role/workload identity and leave the key/secret empty if
your host supports it. Set `EGRESS_S3_FORCE_PATH_STYLE=true` for MinIO, Ceph and
many RU S3 clones, `false` for virtual-hosted AWS; `render-config.sh` writes it
to `storage.s3.force_path_style` (do not edit the rendered file by hand, the
next render overwrites it).

### 6.2 Optional MinIO (lab/self-hosted profile)

The compose file has a `minio` profile. It publishes the API/console on
**loopback only**; egress (host network) reaches `127.0.0.1:9000`. It is not
started by default.

```bash
cd /opt/agil-egress
# .env for MinIO:
#   EGRESS_S3_ENDPOINT=http://127.0.0.1:9000
#   EGRESS_S3_REGION=ru-msk
#   EGRESS_S3_BUCKET=agil-recordings
#   EGRESS_S3_ACCESS_KEY=<MINIO_ROOT_USER>
#   EGRESS_S3_SECRET_KEY=<MINIO_ROOT_PASSWORD>
#   EGRESS_S3_FORCE_PATH_STYLE=true
#   MINIO_ROOT_USER=agil-egress
#   MINIO_ROOT_PASSWORD=<strong-password>
sudo sh render-config.sh
sudo docker compose --profile minio up -d
sudo docker compose logs -f minio-init   # "bucket ready"
```

The `minio-init` one-shot creates the bucket and sets it private. Console:
`ssh -L 9001:127.0.0.1:9001 root@worker` then <http://127.0.0.1:9001>.

**MinIO caveat:** MinIO stopped publishing community Docker images in late
2025; the pinned tags in the compose file are the last AGPLv3 community images
with a console. Mirror them to your own registry, verify licenses/CVEs, or use
an external S3/MinIO/Ceph cluster. Do not treat the compose profile as a
supported long-term storage product.

### 6.3 `/out` volume and backup

`/out` is bind-mounted from `EGRESS_OUT_DIR` (default
`/srv/agil-egress/out`) and used for:

- local file output if an operator explicitly targets `/out/...`;
- `backup.prefix: /out/backup` — a fallback copy when the primary S3 upload
  fails (`backup_storage_used` is set on the egress info).

`/out` is **not** durable production storage: it is one disk, it is not
replicated, and a full disk breaks new jobs. Monitor it and copy/retry backups
to S3. Remove the `backup` block if you prefer jobs to fail closed instead of
filling the local disk.

### 6.4 CDN for HLS/VOD

- Keep the bucket private. Use a CDN with signed URLs/cookies or an origin
  access identity; do not make the bucket public.
- HLS needs CORS for browser playback (`GET`, `HEAD`, `Range`, `Content-Type`,
  `Content-Length`, `Content-Range`) and correct MIME types (`.m3u8` →
  `application/vnd.apple.mpegurl`, `.ts` → `video/mp2t`).
- HLS segments are uploaded as they are produced; MP4 appears only when the job
  is stopped/finalized.
- Configure cache behavior: short TTL for live playlists, longer for segments
  and VOD MP4; purge on deletion if required.

## 7. Configuration

### 7.1 `.env`

```bash
cd /opt/agil-egress
sudo cp -n .env.example .env
sudo chmod 600 .env
sudo $EDITOR .env
```

Required values:

| Variable | Meaning |
|---|---|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | same key/secret as the SFU (and the app's `AGIL_SFU_*`) |
| `EGRESS_WS_URL` | `wss://sfu.example.com` |
| `EGRESS_REDIS_ADDRESS` | `127.0.0.1:16379` (tunnel) or private VPC address; **host:port only** |
| `EGRESS_REDIS_TLS` | `true` for a TLS Redis (`rediss`); `false` for the loopback tunnel |
| `EGRESS_REDIS_DB` | Redis logical database (default `0`) |
| `EGRESS_S3_ENDPOINT/REGION/BUCKET` | storage target |
| `EGRESS_S3_ACCESS_KEY/SECRET_KEY` | static key if no instance role |
| `EGRESS_S3_FORCE_PATH_STYLE` | `true` for MinIO/Ceph, `false` for virtual-hosted AWS |
| `EGRESS_OUT_DIR` | host directory for `/out` |
| `EGRESS_CONFIG_FILE` | rendered config path (default `/etc/agil-egress/egress.yaml`) |

Do not commit `.env`. Do not paste its contents into tickets or chat. Quote
values containing spaces, `#`, `$`, backticks or quotes; `render-config.sh`
parses the file literally (it never sources it), so `$`/backticks are not
expanded. Compose uses `.env` for interpolation and passes only
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `AWS_*` into the egress container;
the file itself is not mounted into the container.

### 7.2 Render `egress.yaml`

```bash
cd /opt/agil-egress
sudo sh render-config.sh
# rendered /etc/agil-egress/egress.yaml (mode 640, no API keys)
sudo ls -l /etc/agil-egress/egress.yaml
# expected: -rw-r----- 1 root root ... /etc/agil-egress/egress.yaml
# 0640 (not 0600): egress runs as UID 1001 with primary group root and must be
# able to read the mounted config. It contains no API keys.
sudo sed -n '1,25p' /etc/agil-egress/egress.yaml   # inspect; no secrets expected
```

`render-config.sh` refuses to write inside the repo, uses `umask 077`, checks
for unresolved `${EGRESS_*}` placeholders, and validates the YAML if
`python3`+PyYAML is available. It parses `.env` with a non-evaluating dotenv
reader (never `source`s it), quotes string values as YAML scalars, and renders
`redis.use_tls`, `redis.db` and `storage.s3.force_path_style`. The rendered
file has no API keys; egress reads them from
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in the container environment.

Key values in the template:

| Key | Meaning |
|---|---|
| `ws_url` | SFU signaling URL; worker joins here |
| `redis.address` | the SFU's Redis through the tunnel/private network (`host:port`) |
| `redis.use_tls` | `true` for TLS; rendered from `EGRESS_REDIS_TLS` |
| `redis.db` | Redis database; rendered from `EGRESS_REDIS_DB` |
| `health_port: 8080` | health only; block externally |
| `prometheus_port: 9090` | metrics; block externally |
| `template_port: 7980` | local templates; do not expose |
| `storage.s3` | MP4/HLS upload target; `force_path_style` from `.env` |
| `backup.prefix` | local `/out/backup` fallback |
| `cpu_cost.room_composite_cpu_cost: 6.0` | one composite on 8 vCPU |
| `session_limits` | runaway-job protection |

`insecure: false` is correct for `wss://`. Set it to `true` only for `ws://` on a
trusted private network, and only after a canary.

### 7.3 Validate before starting

```bash
cd /opt/agil-egress

# Compose interpolation and basic schema. --quiet suppresses the rendered
# output; a plain `docker compose config` would print secret env values, so do
# not paste that output into tickets.
sudo docker compose config --quiet

# YAML parse of the template/render (no secrets). The rendered config is
# 0640 root:root by design, so a non-root operator cannot read it: run this
# block with sudo (or as root). The template itself is world-readable.
sudo python3 - <<'PY'
import yaml
for p in ('egress.yaml', '/etc/agil-egress/egress.yaml'):
    with open(p, encoding='utf-8') as f:
        yaml.safe_load(f)
    print('OK', p)
PY
```

If `docker compose config` is not available, install the Compose v2 plugin; the
health script and egress will fail fast on a malformed config, but validate
before the maintenance window.

## 8. Firewall and ports

With `network_mode: host`, all egress listeners bind on the host. Docker
published-port DNAT does not apply, so host/cloud firewall rules **do** matter;
still enforce them at the cloud security group as the primary boundary.

| Direction | Source → destination | Port / proto | Purpose | Exposure |
|---|---|---|---|---|
| Inbound | admin → worker | 22/tcp | SSH/ops | allowlist only |
| Inbound | internet → worker | 8080, 9090, 7980/tcp | egress health/metrics/templates | **DENY** |
| Outbound | worker → SFU | 443/tcp | `wss://` signaling, API | allow |
| Outbound/return | worker ↔ SFU | UDP 50000–50100, 50200–50300 | WebRTC media capture | allow; stateful return must work |
| Outbound | worker → SFU | 22/tcp | Redis SSH tunnel | allow to SFU only |
| Outbound | worker → SFU Redis | 6379/tcp | private-network option only | allow worker IP only; never public |
| Outbound | worker → S3/CDN | 443/tcp | MP4/HLS upload, CDN API | allow |
| Outbound | worker → RTMP provider | 1935/tcp (or 443 for rtmps) | RTMP(S) push | allow provider host |
| Outbound | worker → DNS | 53/udp,tcp | name resolution | allow resolver |
| Inbound | app VPS → SFU | 443/tcp | Twirp egress API | app already has this |
| Inbound | SFU → worker | ephemeral UDP | return media for worker-initiated ICE | stateful firewall; open if stateless |

Examples (review before applying; provider firewalls differ):

```bash
# Host firewall (Ubuntu/ufw). Docker host networking binds directly, but still
# use the cloud security group as the real boundary.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
# Explicitly deny the egress admin/health ports if a default-allow policy exists:
sudo ufw deny 8080/tcp
sudo ufw deny 9090/tcp
sudo ufw deny 7980/tcp
# --force makes this non-interactive; confirm the rule set afterwards.
sudo ufw --force enable
sudo ufw status numbered
```

For a stateless cloud firewall, allow outbound UDP to the SFU RTC ranges and
allow the SFU's public IPs to send UDP back to the worker on ephemeral ports
(1024–65535), or put a TURN/TCP path in place. Test with `lk load-test` /
`ss -u` while an egress job is active; do not assume "outbound is open" is
enough for WebRTC.

**Never expose 8080/9090/7980 publicly.** The health endpoint has no
authentication. The egress Twirp API is on the SFU (`/twirp/livekit.Egress/...`),
not on the worker.

## 9. Deploy the worker

```bash
cd /opt/agil-egress

# .env and rendered config must already exist (sections 7.1–7.2).
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=100 egress
sudo docker compose exec egress id
# expect uid=1001(egress) gid=0(root) ...; the 0640 config is group-readable
sudo docker compose exec egress head -1 /etc/agil-egress/egress.yaml

# Health (read-only; smoke is dry-run by default). `.env` is root 0600, so
# run as root on the worker (or use a copy owned by your operator account):
sudo node agil/core/scripts/egress-health.mjs --env-file .env
```

If `agil/core/scripts/` is not copied to the worker, copy `agil/core/scripts/egress-health.mjs`
from the repo (or run it from an admin workstation with `.env` and network
access to Redis/the SFU). The script needs no npm dependencies. If root's
`PATH` does not include `node`, use the absolute path (`command -v node` as the
operator) or install Node system-wide.

Expected first start:

- `egress` becomes `healthy`;
- `docker logs` eventually prints `service ready`;
- `systemctl status agil-egress-redis-tunnel` is `active (running)`;
- `lk egress list --json` returns an empty result (`[]`/`null`), i.e. worker
  registered with no active jobs;
- no errors about `redis`, `no response from egress service`, or Chrome.

If the worker starts before Redis is reachable, it exits/retries according to
compose `restart: unless-stopped`; fix the tunnel, then
`sudo docker compose restart egress`.

### 9.1 Health script reference

```bash
# Read-only checks + smoke plan (default):
sudo node agil/core/scripts/egress-health.mjs --env-file .env

# Explicit dry run (overrides --run/--smoke):
sudo node agil/core/scripts/egress-health.mjs --env-file .env --dry-run

# Machine-readable (HTTP/TLS errors are scrubbed; no token/key/password):
sudo node agil/core/scripts/egress-health.mjs --env-file .env --json

# Redis TLS with a private CA: --redis-ca takes a PEM *path*; the script reads
# the file contents (Node does not accept a filename as `ca`).
sudo node agil/core/scripts/egress-health.mjs --env-file .env \
  --redis=rediss://redis.internal:6379 --redis-ca=/etc/ssl/certs/sfu-redis-ca.pem

# On a host without lk/app admin key:
sudo node agil/core/scripts/egress-health.mjs --env-file .env --skip-lk --skip-app

# Real start/stop smoke (mutates only the canary room; requires a publisher).
# Use a root shell and read the token without echoing it, so it is not in argv
# or a non-root shell history. `--publisher` starts a synthetic lk publisher.
sudo -s
cd /opt/agil-egress
export EGRESS_SMOKE_ROOM='<app-room-uuid>'
read -r -s -p 'host app token: ' EGRESS_SMOKE_TOKEN; echo
export EGRESS_SMOKE_TOKEN
node agil/core/scripts/egress-health.mjs --env-file .env --run --publisher --kind=hls --seconds=15
unset EGRESS_SMOKE_TOKEN
exit
```

Alternatively pass `--room`/`--token` (argv is visible in `ps`; prefer env), or
run the read-only checks from an admin workstation with a 0600 copy of the
relevant variables and network access to Redis/the SFU.

The script never prints the token, API secret, Redis password (including the
userinfo password in a `rediss://` URL), S3 secret or RTMP URL. It passes
LiveKit credentials to `lk` through `LIVEKIT_*` environment variables, not
command-line arguments. `--dry-run` is accepted as an explicit override of
`--run`.

What it checks:

| Check | Pass condition | Failure meaning |
|---|---|---|
| rendered config | `EGRESS_CONFIG_FILE` exists | run `render-config.sh` or fix the mount |
| out volume | directory exists and is writable by the egress UID (mode/owner check; host `accessSync` is secondary) | `chown -R 1001:1001 /srv/agil-egress/out`; `/out` fallback will fail |
| Redis worker | `PING` + `EgressInternal|StartEgress|*REQ` with `NUMSUB > 0` | wrong Redis/tunnel/worker down |
| `lk egress list` | exits 0; JSON parses (empty list/`null` is OK only without `no response from egress service`) | SFU cannot reach a worker, bad URL/keys, or `lk` missing |
| app egress status | `configured=true`, `urlConfigured=true` | app env missing; see §10 |
| smoke (optional) | `EGRESS_ACTIVE` → stop → `EGRESS_COMPLETE` | publisher/S3/gating/etc.; see worker logs |

## 10. Point the app at egress (exact commands)

The app reads these from its process environment (`agil/core/apps/server/src/env.ts`):

| Variable | Value / default | Notes |
|---|---|---|
| `AGIL_EGRESS_URL` | `https://sfu.example.com` | LiveKit **Twirp base**, not the worker and not `:8080` |
| `AGIL_EGRESS_API_KEY` | default `AGIL_SFU_API_KEY` | only set if you use a separate key |
| `AGIL_EGRESS_API_SECRET` | default `AGIL_SFU_API_SECRET` | must match the worker's `LIVEKIT_API_KEY/SECRET` |
| `AGIL_EGRESS_ENABLED` | **default `true`** | set `0` (or `false`) to disable with `501 egress_disabled` |

On the **app VPS** (`203.0.113.7`), with a backup first:

```bash
ssh root@203.0.113.7
cd /opt/agil-calls

# The app must reach the SFU Twirp endpoint over HTTPS (it is behind Caddy/HAProxy).
curl -fsS https://sfu.example.com/ >/dev/null && echo 'SFU reachable from app VPS'

# Back up the current environment (600, outside git).
cp -a .env ".env.bak-egress-$(date -u +%Y%m%dT%H%M%SZ)"
chmod 600 .env.bak-egress-*

# Replace or append exactly these two lines, without printing the file.
sed -i -e '/^AGIL_EGRESS_URL=/d' -e '/^AGIL_EGRESS_ENABLED=/d' .env
printf '%s\n' \
  'AGIL_EGRESS_URL=https://sfu.example.com' \
  'AGIL_EGRESS_ENABLED=1' >> .env

# Recreate only the app container so env_file changes take effect. Compose does
# not hash env_file contents, so --force-recreate is required.
docker compose up -d --force-recreate --no-deps agil-calls
docker compose ps agil-calls
```

If you use a separate egress key (not the SFU key), append
`AGIL_EGRESS_API_KEY=...` and `AGIL_EGRESS_API_SECRET=...` the same way, and set
the same pair as `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` on the worker.

Preflight the credential names (names only; values stay in the file). The app
defaults `AGIL_EGRESS_API_*` to `AGIL_SFU_API_*`, but egress itself only reads
`LIVEKIT_*`; if the app was configured through tenant `scale.sfu` env names,
`/v1/admin/egress/status` can stay `configured=false`:

```bash
grep -E '^(AGIL_SFU_API_KEY|AGIL_EGRESS_API_KEY)=' .env
grep -E '^(AGIL_SFU_API_SECRET|AGIL_EGRESS_API_SECRET)=' .env
```

If neither pair is present, append explicit `AGIL_EGRESS_API_KEY` /
`AGIL_EGRESS_API_SECRET` lines (same values as the worker) or set the SFU pair
first; then verify `configured=true` below.

Verify (no secret is printed or placed in argv; the admin key is read from the
root-only file inside the here-doc and sent to `curl --config -` on stdin):

```bash
curl -fsS --config - <<EOF | python3 -m json.tool
url = "https://calls.example.com/v1/admin/egress/status"
header = "x-api-key: $(cat /root/agil-admin-key.txt)"
EOF
```

Expected:

```json
{
  "configured": true,
  "enabled": true,
  "urlConfigured": true,
  "activeCount": 0,
  "lastError": null
}
```

If `configured=false` or `urlConfigured=false`, the app did not get the env
change (wrong file, wrong container, or `AGIL_EGRESS_ENABLED=0`). If
`lastError` is non-null, the most recent `ListEgress` call failed (Twirp/worker
or SFU↔Redis); `activeCount` itself returns HTTP 200 with `lastError` rather
than a 502. Go back to §5.

`AGIL_EGRESS_ENABLED=0` is the safe "off" switch: egress endpoints return `501
egress_disabled`, and no worker call is attempted. Calls and the rest of the app
continue to work.

## 11. Verify MP4 / RTMP / HLS via the app API

> **Scope note:** the local lab verified these outputs through direct Twirp
> against a local dispatcher and the production SFU. The app's own
> `/v1/rooms/:id/egress/*` orchestration was **not** exercised in the lab (see
> §9 of the lab). Use this
> section as the production acceptance procedure, and treat a failure as a
> finding to investigate — not as proof that the worker is broken.

### 11.1 Prepare a canary room, host token and publisher

The demo tenant defaults to mesh; scope SFU mode to the canary room with a
per-room override (no global config change):

```bash
set -euo pipefail
APP=https://calls.example.com
CURL_DIR=$(mktemp -d); chmod 700 "$CURL_DIR"
cleanup() {
  rm -rf "$CURL_DIR"
  unset HOST_TOKEN ROOM_JSON JOIN_JSON STREAM_KEY RTMP_URL 2>/dev/null || true
}
trap cleanup EXIT

# Admin key -> 0600 curl config. The key is not in argv/history; curl reads the
# header from the file. `umask 077` makes it non-world-readable from creation.
( umask 077; printf 'header = "x-api-key: %s"\n' "$(cat /root/agil-admin-key.txt)" > "$CURL_DIR/admin.rc" )
chmod 600 "$CURL_DIR/admin.rc"

# Room creation uses the tenant API key (x-api-key), never a Bearer admin token.
ROOM_JSON=$(curl -fsS --config "$CURL_DIR/admin.rc" -X POST "$APP/v1/rooms" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{"tenantId":"demo","name":"Egress production check","configOverrides":{"scale":{"mediaMode":"sfu"}}}
JSON
)

ROOM_ID=$(printf '%s' "$ROOM_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["room"]["id"])')
HOST_TOKEN=$(printf '%s' "$ROOM_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
unset ROOM_JSON

# Host token -> 0600 curl config (used by every egress call below).
( umask 077; printf 'header = "Authorization: Bearer %s"\n' "$HOST_TOKEN" > "$CURL_DIR/host.rc" )
chmod 600 "$CURL_DIR/host.rc"

# The join body carries the host token, so build it in a 0600 file (token in
# the environment, not in argv) and send it with --data-binary @file.
export HOST_TOKEN
python3 - "$CURL_DIR/join.json" <<'PY'
import json, os, sys
body = {
    'token': os.environ['HOST_TOKEN'],
    'name': 'Egress production host',
    'participantId': 'egress-prod-host',
}
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump(body, handle)
PY
chmod 600 "$CURL_DIR/join.json"
unset HOST_TOKEN
JOIN_JSON=$(curl -fsS -X POST "$APP/v1/rooms/$ROOM_ID/join" \
  -H 'Content-Type: application/json' --data-binary @"$CURL_DIR/join.json")
rm -f "$CURL_DIR/join.json"

SFU_ROOM=$(printf '%s' "$JOIN_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["media"]["room"])')
unset JOIN_JSON
printf 'room=%s sfu_room=%s\n' "$ROOM_ID" "$SFU_ROOM"
```

`HOST_TOKEN` is an app JWT, not a LiveKit token; it lives only in the 0600
`host.rc` (removed by the EXIT trap) and is never printed or committed.
`APP`, `ROOM_ID`, `SFU_ROOM` and `CURL_DIR` are used by §11.2–§11.5: run those
blocks in the same shell (or re-export the same values).

The feature gates must be on for the tenant (or use a test tenant):

```bash
# recording: features.recording=true AND (mediaProcessing.egress OR scale.streaming.enabled)
# rtmp/hls:  features.liveStreaming=true AND scale.streaming.enabled
# E2EE must be off for SFU egress.
# The config handler authenticates with the tenant key (x-api-key), not Bearer.
curl -fsS --config "$CURL_DIR/admin.rc" -X PATCH "$APP/v1/tenants/demo/config" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{"features":{"recording":true,"liveStreaming":true},"scale":{"streaming":{"enabled":true}},"mediaProcessing":{"mode":"server-assisted","egress":true}}
JSON

# Fail the canary now if the gates did not apply (GET config is public).
curl -fsS "$APP/v1/tenants/demo/config" | python3 -c '
import json, sys
config = json.load(sys.stdin)["config"]
assert config["features"]["recording"] is True, config["features"]
assert config["features"]["liveStreaming"] is True, config["features"]
assert config["scale"]["streaming"]["enabled"] is True, config["scale"]["streaming"]
print("feature gates on: recording/liveStreaming/streaming")
'
```

This changes tenant-wide config. Prefer a dedicated test tenant; if you must
use `demo`, revert/confirm with the product owner after the canary.

Publish media before starting egress (egress in an empty room fails at the
Chrome/page stage). In a second terminal, using the SFU key/secret (same as the
app's `AGIL_SFU_*`; never echo it):

```bash
set -a
. /opt/agil-calls/.env
set +a

# lk reads LiveKit credentials from the environment; do not pass
# --api-key/--api-secret (argv is visible in ps and shell history).
# The app .env may use either the AGIL_SFU_* or LIVEKIT_* names.
LIVEKIT_URL=${LIVEKIT_URL:-wss://sfu.example.com}
LIVEKIT_API_KEY=${LIVEKIT_API_KEY:-${AGIL_SFU_API_KEY:-}}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET:-${AGIL_SFU_API_SECRET:-}}
export LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET

lk load-test \
  --url "$LIVEKIT_URL" \
  --room "$SFU_ROOM" \
  --video-publishers 1 --video-resolution medium --duration 180s
```

Wait for `publishing simulcast video track` / `Publishers=1` before starting
egress. Alternatively use `--publisher` in the health script, which resolves
`media.room` and starts `lk load-test` for you.

### 11.2 MP4 recording

```bash
START_JSON=$(curl -fsS --config "$CURL_DIR/host.rc" -X POST "$APP/v1/rooms/$ROOM_ID/egress/start" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{"kind":"recording","layout":"speaker","audioOnly":false}
JSON
)

EGRESS_ID=$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["egressId"])')
printf 'egress=%s\n' "$EGRESS_ID"

# Poll every 2 s until active (up to 60 s).
for i in $(seq 1 30); do
  LIST=$(curl -fsS --config "$CURL_DIR/host.rc" "$APP/v1/rooms/$ROOM_ID/egress")
  STATUS=$(printf '%s' "$LIST" | python3 -c 'import json,sys; d=json.load(sys.stdin); i=sys.argv[1]; print(next((x.get("status","") for x in d.get("egress",[]) if x.get("egress_id")==i), ""))' "$EGRESS_ID")
  printf 'status=%s\n' "$STATUS"
  [ "$STATUS" = "EGRESS_ACTIVE" ] && break
  sleep 2
done

# Hold ~20 s, then stop. MP4 is finalized on stop; nothing appears before EOS.
sleep 20
curl -fsS --config "$CURL_DIR/host.rc" -X POST "$APP/v1/rooms/$ROOM_ID/egress/$EGRESS_ID/stop"
```

Wait for `EGRESS_COMPLETE` (same list call), then read the artifact location:

```bash
curl -fsS --config "$CURL_DIR/host.rc" "$APP/v1/rooms/$ROOM_ID/egress" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(x.get("status"), (x.get("file_results") or [{}])[0].get("location")) for x in d.get("egress",[])]'
```

For a private bucket, copy and probe:

```bash
aws s3 cp "s3://agil-recordings/<tenant>/<roomId>/<file>.mp4" /tmp/egress-check.mp4
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height -of json /tmp/egress-check.mp4
ffmpeg -v error -i /tmp/egress-check.mp4 -f null -   # rc 0
```

Expected: H.264 + AAC, 1280×720, duration ≈ hold time minus startup; the file
and egress manifest appear atomically at the end. Do **not** treat "file
missing" during an active job as a failure — that is how egress finalizes MP4.

### 11.3 RTMP push

```bash
# The stream key is a secret: read it without echo and keep it out of argv.
read -r -s -p 'RTMP stream key: ' STREAM_KEY; echo
export RTMP_URL="rtmp://live.example/app/$STREAM_KEY"
unset STREAM_KEY
python3 - "$CURL_DIR/rtmp.json" <<'PY'
import json, os, sys
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump({'kind': 'rtmp', 'rtmpUrl': os.environ['RTMP_URL']}, handle)
PY
chmod 600 "$CURL_DIR/rtmp.json"
unset RTMP_URL

START_JSON=$(curl -fsS --config "$CURL_DIR/host.rc" -X POST "$APP/v1/rooms/$ROOM_ID/egress/start" \
  -H 'Content-Type: application/json' --data-binary @"$CURL_DIR/rtmp.json")
rm -f "$CURL_DIR/rtmp.json"
EGRESS_ID=$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["egressId"])')

# Stop after ~20 s (same path route as MP4).
sleep 20
curl -fsS --config "$CURL_DIR/host.rc" -X POST "$APP/v1/rooms/$ROOM_ID/egress/$EGRESS_ID/stop"
```

- The app accepts only `rtmp://`/`rtmps://` with a host and validates the URL.
- The app redacts the URL to `rtmp://host/…` in audit/logs/list responses; the
  stream key must still be treated as a secret.
- Verify at the provider (preview/health), not from the egress list; egress also
  redacts stream URLs as `{t...t}` in its JSON/CLI output.
- Stop with the same `/egress/$EGRESS_ID/stop` call after ~20 s.
- A failed RTMP handshake leaves the other outputs running; check worker logs
  for `rtmp`/`connection` errors and provider ingest health.

If the provider supports HLS preview, probe it:

```bash
ffprobe -v error -show_entries format=duration,format_name:stream=codec_name,width,height \
  -of json https://provider.example/preview/<stream>.m3u8
```

### 11.4 HLS

```bash
START_JSON=$(curl -fsS --config "$CURL_DIR/host.rc" -X POST "$APP/v1/rooms/$ROOM_ID/egress/start" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{"kind":"hls"}
JSON
)
EGRESS_ID=$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["egressId"])')
```

The app requests a segmented output with `protocol: "HLS_PROTOCOL"`, a prefix
`<tenant>/<roomId>/<timestamp>`, `index.m3u8`, `live.m3u8` and a 2 s segment
duration. After `EGRESS_COMPLETE`, read `segment_results`:

```bash
curl -fsS --config "$CURL_DIR/host.rc" "$APP/v1/rooms/$ROOM_ID/egress" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(x.get("status"), (x.get("segment_results") or [{}])[0]) for x in d.get("egress",[])]'
```

Then verify the playlist and segments through S3 or the CDN:

```bash
curl -fsS "https://cdn.example/recordings/<tenant>/<roomId>/<timestamp>/index.m3u8" | tail -5
# expect #EXT-X-ENDLIST for the final VOD playlist
ffprobe -v error -show_entries format=duration,format_name:stream=codec_name,width,height \
  -of json "https://cdn.example/recordings/<tenant>/<roomId>/<timestamp>/index.m3u8"
```

For live playback use `live.m3u8`; for VOD use `index.m3u8` after stop. HLS
segments are uploaded while the job runs, so the live playlist can be played
before the job ends. `HLS_FMP4_PROTOCOL` was not tested in the lab; the kit uses
the default TS HLS.

### 11.5 Admin status and failure codes

```bash
curl -fsS --config - <<EOF | python3 -m json.tool
url = "https://calls.example.com/v1/admin/egress/status"
header = "x-api-key: $(cat /root/agil-admin-key.txt)"
EOF
```

| HTTP | Code | Meaning |
|---|---|---|
| 501 | `egress_disabled` | `AGIL_EGRESS_ENABLED=0` |
| 501 | `egress_not_configured` | `AGIL_EGRESS_URL` or keys missing |
| 503 | `egress_node_unavailable` | The organization’s bound Egress module is unavailable |
| 403 | `feature_disabled` | tenant features/streaming gate |
| 409 | `e2ee_incompatible` | E2EE is on; SFU cannot decrypt for egress |
| 400 | `validation_failed` | bad RTMP URL |
| 502 | `egress_failed` | Twirp/worker failure; check SFU↔Redis and worker logs |

## 12. Health, monitoring and alerting

Minimum signals:

1. **Worker registration:** `agil/core/scripts/egress-health.mjs` (Redis `PUBSUB NUMSUB` +
   `lk egress list`). Alert if no subscription for 2 minutes.
2. **Redis tunnel:** `systemctl is-active agil-egress-redis-tunnel`; alert on
   failure/restart. The tunnel is a single point of failure in Option B.
3. **Container health:** `docker compose ps` / healthcheck; restart count.
4. **CPU/RSS:** `docker stats --no-stream`; alert if sustained > 80% of the 8
   vCPU limit or RSS > 7 GB. One composite should peak around 5.4 cores / 2 GB.
5. **Disk:** `df -h /srv/agil-egress/out`; alert at 80%. Clean `/out/backup`
   per retention and investigate S3 failures.
6. **Egress metrics:** `http://127.0.0.1:9090/metrics` (do not expose). The
   `livekit_egress_available` metric is the upstream autoscaling signal; 0 means
   the worker is busy/unavailable. Scrape locally or via a private Prometheus.
7. **App status:** `GET /v1/admin/egress/status` — `lastError` non-null,
   `configured/urlConfigured` false, or `activeCount` not changing as expected.
8. **Job outcomes:** audit events `egress.started/stopped/failed`; egress
   `EGRESS_FAILED`/`EGRESS_ABORTED` in `GET /v1/rooms/:id/egress`.
9. **S3:** upload errors/retries in worker logs, `backup_storage_used` in egress
   info, bucket 4xx/5xx metrics.

Useful commands:

```bash
cd /opt/agil-egress
sudo docker compose ps
sudo docker compose logs --tail=200 egress | grep -Ei 'error|fail|redis|rtmp|s3|chrome'
sudo docker stats --no-stream
curl -fsS http://127.0.0.1:8080/ | python3 -m json.tool
curl -fsS http://127.0.0.1:9090/metrics | grep livekit_egress
df -h /srv/agil-egress/out
du -sh /srv/agil-egress/out/backup 2>/dev/null || true
```

Log retention is capped by the compose `json-file` options (50 MB × 5 for
egress, 20 MB × 3 for MinIO). Ship logs to your central store if required; do
not let a full disk stop recordings.

## 13. Capacity

Measured on the lab host (8 vCPU, 15 GiB; see
`agil/core/docs/egress-local-test.md`):

| Job | Avg CPU | Max CPU | Max RSS | Notes |
|---|---|---|---|---|
| MP4 only | 1.41 cores | 3.79 | 1.78 GB | 720p30, ~25 MB/min |
| RTMP only | 1.11 | 3.19 | 1.76 GB | provider push |
| HLS only | 1.56 | 3.86 | 1.73 GB | 2 s segments, ~20 MB/min |
| MP4 + RTMP + HLS | 1.21 | **5.41** | **1.95 GB** | the capacity-relevant run |

Recommendations:

| Scenario | Worker | Density | Notes |
|---|---|---|---|
| One 720p multi-output composite | **8 vCPU / 8 GB** | 1 job | lab peak 5.41 cores; 8 GB leaves Chrome/OS headroom |
| One 720p single output (MP4 **or** RTMP **or** HLS) | **4 vCPU / 4 GB** minimum | 1 job | peaks 3.19–3.86 cores / ~1.8 GB; tight — 6 vCPU gives margin |
| Two concurrent composites | 16 vCPU / 16 GB | 2 jobs | do not rely on admission defaults alone; re-test |
| Two workers for HA | 2 × 8 vCPU / 8 GB | 1 job each | egress load-balances over the shared Redis bus |

`egress.yaml` sets `room_composite_cpu_cost: 6.0`, `max_cpu_utilization: 0.80`,
`max_memory: 7.0`, so an 8 vCPU worker accepts one composite (6/8 = 0.75) and
rejects a second (12/8 > 0.80). For a 4 vCPU single-output worker, lower
`room_composite_cpu_cost` to `3.0` and `max_memory` to `3.5`, and re-run the
smoke; the default 6.0 would reject every job on 4 vCPU.

Other sizing facts:

- **Disk:** combined 720p ≈ 50 MB/min (MP4 + HLS + manifest); 100 GB is ~33
  hours of continuous recording before cleanup. Use 200 GB if `/out` backup is
  enabled and S3 outages are possible.
- **Network:** ~3 Mbps per output; 1 Gbps NIC is ample. The worker must sustain
  inbound media from the SFU and outbound RTMP/S3 simultaneously.
- **Startup:** Chrome warm-up adds 7–22 s per room-composite in the lab.
  Pre-pull the 2.5 GB image; the first job after a restart is slower.
- **One room per composite:** LiveKit room media is hosted on one SFU node; the
  egress worker follows the room. Multi-node SFU scales rooms, not one room's
  participants.

Do **not** co-locate egress with the SFU or the app. The app VPS is 1 vCPU / 2
GB and the SFU is already serving media; egress is a separate failure domain.

## 14. Retention and backup

### Archive after a meeting

The dashboard's **Recordings** page includes MP4 files started through Core's
Egress client. Core publishes `recording.ready` after LiveKit reports success and
the configured S3 bucket or playback directory exposes a non-empty object at
the expected key. The event includes `recordingId`, `egressId`, and a stable
delivery ID for deduplication. It does not include a signed link.

An administrator of the recording's organization can reload the catalogue to
get a fresh signed URL or call
`POST /v1/rooms/:roomId/egress/:egressId/playback` after the meeting. Keep
`<AGIL_DATA_DIR>/egress-archive` on persistent storage along with the rest of
Core's data. Cores in a failover setup need access to the same directory and
playback store. Backing up the S3 bucket alone preserves the media but loses
the Core catalogue.

Set `AGIL_EGRESS_PLAYBACK_BACKEND=local` to read from the worker's shared
volume at `AGIL_EGRESS_PLAYBACK_DIR`, or `s3` to use the configured
S3-compatible endpoint and bucket. Explicit selection never falls back to the
other store when configuration is incomplete or the store is unavailable.
`auto` preserves the previous selection order, configured S3 before local.
After a configuration change, archive records and new signed links stay bound
to their original store. Legacy records are bound after the first successful
check of their object and size.

S3 lifecycle and local storage policies can expire media outside Core. A
periodic leader check hides missing or changed files from the catalogue.
Verification runs on startup and in bounded batches. Metadata is retained so
the catalogue can recover if the original object returns. A storage permission
or network error does not mark a file absent.

Set `AGIL_EGRESS_ARCHIVE_DELETE_ENABLED=1` to expose the archive delete action
to organization administrators. The local volume must permit deletion. For
S3-compatible storage, grant the Core credential `s3:DeleteObject` on the
recording prefix in addition to its read permission. Verify that an authenticated
HEAD of a missing object returns 404. Core checks object removal before deleting
its catalogue entry. If the backend still reports the object or denies the
confirmation request, Core preserves the metadata. Existing links stop working
once the object is removed. In versioned buckets, older versions follow the
bucket's lifecycle. Older jobs launched before archive tracking and jobs started
outside Core require a separate import.

- **S3 lifecycle** (example: delete recordings after 90 days, abort incomplete
  multipart uploads after 1 day, expire noncurrent versions after 30 days):

```json
{
  "Rules": [
    {
      "ID": "agil-recordings-90d",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "Expiration": { "Days": 90 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket agil-recordings \
  --lifecycle-configuration file://lifecycle.json
```

- Enable **versioning** and, where legally required, **Object Lock** for
  recordings that must be retained/immutable. Document the retention period per
  tenant/contract; do not rely on a single global rule if tenants differ.
- **Encryption:** SSE-S3 or SSE-KMS by default; restrict KMS decrypt to the
  playback service/CDN role, not to the egress worker (egress only needs
  `PutObject`).
- **`/out/backup`:** not durable. Copy/retry to S3, then prune. Example (dry-run
  first, then delete):

```bash
find /srv/agil-egress/out/backup -type f -mtime +7 -print
# after review:
find /srv/agil-egress/out/backup -type f -mtime +7 -delete
```

- **152-ФЗ / data residency:** store recordings in a RU region/provider and
  restrict cross-border access. RTMP to a foreign provider is an export of the
  media stream; get legal/security approval before enabling it for tenants with
  personal data. HLS through a foreign CDN has the same consideration.
- **App metadata:** the app does not automatically ingest egress artifacts; the
  egress info (file/segment locations) is available through
  `GET /v1/rooms/:id/egress` while the app has the job record. Build a
  reconciliation job if recordings must be listed/deleted per tenant beyond the
  bucket lifecycle.

## 15. Security

- **Secrets:** SFU API key/secret only in `agil/core/deploy/egress/.env` (0600) and the
  container environment. The rendered `egress.yaml` has no API keys. App
  `.env` is 0600 on the app VPS. Never commit `.env`, never paste it into
  tickets, and scrub `docker inspect` output.
- **Key rotation:** rotate the SFU key/secret in the SFU, the app
  (`AGIL_SFU_*` / `AGIL_EGRESS_*`), and the worker (`LIVEKIT_*`), then restart
  all three. Existing tokens/jobs die with the old key; plan a maintenance
  window. `AGIL_EGRESS_API_*` defaults to the SFU key; if you need independent
  rotation, configure a separate pair on both sides.
- **Redis:** never public. Loopback tunnel or private network with firewall +
  optional TLS/ACL. The tunnel key is restricted with
  `restrict,port-forwarding,permitopen="127.0.0.1:6379"`; the tunnel user has
  `nologin`. Protect the private key (0600) and host key verification.
- **Host:** dedicated, patched, SSH keys only, no password auth, allowlisted
  source IPs, fail2ban/IDS as appropriate. Docker group is root-equivalent.
- **Container:** `SYS_ADMIN` + `seccomp=unconfined` is a real privilege. It is
  the lab-proven configuration for egress v1.15.0 with Chrome sandboxing
  disabled. Hardening path (not tested end-to-end here): set
  `enable_chrome_sandbox: true` and launch with LiveKit's
  [seccomp profile](https://github.com/livekit/egress/blob/main/chrome-sandboxing-seccomp-profile.json),
  then evaluate dropping `SYS_ADMIN`. Do not enable both configurations at
  once; canary it. Treat the worker as a sensitive media-processing host, not a
  general-purpose server.
- **Image supply chain:** pin `livekit/egress:v1.15.0`; for stricter control pin
  the digest after verification:
  `docker inspect --format '{{index .RepoDigests 0}}' livekit/egress:v1.15.0`.
  Scan images (Trivy/Grype/Scout) and track upstream Chrome/GStreamer CVEs;
  rebuild cadence is an operational requirement.
- **Firewall:** block 8080/9090/7980 from the internet. The health endpoint has
  no auth. The Twirp API is on the SFU behind TLS; the app should reach it over
  HTTPS only (SSRF policy/allowlist as applicable).
- **S3:** private bucket, TLS endpoint, least-privilege key, SSE, no public ACL.
  `EGRESS_S3_FORCE_PATH_STYLE=true` for MinIO/Ceph (rendered, not hand-edited);
  validate the endpoint to avoid credential leakage to an attacker-controlled host.
- **RTMP:** the URL contains a stream key; the app redacts it in logs/audit/list,
  and egress redacts URLs as `{t...t}`. Still restrict log access, rotate stream
  keys on suspicion, and prefer `rtmps://` where the provider supports it.
- **E2EE:** server-side egress cannot decrypt E2EE media. The app returns `409
  e2ee_incompatible`; do not try to bypass. Use client-side recording for E2EE
  rooms.
- **Multi-tenancy:** output paths are `<tenant>/<roomId>/...`; use bucket
  prefixes and IAM/CDN policies to isolate tenants. A single worker config uses
  one bucket/key; per-tenant buckets require per-request storage overrides
  (app code does not currently send them) or separate workers.

## 16. Fail-open behaviour

Egress is an optional media-processing feature. A broken worker must not take
down calls, chat or the app API.

| Failure | Impact | Behaviour | Recovery |
|---|---|---|---|
| `AGIL_EGRESS_ENABLED=0` | recording/RTMP/HLS unavailable | `501 egress_disabled`; no worker call | set `1`, restart app |
| `AGIL_EGRESS_URL` empty/bad | egress unavailable | `501 egress_not_configured` or `502 egress_failed`; calls unaffected | fix env, restart app |
| Worker down / no Redis route | no new jobs | `lk egress list` → `no response from egress service`; start → `502` | start worker, fix tunnel; new jobs only |
| Redis/tunnel down | no dispatch, list fails | calls unaffected; app status `lastError`; worker reconnects when Redis returns | restore tunnel/Redis; restart worker if stuck |
| S3 down | upload retries, then `/out/backup` | egress may finish with `backup_storage_used`; disk grows | restore S3, copy backups, monitor disk |
| Worker crash mid-job | that job fails | `EGRESS_FAILED`/aborted; no automatic resume | restart worker; start a new job |
| SFU node down | calls/egress on that node fail | clients reconnect via Caddy/Redis; egress follows the room | existing LiveKit HA runbook |
| App restart | active jobs continue in SFU/egress | dashboard card re-lists raw `egress_id`/`EGRESS_*` sessions after reconnect; job IDs persist in egress state | verify `GET /v1/rooms/:id/egress` |
| Disk full | new uploads/finalization fail | egress errors; calls unaffected | clean `/out`, S3 lifecycle, add disk |

The app's `EgressClient` treats missing config as `501`, Twirp/worker errors as
`502 egress_failed`, and never crashes the room path. The dashboard card now
normalizes the raw `EgressInfo` list and stops via
`POST /v1/rooms/:id/egress/:egressId/stop`; still verify critical canaries with
the API calls above (the card polls every 10 s with backoff).

## 17. Rollout and rollback

### 17.1 Rollout

| Stage | Action | Gate |
|---|---|---|
| 0. Preflight | capacity, image pull, tunnel, S3 bucket, app backup, firewall | all health checks pass with app disabled |
| 1. Worker only | deploy worker; app `AGIL_EGRESS_ENABLED=0` | `lk egress list` returns `[]`; Redis subscription > 0 |
| 2. App canary | set `AGIL_EGRESS_URL` + `AGIL_EGRESS_ENABLED=1`; force-recreate the app | admin status `configured/urlConfigured=true` |
| 3. MP4 canary | one room, 20 s recording, stop | `EGRESS_COMPLETE`; MP4 probes H.264/AAC; CPU peak < 8 vCPU |
| 4. RTMP/HLS canary | same room; provider preview and CDN playlist | provider receives stream; `#EXT-X-ENDLIST`; no secret leak |
| 5. Full enable | confirm gates with product/tenant owner | 24 h of job success, alerts green |

Keep the app disabled until the worker is registered. This avoids users seeing
`502` during setup and makes the first canary deterministic.

### 17.2 Rollback

```bash
set -euo pipefail

# 1. Stop new jobs immediately (app-side kill switch).
ssh root@203.0.113.7
cd /opt/agil-calls
BACKUP=".env.bak-egress-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a .env "$BACKUP"
printf 'env backup: %s\n' "$BACKUP"   # record this in the incident ticket

# Ensure the kill switch EXISTS and is 0. Replacing only an existing line is
# not enough: AGIL_EGRESS_ENABLED defaults to true when the line is absent.
if grep -qE '^[[:space:]]*(export[[:space:]]+)?AGIL_EGRESS_ENABLED=' .env; then
  sed -i -E 's/^[[:space:]]*(export[[:space:]]+)?AGIL_EGRESS_ENABLED=.*/AGIL_EGRESS_ENABLED=0/' .env
else
  printf '\nAGIL_EGRESS_ENABLED=0\n' >> .env
fi
grep -nE '^[[:space:]]*(export[[:space:]]+)?AGIL_EGRESS_ENABLED=' .env

# env_file contents are not part of the Compose config hash; force recreation
# so the running app actually reads AGIL_EGRESS_ENABLED=0.
docker compose up -d --force-recreate --no-deps agil-calls

# Assert the kill switch BEFORE stopping the worker. Do not proceed on failure.
ENABLED=$(curl -fsS --config - <<EOF | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("enabled")).lower())'
url = "https://calls.example.com/v1/admin/egress/status"
header = "x-api-key: $(cat /root/agil-admin-key.txt)"
EOF
)
[ "$ENABLED" = "false" ] || { echo "ROLLBACK ABORT: admin status enabled=$ENABLED (worker left running)" >&2; exit 1; }
# /egress/start now returns 501 egress_disabled.

# 2. Only after enabled=false: stop active jobs gracefully (MP4 finalizes on
# SIGTERM) and the worker.
cd /opt/agil-egress
sudo docker compose stop egress          # 180s grace period
sudo docker compose down                 # keep volumes; do not use -v
sudo systemctl disable --now agil-egress-redis-tunnel.service   # if decommissioning

# 3. Restore the previous app env if the change itself caused the incident.
cd /opt/agil-calls
# cp -a "$BACKUP" .env && docker compose up -d --force-recreate --no-deps agil-calls
```

Recordings already uploaded remain in S3 and are subject to the bucket
lifecycle. `/out` backups remain on the worker disk; copy them before
decommissioning. Do **not** run `docker compose down -v` unless you intend to
delete the optional MinIO data.

### 17.3 Upgrade / downgrade

- Change the image tag in compose, `docker compose pull`, then
  `docker compose up -d`; keep the previous image locally for rollback.
- Re-run the MP4/RTMP/HLS canary after any egress, LiveKit, Chrome or GStreamer
  change. Keep `livekit/livekit-server` and `livekit/egress` pins documented
  together (lab pair: `v1.13.11` + `v1.15.0`; CLI `v2.19.4`).
- Egress job state is in Redis; a worker restart does not resume an in-flight
  job. Stop canaries before upgrading.

## 18. Limitations and open items

This kit is a deployment blueprint, not a production deployment. Known gaps:

1. **Not deployed or run against production.** The files were validated locally
   (YAML syntax, shell syntax, Node syntax, a mocked Redis health check). No
   worker was started, no production Redis was touched, no app env was changed.
2. **Docker Compose CLI was not available** in the authoring environment, so the
   compose file was parsed with PyYAML and checked structurally, not with
   `docker compose config`. Run `docker compose config --quiet` on the worker
   before deploying.
3. **The lab used a local LiveKit dispatcher.** It proved the worker can join
   the production SFU and produce MP4/RTMP/HLS, but it did not prove a
   production worker sharing the SFU's actual Redis. This kit's Option B (SSH
   tunnel) and Option A (VPC) are the two ways to close that gap; neither was
   exercised against production here.
4. **App orchestration was not exercised in the lab.** The app's
   `/v1/rooms/:id/egress/*` controller has unit tests for request/response and
   redaction, but the lab started jobs through `lk`/Twirp. Canary via the app API
   before trusting the dashboard.
5. **Dashboard/backend mismatch (fixed in code, browser retest pending).**
   `agil/core/apps/dashboard/src/api.ts` now calls
   `POST /v1/rooms/:id/egress/:egressId/stop` and normalizes
   `{ roomId, egress: EgressInfo[] }` (`egress_id`, `EGRESS_*`, ns
   `started_at`, `*_results`) into the card model; dashboard API tests cover the
   exact route and mapping. Manually verify list/stop in a browser before
   production (QA gate 1 in the QA report).
6. **App HLS/RTMP request mapping (fixed, real-SFU canary pending).** The app now
   sends `stream_outputs[0].protocol = "RTMP"` and
   `segment_outputs[0].protocol = "HLS_PROTOCOL"` (no `kind`, 2 s segments). The
   mock Twirp in `agil/core/apps/server/test/egress.test.ts` now rejects unknown
   fields and invalid enum names, so the old body fails the tests; a real-SFU
   canary is still required (QA gate 2).
7. **S3/MinIO upload was not tested in the lab.** The lab wrote MP4/HLS to local
   `/out`; S3 signing, bucket policies, multipart uploads and CDN playback must
   be canaried. The optional MinIO tags are the last community images and may be
   unavailable/unmaintained; prefer external S3/MinIO/Ceph.
8. **Redis TLS/ACL was not tested end-to-end.** The tunnel is plain loopback.
   `EGRESS_REDIS_TLS`/`EGRESS_REDIS_DB` are rendered now, and the health script
   reads `--redis-ca` as PEM contents, but no TLS Redis was available in this
   audit. If AUTH is used, the password is rendered into the 0640 config;
   protect it and rotate it with the Redis change.
9. **Single worker = no HA.** One 8 vCPU worker runs one composite. Two workers
   are needed for concurrent jobs/HA; egress load-balances via Redis, but there
   is no compose autoscaling. The SFU's 1 vCPU app host is not a candidate.
10. **Chrome sandbox hardening is not tested.** The kit uses the lab-proven
    `SYS_ADMIN` + `seccomp=unconfined` configuration with Chrome sandboxing
    disabled. Enabling `enable_chrome_sandbox` + the seccomp profile is a
    follow-up with its own canary.
11. **No egress completion webhook / artifact ingestion.** The app polls
    `GET /v1/rooms/:id/egress`; it does not ingest the S3 object into its
    recording metadata. Retention and reconciliation are operator/S3 lifecycle
    responsibilities.
12. **No per-tenant quotas** in this worker. All tenants share one bucket/key and
    one worker; enforce quotas/policies in the app/storefront and monitor usage.
13. **RTMP provider specifics** (YouTube/VK handshakes, stream keys, reconnect
    behavior) were not tested beyond a local nginx-rtmp receiver.
14. **HLS fMP4** (`HLS_FMP4_PROTOCOL`) was not tested; the kit uses TS HLS.
15. **No production deploy.** Per the task, this kit stops at files, validation
    and the runbook.

## 19. File index

- [`agil/core/deploy/egress/docker-compose.yml`](../deploy/egress/docker-compose.yml)
- [`agil/core/deploy/egress/egress.yaml`](../deploy/egress/egress.yaml)
- [`agil/core/deploy/egress/.env.example`](../deploy/egress/.env.example)
- [`agil/core/deploy/egress/render-config.sh`](../deploy/egress/render-config.sh)
- [`agil/core/scripts/egress-health.mjs`](../scripts/egress-health.mjs)
- S3/MinIO storage + signed HLS/MP4 playback:
  [`agil/core/docs/egress-production-s3.md`](egress-production-s3.md)
- Independent QA report + status: `agil/core/docs/qa-egress-ops.md`
- Regression tests: [`agil/core/scripts/test/egress-health.test.mjs`](../scripts/test/egress-health.test.mjs),
  [`agil/core/apps/dashboard/test/egress-api.test.ts`](../apps/dashboard/test/egress-api.test.ts),
  `agil/core/qa/egress-local/render-config-test.sh`
- Lab evidence and exact Twirp commands:
  `agil/core/docs/egress-local-test.md`,
  `agil/core/qa/egress-local/commands.md`
- Production app deployment record:
  `agil/core/docs/deployment-record.md`
- SFU multi-node topology:
  [`agil/core/docs/sfu-multinode.md`](sfu-multinode.md)
