# AGIL Infra — sales / deployment kit

Optional infrastructure for taking AgilFrame from a repo to a first customer
call in **15–30 minutes**, then to Kubernetes or AWS when the customer needs it.
Nothing here is required to run AGIL, nothing here is production infrastructure
by itself, and no script in this kit touches an existing Caddy/HAProxy/VPN
installation, firewall, or running AGIL deployment.

| Path | What it is | Start here when… |
|---|---|---|
| [`quickstart/`](quickstart/README.md) | Docker Compose: core + node + coturn + Redis, `install.sh`, `doctor.sh`, `smoke.sh` | you need a working demo/customer instance on one VM |
| [`helm/`](helm/README.md) | `agil-core` and `agil-node` charts, no dependencies | the customer has Kubernetes |
| [`terraform/aws/`](terraform/aws/README.md) | VPC, subnets, security groups, VMs, EIPs, optional Route53 | you need the AWS host layer provisioned |
| [`examples/`](examples/README.md) | nginx, HAProxy, Caddy, Traefik snippets | you must put TLS in front of core |
| [`node/`](node/node-loop.sh) | enrollment/heartbeat loop using the first-party CLI (default node runtime) | you want to know what the `node` container is |
| [`node-agent/`](node-agent/README.md) | optional HTTP-probe agent (same contract, `/metrics`, Docker add-on modules); not used by default | you need node-local health/metrics endpoints or Core-managed Docker modules |
| `pilot/` | single-host pilot ops kit: read-only `healthcheck.sh` + systemd timer, verified 7-day `backup.sh`, `restore-drill.sh` | you run the calls.example.com pilot and need monitoring + backups |

Each surface is independent: Terraform can create hosts without Helm, Helm can
run on any cluster without Terraform, and the quickstart needs neither.

---

## 1. Topology

### 1.1 All-in-one quickstart

```
              participants
                   │  HTTPS/WSS 443
        ┌──────────▼───────────┐
        │ reverse proxy (BYO)  │  TLS, WebSocket, 30 MiB body
        └──────────┬───────────┘
                   │ 127.0.0.1:8787
        ┌──────────▼───────────┐      enroll/heartbeat      ┌──────────────┐
        │ core                 │◄───────────────────────────│ node (CLI)   │
        │ REST + WS + static   │                            │ no ports     │
        │ /app/.data (volume)  │                            └──────────────┘
        └──────┬─────────┬─────┘
               │         │ ICE list
               │    ┌────▼────────────────┐
               │    │ coturn              │  UDP 3478 + relay range
               │    │ STUN/TURN           │  public
               │    └─────────────────────┘
        ┌──────▼──────┐
        │ Redis :6379 │  media-plane bus; core 0.1.0 does not use it
        └─────────────┘
```

Core is the only process that owns room state. The node runs the same image and
the first-party CLI: it only registers and heartbeats a role record, it is not a
second core. TURN relays media; Redis is present for the media plane and future
multi-node signalling.

The same compose definitions are split into a core bundle and a node/TURN bundle.
For the split (core VM + node VM) topology, run the node/TURN bundle on the node
host against the remote core — see
[`quickstart/README.md` §2.3](quickstart/README.md#23-remote-node--turn-host).
Never run the all-in-one installer on a node host: it starts a local core and
the real core's registry never sees the node.

### 1.2 Kubernetes

```
Ingress (nginx/HAProxy/Traefik/Caddy)
   │  Service :8787
   ▼
Deployment agil-core (1 replica, RWO PVC /app/.data)
   ▲
   │ HTTPS + node token/key
Deployment agil-node-<id> (1 replica per node, tiny PVC for node key)
```

Media processes (LiveKit/coturn) are separate workloads; the node chart only
maintains the node record.

### 1.3 AWS reference

Two public subnets across two AZs, one core VM with an EIP, N node VMs with
EIPs, security groups that expose 80/443 on core and TURN/media ports on nodes,
optional Route53 A records. TLS is deliberately manual (Caddy/nginx/ALB).
See [`terraform/aws/README.md`](terraform/aws/README.md).

---

## 2. Prerequisites

| Surface | Needs |
|---|---|
| Quickstart | Linux VM 2 vCPU / 2 GiB / 10 GiB free, Docker Engine 24+ with Compose **2.24+**, public IPv4 for TURN, open 80/443/tcp, 3478/tcp+udp and the relay range (`TURN_MIN_PORT`–`TURN_MAX_PORT`, default 49200–49250/udp), DNS A record, TLS certificate at the proxy |
| Helm | Kubernetes ≥ 1.25, Helm 3, a StorageClass for the PVC, an ingress controller (optional), a registry image for `agil-calls` |
| Terraform | Terraform ≥ 1.9, AWS credentials (incl. IAM role/profile creation for SSM), optional EC2 key pair (`enable_ssm` covers keyless access), admin CIDR, optional Route53 zone |
| All | Outbound HTTPS for image pulls/ACME; a secret store or `0600` env file; a way to back up `.data` |

Minimum sizing: 2 vCPU / 2 GiB is a demo; 2 vCPU / 4 GiB is a small customer
instance. Media does not run on core in the quickstart (mesh/TURN), so CPU is
mostly signalling and TLS.

---

## 3. Node tokens

AGIL Core maintains a **node registry**: a node is a role record (`sfu`,
`turn`, `stun`, `all`) with features, capacity, endpoint, region, status and a
last heartbeat. Node tokens authenticate the one-time registration; the
returned node key authenticates heartbeats. Tokens are hashed at rest, TTL/use
limited and revocable. This is a **control-plane** mechanism: it does not
allocate media ports, proxy traffic or run LiveKit.

### 3.1 Lifecycle

```
admin/dashboard                core                        node (CLI loop)
     │  POST /v1/admin/cluster/tokens                          │
     │─────────────────────────►│  token agil_enr_… (shown once)│
     │                          │                              │
     │  put into Secret/.env    │                              │
     │──────────────────────────────────────────────────────────► POST /v1/nodes/register
     │                          │  validates token, burns one use
     │                          │  returns nodeKey nk_… (once) ◄──┤
     │                          │                              │ writes node.json 0600
     │                          │◄─────────────────────────────── POST /v1/nodes/:id/heartbeat
     │                          │       x-node-token: nk_…        every 30 s
     │                          │  no heartbeat for 90 s → offline
```

- **One-time by default** (`uses: 1`). A leaked unused token is worth at most
  one registration; revoke it in the dashboard/API.
- **Node key** is stored only on the node (compose volume or k8s PVC). Losing it
  means re-enrollment with a new token; reusing the same `node.id` while the old
  record is live returns `409 node_exists`.
- **Disable/drain** a node in core before decommissioning; heartbeats from a
  disabled node stop updating its status.
- **Rotate**: disable the old record, mint a new token, delete the state
  volume/PVC, re-enroll with the same `node.id`.
- **Never** put tokens/keys in Git, images, ConfigMaps, Terraform user data or
  shell history visible to others.

### 3.2 Mint a token

Dashboard → Infrastructure (`#/infrastructure`), or:

```bash
curl -sS -X POST https://calls.example.com/v1/admin/cluster/tokens \
  -H "x-api-key: $AGIL_API_KEY" -H 'content-type: application/json' \
  -d '{"kind":"node","role":"sfu","features":["sfu"],"ttlSec":3600,"uses":1,"label":"sfu-1"}'
```

The response contains the plaintext `token` **once** and its metadata. Send it
to the node through a secret manager or an SSH session; do not paste it into a
ticket.

### 3.3 Register and heartbeat

The quickstart's `install.sh --start` does this automatically; the Helm chart
uses a Kubernetes Secret. Under the hood:

```bash
# one-shot enrollment; --json returns {node, nodeKey, cluster, ...}
node agil/core/scripts/agil-cli.mjs nodes register --json

# subsequent heartbeats (node key from the register response)
node agil/core/scripts/agil-cli.mjs nodes heartbeat --id <node-id> --key nk_... --json
```

The default node runtime is [`node/node-loop.sh`](node/node-loop.sh): it runs
inside the standard `agil-calls` image (mounted read-only in compose, a
ConfigMap in Helm), persists `node.json` + `heartbeat-at` on a volume/PVC and
loops the two CLI calls. No separate node image is required. The optional
HTTP-probe agent ([`node-agent/`](node-agent/README.md)) implements the same
contract if you specifically need `/metrics`; it is not used by default. It is
also the only kit runtime that implements Core-managed Docker add-on modules
(`egress/stt/recorder/turn/sip`): containers labelled `agil.module`/`agil.node`
are reported on the heartbeat and `install/start/stop/restart/remove` commands
are executed through the Docker socket. Without a socket it stays an agent-only
node; see [`node-agent/README.md`](node-agent/README.md#docker-modules-heartbeat-modules--modulecommands).

Every heartbeat also carries a best-effort host snapshot under `metrics`
(`cpuPercent`, `memoryPercent`, `load1`, `uptimeSec`, `version`, `reportedAt`,
plus `bandwidthMbps` only when measurable). Both the CLI and the optional agent
collect it automatically; a field that cannot be measured is omitted, never
sent as a fake zero, and `activeRooms`/`participants` are not reported because
the node runtime owns no room state. Use `--no-metrics` on `nodes heartbeat` to
omit the object (e.g. when the CLI runs on a monitoring host).

### 3.4 Admin endpoints (API key or admin session)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/admin/cluster/tokens` | mint a core/node enrollment token |
| `GET` | `/v1/admin/cluster/tokens` | list tokens + status (active/used/expired/revoked) |
| `DELETE` | `/v1/admin/cluster/tokens/:id` | revoke |
| `GET` | `/v1/admin/cluster/status` | cluster id/role, nodes, counts, limitations |
| `GET` | `/v1/admin/nodes` | node records |
| `PATCH` | `/v1/admin/nodes/:id` | name/role/features/capacity |
| `POST` | `/v1/admin/nodes/:id/disable` | stop trusting the node |
| `POST` | `/v1/admin/nodes/:id/drain` | mark for maintenance |
| `DELETE` | `/v1/admin/nodes/:id` | delete the record and free the id for re-enrollment |
| `POST` | `/v1/cluster/join` | token-only standby join (no API key) |
| `POST` | `/v1/nodes/register` | token-only registration (no API key) |
| `POST` | `/v1/nodes/:id/heartbeat` | node key only |

`/v1/cluster/*` and `/v1/nodes/*` are deliberately outside `/v1/admin/*` so an
admin IP allowlist does not block node traffic; protect them with TLS and
network policy instead.

### 3.5 Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGIL_CORE_URL` | node loop | core base URL (default `http://core:8787`; required on a remote node host, which has no local core) |
| `AGIL_NODE_TOKEN` | node loop | one-time token, burned after register |
| `AGIL_NODE_KEY` | node loop | pre-issued node key; skips enrollment |
| `AGIL_NODE_ID` / `_NAME` | node loop | unique id / display name |
| `AGIL_NODE_ROLE` | node loop | `sfu` `turn` `stun` `all` |
| `AGIL_NODE_FEATURES` | node loop | comma list, e.g. `sfu,egress` |
| `AGIL_NODE_REGION` / `_ENDPOINT` | node loop | informational labels |
| `AGIL_NODE_CAPACITY` | node loop | JSON capacity hint |
| `AGIL_NODE_HEARTBEAT_SEC` | node loop | default 30 (core offline after 90) |
| `AGIL_CLUSTER_ID` / `AGIL_CLUSTER_ROLE` | core | optional cluster id and `leader`/`standby` role; persisted under `AGIL_DATA_DIR/cluster/` |

---

## 4. Ports

| Port | Proto | Component | Exposure |
|---|---|---|---|
| 80 | TCP | reverse proxy (ACME/redirect) | public |
| 443 | TCP | reverse proxy (HTTPS/WSS) | public |
| 8787 | TCP | core API/WS/static | **loopback** (quickstart) or ClusterIP (k8s) |
| 3478 | TCP+UDP | coturn STUN/TURN | public |
| 5349 | TCP | coturn TURN over TLS | only when TLS is configured (`enable_turn_tls` in Terraform; not published by the quickstart) |
| `TURN_MIN_PORT`–`TURN_MAX_PORT` | UDP | coturn relay (default 49200–49250) | public; published 1:1 host↔container↔coturn |
| 6379 | TCP | Redis | internal only; **never** publish |
| 7880/7881 | TCP | LiveKit signalling/RTC (optional) | public |
| 50000–50100 | UDP | LiveKit RTC (optional) | public |
| 9443 | TCP | current production Caddy (existing stack) | not created by this kit |

Docker-published ports bypass host `ufw INPUT`; the cloud/provider security
group is the real boundary. Keep core off `0.0.0.0` unless a firewall restricts
it. Do not publish Redis. The relay range is identity-mapped on purpose: if you
change the host side you must change the container side and coturn
`--min-port/--max-port` together, or media silently breaks.

---

## 5. Upgrade and rollback

### 5.1 Quickstart

1. Back up `.data` (and `node-state` if you want to keep the node key):
   `docker run --rm -v agil-quickstart_agil-data:/data -v "$PWD":/backup alpine tar czf /backup/agil-data.tgz -C /data .`
2. Set `AGIL_CORE_IMAGE` to the new immutable tag/digest.
3. `docker compose up -d core` (or `--build` for a source build); wait for
   health; run `./doctor.sh && ./smoke.sh`.
4. Rollback: set the old tag and `docker compose up -d core`, or restore the
   volume if a downgrade needs the old on-disk state.

Live calls drop on every core restart (in-memory state). Keep
`AGIL_TOKEN_SECRET` stable across upgrades or every join link/session dies.

### 5.2 Helm

```bash
helm upgrade agil-core agil/infra/helm/agil-core -n agil -f core-values.yaml
kubectl -n agil rollout status deploy/agil-core
helm rollback agil-core <revision> -n agil
```

Back up the PVC/snapshot before a major version. Node chart upgrades do not
re-enroll (the key is on the PVC); changing `node.id` creates a new record.

### 5.3 Terraform

Terraform manages hosts, not the app. Change image/values on the host/cluster;
`terraform apply` only for infrastructure changes. Instance replacements
re-associate EIPs; `terraform destroy` deletes EBS volumes, so back up first.

### 5.4 Compatibility notes

- Data format is forward-only in 0.1.0; downgrades may need a volume restore.
- Multi-node signalling is **not implemented** (`multiNodeActive: false`):
  the registry is a contract, not a data plane.
- The node enrollment API is provisional; the loop and chart are pinned to the implemented CLI contract.

---

## 6. Security model

### 6.1 Trust boundaries

```
internet ──TLS──► reverse proxy ──HTTP loopback──► core
                                        │
                     node (CLI) ──TLS/HTTP──┘ (heartbeat + registry)
                                        │
                     coturn ◄──UDP media──► participants
```

- TLS terminates at your proxy/ingress. Core should never be reachable
  directly from the internet, and `AGIL_TRUST_PROXY=1` is only safe when the
  proxy overwrites `X-Forwarded-*`.
- Node enrollment crosses a trust boundary: use HTTPS for a remote core. Tokens
  and node keys are bearer secrets; there is no mTLS in this baseline.
- TURN is public by design and relays untrusted media. Run coturn with
  `--no-multicast-peers`, long-term credentials, a strong generated password,
  a minimal relay range and allocation quotas. **One static credential is shared
  by every client** (demo-only): production should use coturn's TURN REST API
  with short-lived credentials. Consider adding denied peer ranges for private
  networks (documented in coturn) after testing your LAN/mobile cases.
- Secrets are split by service: core gets an explicit `AGIL_*` environment list
  and never `TURN_PASSWORD`/`AGIL_NODE_*`; a remote node/TURN host uses
  `node.env.example`, not the core `.env`.

### 6.2 Secrets

| Secret | Where it lives | Rotation |
|---|---|---|
| `AGIL_TOKEN_SECRET` | `.env` 0600 / k8s Secret / vault | invalidates all join tokens and dashboard sessions |
| `AGIL_API_KEYS` | same | issue a new key, move clients, revoke old |
| `AGIL_IP_SALT` | same | changes hashed IPs in audit/logs |
| TURN user/password | `.env` + `AGIL_ICE_SERVERS` | clients receive it; rotate and redeploy ICE config |
| node enrollment token | `.env`/Secret | one-time; revoke unused tokens |
| node key | node volume/PVC | disable node, delete state, re-enroll |

Never commit `.env`, `terraform.tfvars`, state, certificates or kubeconfigs.
The chart generates core secrets on install and preserves them on upgrade
(offline renderers such as ArgoCD/Flux must use `secrets.existingSecret`),
`install.sh` generates all quickstart secrets with `openssl rand` and
`chmod 600`, and the compose model only passes node/TURN secrets to the
node/TURN bundle — the public core container never receives them.

### 6.3 Hardening checklist

- [ ] TLS 1.2+, valid certificate, HSTS after verification.
- [ ] `AGIL_ALLOW_ANONYMOUS=0` for anything customer-facing.
- [ ] Core bound to loopback/ClusterIP; Redis unpublished.
- [ ] `AGIL_ADMIN_API_ENABLED` and `/docs` restricted by allowlist or disabled.
- [ ] API keys ≥ 32 random chars, one per tenant, stored in a secret manager.
- [ ] `AGIL_GEO_PROVIDER` set intentionally (`header` only behind a trusted CDN).
- [ ] CORS/`AGIL_PUBLIC_ORIGIN` exactly matches the public URL.
- [ ] SSH restricted to `admin_cidr`; no password auth; key-based or SSM only.
- [ ] `admin_cidr` is a `/32`-style egress range, never `0.0.0.0/0` (Terraform
      rejects `/0` unless `allow_world_admin` is deliberately enabled).
- [ ] `TURN_EXTERNAL_IP` is a public IPv4 for a remote origin (installer
      refuses RFC1918/CGNAT unless `--allow-private-ip`); relay range minimal,
      published 1:1 and open on the provider and host firewalls.
- [ ] TURN password strong and quotas set; understand that the statically
      shared credential is demo-only (use the TURN REST API for customers).
- [ ] `enable_turn_tls`/5349 opened only when coturn actually has a certificate.
- [ ] Backups of `.data` tested; audit logs shipped to SIEM.
- [ ] Images pinned by digest for customer deployments.
- [ ] `doctor.sh` clean (or every warning understood) before handover.

### 6.4 Supply chain

- Images: `agil-calls` built from the repo root Dockerfile is the only required
  runtime image; the node loop runs inside it. The optional `node-agent` image
  (HTTP probes) is kit-built and not used by default. Pinning tags/digests is
  the operator's responsibility.
- No `curl | bash` anywhere in the kit. Terraform user data downloads the
  Docker apt key to a file and installs through apt.
- `install.sh` only writes `.env` in its own directory (plus a timestamped
  backup) and never edits host proxies, Caddy, HAProxy, VPN or firewall rules.

---

## 7. Limitations and non-goals

- **Not HA.** One core process owns rooms/WebSockets; a restart drops calls.
  Multi-node signalling, room leases and Redis fan-out are not implemented.
- **Not an SFU installer.** The quickstart is mesh + TURN; deploy LiveKit
  separately (`agil/core/deploy/livekit/`) for larger rooms/recording.
- **Node is a control-plane client**, not a media server: the default runtime
  runs the first-party CLI inside the core image and only registers/heartbeats.
  Core does not probe node endpoints yet. The optional `node-agent` adds
  HTTP probes/metrics but is not part of the default path.
- **No bundled TLS/ACME**, no DNS provider integrations beyond optional Route53,
  no certificate automation.
- **No Postgres deployment.** Core persists to `.data`; Redis/Postgres values
  are forward-looking. There is no S3 file store in this baseline.
- **No bundled observability.** Prometheus rules/Grafana/ops-check live in
  `agil/core/deploy/observability/` and `agil/core/scripts/ops-check.mjs`.
- **AWS reference is single-region, public-subnet only**, with no NAT, ALB or
  WAF and no backup plan. SSM Session Manager is supported via an optional IAM
  instance profile (`enable_ssm`, on by default); `admin_cidr=0.0.0.0/0` is
  rejected at plan time.
- **No Windows/macOS production story.** Docker Desktop can run the quickstart
  for a demo, but TURN UDP and performance are not representative.

---

## 8. Validation performed for this kit

The kit does not require Helm to be validated; a local Helm 3.16, Terraform 1.16
and shellcheck 0.10 were also used as extra checks. Portable checks:

```bash
# shell
bash -n agil/infra/quickstart/install.sh
bash -n agil/infra/quickstart/doctor.sh
bash -n agil/infra/quickstart/smoke.sh
bash -n agil/infra/node/node-loop.sh
bash -n agil/infra/node/node-healthcheck.sh

# TURN_EXTERNAL_IP classifier unit tests (P2-3)
bash agil/infra/tools/test-net.sh

# YAML (compose, values, examples) — PyYAML
python - <<'PY'
import glob, yaml
for path in glob.glob('agil/infra/**/*.yml', recursive=True) + glob.glob('agil/infra/**/*.yaml', recursive=True):
    list(yaml.safe_load_all(open(path, encoding='utf-8')))
print('yaml ok')
PY

# compose variants (with a generated .env; remove it afterwards)
cd agil/infra/quickstart
docker compose -f docker-compose.yml config -q
docker compose -f docker-compose.core.yml config -q
AGIL_CORE_URL=https://calls.example.com \
  docker compose -f docker-compose.node.yml -f docker-compose.node-remote.yml config -q

# Helm (if installed)
helm lint agil/infra/helm/agil-core agil/infra/helm/agil-node
helm template agil-core agil/infra/helm/agil-core -n agil >/tmp/core.yaml
helm template agil-node agil/infra/helm/agil-node -n agil --set enrollment.token=test >/tmp/node.yaml

# Terraform
terraform fmt -check -recursive
terraform validate        # after init -backend=false
```

Helm templates were rendered for default and variant values (existing secret,
ingress off, network policy, HPA/PDB, node key, media config) and
the results were parsed as multi-document YAML. See
[`tools/validate.py`](tools/validate.py) for the no-Helm structural checker.

**Not executed:** `docker compose up` (no Docker daemon in the authoring
environment), `terraform plan/apply` (no AWS credentials), `helm install`
(no cluster), and any live browser call. Those are the operator's acceptance
steps in the quickstart README.

---

## 9. Related documentation

- [`agil/core/docs/deployment.md`](../core/docs/deployment.md) — minimum
  production requirements, TLS/WebSocket/TURN, scaling stages.
- [`agil/core/docs/deployment-quickstart.md`](../core/docs/deployment-quickstart.md)
  — one-page pointer to this kit.
- [`agil/core/docs/operations.md`](../core/docs/operations.md) — SLOs, health,
  backups, HA topology, runbooks.
- [`agil/core/docs/security.md`](../core/docs/security.md) and
  [`agil/core/docs/api-exposure.md`](../core/docs/api-exposure.md) — exposure
  model.
- [`agil/core/deploy/livekit/README.md`](../core/deploy/livekit/README.md) —
  optional SFU scaffold.
- [`agil/core/deploy/egress/`](../core/deploy/egress/) and
  [`agil/core/deploy/observability/`](../core/deploy/observability/) — media
  worker and monitoring kit.
