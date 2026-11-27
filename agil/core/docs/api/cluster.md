# Cluster & Node enrollment (baseline)

Status: **implemented baseline** (`@agil/protocol` + `@agil/calls-server` + dashboard +
CLI). No deploy / production config is part of this change.

A leader Core issues **one-time enrollment tokens**. A standby Core redeems a
`core` token through `POST /v1/cluster/join`; an SFU / TURN / STUN / all-in-one
Node redeems a `node` token through `POST /v1/nodes/register` and then keeps its
liveness with `POST /v1/nodes/:id/heartbeat`. The dashboard
(**Инфраструктура → `#/infrastructure`**) and `agil/core/scripts/agil-cli.mjs`
manage tokens and the node registry.

The same registry owns the **per-node module allowlist** (Docker add-on packages:
`egress`, `stt`, `recorder`, `turn`, `sip`, `ingress`, `sfu`): the dashboard expands a node, sees
the modules it reports and their status/health, and queues an allowlisted
`start|stop|restart|install|remove|enable-autostart|disable-autostart` action. The Core delivers the command on the
node's next heartbeat (exactly once, TTL 5 min), the node agent executes the
Docker action and acknowledges the result on a later heartbeat. The server never
accepts an image or a command from the dashboard — images come from the Core
catalog (§10).

With `AGIL_REDIS_URL` set, Cores elect **one leader** through a Redis lease and a
standby takes over when the lease expires (automatic failover, read-only
standby). The lease, its fencing model, status fields and runbook are documented
in [`agil/core/docs/ha-leader.md`](../ha-leader.md).

The cluster registry covers identity, inventory, module control, the leader
lease and room assignments:

- leader election and failover **are** implemented (Redis lease, TTL + fencing);
- with `AGIL_ROOM_SNAPSHOT_STORE=redis`, the new leader restores room snapshots from shared Redis;
  tenant configuration and the node registry still require separate synchronization;
- Core can assign a configured LiveKit ingress to a room. Registry `endpoint`
  and `healthPath` are informational. The agent reports readiness on heartbeat;
- the node agent is the only component that talks to the Docker daemon; the Core
  only queues allowlisted module commands and never runs a container itself;
- `drain` excludes a node from new room assignments. Existing rooms retain
  their assignments;
- the registry is a single-node file (`<AGIL_DATA_DIR>/cluster/cluster.json`),
  not a replicated database.

Those are the documented next steps (§11).

---

## 1. Concepts

| Entity | Fields | Notes |
|---|---|---|
| Cluster | `{id, role: leader\|standby, version}` | `id` persists per data dir (`AGIL_CLUSTER_ID` can pin it); with `AGIL_REDIS_URL` the role comes from the leader lease, otherwise from `AGIL_CLUSTER_ROLE` (default `leader`); `version` is the server version |
| Node | `{id, role: sfu\|turn\|stun\|all, features[], capacity, status}` | Metadata kept by the Core: name, endpoint, healthPath, region, version, enabled, drain, timestamps + the latest self-reported `metrics` (live stats, §3.2) and `modules` (add-on inventory, §10) |
| Node status | `online \| offline \| draining \| disabled` | Derived: disabled → `disabled`, drain → `draining`, otherwise `online` if last heartbeat ≤ 90 s ago, else `offline` |
| Node module | `{id, kind, name, version, image, status, health, ports, updatedAt, lastError?}` | One Docker add-on from the Core allowlist (`egress`, `stt`, `recorder`, `turn`, `sip`). `status`: `running\|stopped\|error\|installing\|unknown`; `health`: `healthy\|degraded\|unhealthy\|unknown`; absent `NodeSummary.modules` = never reported, `[]` = reported none |
| Module command | `{id, moduleId, action, image?, createdAt, expiresAt}` | Server-generated command queued by an admin (`start\|stop\|restart\|install\|remove`), delivered exactly once on a heartbeat, TTL 5 min. `image` only for `install` and always from the catalog |
| Enrollment token | `{id, kind: core\|node, role, features[], expiresAt, uses, createdBy}` | Plus `remainingUses`, `createdAt`, `revokedAt`, `label`, `status` in API responses |
| Token status | `active \| used \| expired \| revoked` | `revoked` wins over `expired`, `expired` over `used` |

Token roles:

- `core` tokens: `standby` is the only usable role (a `leader` token is stored
  but cannot join — the leader is the server that issued it).
- `node` tokens: `sfu`, `turn`, `stun`, `all`. A token with role `all` may
  register as any node role; a role-scoped token must match exactly.

`features` are lowercase ids (`^[a-z0-9][a-z0-9._-]{0,31}$`, ≤ 16). When a token
lists features, registration must be a **subset** — a compromised node cannot
claim capabilities it was not enrolled for.

---

## 2. Security model

- The plaintext token is generated with 24 random bytes
  (`agil_enr_<base64url>`), returned **once** by `POST /v1/admin/cluster/tokens`
  and never persisted. The store keeps `sha256(AGIL_IP_SALT + ':' + token)`.
- The per-node key returned by registration (`nk_<base64url>`) is also returned
  once and stored hashed; it is the only credential for heartbeat. It can have
  an optional lifetime (`keyTtlSec` at registration, or the Core default
  `AGIL_NODE_KEY_TTL_SEC`; `0` = never expires) and can be rotated by a tenant
  admin with `POST /v1/admin/nodes/:nodeId/rotate-key`, which invalidates the
  old key immediately. A node whose key expired gets `401` on heartbeat.
- Tokens are TTL-limited (1 s … 30 days, default 1 h), use-limited
  (`uses` 1…100, default 1) and revocable. A use is consumed **only after all
  scope/duplicate checks pass**, so a rejected registration does not burn a
  one-time token. Persistence happens before credentials are returned.
- **Three separate rate limiters**:
  - enrollment (`POST /v1/cluster/join`, `POST /v1/nodes/register`) — 120
    requests/min per client IP hash (`429 rate_limited` + `Retry-After`);
  - **outer heartbeat** (`POST /v1/nodes/:nodeId/heartbeat`) — every attempt,
    valid credential or not, is charged to one bucket per client IP **before**
    the credential is hashed/validated; default 600/min
    (`AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN`). This bounds a client that sends a
    different bogus key per request. A 61-node fleet behind one NAT costs ~122
    attempts/min at the 30 s contract, so it stays far below the cap;
  - **per-node heartbeat** — keyed by the *tenant id + authenticated node id*
    (node ids are unique per tenant only), 10/min by default
    (`AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN`), charged only after the credential,
    node id, `enabled` and key expiry checks pass. Invalid keys cannot create or
    burn per-node buckets, and tenants that own the same node id never share a
    bucket (P2-R).
  The invalid-token answer is generic (`Invalid enrollment token`) to avoid id
  probing.
- **Module control uses fixed actions.** Catalog modules keep their allowed
  actions and the Core supplies the catalog image for `install`. Locally
  approved custom containers support `start`, `stop` and `restart`,
  each targeting the exact Docker container ID reported by the agent.
  A container created from an approved isolated template can also be
  removed when the same inventory entry reports `templateRemovable: true`.
  A custom install confirms the current approved digest with `expectedImage`.
  The node rechecks local authorization and uses its cached image and fixed
  isolated runtime. Commands and runtime options come from the node and image.
  Catalog
  `env` entries are names + `required`/`secret`
  hints, never values; module commands are tenant-scoped, leader-only and
  audited (`cluster.node.module.command` / `cluster.node.module.result`).
- Tenant scope comes from the token, never from headers: a token issued for
  tenant A can only create registry entries for tenant A. Admin endpoints are
  tenant-scoped by `x-api-key` (or an SSO admin session); the platform key is
  rejected with `403` (same rule as other tenant admin endpoints).
- No secret is written to logs, audit entries, API listings or error messages.
  Audit records only token/node ids, kind/role/features, field names and key
  expiry (never a plaintext token/key).
- **Enrollment surface fencing.** The enrollment endpoints are **outside**
  `/v1/admin`, so `AGIL_ADMIN_API_ENABLED` / `AGIL_ADMIN_ALLOW_IPS` deliberately
  do **not** apply: nodes never hold an admin key and must keep enrolling when
  the admin API is disabled. They are secured by the bearer token and an
  **optional dedicated allowlist** `AGIL_ENROLL_ALLOW_IPS` (CIDR list, empty =
  everyone; outside → `403`). Use TLS in front of the Core in any case.
- **Standby is read-only.** A Core that does not hold a locally valid leader
  lease rejects token creation **and revocation**, standby join, node
  registration, heartbeat, node PATCH/disable/drain/delete and key rotation with
  `409 not_leader`; its registry views, status and audit remain readable. With
  `AGIL_REDIS_URL` the gate is the fenced Redis lease (`docs/ha-leader.md`); with
  `AGIL_CLUSTER_ROLE=standby` it is pinned by configuration. This prevents
  split-brain enrollment and admin mutations on a stale copied registry.
- **The node-registry write lock is separate from the leader lease.** Even the
  leader must still hold `agil:cluster:<id>:registry-lock`; otherwise the write
  fails closed with `503 registry_unavailable` (the lease is not enough when the
  registry file is shared between hosts).
- **A registry write either persists or fails.** If the advisory lock cannot be
  acquired or the atomic rename fails, the in-memory change is rolled back and
  the request returns `503 registry_unavailable`; it never reports `201/200` for
  data that only exists in memory (a restart would lose it). Retrying after the
  lock clears is safe.

---

## 3. HTTP API

### 3.1 Admin (tenant admin key or admin session)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/v1/admin/cluster/tokens` | `{kind, role?, features?, ttlSec?, uses?, label?}` | `201 {token, enrollment}` — `token` plaintext once |
| GET | `/v1/admin/cluster/tokens` | — | `{tokens: EnrollmentTokenSummary[]}` (newest first, no secrets) |
| DELETE | `/v1/admin/cluster/tokens/:tokenId` | — | `{revoked:true, id, enrollment}`; `404` unknown, idempotent for an already revoked token |
| GET | `/v1/admin/cluster/status` | — | `ClusterStatusResponse` + `cluster`, `leader`, `lease`, `ha`, `failover`, `standbys[]`, `enrolledNodes[]`, `counts`, `limitations[]` |
| GET | `/v1/admin/nodes?role=&status=&limit=&offset=` | — | `{nodes: NodeSummary[]}` (`limit` 1…500, `offset`; with either set the response also carries `total/limit/offset`) |
| PATCH | `/v1/admin/nodes/:nodeId` | `{name?, role?, features?, capacity?, endpoint?, healthPath?, region?}` | `{node}` |
| POST | `/v1/admin/nodes/:nodeId/disable` | `{disabled?: boolean}` (default `true`) | `{node}` |
| POST | `/v1/admin/nodes/:nodeId/drain` | `{drain?: boolean}` (default `true`) | `{node}` |
| POST | `/v1/admin/nodes/:nodeId/rotate-key` | `{keyTtlSec?: number}` (1 s … 90 days; omitted = `AGIL_NODE_KEY_TTL_SEC`) | `{node, nodeKey, keyExpiresAt, heartbeatIntervalSec}` — new key once; old key invalid immediately |
| DELETE | `/v1/admin/nodes/:nodeId` | — | `{deleted:true, id}`; frees the id for re-enrollment |
| GET | `/v1/admin/node-modules/catalog` | — | `{catalog: NodeModuleCatalogEntry[], actions: NodeModuleAction[]}` — allowlisted ids, images, repositories, ports and env **hints** (no values/secrets) |
| GET | `/v1/admin/nodes/:nodeId/modules` | — | Node inventory, Docker availability, active commands and latest failures by module. `modules: []` until the node reports (§10). |
| POST | `/v1/admin/nodes/:nodeId/modules/:moduleId/actions` | `{action}` for presets, `{action,targetContainerId}` for custom lifecycle, `{action:"install",expectedImage}` for a locally approved cached template | `201 {command}`, `404` unknown node/module, `400` unsupported action or `409` conflict |

`createdBy` is `api-key:<tenantId>` for an API-key request or
`admin-session:<sub>` for a dashboard SSO session. It is an audit label, not a
secret.

An admin `PATCH` saves each supplied `capacity` field as an operator override.
The effective values in `node.capacity` remain in effect across heartbeats and
Core restarts. The node can still update fields without an operator override
through its heartbeat. A separate patch can change any override, including to
`0` for unspecified capacity.

Every **write** in the table above (token issue/revoke, node PATCH/disable/
drain/delete/rotate, module action queueing) is leader-only: on a standby (no
fenced lease, or `AGIL_CLUSTER_ROLE=standby`) it returns `409 not_leader` before
touching the local registry. Reads (including the module catalog and a node's
module inventory) stay available. The same gate covers `POST /v1/rooms`,
`POST /v1/tokens`, `DELETE /v1/rooms/:id`, room joins and local-volume uploads
(`POST /v1/files`, `POST /v1/recordings`) — rooms and uploaded blobs live on one
Core, so only the leader may write them.

### 3.2 Enrollment (token-only; no API key)

| Method | Path | Credential | Response |
|---|---|---|---|
| POST | `/v1/cluster/join` | `{token}` (kind `core`) | `{cluster, leader:{nodeId,version,publicOrigin}, standby, token:{id,remainingUses}}` |
| POST | `/v1/nodes/register` | `{token}` (kind `node`) | `201 {node, nodeKey, keyExpiresAt, heartbeatIntervalSec, cluster}` |
| POST | `/v1/nodes/:nodeId/heartbeat` | header `x-node-token: nk_…` (or `Authorization: Bearer`) | `{node, drain, heartbeatIntervalSec, serverTime, moduleCommands: NodeModuleCommand[]}` (node carries `keyExpiresAt`, and once reported, `metrics`/`modules`; `moduleCommands` is always present) |

`leader.nodeId` is the **cluster id** in standalone mode (historical behaviour)
and the **current leader Core id** when `AGIL_REDIS_URL` is configured, so a
standby can retry its writes against the right process. The per-tenant signaling
node id (`scale.signaling.nodeId`) is reported separately by
`GET /v1/admin/cluster/status` as `nodeId`. See
[`ha-leader.md`](../ha-leader.md) for the lease fields (`leader`, `lease`, `ha`,
`failover`) and their fencing semantics.

Registration request:

```jsonc
{
  "token": "agil_enr_…",
  "nodeId": "edge-1",              // optional; generated as node_<hex> when omitted
  "role": "sfu",                   // sfu | turn | stun | all
  "name": "Edge SFU",
  "features": ["sfu", "egress"],   // must be a subset of the token features
  "capacity": { "maxRooms": 5, "maxParticipants": 300, "bandwidthMbps": 500 },
  "endpoint": "https://sfu-1.example:7880", // informational (not probed yet)
  "healthPath": "/health",         // informational
  "region": "ru-msk",
  "version": "0.1.0",
  "keyTtlSec": 2592000             // optional node-key lifetime; omitted = AGIL_NODE_KEY_TTL_SEC
}
```

`endpoint` must be an `http(s)`/`ws(s)` URL without embedded credentials and
must not point at a cloud metadata host (`169.254.169.254`,
`metadata.google.internal`, …); private/loopback node URLs stay allowed because
nodes are expected to be internal. Nothing fetches the field yet.

The bundled agent reports `sfuReady` for nodes configured to run LiveKit. A
false or stale report excludes the node from new Core room pins while keeping
the agent online. Registered nodes need a first heartbeat before they can be
pinned. Legacy nodes that never report `sfuReady` keep the existing
heartbeat-based behavior until the administrator changes their SFU eligibility.
Only roles `sfu` and `all` can be ready. Replacing the feature list through the
admin API with a list that omits `sfu` prevents new Core room pins for either
role. Restoring the feature or changing back to an SFU-capable role requires a
fresh readiness report. Existing rooms keep their pins.
Entering drain also invalidates the previous SFU readiness report for new
pins. A positive report received during drain can be used once drain ends.
Otherwise Core waits for the next fresh report before assigning new rooms to
that node.
The pin is used by room continuity and can select a client ingress
when the Core operator [configures trusted node URLs](../operations.md#direct-sfu-ingress-per-room).

Heartbeat fields are optional. `status: "offline"` lets a node announce a graceful
shutdown, `metrics` is a live statistics snapshot, and `modules` and
`moduleResults` carry inventory and acknowledgements (§10).

```jsonc
{
  "metrics": {
    "cpuPercent": 12.5,      // 0..100
    "memoryPercent": 43,     // 0..100
    "load1": 0.42,           // >= 0 (1-minute load average)
    "activeRooms": 3,        // integer >= 0
    "participants": 17,      // integer >= 0
    "bandwidthMbps": 12.5,   // >= 0, aggregate media bandwidth
    "uptimeSec": 86400,      // >= 0 seconds (fractions allowed, e.g. process.uptime())
    "version": "0.1.0",      // agent build, 1..32 chars (separate from registration version)
    "reportedAt": 1732230000000 // epoch ms; Core receipt time when omitted
  }
}
```

Every metric field is independently optional and range-validated (400
`validation_failed` otherwise; `Infinity`/`NaN` are rejected). The Core **merges**
a report into the node's last snapshot — absent fields keep their previous value,
and `metrics: {}` is a no-op. `reportedAt` is refreshed on every report; when the
node omits it the Core stamps its receipt time, so it is always an honest
timestamp. Values are never invented or zero-filled: `node.metrics` is **absent**
from `GET /v1/admin/nodes` until the node sends its first report, and old agents
that send only `capacity`/`status` keep working unchanged. The node key is
bound to one node id — using it for another id is `403`. An expired node key is
`401` with an actionable "rotate it" message; `keyExpiresAt` is returned in the
node record so the agent can rotate before expiry.

Module inventory and commands travel on the same heartbeat (§10). Request:

```jsonc
{
  "modules": [
    {
      "id": "egress",
      "image": "agil/node-egress:0.1.0", // must use the catalog repository
      "status": "running",               // running|stopped|error|installing|unknown
      "health": "healthy",               // healthy|degraded|unhealthy|unknown (optional)
      "version": "0.1.0",                // optional; ''/omitted = not reported
      "ports": [9000],                   // optional published ports
      "updatedAt": 1732230000000,        // optional; Core receipt time when omitted
      "lastError": "container restarting" // optional
    }
  ],
  "moduleResults": [
    { "commandId": "nmc_0123456789abcdef", "ok": true, "status": "stopped" }
  ]
}
```

`modules` is a **full snapshot**: omitted keeps the previous inventory (old
agents stay compatible), `[]` honestly means "no modules installed". The Core
drops reserved catalog ids when their image uses a different repository and
fills catalog names and kinds. Other valid ids are shown in the Docker inventory
with their reported kind or their id as the default. They do not grant provider
capabilities. An agent can report `lifecycleContainerId` on a custom entry
after checking the local opt-in and runtime constraints. `templateRemovable`
requires a matching record in the node's local state and the current
isolated container. `node.modules` is absent from the API until the
first snapshot. `moduleResults` acknowledges a command received on an earlier
heartbeat; unknown/expired command ids are ignored. The response always carries
`moduleCommands` (possibly empty) — each command is delivered by **exactly one**
heartbeat, so the agent must not expect to see it again; a heartbeat with
`status: "offline"` receives no new commands.

The authenticated heartbeat can carry `moduleTemplates` alongside the full
Docker inventory. The node reports up to 16 operator-approved custom IDs,
their explicit registry and SHA-256 digest references, and a `cached`
boolean. An optional `installable: true` indicates the local install opt-in
and a cached image compatible with the isolated profile. The tenant administrator reads this metadata from
`GET /v1/admin/nodes/{nodeId}/modules`. It is separate from the preset
installation catalog and provider capabilities. A full report with an empty
array or without the field removes old template entries. When Docker stops
reporting inventory, Infrastructure marks the previous snapshot as historical.
An opted-in template can instead report `blockedReason` as
`image_not_cached`, `image_incompatible`, `inspection_failed`,
`environment_unavailable`, or `storage_unavailable`.
An optional `resources` object reports the effective per-container
`cpuMillicores`, `memoryMiB` and `pidsLimit` from the operator's local file.
Payloads for admin module actions keep the existing shape. The agent reads
and verifies the local resource profile when creating the container.
The `environment_unavailable` state covers a missing or unsafe local
environment file, an unresolved named value or a nonlocal Docker endpoint. The local `envRefs`
list and environment data stay on the node.
The optional local `commandArgs` array replaces the image's Docker `CMD`.
Only the node agent reads it. It never enters heartbeat reports or module
action payloads and requires a node-local Docker connection.
The operator can also set a local template `restartPolicy` of `no` or
`on-failure` with at most three restart attempts. Core cannot set this
policy. It applies when Docker creates the container.
An optional `storage: "read_only"` reports the local named volume profile.
It mounts at the fixed container path `/agil-data`. The template file
keeps the actual volume name on the node. `storage_unavailable` means
the node could not verify the volume's ownership or local configuration.
An undelivered install is cancelled if the approved digest becomes blocked.
The agent rechecks eligibility before creating a container and compensates a
failed startup by removing only the new container matched to that command.

An opted-in module report may include a `logs` snapshot with up to 16
normalized events. Each event contains the Docker timestamp, level and stream.
Core returns up to four module windows as `logWindows` only in the tenant
administrator's node module view, with `Cache-Control: no-store`. Snapshots
expire with the inventory and are held in memory. Raw lines stay on the node.

#### Module availability

`node.availableModules` lists modules from the current, usable inventory in the heartbeat and node registry responses. Core includes a module when the node is online, the inventory is at most 90 seconds old, Docker management is available, and the container is running with `healthy` or `unknown` health. A lifecycle acknowledgement for `install`, `start` or `restart` can report the process as running before the agent reports readiness. Core marks that module as `degraded` until a new inventory confirms its state, even when its previous health was `healthy`. Other modules retain their own inventory and readiness. `node.features` continues to report the configured feature ids. TURN uses the same inventory checks for ICE eligibility when the relay uses managed Docker. Egress, STT, SIP and recording still depend on their provider configuration and health.

An organization admin can send `{"moduleEnabled":{"turn":false}}` to
`PATCH /v1/admin/nodes/:nodeId`. Only the supplied module IDs change. Core
removes the disabled module from `availableModules`, cancels its undelivered
commands and rejects new ones with `409 module_disabled`. A command already
delivered can still return its result. The running container remains visible
in inventory and continues to serve existing work. The policy and its audit
entry are persisted. Set the same key to `true` to enable the module again.
For a running module Core waits for a fresh inventory before routing new
work. The built-in TURN service follows `node.features`, while the Docker
TURN module follows this policy.

For a node that reports bundled TURN readiness, removing `turn` from `node.features` excludes its bound relay from ICE with `nodeState: turn_feature_disabled`. This also applies when the first such report arrives after the feature was removed. Restoring the feature requires a fresh `turnReady` report. The Docker inventory remains visible for module management.

`inventoryStale` is returned in the node summary and `GET /v1/admin/nodes/:nodeId/modules`. It is true when the last inventory exists and has expired or was invalidated. A liveness-only heartbeat does not renew inventory freshness. The dashboard marks this snapshot as the last node report.

The all-in-one agent reports `turnReady` for its bundled coturn after a local UDP STUN Binding probe. If configured for TLS, the agent also checks that the TLS listener completes a handshake. For a configured relay linked to that node, Core uses this report independently of Docker inventory. A failed or expired report, an offline or disabled node, or a node in drain excludes the relay from ICE. A liveness-only heartbeat does not renew the report. Agents that never report `turnReady` continue to use the Docker inventory check for a linked TURN container.

A ready bundled relay can advertise `turnEndpoint: {ip, port, tlsPort?, tlsHostname?, credentialMode?}` in its authenticated heartbeat. The endpoint is available with fresh TURN readiness in the node's organization. The dashboard fills UDP and TCP addresses from the report. It also fills a `turns:` address when the report includes both `tlsPort` and `tlsHostname`, otherwise the TLS name can be entered manually. An administrator supplies the credential configuration and saves the draft to publish the relay. Passwords, signing keys and certificate paths stay out of the heartbeat. With REST credentials, coturn and Core use the same configured signing key.

For an explicitly provisioned node, `turnEndpointProof` confirms possession of
its `AGIL_COTURN_AUTO_SECRETS` key and binds the proof to the current enrollment
credential and endpoint. The node response exposes only `automaticTurnVerified`
while the report is ready. The scale status sets `automatic: true` for derived
relays, whose addresses are supplied to joined users through the normal ICE
updates. See [Automatic membership](../node-image.md#automatic-turn-pool-membership).

Disabling a node in the registry blocks new module commands with `409 node_disabled` and rejects heartbeats until the node is enabled again. It also cancels undelivered commands. An agent can acknowledge already delivered commands after re-enabling, subject to the original command TTL. Module availability is restored after the next usable inventory report.

For an organization whose LiveKit deployment depends on one managed Egress worker, set `mediaProcessing.egressNodeId` in the dashboard’s media processing settings or in the editor. The value is the ID from that organization's node registry. The field may be empty. Core checks that the bound node reports `egress` in `availableModules` before starting a new recording, RTMP stream or HLS job. A blocked start returns `503 egress_node_unavailable`. Routes and flows report an unavailable destination. Listing and stopping existing jobs still use LiveKit.

The binding controls when Core submits jobs to the existing `AGIL_EGRESS_URL`. LiveKit still schedules the workers attached to its configured backend. Use the binding only when the node’s module is a dependency of that backend. Clearing the ID restores independent submission. A multi-worker LiveKit pool can continue to rely on its own scheduler.

### 3.3 Errors

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `validation_failed` | Zod body errors, invalid role/kind combination |
| 401 | `unauthorized` | Missing/unknown/expired/used/revoked token or node key (including an expired node key) |
| 403 | `forbidden` | Token kind/role/feature scope mismatch; disabled node; platform key on admin endpoints; node key used for another node; client IP outside `AGIL_ENROLL_ALLOW_IPS` |
| 404 | `not_found` | Unknown token/node/module id (admin), unknown route |
| 409 | `node_exists` | Duplicate node id or duplicate standby id |
| 409 | `module_command_pending` | A command for this module is queued or awaiting acknowledgement |
| 409 | `node_disabled` | An administrator disabled the node in the registry |
| 409 | `node_modules_unavailable` | The agent reports that Docker inventory is unavailable or module management is disabled |
| 409 | `module_queue_full` | The per-node module command queue already holds 16 commands |
| 409 | `not_leader` | This Core does not hold a locally valid leader lease (standby, or `AGIL_CLUSTER_ROLE=standby`); every write is leader-only: token create/revoke, join, register, heartbeat, node PATCH/disable/drain/delete, key rotation, module action queueing, room create/delete/join and tenant config |
| 429 | `rate_limited` | Enrollment (120/min per IP), outer heartbeat bucket (`AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN`, default 600/min per IP; invalid/missing keys included) or per-node heartbeat bucket (`AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN`, default 10/min, keyed by tenant id + node id and charged after auth) |
| 503 | `registry_unavailable` | The cluster registry write failed (advisory lock held or I/O error); the in-memory change was rolled back, retry the request |

Token responses deliberately distinguish `expired` / `revoked` / `used` for an
already-valid token (operators need it); unknown tokens share one message.

---

## 4. Lifecycle

```
leader Core                          standby Core                     node
    │  POST /v1/admin/cluster/tokens      │                             │
    │  {kind:"core"} → tok_core            │                             │
    │  {kind:"node",role:"sfu"} → tok_node │                             │
    │                                      │                             │
    │  POST /v1/cluster/join {token}  ◄────┤                             │
    │  → cluster{id,role}, standby         │                             │
    │                                      │                             │
    │  POST /v1/nodes/register {token} ◄───┼─────────────────────────────┤
    │  → {node, nodeKey}                   │                             │
    │                                      │      POST /v1/nodes/:id/heartbeat
    │                                      │      x-node-token: nk_…  ◄───┤
    │  GET /v1/admin/nodes / cluster/status│                             │
```

The standby flow is **registration only**: it shows up in
`GET /v1/admin/cluster/status` (`standbys[]`, `counts.standbys`) so operators can
inventory it. It receives no data, promotion or traffic.

---

## 5. Node liveness

- Heartbeat interval: **30 s** (`NODE_HEARTBEAT_INTERVAL_SEC`).
- Without a heartbeat for **90 s** (`NODE_OFFLINE_AFTER_SEC`) the node is
  reported `offline` but stays registered (and keeps its id/key).
- `disabled` blocks heartbeat with `403`; `drain` keeps heartbeat working (so a
  draining node can finish work) and only changes `status`/`drain`.
- Node-key lifetime is optional: `keyExpiresAt` is `null` unless the node asked
  for `keyTtlSec` at registration or the Core runs with a positive
  `AGIL_NODE_KEY_TTL_SEC`. An expired key gets `401`; a tenant admin rotates it
  with `POST /v1/admin/nodes/:nodeId/rotate-key` and delivers the new key to the
  node. Rotation invalidates the old key immediately and is audited
  (`cluster.node.key-rotated`).
- Deleting a node invalidates its key immediately; the id can then be enrolled
  again with a fresh token.
- Module commands are delivered on the heartbeat: a command queued by an admin is
  returned once to the node, and the node agent acknowledges it on a later beat.
  Commands expire after 5 minutes (undelivered or unacknowledged) and a node can
  hold at most 16 at a time. A `status: "offline"` beat does not receive new
  commands, so a graceful shutdown never starts Docker work; queued commands wait
  for the next online beat within their TTL.

---

## 6. Storage

Everything lives in one atomically written JSON document:

```
<AGIL_DATA_DIR>/cluster/cluster.json
{
  "version": 1,
  "clusterId": "cl_…",
  "tokens":  [{ "id","tenantId","kind","role","features","hash","expiresAt","uses","used","createdBy","createdAt","revokedAt","label" }],
  "nodes":   [{ "id","tenantId","role","features","capacity","name","endpoint","healthPath","region","version","metrics","modules","moduleCommands","keyHash","enabled","drain","createdAt","registeredAt","lastSeenAt","lastStatus","keyExpiresAt","keyRotatedAt" }],
  "standbys":[{ "id","tenantId","clusterId","version","region","registeredAt","lastSeenAt" }]
}
```

- `hash`/`keyHash` are `sha256(AGIL_IP_SALT:secret)`, 64 hex chars.
- `modules` is the last sanitized inventory (`null` = never reported); each entry
  is re-validated on load (unknown ids/foreign images/corrupt fields are dropped,
  never served). `moduleCommands` keeps pending and delivered-in-flight commands
  (`deliveredAt` is internal and never exposed); expired commands are pruned on
  every write/heartbeat, so the queue is bounded to 16 per node.
- Writes take an advisory sibling lock `cluster.json.lock` (PID + timestamp,
  stale after 30 s) around the tmp-file + atomic rename, so two Cores sharing
  `AGIL_DATA_DIR` cannot interleave renames. If a **live** foreign lock is held
  for the 1 s wait, the write fails closed: the in-memory mutation is rolled
  back and the request returns `503 registry_unavailable` (never a silent
  `200/201` for state that only exists in memory). This does **not** make two
  in-memory registries coherent — a shared data dir by multiple active Cores is
  still unsupported (durable/replicated registry is a production gate).
- Retired tokens are kept for 30 days; at most 500 tokens and 500 nodes per
  tenant (oldest retired entries are dropped first).
- A corrupt file is renamed to `cluster.json.corrupt-<ts>` and the server starts
  with an empty registry instead of silently overwriting evidence.
- Back up `AGIL_DATA_DIR`. Nodes re-enroll with new tokens if the registry is
  lost; existing tokens cannot be recovered (only their hashes exist).

---

## 7. Environment variables

Core (`agil/calls-server`):

| Variable | Default | Meaning |
|---|---|---|
| `AGIL_CLUSTER_ID` | generated `cl_<hex>` persisted in the registry | Cluster id; pin it for stable operator tooling and for the shared lease namespace (`agil:cluster:<id>:…`) |
| `AGIL_CLUSTER_ROLE` | `leader` | Standalone mode (no Redis): `leader` (active) or `standby` (read-only). With `AGIL_REDIS_URL`: `standby` **opts out of the election** and stays read-only; `leader` participates normally |
| `AGIL_REDIS_URL` | empty = standalone | `redis://` / `rediss://` URL for the leader lease. Empty = single active Core, no failover (see [`ha-leader.md`](../ha-leader.md)) |
| `AGIL_CLUSTER_NODE_ID` | `<hostname>:<PORT>` | Stable id written into the lease. **Must be unique per Core**; set it explicitly when several Cores share a host (e.g. `PORT=0` tests) |
| `AGIL_REDIS_KEY_PREFIX` | `agil` | Prefix for lease keys (`<prefix>:cluster:<id>:leader`) |
| `AGIL_LEADER_LEASE_TTL_MS` | `10000` | Lease TTL in ms (2000…120000). This is also the worst-case failover time |
| `AGIL_LEADER_RENEW_INTERVAL_MS` | `TTL / 3` | Renewal interval (100…TTL−100). Must leave at least one retry before expiry |
| `AGIL_LEADER_RETRY_INTERVAL_MS` | `1500` | How often a standby retries acquiring the lease (100…60000) |
| `AGIL_ENROLL_ALLOW_IPS` | empty = everyone | Optional CIDR/IP allowlist for `/v1/cluster/join`, `/v1/nodes/register`, `/v1/nodes/:id/heartbeat`; independent of `AGIL_ADMIN_*` |
| `AGIL_HEARTBEAT_RATE_LIMIT_PER_MIN` | `10` | Per-node heartbeat allowance after successful auth (key = tenant id + authenticated node id, so same-id nodes of different tenants are independent); contract is 2/min |
| `AGIL_HEARTBEAT_IP_RATE_LIMIT_PER_MIN` | `600` | Outer heartbeat allowance per client IP, charged before credential validation (invalid/missing keys included); 61 nodes behind one NAT need ~122/min |
| `AGIL_NODE_KEY_TTL_SEC` | `0` | Default per-node key lifetime in seconds (0 = never expires; max 90 days); `keyTtlSec` at registration/rotation overrides it |

Node/CLI side (not read by the server today):

| Variable | Meaning |
|---|---|
| `AGIL_CORE_URL` | Core base URL (CLI default `http://127.0.0.1:8787`) |
| `AGIL_API_KEY` | Tenant admin key for `token`/`nodes list`/`cluster status` |
| `AGIL_NODE_TOKEN` | One-time enrollment token for `nodes register` |
| `AGIL_NODE_KEY` | Per-node key returned by registration (heartbeat) |
| `AGIL_NODE_ID`, `AGIL_NODE_NAME`, `AGIL_NODE_ROLE` | Node identity / role |
| `AGIL_NODE_FEATURES` | Comma-separated features |
| `AGIL_NODE_CAPACITY` | JSON capacity object |
| `AGIL_NODE_ENDPOINT`, `AGIL_NODE_REGION` | Informational endpoint/region |

There is a first-party all-in-one **node image** at
`agil/core/nodes/all-in-one/` (Dockerfile + compose + dependency-free agent):
it redeems a node token, heartbeats, serves `/healthz`/`/readyz`/`/metrics`,
handles drain/key rotation and supervises LiveKit (`sfu`) and coturn
(`turn`/`stun`) in one host-networked container. See
[`agil/core/docs/node-image.md`](../node-image.md). The infra kit still ships a
**reference** registry-only agent at `agil/infra/node-agent/` (Dockerfile +
`agent.mjs`) for environments that only need enrollment/heartbeat;
`AGIL_NODE_ONCE=1` gives a single register+heartbeat run with a clean exit code
(CI smoke). Use [direct SFU ingress per room](../operations.md#direct-sfu-ingress-per-room)
to configure client-facing addresses. For external TURN clients, configure a
relay address and ports reachable from their networks.

---

## 8. CLI

```
node agil/core/scripts/agil-cli.mjs token create --kind node --role sfu \
  --features sfu,egress --ttl 3600 --label edge-sfu
node agil/core/scripts/agil-cli.mjs token list
node agil/core/scripts/agil-cli.mjs token revoke enr_…
node agil/core/scripts/agil-cli.mjs nodes list [--role sfu] [--status online]
node agil/core/scripts/agil-cli.mjs nodes register --token agil_enr_… --id edge-1 --role sfu
node agil/core/scripts/agil-cli.mjs nodes heartbeat --id edge-1 --key nk_…
node agil/core/scripts/agil-cli.mjs nodes rotate-key edge-1 --ttl 2592000
node agil/core/scripts/agil-cli.mjs cluster status
```

Global flags: `--core <url>`, `--api-key <key>`, `--json`. The CLI prints the
one-time token/node key to **stdout** once and never to stderr; it works against
the production image without a build step.

---

## 9. Dashboard

`#/infrastructure` (nav: **Инфраструктура**):

- KPI row: cluster role, node counts, standby cores, active tokens;
- cluster card: id/role/version, **leader + lease** (mode, held, TTL remaining,
  fencing deadline, Redis connection, heartbeat, registry lock), a **failover
  banner** when this Core took over, the replication `ha` flags, the standby
  list and the explicit **limitations** list;
- tokens table: kind/role/features/uses/expiry/author/status, **create** (one-time
  reveal modal with a copy button and a ready CLI/curl example) and **revoke**;
- nodes table: role, features, capacity, heartbeat/status, **edit**
  (role/features/capacity/name/region), **drain**, **disable/enable**, **delete**;
  every row can be **expanded** to show the reported add-on modules
  (`NodeSummary.modules`) with status/health/version, their pending commands and
  the catalog actions the tenant admin may queue (§10).

Layout is verified at 390 px and 1440 px in light and dark themes; tables switch
to the existing `.table-cards` mobile layout. The screen degrades gracefully with
an explicit notice when the server predates the registry (404/405/501) and hides
itself for a platform key (tenant-scoped data).

---

## 10. Per-node modules (Docker add-on packages)

Status: **implemented backend/protocol** (`@agil/protocol` + `@agil/calls-server`).
The dashboard UI and the node-agent Docker executor are owned by separate
changes; this section is the exact wire contract for both. The Core never talks
to Docker: it stores the inventory the node reports and queues allowlisted
commands that the node agent executes.

### 10.1 Allowlist catalog

`GET /v1/admin/node-modules/catalog` (tenant admin key or admin session; the
platform key is rejected) returns the full allowlist:

```jsonc
{
  "actions": ["start", "stop", "restart", "install", "remove", "enable-autostart", "disable-autostart"],
  "catalog": [
    {
      "id": "egress",                       // egress | stt | recorder | turn | sip
      "kind": "egress",
      "name": "Egress streaming worker",
      "description": "…",
      "image": "agil/node-egress:0.1.0",    // canonical image the Core installs
      "repository": "agil/node-egress",     // allowlisted Docker repository
      "ports": [],                          // default ports (informational)
      "env": [                              // names + hints only, NEVER values
        { "name": "AGIL_EGRESS_CORE_URL", "required": true, "secret": false, "description": "…" }
      ],
      "actions": ["start", "stop", "restart", "install", "remove", "enable-autostart", "disable-autostart"]
    }
    // stt (8090), recorder (8091), turn (3478/5349), sip (5060/5061)
  ]
}
```

- The catalog is a **hard allowlist**: a module id outside it is `404` on the
  control route and is dropped from a node's heartbeat inventory. Adding a module
  is a protocol + server change on purpose.
- `image` is what an `install` command carries. Matching is by **repository**:
  a node may run another tag/digest of `agil/node-egress`, but no other image is
  ever accepted, installed or shown.
- `env` hints let the dashboard/operator show required variables without ever
  sending a value or a secret to the Core.
- The Recorder entry exposes lifecycle actions for existing containers. Its action list omits `install`. Core rejects new requests and skips undelivered legacy install commands. Updated agents also reject older install commands before calling Docker. Recorder removal stops the container first and keeps its Docker volumes, including anonymous volumes. Keep important data on volumes or bind mounts, since the container's writable layer is removed. Server recording jobs use LiveKit Egress, and browser recordings use the Core recording store.

### 10.2 Dashboard flow (contract)

1. `GET /v1/admin/nodes` — each `NodeSummary` may carry
   `modules?: NodeModule[]` (absent = the node has not reported yet; `[]` = it
   reported that no add-ons are installed).
2. Expand a node → `GET /v1/admin/nodes/:nodeId/modules` →
   `{nodeId, modules, moduleAvailability?, pendingCommands, inFlightCommands, failures}`.
   `moduleAvailability` comes from the latest online heartbeat. `available` means
   Docker returned inventory. `unavailable` means the agent could not get that
   inventory. `disabled` means module management on the agent is off. If the
   field is absent, the agent may be running an older version. For `unavailable`
   and `disabled`, Core retains the last inventory, rejects new module commands
   and holds queued commands until recovery or expiry.
   `failures` lists the last failed
   or expired command for each module (`moduleId`, `action` and optional `error`),
   including failed installs that produced no container. On expiry, `reason` is
   `delivery_expired` if Core never sent the command in a heartbeat response or `result_expired`
   if Core received no acknowledgement before the deadline. In the latter case
   check the reported module state before retrying. A successful command for the
   same module clears the failure. Clients can treat an absent field as an empty list.
   `inFlightCommands` lists commands already delivered in a heartbeat response
   and awaiting acknowledgement. Clients can treat an absent field as an empty
   list. A repeat of the same action for the same module returns HTTP 409 while
   the prior command is queued or awaiting acknowledgement.
   `pendingCommands` are queued but not yet
   delivered by a heartbeat (a pending badge). Both endpoints are tenant-scoped
   and readable on a standby Core.
3. Load the catalog once (`GET /v1/admin/node-modules/catalog`) for labels,
   actions, ports and env hints.
4. Control: `POST /v1/admin/nodes/:nodeId/modules/:moduleId/actions` with a
   single `action` from the catalog → `201 {command}`.
   The dashboard **must not** send an image or any Docker command; unknown keys
   are stripped. Show "queued for the next heartbeat" — the reported module
   status changes only after the node reports it (no optimistic state).
5. Map catalog `actions` to buttons; show `status`/`health`/`version` from
   `NodeModule`, `lastError` when present. Poll nodes/modules while expanded.
6. Show auto-start controls for an installed module that reports `autoStart`.
   `enable-autostart` sets Docker policy `unless-stopped`. `disable-autostart`
   sets it to `no`. The policy changes in place and the next inventory report
   confirms it. Enabling it leaves a manually stopped module stopped until
   the operator starts it. Older agents and unmanaged policies omit
   `autoStart`. The API returns `409 module_autostart_unavailable` if the latest
   inventory has no manageable policy and holds already queued auto-start
   commands until a compatible heartbeat or command expiry.

### 10.3 Node agent flow (contract)

1. On heartbeat, send a **full inventory snapshot** whenever it changed (or on
   every beat): `modules: [{id, image, status, health?, autoStart?, version?, ports?, updatedAt?, lastError?}]`.
   `image` is the observed Docker image. Reserved catalog IDs require the
   catalog repository. `status` ∈ `running|stopped|error|installing|unknown`,
   `health` ∈ `healthy|degraded|unhealthy|unknown`. The Core stamps
   `updatedAt` with receipt time when omitted and never invents a value.
2. Read `moduleCommands` from the heartbeat response. Each command appears in
   **exactly one** response — persist it locally if execution can be interrupted.
   For catalog IDs, execute only the permitted actions:
   - `install` → pull/run `command.image` for `command.moduleId`;
   - `start|stop|restart|remove` → the corresponding container lifecycle action;
   - `enable-autostart|disable-autostart` → update the owned container's restart policy in place;
   - respect `expiresAt`; a command should not be started after it.
   For a custom ID, `start`, `stop` and `restart` require the matching
   `targetContainerId`. For custom `remove`, the same target must carry
   `templateRemovable: true` and pass the agent's provenance and isolation
   checks immediately before removal. The agent keeps images and volumes.
   Custom `install` requires an exact approved digest
   and a free module ID. The Core delivers against a fresh matching
   inventory and records `target_changed` if the target changed before
   delivery. The agent checks local approval and isolation again before
   acting. Installation uses the local cached image ID in a fixed profile.
   For replacement use `{action: "install", expectedImage, targetContainerId}`.
   Replacing with the same image requires a fresh `profileChanged: true`
   report. The node checks the currently approved profile before replacing
   the exact target. No private profile values are sent through Core.
   The target must still be a running isolated template container with
   confirmed installation provenance. The agent stages the cached digest,
   verifies early startup and stops the previous container only after the
   candidate is running. The operator can restore a previous version by
   approving its digest locally again and repeating the action.
   Official `livekit/egress` and `livekit/sip` containers are reported read-only.
   A lifecycle request for either returns `409 module_compose_read_only`.
   Existing legacy `agil/node-egress` and `agil/node-sip` containers keep their
   lifecycle controls. Deploy new workers using the node's Compose project.
   The operator-managed `ingress` catalog entry uses the same exact
   `targetContainerId` for start, stop and restart. The node validates
   local Compose opt-in and ownership again before executing. Ingress
   installation, configuration and removal are operator actions on the node.
   The operator-managed `sfu` module accepts `start` for a stopped container
   and `stop` or `restart` for a running container with `sfuDrainState: available`.
   These actions require the exact Docker ID from current inventory and maintenance
   mode when Core queues and delivers the command. Leaving maintenance cancels
   undelivered actions. After Core delivers a graceful stop, leaving
   maintenance returns `409 sfu_drain_in_progress` until the node confirms the
   stop or reports that it rejected the request before reserving the signal.
   An acknowledged stop can return `status: running`. The SFU reports
   `sfuDrainState: requested` while waiting to exit. The agent verifies local
   operator approval and sends one `SIGTERM` per running process. During a
   restart the Core shows `restart_requested`, sends a separate `start` only
   after the same container reports stopped, and holds maintenance until fresh
   readiness. A replacement container never receives this automatic start.
   [External SFU maintenance](../node-image.md#start-a-stopped-external-livekit-from-infrastructure).
3. Acknowledge on a later heartbeat:
   `moduleResults: [{commandId, ok, status, error?}]` where `status` is the
   resulting module state (`running` after start/restart/install-that-starts,
   `stopped`/`unknown` after stop/remove, `error` on failure). Unknown or expired
   `commandId`s are ignored by the Core (no error).
4. A heartbeat with `status: "offline"` receives no new commands; do not start
   Docker work while shutting down.
5. Never send env values/secrets: the Core has no field for them.

### 10.4 Queue semantics (Core)

- Commands are server-generated (`nmc_<16 hex>`), tenant-scoped, leader-only and
  audited (`cluster.node.module.command`; acknowledgements are audited as
  `cluster.node.module.result` without the node's raw error text).
  In the dashboard audit log, select administrator actions and search for the
  command ID to find both records. The same search is available with
  `GET /v1/admin/audit?type=admin.action&q=<commandId>`. Node ID and module ID
  can also be used as search terms.
- TTL **300 s** (`NODE_MODULE_COMMAND_TTL_SEC`); max **16** queued+in-flight
  commands per node. Expired commands are pruned on every write/heartbeat and are
  never delivered; an ack after expiry is ignored.
- Delivery is recorded in the registry (`deliveredAt`, internal and never
  exposed), so a Core restart never repeats an already-delivered command.
- A module accepts one command at a time. A second command for that module
  returns `409 module_command_pending` and the active command ID while it
  waits for delivery or acknowledgement. Other modules can accept commands.
  A full node queue returns `409 module_queue_full`. An idle module accepts
  `install` for the agent to process even if it is already installed.
- The image comes from the catalog for `install` and is `absent` for the other
  actions. The image is not part of the admin request schema.

### 10.5 Security

- Catalog requests send `{action}`. Custom lifecycle requests also send the
  current `targetContainerId`, copied from `lifecycleContainerId`.
  A missing or changed target returns `409 module_target_changed`.
- Tenant scoping via the admin key; a foreign node is `404`; the platform key is
  `403`; a standby Core is `409 not_leader` for queueing (reads stay available).
- No secrets in protocol/logs/audit/registry: env hints are names only, and a
  node's error text is stored as a bounded diagnostic (never copied to audit).

## 11. Tests & limitations / next steps

Server tests: `agil/core/apps/server/test/cluster.test.ts`

- token TTL, one-time and multi-use semantics, revoke (and idempotent revoke);
- node register / heartbeat / duplicate id (a failed duplicate does not burn the
  token), scope mismatch (role/features), drain/disable/enable/update/delete;
- standby join (core token), duplicate standby id, wrong kind/role on the wrong
  endpoint;
- tenant isolation, platform-key rejection;
- 61 nodes behind one NAT heartbeating without `429` (outer IP bucket + separate
  per-node limiter), the per-node 10/min cap and `Retry-After`, the same node id
  in two tenants getting **independent** buckets (10 beats each `200`, 11th per
  tenant `429`, a third tenant unaffected), 40/100 distinct bogus keys from one
  IP being IP-limited, and the no-credential path staying IP-limited;
- node-key TTL expiry, admin rotation (old key dies, new key works, audit has no
  secret) and `not_leader` on a standby Core for every write, including node
  PATCH/disable/drain/delete and token revoke against a copied registry;
- `AGIL_ENROLL_ALLOW_IPS` fencing (including `AGIL_TRUST_PROXY`), endpoint
  metadata/credential rejection, stale registry-lock reclaim;
- a live foreign lock failing the write with `503 registry_unavailable` (no
  phantom token in memory or on disk) and a retry surviving a restart;
- no secret leakage: list/status/audit/heartbeat responses and the on-disk
  registry contain no plaintext token or node key, only 64-hex hashes;
- dashboard build (`npm run build:dashboard`) is the UI gate.

Per-node module tests:

- `agil/core/packages/protocol/test/node-modules.test.ts` — schema contract:
  catalog/report/command/result/action shapes, catalog IDs and approved custom
  targets, image/repository parsing (tag/digest/registry port), bounded
  ports/items, path constants and TTL/queue constants;
- `agil/core/apps/server/test/node-modules.test.ts` — catalog auth + allowlist +
  no secrets; queue 201 for all actions and catalog-image-only `install`;
  unknown module `404` / action `400`; active module command `409 module_command_pending`;
  queue cap `409 module_queue_full`; tenant/platform scoping; heartbeat delivery
  exactly once, ack updates the reported status and is audited without node error
  text; inventory sanitization (unknown ids/foreign images dropped, `[]` vs
  absent, old-style beats keep the snapshot); TTL expiry, late-ack ignore and
  offline-beat no-delivery; standby `409 not_leader` (reads stay open); inventory
  and delivered/pending queue survive restarts; no node key in command/queue/
  registry payloads;
- `agil/core/apps/server/test/static-docs.test.ts` — the catalog/control paths and
  the module heartbeat/`NodeSummary` fields are in OpenAPI (admin-only paths, no
  admin path in the public spec).

Leader election/failover tests (Redis; see [`ha-leader.md`](../ha-leader.md)):

- `test/ha-cluster.test.ts` — two Cores in one test process against the bundled
  RESP stub (or `AGIL_TEST_REDIS_URL`): one leader, standby is read-only (409
  `not_leader` on every mutation surface), no split-brain after the leader is
  frozen, failover and the post-failover mutation path;
- `test/ha-two-process.test.ts` — two **real OS processes** and Redis, the leader
  is `SIGKILL`ed and the standby must not acquire before the fencing deadline,
  then serves mutations and reports `failover.detected`.

Next steps (not implemented, intentionally):

1. **Room/presence/config/registry replication** between Cores (Redis pub/sub or
   a durable store) so a failover does not lose live rooms; until then a standby
   stays read-only and a failover starts with an empty room set.
2. **Scheduler**: place rooms/media on nodes using `capacity`, `drain`, `region`
   and real health probes of `endpoint`/`healthPath`.
3. **Node image runtime acceptance**: the image now exists
   (`agil/core/nodes/all-in-one/`, media supervision + TURN + rotation) but has
   only fake-Core/static validation; a real Docker build and public-IP
   SFU/TURN-relay run remain the production gate (docs/node-image.md §11).
4. **Durable registry**: Postgres/Redis instead of the single-node JSON file;
   multi-leader safety for concurrent enrollments (the advisory file lock only
   prevents interleaved writes, not divergent in-memory state).
5. **Redis HA**: the lease assumes one Redis endpoint; Sentinel/Cluster failover
   of Redis itself is a deployment concern (a Redis failover can extend the
   lease outage; the fencing deadline still stops the old leader).
6. **Module runtime acceptance**: the Core/agent contract, allowlist and queue
   are implemented and tested against a fake Docker executor; a real node-agent
   run that pulls each allowlisted image, publishes the catalog ports and reports
   health for every module remains the deployment gate. The dashboard module
   panel and the node-agent executor are separate UI/agent changes (§10 is their
   contract).
