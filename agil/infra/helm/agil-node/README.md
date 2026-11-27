# agil-node Helm chart

Registers a node with AGIL Core and keeps its record alive. The chart runs the
standard **`agil-calls` image** with the first-party operator CLI
(`agil/core/scripts/agil-cli.mjs`) — there is no separate node image and no
media process in this chart. LiveKit/coturn stay separate
(`agil/core/deploy/livekit/`).

> One release = one node identity. Do not scale the Deployment above one
> replica: every pod would use the same `node.id` and the second registration is
> rejected with `409 node_exists`. For multiple nodes install multiple releases
> with different `fullnameOverride` and `node.id`.

## Prerequisites

1. AGIL Core reachable from the cluster. In-cluster:
   `http://agil-core:8787` (the core chart's Service is `<fullname>:8787`).
   Remote: use the HTTPS origin. Enrollment tokens and node keys are bearer
   secrets; never send them over plain HTTP across the internet.
2. An `agil-calls` image in a registry the cluster can pull (built from the repo
   root Dockerfile).
3. A one-time node token (or an existing node key). Create it in the dashboard
   (`#/infrastructure`) or:

   ```bash
   curl -sS -X POST https://calls.example.com/v1/admin/cluster/tokens \
     -H "x-api-key: $AGIL_API_KEY" -H 'content-type: application/json' \
     -d '{"kind":"node","role":"sfu","features":["sfu"],"ttlSec":3600,"uses":1,"label":"k8s-sfu-1"}'
   ```

## Install

```bash
# Token in a Secret (never in shell history or values.yaml)
kubectl -n agil create secret generic agil-node-sfu1-enrollment \
  --from-literal=AGIL_NODE_TOKEN='agil_enr_...'

helm install agil-node-sfu1 agil/infra/helm/agil-node \
  -n agil \
  --set fullnameOverride=agil-node-sfu1 \
  --set image.repository=registry.example.com/agil/calls \
  --set image.tag=0.1.0 \
  --set node.id=sfu-1 \
  --set node.role=sfu \
  --set node.features={sfu} \
  --set node.region=eu-central \
  --set node.endpoint=https://sfu.example.com \
  --set core.url=http://agil-core:8787 \
  --set enrollment.existingSecret=agil-node-sfu1-enrollment

kubectl -n agil rollout status deploy/agil-node-sfu1
kubectl -n agil logs deploy/agil-node-sfu1 --tail=50
```

Successful enrollment logs `enrolled; node key stored in …`. The token is burned
and the node key is written to the PVC (mode 0600). Restarts then only heartbeat;
the token Secret can be deleted and the token revoked.

### Pre-registered node (no token)

```bash
kubectl -n agil create secret generic agil-node-key --from-literal=AGIL_NODE_KEY='nk_...'
helm upgrade --install agil-node-sfu1 agil/infra/helm/agil-node -n agil \
  --set enrollment.nodeKeySecret=agil-node-key \
  --set node.id=sfu-1
```

## What it does at runtime

```
/bin/sh /opt/agil/node-loop.sh
  ├─ no node.json + AGIL_NODE_KEY  → persist key
  ├─ no node.json + AGIL_NODE_TOKEN → node agil-cli nodes register --json
  │                                    → persist nk_… in node.json (0600)
  └─ loop: node agil-cli nodes heartbeat --id <id> --json
           write heartbeat-at; sleep AGIL_NODE_HEARTBEAT_SEC (30)
```

- Core marks a silent node offline after 90 s but keeps the record.
- `heartbeat-at` is deleted at startup and written only after core **accepts** a
  heartbeat, so a node with an unreachable core is not reported ready.
- With neither a token nor a node key the container exits with a clear,
  actionable error (and the Kubernetes restart policy backs off); configure
  `enrollment.existingSecret` — see the warning in the release NOTES.
- Probes are **exec-based** (there is no HTTP port):
  - startup/liveness: `node.json` exists;
  - readiness: `heartbeat-at` is younger than 90 s.
- Runtime state: `{{ .Values.persistence.mountPath }}/node.json` and
  `.../heartbeat-at` on the PVC.

The enrollment script lives in [`files/node-loop.sh`](files/node-loop.sh)
(synced from `agil/infra/node/node-loop.sh`; the validator enforces equality).

## Values

| Value | Default | Notes |
|---|---|---|
| `image.repository` / `tag` | `agil-calls` / `0.1.0` | same image as core; pin a digest for production |
| `replicaCount` | `1` | **do not scale** (node identity) |
| `core.url` | `http://agil-core:8787` | HTTPS for a remote core |
| `enrollment.existingSecret` | `""` | Secret with `AGIL_NODE_TOKEN` and/or `AGIL_NODE_KEY` |
| `enrollment.token` | `""` | inline one-time token (prefer a Secret) |
| `enrollment.nodeKey` | `""` | pre-issued node key |
| `node.id` | release fullname | unique; a live duplicate gets 409 |
| `node.name` | node id | display name |
| `node.role` | `sfu` | `sfu`, `turn`, `stun`, `all` |
| `node.features` | `[sfu]` | comma-joined into `AGIL_NODE_FEATURES` |
| `node.region` | `""` | free-form region label |
| `node.endpoint` | `https://<domain>` | informational media URL |
| `node.capacity` | `{}` | e.g. `{"maxRooms":10,"maxParticipants":500}` |
| `node.heartbeatIntervalSec` | `30` | core offline threshold is 90 s |
| `domain` / `tls.enabled` | `sfu.example.com` / `false` | endpoint scheme only (no ingress in this chart) |
| `redis.url` / `postgres.url` | `""` | ConfigMap for the co-located media process only |
| `persistence.size` | `1Gi` | holds the node key + heartbeat timestamp |
| `probes.*` | exec on `node.json` / `heartbeat-at` | toggle individually |
| `networkPolicy.enabled` | `false` | node only needs egress |
| `resources` | 25m/32Mi → 200m/128Mi | the loop is tiny |

## Upgrade and rollback

```bash
helm upgrade agil-node-sfu1 agil/infra/helm/agil-node -n agil -f node-values.yaml
helm rollback agil-node-sfu1 1 -n agil
```

- The key lives on the PVC, so upgrades/restarts do not re-enroll.
- Changing `node.id` creates a **new** record; disable the old one first
  (`POST /v1/admin/nodes/:id/disable`, then `DELETE /v1/admin/nodes/:id` frees
  the id).
- Removing the release keeps the PVC (Helm does not delete PVCs). Reuse it with
  the same `node.id` to keep the key; delete it to enroll fresh.
- Rotate: disable the node, delete the PVC, mint a new token, reinstall.

## Limitations

- Control-plane only: no media, no TURN allocation, no SFU room allocation.
- No HTTP endpoint in this chart (exec probes only). If you need `/healthz`,
  `/readyz` or Prometheus `/metrics` on the node itself, the optional
  [`../../node-agent/`](../../node-agent/README.md) reference image implements
  the same enrollment contract; it is **not** used by default.
- Core does not probe `node.endpoint` yet.
- No mTLS/client certificates; protect the core URL with TLS and network policy.
- One replica per release (see above).
- The enrollment API is provisional; the loop and chart follow the implemented
  `agil/core/scripts/agil-cli.mjs` contract.
