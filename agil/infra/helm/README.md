# AGIL Helm charts

Two independent charts, no subchart dependencies:

| Chart | What it deploys | Typical release |
|---|---|---|
| [`agil-core`](agil-core/README.md) | core Deployment + Service + PVC + Secret/ConfigMap + optional Ingress/PDB/NetworkPolicy/HPA | one per environment |
| [`agil-node`](agil-node/README.md) | node enrollment/heartbeat loop using the `agil-calls` image (Deployment + PVC + optional Secret) | one per node |

The charts never bundle or require Redis, Postgres, an ingress controller or
cert-manager. Values for Redis/Postgres exist as opt-in `injectEnv` blocks for
forward-compatible builds; core 0.1.0 stores state on the PVC.

## Install order

```bash
# 1) core
helm install agil-core agil/infra/helm/agil-core \
  -n agil --create-namespace -f core-values.yaml

# 2) one node per media/TURN host
helm install agil-node-sfu1 agil/infra/helm/agil-node \
  -n agil -f node-sfu1-values.yaml \
  --set enrollment.existingSecret=agil-node-sfu1-enrollment
```

Minimal `core-values.yaml` (never commit real secrets; see the chart README):

```yaml
domain: calls.example.com
ingress:
  enabled: true
  className: nginx
  tls:
    enabled: true
    secretName: agil-core-tls
iceServers:
  - urls: stun:turn.example.com:3478
  - urls: turn:turn.example.com:3478?transport=udp
    username: agil
    credential: REPLACE_ME
  - urls: turn:turn.example.com:3478?transport=tcp
    username: agil
    credential: REPLACE_ME
```

## What "works with any ingress" means

Only `agil-core` renders a plain `networking.k8s.io/v1` Ingress with
`ingressClassName` (empty = cluster default), so ingress-nginx, HAProxy,
Traefik, Caddy or a cloud LB controller all work. Controller-specific behaviour
(WebSocket timeouts, body size, headers) is configured with annotations and is
documented per controller in [`../examples/`](../examples/README.md). The node
chart has no HTTP port; its probes are exec-based and it is never exposed.

If you terminate TLS **outside** Kubernetes (ALB/NLB or an edge proxy), set
`ingress.enabled: false` and expose the core Service with
`service.type: LoadBalancer` or a NodePort — the app still binds 8787 and
expects `X-Forwarded-*`.

## Secrets

Neither chart requires secrets in `values.yaml`:

- `agil-core` generates `AGIL_TOKEN_SECRET`, `AGIL_IP_SALT` and a first API key
  on install and preserves them on upgrade; use `secrets.existingSecret` for
  External Secrets/Vault/SOPS.
- `agil-node` needs a one-time node token or a pre-issued node key. Put it in a
  Kubernetes Secret and reference it with `enrollment.existingSecret`.

> **GitOps determinism.** The chart-generated core secrets use `randAlphaNum` and
> are stable only when Helm can `lookup` the live Secret during an upgrade.
> `helm template`, ArgoCD, Flux and other offline renderers cannot, so they
> produce different values on every sync and rotate `AGIL_TOKEN_SECRET`
> (invalidating every join link/session). For GitOps, set
> `secrets.existingSecret`; treat generation as a `helm install` convenience.

## Validate without a cluster

```bash
helm lint agil/infra/helm/agil-core agil/infra/helm/agil-node
helm template agil-core agil/infra/helm/agil-core -n agil > /tmp/core.yaml
helm template agil-node agil/infra/helm/agil-node -n agil \
  --set enrollment.token=test > /tmp/node.yaml
# optional, if kubeconform is installed:
kubeconform -strict -summary /tmp/core.yaml /tmp/node.yaml
```

The repository's `agil/infra/tools/validate.py` also parses rendered YAML and
checks value references, so the kit can be validated in CI without Helm.

## Versioning and rollback

Chart `version` follows the kit, `appVersion` follows the core image. Pin the
image digest for reproducible deployments. Roll back with
`helm rollback <release> <revision>`; keep `AGIL_TOKEN_SECRET` stable or all
join links break. Back up the core PVC before a major upgrade.

## Known limitations

- Core is single-replica (in-memory rooms); HPA/PDB templates are off by
  default and HPA is unsupported in 0.1.0. Enabling the PDB with one replica
  renders `maxUnavailable: 1` (no-op) rather than a drain-blocking
  `minAvailable`.
- The node chart is a control-plane registry client, not a media server. It
  runs the standard core image with the first-party CLI; no extra node image is
  needed.
- No bundled Redis/Postgres; no `values.schema.json` (chart values are
  documented and linted but not schema-validated).
- No ServiceMonitor: core has no `/metrics` endpoint; scrape `/v1/health` with
  blackbox probes or use `agil/core/deploy/observability/`.
