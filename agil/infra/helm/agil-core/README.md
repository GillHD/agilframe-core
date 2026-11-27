# agil-core Helm chart

Deploys the AgilFrame core (REST + WebSocket signalling, demo, dashboard,
visual editor, admin API) into Kubernetes. It has **no dependencies**: no
ingress controller, no Redis, no Postgres and no cert-manager are required.

> **Single replica by design.** Core 0.1.0 keeps rooms, WebSocket sessions and
> chat in one process. `replicaCount > 1` returns different rooms on different
> pods and breaks calls. Scale vertically; horizontal multi-node signalling is
> not implemented (`multiNodeActive: false`).

## Install

```bash
# from the repository root, with your own domain
helm install agil-core agil/infra/helm/agil-core \
  --namespace agil --create-namespace \
  --set domain=calls.example.com \
  --set iceServers[0].urls=stun:turn.example.com:3478 \
  --set iceServers[1].urls=turn:turn.example.com:3478 \
  --set iceServers[1].username=agil \
  --set iceServers[1].credential='<turn-password>'

# or keep everything in a private values file (recommended)
helm install agil-core agil/infra/helm/agil-core -n agil --create-namespace -f my-values.yaml
```

The chart generates `AGIL_TOKEN_SECRET`, `AGIL_IP_SALT` and a first API key when
you do not provide them, and preserves them across upgrades via `lookup`.

```bash
kubectl -n agil get secret agil-core -o jsonpath='{.data.AGIL_API_KEYS}' | base64 -d; echo
```

Then open `https://calls.example.com/dashboard/` and log in with that key.

## Secrets

Three options, in order of preference:

1. `secrets.existingSecret: my-agil-core-secret` — a Secret you manage
   (External Secrets, Sealed Secrets, SOPS, Vault). It must contain at least
   `AGIL_TOKEN_SECRET`, `AGIL_IP_SALT`, `AGIL_API_KEYS`; any other key is passed
   to the container via `envFrom`.
2. `--set secrets.tokenSecret=…,secrets.apiKeys=…` (or a private values file).
3. Let the chart generate them (default). Values are preserved on upgrade but
   are **not** backed up by Helm; export them before deleting the release.

**GitOps:** generation is not deterministic for offline renderers. `helm
template`, ArgoCD and Flux cannot `lookup` the live Secret, so every sync would
rotate `AGIL_TOKEN_SECRET` (breaking all join links and dashboard sessions). Set
`secrets.existingSecret` in GitOps and treat chart generation as a one-off
`helm install` convenience.

Never put real secrets in this chart's `values.yaml`.

## Ingress and TLS

`ingress.enabled: true` renders a plain `networking.k8s.io/v1` Ingress, so it
works with ingress-nginx, HAProxy, Traefik, Caddy or any compliant controller:

```yaml
ingress:
  enabled: true
  className: nginx            # or haproxy, traefik, caddy, "" for the default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    # nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    # nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    # nginx.ingress.kubernetes.io/proxy-body-size: "30m"
  hosts:
    - host: calls.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    enabled: true
    secretName: agil-core-tls   # empty -> <fullname>-tls
```

Critical ingress settings for WebRTC signalling, whichever controller you use:

- WebSocket upgrade on `/ws` (nginx needs `proxy_http_version 1.1` +
  `Upgrade`/`Connection`; HAProxy needs `timeout tunnel` ≥ 1 h);
- read/send timeout ≥ 1 h (idle WS otherwise reconnects every 60 s);
- request body limit ≥ 30 MiB for file uploads;
- preserve `X-Forwarded-For/Proto` and do not strip `Sec-WebSocket-Protocol`
  (the widget can carry the join token there).

Editable examples for nginx, HAProxy, Caddy and Traefik live in
[`../../examples/`](../../examples/README.md). If you terminate TLS on a
separate proxy (not the ingress), set `ingress.enabled: false` and expose the
Service yourself.

## Redis and Postgres

Both services are optional. `redis.injectEnv` supplies `AGIL_REDIS_URL` for
Core coordination, which also requires the appropriate cluster settings.
`postgres.injectEnv` supplies `AGIL_DATABASE_URL` as the fallback connection
string for PostgreSQL chat history. For production, prefer an existing Secret
containing `AGIL_CHAT_POSTGRES_URL`. Choose `postgres` in a tenant's chat settings
to use the database. See the [storage architecture](../../../core/docs/devops/storage-architecture.md).

## Key values

| Value | Default | Notes |
|---|---|---|
| `image.repository` / `tag` | `agil-calls` / `0.1.0` | or `image.digest` for immutability |
| `replicaCount` | `1` | do not increase (see above) |
| `deploymentStrategy.type` | `Recreate` | avoids two pods on one RWO volume |
| `domain` | `calls.example.com` | ingress host + join link host |
| `publicOrigin` | `https://<domain>` | override for a different public URL |
| `allowAnonymous` | `false` | `true` = demo mode |
| `trustProxy` | `true` | keep only behind a trusted proxy |
| `features.*` | docs/admin on; mcp/sip/egress/sfu off | rendered as `AGIL_*_ENABLED` |
| `iceServers` | sample STUN/TURN | clients need a working TURN for NAT |
| `persistence.size` | `20Gi` | `.data`: tenants, files, audit, recordings |
| `persistence.existingClaim` | `""` | reuse a PVC instead of creating one |
| `resources` | 250m/512Mi → 1/1Gi | size by concurrent rooms |
| `probes.*` | `/v1/health` | liveness/readiness/startup toggleable |
| `ingress.enabled` | `true` | generic Ingress |
| `ingress.className` | `""` | controller class |
| `ingress.tls.secretName` | `<fullname>-tls` | bring your own or cert-manager |
| `networkPolicy.enabled` | `false` | tighten ingress to the controller namespace |
| `podDisruptionBudget.enabled` | `false` | with 1 replica a PDB is a no-op; the template renders `maxUnavailable: 1` so drains are not blocked |
| `autoscaling.enabled` | `false` | unsupported in 0.1.0 |
| `extraEnv` / `extraEnvFrom` | `[]` | escape hatch for anything not modelled |

## Upgrade and rollback

```bash
helm upgrade agil-core agil/infra/helm/agil-core -n agil -f my-values.yaml
kubectl -n agil rollout status deploy/agil-core
helm rollback agil-core 1 -n agil
```

- Keep `AGIL_TOKEN_SECRET` stable across upgrades, or every previously issued
  join link and dashboard session becomes invalid.
- `.data` is a RWO volume and the strategy is `Recreate`: expect a short
  interruption. Active calls drop on every core restart in 0.1.0.
- Back up the PVC before major upgrades (`agil/core/scripts/backup-data.sh` or a
  volume snapshot). Downgrades may not understand newer on-disk state.

## Uninstall

```bash
helm uninstall agil-core -n agil
```

The PVC created by the chart is **not** deleted automatically (Helm keeps
PVCs). Export the API key/secret first if you plan to reinstall; delete the PVC
only after a verified backup.

## Known limitations

- one process owns room state; no HA, no rolling update without dropping calls;
- no `/metrics` endpoint in core 0.1.0 — use blackbox probes against
  `/v1/health` and the ops kit in `agil/core/deploy/observability/`;
- no built-in TLS/ACME: your ingress controller or load balancer terminates TLS;
- node registration is a control-plane registry, not a media server (see
  `../agil-node/README.md`).
