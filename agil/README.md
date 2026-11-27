# AGIL Platform

Monorepo layout: one deployable per top-level product.

```
agil/
├─ core/       server + panels (dashboard/editor), contracts, MCP, deploy, docs, qa
├─ websdk/     widget + SDK + embed + demo/custom UI
├─ mobile/     React Native, iOS, Android, Flutter, Capacitor
├─ edge/       Linux/MiniPC headless audio/video agent (future)
└─ infra/      optional Helm/Terraform/monitoring examples
```

Dependency direction:

```
core/packages/protocol -> websdk, mobile, edge
```

Rules:
- one deployable per top-level product: Core, Web SDK, Mobile, Edge;
- OpenAPI/contracts stay inside Core as a package, not a separate repo;
- nodes are roles/images inside Core, not a separate repo;
- Caddy/HAProxy/nginx are deployment examples, never hard dependencies;
- runtime state (`.data`), `.git`, `node_modules` and `.tmp` stay at the
  repository root and are never part of a product tree.

See [core](core/README.md), [websdk](websdk/README.md), [mobile](mobile/README.md)
and [edge](edge/README.md) for scope and build commands.
